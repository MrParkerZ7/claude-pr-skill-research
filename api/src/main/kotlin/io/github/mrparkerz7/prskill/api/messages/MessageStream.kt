package io.github.mrparkerz7.prskill.api.messages

import com.fasterxml.jackson.annotation.JsonValue
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Keepalive
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Msg
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Overflow
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Resync
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.codec.ServerSentEvent
import org.springframework.stereotype.Component
import reactor.core.Exceptions
import reactor.core.publisher.BufferOverflowStrategy
import reactor.core.publisher.Flux
import reactor.core.publisher.Mono
import java.time.Duration

/**
 * The stream's timings and bound (SPEC-001 C1, C2 and C7): a keepalive every [heartbeat], the client's reconnect
 * delay [retry], and [backlog] undelivered items per subscriber. The application uses the defaults through
 * [StreamConfig]; tests build their own. There is no external configuration.
 */
data class StreamSettings(
    val heartbeat: Duration = Duration.ofSeconds(15),
    val retry: Duration = Duration.ofSeconds(3),
    val backlog: Int = 256,
)

@Configuration(proxyBeanMethods = false)
class StreamConfig {
    @Bean
    fun streamSettings(): StreamSettings = StreamSettings()
}

/** Why a subscriber must reload (SPEC-001 C5). It is written in lower case: `restart`, `ahead`, `gap`. */
enum class ResyncReason {
    RESTART,
    AHEAD,
    GAP,
    ;

    @JsonValue
    fun wire(): String = name.lowercase()
}

/** One item of a subscriber's stream. [toServerSentEvent] renders it as a frame. */
sealed interface StreamItem {
    /** A stored or live message. */
    data class Msg(
        val message: Message,
    ) : StreamItem

    /** Reload: the frame's data is this object, `{reason, epoch, latestId}`, and only ids above [latestId] follow. */
    data class Resync(
        val reason: ResyncReason,
        val epoch: String,
        val latestId: Long,
    ) : StreamItem

    /** The heartbeat comment (SPEC-001 C2). */
    data object Keepalive : StreamItem

    /** The last item of a subscriber whose backlog overflowed (SPEC-001 C7). */
    data object Overflow : StreamItem
}

/**
 * A resume point `<epoch>.<seq>` (SPEC-001 C3 and C4): the epoch is exactly 8 lowercase hex characters, and the seq a
 * non-negative `Long` written without a leading zero.
 */
data class ResumePoint(
    val epoch: String,
    val seq: Long,
) {
    companion object {
        const val LAST_EVENT_ID = "Last-Event-ID"

        private const val AFTER = "after"
        private val FORM = Regex("([0-9a-f]{8})\\.(0|[1-9][0-9]*)")

        /** The resume point [value] names, or null when it does not parse (a seq above `Long.MAX_VALUE` included). */
        fun parse(value: String): ResumePoint? {
            val match = FORM.matchEntire(value) ?: return null
            val (epoch, digits) = match.destructured
            return digits.toLongOrNull()?.let { ResumePoint(epoch, it) }
        }

        /**
         * R from the `Last-Event-ID` [header] if it parses; `after` is then not read. Otherwise from the raw [after]
         * values: absent, one blank value or a bare `?after` (one null value) means none, one value that parses is R,
         * and anything else, a repeated parameter included, is the 400 `malformed`.
         */
        fun resolve(
            header: String?,
            after: List<String?>?,
        ): ResumePoint? {
            header?.let(::parse)?.let { return it }
            if (after == null) return null
            if (after.size != 1) malformed()
            val value = after[0]
            if (value.isNullOrBlank()) return null
            return parse(value) ?: malformed()
        }

        private fun malformed(): Nothing =
            throw InvalidRequestException(AFTER, "malformed", "after must be one resume point, <epoch>.<seq>.")
    }
}

/**
 * The operator chain of `GET /api/messages/stream` (SPEC-001 C, ADR-002). Messages come from the store's replay sink,
 * which holds the latest [MessageStore.CAPACITY] and is emitted under the store's lock, so every subscriber sees id
 * order. The heartbeat is merged in, and the [StreamSettings.backlog] bound sits after the merge.
 */
@Component
class MessageStream(
    private val store: MessageStore,
    val settings: StreamSettings,
) {
    /**
     * The retained and live messages above [from], in id order. When the first message actually delivered is not
     * `from + 1`, a message after [from] was evicted: a `gap` resync comes first, naming the store's latest id at that
     * moment, and only ids above it follow. Judging the first delivered message makes the check race-free.
     */
    fun messagesAfter(
        from: Long,
        epoch: String,
    ): Flux<StreamItem> =
        store
            .replay()
            .filter { it.id > from }
            .switchOnFirst<StreamItem> { first, messages ->
                // Null when the replay completes before any element: the store is closed.
                val message = first.get()
                if (message != null && message.id > from + 1) {
                    val now = store.snapshot().latestId
                    Flux.concat(Mono.just(Resync(ResyncReason.GAP, epoch, now)), messages.filter { it.id > now }.map(::Msg))
                } else {
                    messages.map(::Msg)
                }
            }

    /**
     * One subscriber's items for the resume point [resumePoint] (null: none). Another epoch is a `restart` resync and a
     * seq above the latest id an `ahead` resync; both continue from the latest id, and so does no resume point.
     *
     * The store is read when the stream is built, which the route does before its first frame, so a client that has
     * seen `:connected` and then posts always gets that post. A message posted between this read and the subscription
     * is still in the replay sink, so nothing falls in between.
     *
     * The buffer requests everything from the merge, so no heartbeat tick is ever refused, and it counts keepalives. At
     * [StreamSettings.backlog] undelivered items plus one it drains what it holds, then [Overflow] ends the stream.
     */
    fun stream(resumePoint: ResumePoint?): Flux<StreamItem> {
        val (epoch, latest) = store.snapshot()
        val head =
            when {
                resumePoint == null -> null
                resumePoint.epoch != epoch -> Resync(ResyncReason.RESTART, epoch, latest)
                resumePoint.seq > latest -> Resync(ResyncReason.AHEAD, epoch, latest)
                else -> null
            }
        val from = if (resumePoint == null || head != null) latest else resumePoint.seq
        return Flux
            .merge(
                Flux.concat(Mono.justOrEmpty<StreamItem>(head), messagesAfter(from, epoch)),
                Flux.interval(settings.heartbeat).map<StreamItem> { Keepalive },
            ).onBackpressureBuffer(settings.backlog, BufferOverflowStrategy.ERROR)
            .onErrorResume(Exceptions::isOverflow) { Flux.just(Overflow) }
    }
}

/**
 * Renders one item as its frame (SPEC-001 C1, C2, C5 and C7). A frame id is `<epoch>.<seq>`; every field this writes
 * comes from the server (the epoch, an id, a constant), never from the request.
 */
fun toServerSentEvent(item: StreamItem): ServerSentEvent<Any> =
    when (item) {
        is Msg -> {
            ServerSentEvent
                .builder<Any>(item.message)
                .id("${item.message.epoch}.${item.message.id}")
                .event("message")
                .build()
        }

        is Resync -> {
            ServerSentEvent
                .builder<Any>(item)
                .id("${item.epoch}.${item.latestId}")
                .event("resync")
                .build()
        }

        is Keepalive -> {
            ServerSentEvent.builder<Any>().comment("keepalive").build()
        }

        is Overflow -> {
            ServerSentEvent.builder<Any>().comment("overflow").build()
        }
    }
