package io.github.mrparkerz7.prskill.api.messages.scenario

import io.github.mrparkerz7.prskill.api.messages.MessageStore
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.io.InputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.fail

/**
 * T-012: SPEC-001 C (the stream) as a client uses it with B (the list), over real HTTP and read as raw frames. The
 * context and its store are shared with the other test classes, so every case reads the epoch and the newest id first
 * and asserts relative to them. Every case starts with no subscription left and ends with none, whatever the run order:
 * `MessageStreamHttpTest` counts exactly one after it opens one.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureWebTestClient
class StreamJourneyScenarioTest(
    @Autowired private val client: WebTestClient,
    @Autowired private val mapper: JsonMapper,
    @Autowired private val store: MessageStore,
    @param:LocalServerPort private val port: Int,
) {
    private val http: HttpClient = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()

    /** The live epoch. */
    private val epoch get() = store.snapshot().epoch

    /** One frame: its lines, without the blank line that ends it. */
    private class Frame(
        val lines: List<String>,
    ) {
        fun field(name: String): String? = lines.firstOrNull { it.startsWith("$name:") }?.substringAfter(':')

        override fun toString() = lines.joinToString(" | ")
    }

    private fun streamRequest(
        query: String,
        headers: Map<String, String>,
    ): HttpRequest {
        val builder =
            HttpRequest
                .newBuilder(URI.create("http://localhost:$port/api/messages/stream$query"))
                .timeout(Duration.ofSeconds(10))
                .GET()
        headers.forEach { (name, value) -> builder.header(name, value) }
        return builder.build()
    }

    /** An open stream, read on its own thread into a queue of frames. */
    private inner class Sse(
        query: String = "",
        headers: Map<String, String> = EVENT_STREAM,
    ) : AutoCloseable {
        private val frames = LinkedBlockingQueue<Frame>()
        val response: HttpResponse<InputStream> = http.send(streamRequest(query, headers), HttpResponse.BodyHandlers.ofInputStream())

        init {
            if (response.statusCode() != 200) response.body().close()
            assertEquals(200, response.statusCode(), "GET stream$query")
            thread(isDaemon = true, name = "sse-reader") {
                runCatching {
                    response.body().bufferedReader(Charsets.UTF_8).useLines { lines ->
                        val frame = mutableListOf<String>()
                        for (line in lines) {
                            if (line.isNotEmpty()) {
                                frame += line
                            } else {
                                frames.put(Frame(frame.toList()))
                                frame.clear()
                            }
                        }
                    }
                }
            }
        }

        /** The next frame that is not a keepalive (one may fall due on a slow machine). */
        fun next(): Frame {
            while (true) {
                val frame = assertNotNull(frames.poll(5, TimeUnit.SECONDS), "no frame within 5 s")
                if (frame.lines != listOf(":keepalive")) return frame
            }
        }

        /** The first frame holds `retry:3000` and `:connected`, in either order. */
        fun assertConnected() = assertEquals(setOf("retry:3000", ":connected"), next().lines.toSet())

        override fun close() = response.body().close()
    }

    private fun postMessage(text: String): JsonNode {
        val body =
            client
                .post()
                .uri("/api/messages")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(mapper.writeValueAsString(mapOf("text" to text)))
                .exchange()
                .expectStatus()
                .isCreated
                .expectBody<String>()
                .returnResult()
                .responseBody
        return mapper.readTree(requireNotNull(body))
    }

    /** `GET /api/messages?limit=100`: the epoch, the newest id and the listed ids, newest first. */
    private class Listing(
        val epoch: String,
        val latestId: Long,
        val ids: List<Long>,
    )

    private fun list(): Listing {
        val body =
            client
                .get()
                .uri("/api/messages?limit=100")
                .accept(MediaType.APPLICATION_JSON)
                .exchange()
                .expectStatus()
                .isOk
                .expectBody<String>()
                .returnResult()
                .responseBody
        val page = mapper.readTree(requireNotNull(body))
        return Listing(page["epoch"].stringValue(), page["latestId"].longValue(), page["messages"].values().map { it["id"].longValue() })
    }

    /** Posts each text and returns the answers' ids, which must be the consecutive ids from [first]. */
    private fun postFrom(
        first: Long,
        vararg texts: String,
    ): List<JsonNode> =
        texts.mapIndexed { index, text ->
            postMessage(text).also { assertEquals(first + index, it["id"].longValue(), text) }
        }

    /** The id inside a message frame's data. */
    private fun Frame.messageId(): Long = mapper.readTree(field("data"))["id"].longValue()

    /** The frame is the message [sent]: its id is `<epoch>.<id>`, its event `message`, its data the `201` body. */
    private fun assertMessage(
        frame: Frame,
        sent: JsonNode,
        label: String,
    ) {
        assertEquals("$epoch.${sent["id"].longValue()}", frame.field("id"), "$label: $frame")
        assertEquals("message", frame.field("event"), "$label: $frame")
        assertEquals(sent, mapper.readTree(frame.field("data")), "$label: $frame")
    }

    private fun awaitTrue(
        what: String,
        within: Duration,
        condition: () -> Boolean,
    ) {
        val deadline = System.nanoTime() + within.toNanos()
        while (!condition()) {
            if (System.nanoTime() > deadline) fail("not within $within: $what")
            Thread.onSpinWait()
        }
    }

    /** A case: it starts with no subscription left and ends with none, so the shared store is as it found it. */
    private fun journey(body: () -> Unit) {
        awaitTrue("no subscription left", Duration.ofSeconds(5)) { store.subscriberCount() == 0 }
        body()
        awaitTrue("released", Duration.ofSeconds(1)) { store.subscriberCount() == 0 }
    }

    // serves-spec: SPEC-001 #C3 · Optional-Success
    @Test
    fun `SC-messages-RC3b-OS1 a client that lists, then resumes from the list's latestId, gets exactly the later posts, then live`() =
        journey {
            val h0 = postMessage("handoff-0")["id"].longValue()
            val listed = list()
            assertEquals(h0, listed.latestId, "the list's latestId is the post before it")
            val e = listed.epoch
            val l = listed.latestId
            val between = postFrom(l + 1, "handoff-1", "handoff-2", "handoff-3")
            Sse("?after=$e.$l").use { sse ->
                sse.assertConnected()
                between.forEach { assertMessage(sse.next(), it, "replay of ${it["id"].longValue()}") }
                val live = postFrom(l + 4, "handoff-4").single()
                assertMessage(sse.next(), live, "live")
            }
        }

    // serves-spec: SPEC-001 #C3 · Optional-Success
    @Test
    fun `SC-messages-RC3b-T1 a client that dropped resumes from its last frame id and gets every missed message once`() =
        journey {
            val received = mutableListOf<Long>()
            val (k, lastFrameId) =
                Sse().use { sse ->
                    sse.assertConnected()
                    val first = postMessage("drop-1")
                    val frame = sse.next()
                    assertMessage(frame, first, "first connection")
                    received += frame.messageId()
                    first["id"].longValue() to requireNotNull(frame.field("id"))
                }
            awaitTrue("released", Duration.ofSeconds(1)) { store.subscriberCount() == 0 }
            val missed = postFrom(k + 1, "drop-2", "drop-3")
            Sse(headers = EVENT_STREAM + ("Last-Event-ID" to lastFrameId)).use { sse ->
                sse.assertConnected()
                missed.forEach {
                    val frame = sse.next()
                    assertMessage(frame, it, "resume")
                    received += frame.messageId()
                }
                val live = postFrom(k + 3, "drop-4").single()
                val frame = sse.next()
                assertMessage(frame, live, "live")
                received += frame.messageId()
            }
            assertEquals(listOf(k, k + 1, k + 2, k + 3), received, "every message once, in order")
        }

    // serves-spec: SPEC-001 #C5 · Optional-Fail
    @Test
    fun `SC-messages-RC5c-T1 a client more than 100 behind gets a gap resync, re-lists and resumes with no loss and no repeat`() =
        journey {
            val before = list()
            val e = before.epoch
            val l = before.latestId
            postFrom(l + 1, *Array(101) { "gap-$it" })
            val (resyncId, relisted) =
                Sse("?after=$e.$l").use { sse ->
                    sse.assertConnected()
                    val frame = sse.next()
                    assertEquals("$e.${l + 101}", frame.field("id"), frame.toString())
                    assertEquals("resync", frame.field("event"), frame.toString())
                    val expected = mapper.readTree("""{"reason":"gap","epoch":"$e","latestId":${l + 101}}""")
                    assertEquals(expected, mapper.readTree(frame.field("data")), frame.toString())
                    // The re-list, with the stream still open.
                    val relisted = list()
                    assertEquals(l + 101, relisted.latestId, "the re-list ends at the resync's latestId")
                    assertEquals((l + 101 downTo l + 2).toList(), relisted.ids, "L+1 was evicted")
                    requireNotNull(frame.field("id")) to relisted
                }
            awaitTrue("released", Duration.ofSeconds(1)) { store.subscriberCount() == 0 }
            val after = postFrom(l + 102, "gap-after").single()
            val streamed = mutableListOf<Long>()
            Sse(headers = EVENT_STREAM + ("Last-Event-ID" to resyncId)).use { sse ->
                sse.assertConnected()
                val resumed = sse.next()
                assertMessage(resumed, after, "resume from the resync's id")
                streamed += resumed.messageId()
                val live = postFrom(l + 103, "gap-live").single()
                val liveFrame = sse.next()
                assertMessage(liveFrame, live, "live")
                streamed += liveFrame.messageId()
            }
            assertEquals((l + 2..l + 103).toList(), (relisted.ids + streamed).sorted(), "every message once")
        }

    // serves-spec: SPEC-001 #C6 · Required-Success
    @Test
    fun `SC-messages-RC6c-S1 a HEAD on the stream is answered 200 with no body and holds no subscription`() =
        journey {
            val request =
                HttpRequest
                    .newBuilder(URI.create("http://localhost:$port/api/messages/stream"))
                    .timeout(Duration.ofSeconds(10))
                    .header("Accept", "text/event-stream")
                    .HEAD()
                    .build()
            val response = http.send(request, HttpResponse.BodyHandlers.ofByteArray())
            assertEquals(200, response.statusCode())
            assertEquals(0, response.body().size, "a HEAD has no body")
            assertEquals(0, store.subscriberCount(), "right after the HEAD")
            postMessage("head")
            assertEquals(0, store.subscriberCount(), "after a post")
        }

    // serves-spec: SPEC-001 #C8 · Required-Success
    @Test
    fun `SC-messages-RC8-S1 closing one of two streams releases only its own`() =
        journey {
            Sse().use { a ->
                Sse().use { b ->
                    a.assertConnected()
                    b.assertConnected()
                    // `:connected` is written just before the chain subscribes to the sink, so the count may lag by a moment.
                    awaitTrue("two subscriptions", Duration.ofSeconds(1)) { store.subscriberCount() == 2 }
                    assertEquals(2, store.subscriberCount())
                    a.close()
                    awaitTrue("one subscription", Duration.ofSeconds(1)) { store.subscriberCount() == 1 }
                    val sent = postMessage("c8")
                    assertMessage(b.next(), sent, "the open stream still gets the post")
                    b.close()
                    awaitTrue("subscriberCount() back to 0", Duration.ofSeconds(1)) { store.subscriberCount() == 0 }
                }
            }
        }

    private companion object {
        val EVENT_STREAM = mapOf("Accept" to "text/event-stream")
    }
}
