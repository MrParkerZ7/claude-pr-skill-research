package io.github.mrparkerz7.prskill.api.messages

import io.github.mrparkerz7.prskill.api.messages.StreamItem.Keepalive
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Msg
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Overflow
import io.github.mrparkerz7.prskill.api.messages.StreamItem.Resync
import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.returnResult
import reactor.core.Disposable
import reactor.core.publisher.Flux
import reactor.test.StepVerifier
import reactor.test.scheduler.VirtualTimeScheduler
import tools.jackson.databind.json.JsonMapper
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.random.Random
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * SPEC-001 C at the `Flux` level. Each case builds a fresh store with the epoch E = `0123abcd` and a fixed clock, and
 * its own [MessageStream]. A real-time case uses an hour-long heartbeat, so no keepalive can interleave; a heartbeat
 * case builds its `Flux` inside `withVirtualTime`, so the interval runs on virtual time.
 */
class MessageStreamTest {
    private val fixedClock = Clock.fixed(Instant.parse("2026-11-06T10:15:30.123Z"), ZoneOffset.UTC)
    private val quiet = StreamSettings(heartbeat = Duration.ofHours(1))

    private fun MessageStore.post(count: Int): List<Long> = List(count) { append(MessageText.parse("m$it")).id }

    private fun storeWith(count: Int) = MessageStore(fixedClock, E).also { it.post(count) }

    private fun at(
        seq: Long,
        epoch: String = E,
    ) = ResumePoint(epoch, seq)

    /** An item as a short label: a message's id, `resync <reason> <epoch> <latestId>`, `keepalive` or `overflow`. */
    private fun label(item: StreamItem): String =
        when (item) {
            is Msg -> item.message.id.toString()
            is Resync -> "resync ${item.reason.wire()} ${item.epoch} ${item.latestId}"
            is Keepalive -> "keepalive"
            is Overflow -> "overflow"
        }

    private fun MessageStream.labels(resumePoint: ResumePoint?): Flux<String> = stream(resumePoint).map(::label)

    private fun ids(range: LongRange) = range.map(Long::toString)

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

    @Test
    fun `T005-S2 three subscribers each get every message once, in id order`() {
        val store = storeWith(0)
        val stream = MessageStream(store, quiet)
        val verifiers =
            List(3) {
                StepVerifier
                    .create(stream.labels(null))
                    .expectNext("1", "2", "3")
                    .expectNoEvent(Duration.ofMillis(100))
                    .thenCancel()
                    .verifyLater()
            }
        store.post(3)
        verifiers.forEach { it.verify(TIMEOUT) }
    }

    @Test
    fun `T005-S3 a keepalive comes every 15 s of virtual time, and the period is the settings' heartbeat`() {
        StepVerifier
            .withVirtualTime { MessageStream(storeWith(0), StreamSettings()).labels(null) }
            .expectSubscription()
            .thenAwait(Duration.ofSeconds(15))
            .expectNext("keepalive")
            .thenAwait(Duration.ofSeconds(15))
            .expectNext("keepalive")
            .thenCancel()
            .verify(TIMEOUT)
        StepVerifier
            .withVirtualTime { MessageStream(storeWith(0), StreamSettings(heartbeat = Duration.ofSeconds(5))).labels(null) }
            .expectSubscription()
            .expectNoEvent(Duration.ofMillis(4_999))
            .thenAwait(Duration.ofMillis(1))
            .expectNext("keepalive")
            .thenCancel()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-F4 a resume point of another epoch is a restart resync at the latest id, then only newer ids`() {
        for (seq in listOf(2L, 5L, 9L)) {
            val store = storeWith(5)
            StepVerifier
                .create(MessageStream(store, quiet).labels(at(seq, X)))
                .expectNext("resync restart $E 5")
                .then { store.post(1) }
                .expectNext("6")
                .thenCancel()
                .verify(TIMEOUT)
        }
    }

    @Test
    fun `T005-F5 a seq above the latest id is an ahead resync, then only newer ids`() {
        for (seq in listOf(6L, 50L, Long.MAX_VALUE)) {
            val store = storeWith(5)
            StepVerifier
                .create(MessageStream(store, quiet).labels(at(seq)))
                .expectNext("resync ahead $E 5")
                .then { store.post(1) }
                .expectNext("6")
                .thenCancel()
                .verify(TIMEOUT)
        }
    }

    @Test
    fun `T005-F6 an evicted message after R is a gap resync at the latest id, then only newer ids`() {
        val store = storeWith(101)
        StepVerifier
            .create(MessageStream(store, quiet).labels(at(0)))
            .expectNext("resync gap $E 101")
            .then { store.post(1) }
            .expectNext("102")
            .thenCancel()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-B1 99 stored and R = E 0 replays 1 to 99 with no resync`() {
        val store = storeWith(99)
        StepVerifier
            .create(MessageStream(store, quiet).labels(at(0)))
            .expectNextSequence(ids(1L..99L))
            .then { store.post(1) }
            .expectNext("100")
            .thenCancel()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-B2 100 stored and R = E 0 replays 1 to 100 with no resync`() {
        val store = storeWith(100)
        StepVerifier
            .create(MessageStream(store, quiet).labels(at(0)))
            .expectNextSequence(ids(1L..100L))
            .then { store.post(1) }
            .expectNext("101")
            .thenCancel()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-B3 101 stored and R = E 1 replays 2 to 101 with no resync`() {
        val store = storeWith(101)
        StepVerifier
            .create(MessageStream(store, quiet).labels(at(1)))
            .expectNextSequence(ids(2L..101L))
            .then { store.post(1) }
            .expectNext("102")
            .thenCancel()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-B4 an empty store and R = E 0 is live only, with no resync`() {
        val store = storeWith(0)
        StepVerifier
            .create(MessageStream(store, quiet).labels(at(0)))
            .expectSubscription()
            .expectNoEvent(Duration.ofMillis(50))
            .then { store.post(1) }
            .expectNext("1")
            .thenCancel()
            .verify(TIMEOUT)
    }

    /**
     * The items are counted, not awaited: `expectNoEvent` and `thenAwait` do not fail on a signal that was queued
     * earlier (a first tick at 0 ms, or two keepalives per tick), so only a list shows "none" and "exactly one".
     */
    @Test
    fun `T005-B5 no keepalive at 14 999 ms of virtual time, exactly one at 15 000 ms, two at 30 000 ms`() {
        val scheduler = VirtualTimeScheduler.getOrSet()
        try {
            val seen = mutableListOf<StreamItem>()
            val subscription = MessageStream(storeWith(0), StreamSettings()).stream(null).subscribe { seen += it }
            scheduler.advanceTimeBy(Duration.ofMillis(14_999))
            assertEquals(emptyList(), seen)
            scheduler.advanceTimeBy(Duration.ofMillis(1))
            assertEquals(listOf<StreamItem>(Keepalive), seen)
            scheduler.advanceTimeBy(Duration.ofMillis(15_000))
            assertEquals(listOf<StreamItem>(Keepalive, Keepalive), seen)
            subscription.dispose()
        } finally {
            VirtualTimeScheduler.reset()
        }
    }

    @Test
    fun `T005-S1 a post between building the stream and subscribing to it is delivered`() {
        val store = storeWith(0)
        val built = MessageStream(store, quiet).labels(null)
        store.post(1)
        StepVerifier
            .create(built)
            .expectNext("1")
            .thenCancel()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-B6 256 undelivered messages are all delivered once requested, and the stream stays open`() {
        val store = storeWith(0)
        StepVerifier
            .create(MessageStream(store, StreamSettings()).labels(null), 0)
            .expectSubscription()
            .then { store.post(256) }
            .thenRequest(Long.MAX_VALUE)
            .expectNextSequence(ids(1L..256L))
            .expectNoEvent(Duration.ofMillis(200))
            .thenCancel()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-B7 the 257th undelivered message ends the stream with exactly 256 messages, then overflow`() {
        val store = storeWith(0)
        StepVerifier
            .create(MessageStream(store, StreamSettings()).labels(null), 0)
            .expectSubscription()
            .then { store.post(257) }
            .thenRequest(Long.MAX_VALUE)
            .expectNextSequence(ids(1L..256L))
            .expectNext("overflow")
            .expectComplete()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-B8 the backlog counts keepalives - 255 messages and a keepalive fill it, the next post overflows`() {
        val store = storeWith(0)
        StepVerifier
            .withVirtualTime({ MessageStream(store, StreamSettings()).labels(null) }, 0)
            .expectSubscription()
            .then { store.post(255) }
            .thenAwait(Duration.ofSeconds(15))
            // Full but still open: nothing at all is signalled while nothing is requested.
            .expectNoEvent(Duration.ofMillis(1))
            .then { store.post(1) }
            .thenRequest(Long.MAX_VALUE)
            .expectNextSequence(ids(1L..255L) + "keepalive")
            .expectNext("overflow")
            .expectComplete()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-L1 a cancelled subscription is released within 1 s`() {
        val store = storeWith(3)
        val subscription = MessageStream(store, quiet).stream(at(1)).subscribe()
        assertEquals(1, store.subscriberCount())
        subscription.dispose()
        awaitTrue("subscriberCount() is 0", Duration.ofSeconds(1)) { store.subscriberCount() == 0 }
    }

    @Test
    fun `T005-L2 300 appends never fail while a subscriber requests nothing, and that subscriber then gets overflow`() {
        val store = storeWith(0)
        StepVerifier
            .create(MessageStream(store, quiet).labels(null), 0)
            .expectSubscription()
            // An emit result other than OK would make append throw here.
            .then { assertEquals((1L..300L).toList(), store.post(300)) }
            .thenRequest(Long.MAX_VALUE)
            .expectNextSequence(ids(1L..256L))
            .expectNext("overflow")
            .expectComplete()
            .verify(TIMEOUT)
        // The overflow cancelled the sink subscription too.
        assertEquals(0, store.subscriberCount())
    }

    @Test
    fun `T005-L3 messages posted with no subscriber are replayed to a later one`() {
        val store = storeWith(5)
        StepVerifier
            .create(MessageStream(store, quiet).labels(at(0)))
            .expectNextSequence(ids(1L..5L))
            .thenCancel()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-L4 a closed empty store completes the message source with no item and no resync`() {
        val store = storeWith(0)
        store.close()
        StepVerifier
            .create(MessageStream(store, quiet).messagesAfter(0, E))
            .expectComplete()
            .verify(TIMEOUT)
    }

    @Test
    fun `T005-L5 append after close throws IllegalStateException`() {
        val store = storeWith(1)
        store.close()
        val failure = assertFailsWith<IllegalStateException> { store.post(1) }
        assertTrue(failure.message.orEmpty().contains("FAIL_TERMINATED"), failure.message)
    }

    @Test
    fun `T005-C1 two live subscribers each see 1 to 200 exactly once, in order, while 8 threads post 25 each`() {
        val store = storeWith(0)
        val stream = MessageStream(store, quiet)
        val seen = List(2) { Collections.synchronizedList(mutableListOf<String>()) }
        val subscriptions = seen.map { list -> stream.labels(null).subscribe { list.add(it) } }
        val pool = Executors.newFixedThreadPool(8)
        try {
            val start = CountDownLatch(1)
            val posters = List(8) { pool.submit<List<Long>> { start.await().let { store.post(25) } } }
            start.countDown()
            // An append that threw (an emit result other than OK) fails here.
            assertEquals((1L..200L).toList(), posters.flatMap { it.get(30, TimeUnit.SECONDS) }.sorted())
            for (list in seen) {
                awaitTrue("200 messages") { list.size >= 200 }
                assertEquals(ids(1L..200L), synchronized(list) { list.toList() })
            }
        } finally {
            pool.shutdownNow()
            subscriptions.forEach(Disposable::dispose)
        }
    }

    @Test
    fun `T005-C2 subscribers joining at random points get exactly the ids above their resume point`() {
        val seed = System.nanoTime()
        println("T005-C2 seed $seed")
        val random = Random(seed)
        val store = storeWith(0)
        val stream = MessageStream(store, quiet)
        val joinPoints = List(4) { random.nextLong(0, 200) }.sorted()
        val joined = mutableListOf<Pair<Long, MutableList<String>>>()
        val subscriptions = mutableListOf<Disposable>()
        val pool = Executors.newFixedThreadPool(8)
        try {
            val start = CountDownLatch(1)
            val posters = List(8) { pool.submit<List<Long>> { start.await().let { store.post(25) } } }
            start.countDown()
            for (point in joinPoints) {
                awaitTrue("the store reaches $point (seed $seed)") { store.snapshot().latestId >= point }
                val resumeAt = store.snapshot().latestId
                val seen = Collections.synchronizedList(mutableListOf<String>())
                subscriptions +=
                    stream.labels(at(resumeAt)).subscribe({ seen.add(it) }, { seen.add("error $it") }, { seen.add("complete") })
                joined += resumeAt to seen
            }
            posters.forEach { it.get(30, TimeUnit.SECONDS) }
            for ((resumeAt, seen) in joined) {
                val context = "seed $seed, joined at R = $E.$resumeAt"
                // Done when id 200 came, or a resync already named 200 (a subscriber that joined late, after its
                // R + 1 was evicted, gets exactly that and nothing more).
                awaitTrue("the last item ($context)") {
                    resumeAt == 200L || seen.contains("200") || seen.contains("resync gap $E 200")
                }
                val items = synchronized(seen) { seen.toList() }
                val first = items.firstOrNull().orEmpty()
                val expected =
                    if (first.startsWith("resync gap $E ")) {
                        // A gap is right only when R + 1 was evicted: at least 100 newer messages existed.
                        val latestId = first.substringAfterLast(' ').toLong()
                        assertTrue(latestId >= resumeAt + 1 + MessageStore.CAPACITY, "$context: $first")
                        listOf(first) + ids(latestId + 1..200L)
                    } else {
                        ids(resumeAt + 1..200L)
                    }
                assertEquals(expected, items, context)
            }
        } finally {
            pool.shutdownNow()
            subscriptions.forEach(Disposable::dispose)
        }
    }

    @Test
    fun `T005-K1 the frames of a stream resumed from E 0 after posts a and b equal the contract sample`() {
        val store = MessageStore(fixedClock, E)
        store.append(MessageText.parse("a"))
        store.append(MessageText.parse("b"))
        val client = WebTestClient.bindToController(MessageController(store, MessageStream(store, quiet))).build()
        val body =
            client
                .get()
                .uri("/api/messages/stream?after=$E.0")
                .accept(MediaType.TEXT_EVENT_STREAM)
                .exchange()
                .expectStatus()
                .isOk
                .returnResult<ByteArray>()
                .responseBody
        val received = StringBuilder()
        body
            .map { String(it, Charsets.UTF_8) }
            .takeUntil { received.append(it).split("\n\n").size > SAMPLE_FRAMES }
            .blockLast(TIMEOUT)
        val frames = received.split("\n\n").take(SAMPLE_FRAMES).filter { it != ":keepalive" }
        val sample = Files.readString(Path.of("..", "contracts", "messages", "stream-sample.txt"))
        assertEquals(sample, frames.joinToString("") { "$it\n\n" })
    }

    @Test
    fun `T005-K2 each item renders as its frame - id, event, data and comment`() {
        // The mapper the codecs use (the Kotlin module is found on the classpath), so the member order is the wire's.
        val mapper = JsonMapper.builder().findAndAddModules().build()
        val message = Message(6, E, "hello", Instant.parse("2026-11-06T10:15:30.123Z"))

        val msg = toServerSentEvent(Msg(message))
        assertEquals("id:$E.6\nevent:message\ndata:", msg.format())
        assertSame(message, msg.data())

        for ((reason, wire) in listOf(ResyncReason.RESTART to "restart", ResyncReason.AHEAD to "ahead", ResyncReason.GAP to "gap")) {
            val resync = toServerSentEvent(Resync(reason, E, 101))
            assertEquals("id:$E.101\nevent:resync\ndata:", resync.format(), wire)
            // A string, not a tree: the members' order is part of the frame (the web client reads it).
            assertEquals("""{"reason":"$wire","epoch":"$E","latestId":101}""", mapper.writeValueAsString(resync.data()), wire)
        }

        for ((item, comment) in listOf(Keepalive to "keepalive", Overflow to "overflow")) {
            val frame = toServerSentEvent(item)
            assertEquals(":$comment\n", frame.format(), comment)
            assertNull(frame.data(), comment)
        }
    }

    private companion object {
        const val E = "0123abcd"
        const val X = "ffffffff"
        const val SAMPLE_FRAMES = 3
        val TIMEOUT: Duration = Duration.ofSeconds(10)
    }
}
