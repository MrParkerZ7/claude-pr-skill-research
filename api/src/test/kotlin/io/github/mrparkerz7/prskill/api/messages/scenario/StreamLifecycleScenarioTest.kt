package io.github.mrparkerz7.prskill.api.messages.scenario

import io.github.mrparkerz7.prskill.api.messages.MessageStore
import io.github.mrparkerz7.prskill.api.messages.MessageStream
import io.github.mrparkerz7.prskill.api.messages.MessageText
import io.github.mrparkerz7.prskill.api.messages.ResumePoint
import io.github.mrparkerz7.prskill.api.messages.StreamItem
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Keepalive
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Msg
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Overflow
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Resync
import io.github.mrparkerz7.prskill.api.messages.StreamSettings
import org.junit.jupiter.api.Test
import reactor.test.StepVerifier
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.Collections
import kotlin.math.max
import kotlin.random.Random
import kotlin.test.assertEquals
import kotlin.test.fail

/**
 * T-012: SPEC-001 C (the stream) as part of the whole feature, at the `Flux` level. Each case builds a fresh store with
 * the epoch E = `0123abcd` and a fixed clock, and its own [MessageStream] with an hour-long heartbeat, so no keepalive
 * can interleave. The property case draws from a seed written in this file.
 */
class StreamLifecycleScenarioTest {
    private val fixedClock = Clock.fixed(Instant.parse("2026-11-06T10:15:30.123Z"), ZoneOffset.UTC)
    private val settings = StreamSettings(heartbeat = Duration.ofHours(1), backlog = 256)

    private fun MessageStore.post(
        count: Int,
        text: String = "m",
    ): List<Long> = List(count) { append(MessageText.parse(text)).id }

    /** An item as a short label: a message's id, `resync <reason> <epoch> <latestId>`, `keepalive` or `overflow`. */
    private fun label(item: StreamItem): String =
        when (item) {
            is Msg -> item.message.id.toString()
            is Resync -> "resync ${item.reason.wire()} ${item.epoch} ${item.latestId}"
            is Keepalive -> "keepalive"
            is Overflow -> "overflow"
        }

    private fun awaitTrue(
        what: String,
        within: Duration = TIMEOUT,
        condition: () -> Boolean,
    ) {
        val deadline = System.nanoTime() + within.toNanos()
        while (!condition()) {
            if (System.nanoTime() > deadline) fail("not within $within: $what")
            Thread.onSpinWait()
        }
    }

    /** What a subscriber that resumes at [resumePoint] must be sent first, when the newest id is [latest] (SPEC-001 C3, C5). */
    private fun expectedPrefix(
        resumePoint: ResumePoint?,
        latest: Long,
    ): List<String> =
        when {
            resumePoint == null -> emptyList()
            resumePoint.epoch != E -> listOf("resync restart $E $latest")
            resumePoint.seq > latest -> listOf("resync ahead $E $latest")
            resumePoint.seq >= latest - RETAINED -> (resumePoint.seq + 1..latest).map(Long::toString)
            else -> listOf("resync gap $E $latest")
        }

    // serves-spec: SPEC-001 #C3 · Optional-Success
    @Test
    fun `SC-messages-RC3b-OS2 any posts and any resume point give each subscriber exactly the model's frames`() {
        val store = MessageStore(fixedClock, E)
        val stream = MessageStream(store, settings)
        val random = Random(SEED)
        var latest = 0L
        var step = 0

        /** One subscriber at [resumePoint]; with [live], one more message is posted and must follow the prefix. */
        fun subscribe(
            resumePoint: ResumePoint?,
            live: Boolean,
        ) {
            val at = if (resumePoint == null) "none" else "${resumePoint.epoch}.${resumePoint.seq}"
            val context = "seed $SEED_NUMBER, step $step, R $at, N $latest"
            val prefix = expectedPrefix(resumePoint, latest)
            val seen = Collections.synchronizedList(mutableListOf<String>())
            val subscription = stream.stream(resumePoint).map(::label).subscribe { seen.add(it) }
            try {
                awaitTrue("the prefix ($context)") { seen.size >= prefix.size }
                assertEquals(prefix, synchronized(seen) { seen.toList() }, context)
                if (live) {
                    val posted = store.post(1, "live").single()
                    assertEquals(latest + 1, posted, context)
                    awaitTrue("the live message ($context)") { seen.size >= prefix.size + 1 }
                    assertEquals(prefix + posted.toString(), synchronized(seen) { seen.toList() }, context)
                    latest = posted
                }
            } finally {
                subscription.dispose()
            }
            awaitTrue("subscriberCount() is 0 ($context)", Duration.ofSeconds(1)) { store.subscriberCount() == 0 }
        }

        // The forced prefix: the edges at N = 0 on every run. No live message is posted, so N stays 0.
        val forced =
            listOf(null, ResumePoint(E, 0), ResumePoint(E, 1), ResumePoint(X, 0), ResumePoint(X, 7), ResumePoint(E, Long.MAX_VALUE))
        forced.forEachIndexed { index, resumePoint ->
            step = index + 1
            subscribe(resumePoint, live = false)
        }
        var previous: ResumePoint? = forced.last()

        repeat(RANDOM_STEPS) { index ->
            step = forced.size + index + 1
            if (random.nextInt(100) < POST_SHARE) {
                latest += store.post(random.nextInt(1, 41), "p").size
            } else {
                val d = random.nextInt(100)
                val resumePoint =
                    when {
                        d < 10 -> null
                        d < 20 -> previous
                        d < 30 -> ResumePoint(X, random.nextLong(0, latest + 4))
                        d < 35 -> ResumePoint(E, Long.MAX_VALUE)
                        d < 70 -> ResumePoint(E, random.nextLong(max(0, latest - 103), latest + 4))
                        else -> ResumePoint(E, random.nextLong(0, latest + 4))
                    }
                subscribe(resumePoint, live = true)
                previous = resumePoint
            }
        }
        assertEquals(0, store.subscriberCount(), "seed $SEED_NUMBER: every subscription is released")
    }

    // serves-spec: SPEC-001 #C7 · Optional-Fail
    @Test
    fun `SC-messages-RC7a-T1 a replay counts toward the backlog - 100 replayed and 157 live end the stream at the 257th`() {
        val store = MessageStore(fixedClock, E)
        store.post(100)
        StepVerifier
            .create(MessageStream(store, settings).stream(ResumePoint(E, 0)).map(::label), 0)
            .expectSubscription()
            .then { store.post(157) }
            .thenRequest(Long.MAX_VALUE)
            .expectNextSequence((1..256).map(Int::toString))
            .expectNext("overflow")
            .expectComplete()
            .verify(TIMEOUT)
        assertEquals(0, store.subscriberCount())
    }

    // serves-spec: SPEC-001 #C7 · Optional-Fail
    @Test
    fun `SC-messages-RC7a-T2 a resync counts toward the backlog - the resync and 255 live messages fill it, the 256th overflows`() {
        val store = MessageStore(fixedClock, E)
        store.post(101)
        StepVerifier
            .create(MessageStream(store, settings).stream(ResumePoint(E, 0)).map(::label), 0)
            .expectSubscription()
            .then { store.post(256) }
            .thenRequest(Long.MAX_VALUE)
            .expectNext("resync gap $E 101")
            .expectNextSequence((102..356).map(Int::toString))
            .expectNext("overflow")
            .expectComplete()
            .verify(TIMEOUT)
        assertEquals(0, store.subscriberCount())
    }

    private companion object {
        const val E = "0123abcd"
        const val X = "ffffffff"

        /** The seed of the property case, written here and in every assertion message. */
        const val SEED = 20261109L
        const val SEED_NUMBER = SEED.toInt()
        const val RANDOM_STEPS = 400
        const val POST_SHARE = 35

        /** SPEC-001 C5: the latest 100 messages are retained, so a seq up to 100 below the newest id still replays. */
        const val RETAINED = 100L
        val TIMEOUT: Duration = Duration.ofSeconds(10)
    }
}
