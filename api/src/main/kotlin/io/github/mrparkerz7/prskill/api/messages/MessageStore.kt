package io.github.mrparkerz7.prskill.api.messages

import jakarta.annotation.PreDestroy
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Component
import reactor.core.publisher.Flux
import reactor.core.publisher.Sinks
import java.security.SecureRandom
import java.time.Clock
import java.time.temporal.ChronoUnit
import java.util.HexFormat

/**
 * The latest [CAPACITY] messages, in memory, under a per-boot [epoch] (ADR-002). One lock guards the ring, the last
 * id and the stream's replay sink, so ids are gap-free, a read sees them together, and the stream emits in id order.
 * The lock is reentrant: a stream that judges a gap while a message is emitted to it calls [snapshot] on the thread
 * that already holds it.
 *
 * The ring (read by the list) and the sink (read by the stream) both hold the latest [CAPACITY].
 *
 * The text arrives as a [MessageText], so a rejected request never reaches [append] and never takes an id.
 */
@Component
class MessageStore(
    private val clock: Clock,
    val epoch: String,
) {
    @Autowired
    constructor(clock: Clock) : this(clock, mintEpoch())

    private val lock = Any()
    private val ring = ArrayDeque<Message>()
    private var lastId = 0L
    private val sink = Sinks.many().replay().limit<Message>(CAPACITY)

    /**
     * Stores the message and emits it into the stream's sink inside the same lock, so frame order is id order. The
     * fan-out to every subscriber, SSE encoding included, runs here on the caller's thread; each subscriber buffers on
     * its own, so a slow one never makes this wait. Any emit result other than `OK` (after [close]: `FAIL_TERMINATED`)
     * is an [IllegalStateException].
     */
    fun append(text: MessageText): Message =
        synchronized(lock) {
            val message = Message(++lastId, epoch, text.toString(), clock.instant().truncatedTo(ChronoUnit.MILLIS))
            ring.addLast(message)
            if (ring.size > CAPACITY) ring.removeFirst()
            val result = sink.tryEmitNext(message)
            check(result == Sinks.EmitResult.OK) { "The stream did not take message ${message.id}: $result" }
            message
        }

    /** The newest [limit] messages, newest first, with the epoch and the newest id from the same locked read. */
    fun page(limit: Int): MessagePage =
        synchronized(lock) {
            val newest = ring.asReversed().take(limit)
            MessagePage(epoch, newest, newest.firstOrNull()?.id ?: 0L)
        }

    fun snapshot(): StoreSnapshot = synchronized(lock) { StoreSnapshot(epoch, lastId) }

    /** The latest [CAPACITY] messages, then every new one, in id order. Each subscriber reads at its own pace. */
    fun replay(): Flux<Message> = sink.asFlux()

    /** How many subscriptions the sink holds; a cancelled stream releases its own (SPEC-001 C8). */
    fun subscriberCount(): Int = sink.currentSubscriberCount()

    /** Completes the sink, which ends the message source of every stream; [append] fails from then on. */
    @PreDestroy
    fun close() {
        synchronized(lock) { sink.tryEmitComplete() }
    }

    companion object {
        const val CAPACITY = 100

        private const val EPOCH_BYTES = 4

        /** 8 lowercase hex characters from `SecureRandom`. */
        private fun mintEpoch(): String {
            val bytes = ByteArray(EPOCH_BYTES)
            SecureRandom().nextBytes(bytes)
            return HexFormat.of().formatHex(bytes)
        }
    }
}
