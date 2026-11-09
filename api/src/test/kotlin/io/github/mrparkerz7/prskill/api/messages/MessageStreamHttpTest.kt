package io.github.mrparkerz7.prskill.api.messages

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
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * SPEC-001 C over real HTTP, read as raw frames. The context and its store are shared with the other test classes, so
 * every case reads the store's epoch and newest id first and asserts relative to them. A case proves that nothing was
 * replayed by posting once and finding that post as the next frame.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureWebTestClient
class MessageStreamHttpTest(
    @Autowired private val client: WebTestClient,
    @Autowired private val mapper: JsonMapper,
    @Autowired private val store: MessageStore,
    @param:LocalServerPort private val port: Int,
) {
    private val http: HttpClient = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()

    /** The live epoch, and another one (`ffffffff`, unless that is the live one). */
    private val epoch get() = store.snapshot().epoch
    private val other get() = if (epoch == "ffffffff") "00000000" else "ffffffff"

    /** One frame: its lines, without the blank line that ends it. */
    private class Frame(
        val lines: List<String>,
    ) {
        fun field(name: String): String? = lines.firstOrNull { it.startsWith("$name:") }?.substringAfter(':')

        override fun toString() = lines.joinToString(" | ")
    }

    private fun request(
        query: String,
        headers: Map<String, String>,
        method: String = "GET",
    ): HttpRequest {
        val builder =
            HttpRequest
                .newBuilder(URI.create("http://localhost:$port/api/messages/stream$query"))
                .timeout(Duration.ofSeconds(10))
                .method(method, HttpRequest.BodyPublishers.noBody())
        headers.forEach { (name, value) -> builder.header(name, value) }
        return builder.build()
    }

    /** An open stream, read on its own thread into a queue of frames. */
    private inner class Sse(
        query: String = "",
        headers: Map<String, String> = EVENT_STREAM,
    ) : AutoCloseable {
        private val frames = LinkedBlockingQueue<Frame>()
        val response: HttpResponse<InputStream> = http.send(request(query, headers), HttpResponse.BodyHandlers.ofInputStream())

        init {
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

        fun header(name: String): String? = response.headers().firstValue(name).orElse(null)

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

    /** Posts [count] messages and returns the first new id. */
    private fun postMany(
        count: Int,
        label: String,
    ): Long = List(count) { postMessage("$label-$it")["id"].longValue() }.first()

    private fun assertMessage(
        frame: Frame,
        id: Long,
        label: String = "",
    ) {
        assertEquals("$epoch.$id", frame.field("id"), "$label: $frame")
        assertEquals("message", frame.field("event"), "$label: $frame")
        assertEquals(id, mapper.readTree(frame.field("data"))["id"].longValue(), "$label: $frame")
    }

    /** Posts one message and finds it as the next frame: nothing older was sent before it. */
    private fun Sse.assertLiveNext(label: String = "") {
        val sent = postMessage("live")
        val frame = next()
        assertMessage(frame, sent["id"].longValue(), label)
        assertEquals(sent, mapper.readTree(frame.field("data")), label)
    }

    private fun Sse.assertReplays(
        ids: LongRange,
        label: String = "",
    ) = ids.forEach { assertMessage(next(), it, "$label, id $it") }

    private fun Sse.assertResync(
        reason: String,
        latestId: Long,
        label: String = "",
    ) {
        val frame = next()
        assertEquals("$epoch.$latestId", frame.field("id"), "$label: $frame")
        assertEquals("resync", frame.field("event"), "$label: $frame")
        val expected = mapper.readTree("""{"reason":"$reason","epoch":"$epoch","latestId":$latestId}""")
        assertEquals(expected, mapper.readTree(frame.field("data")), label)
    }

    /**
     * Sends [request] and checks its status before reading any body. A wrong status closes the body at once, so a
     * stream that should have been an error fails the case instead of blocking it forever.
     */
    private fun statusFirst(
        request: HttpRequest,
        status: Int,
        label: String,
    ): HttpResponse<InputStream> {
        val response = http.send(request, HttpResponse.BodyHandlers.ofInputStream())
        if (response.statusCode() != status) response.body().close()
        assertEquals(status, response.statusCode(), label)
        return response
    }

    private fun assertProblem(
        query: String,
        status: Int,
        method: String = "GET",
        reason: String? = null,
        headers: Map<String, String> = EVENT_STREAM,
    ) {
        val label = "$method stream$query $headers"
        val response = statusFirst(request(query, headers, method), status, label)
        assertEquals(status, response.statusCode(), label)
        val type = MediaType.parseMediaType(response.headers().firstValue("Content-Type").orElse("none/none"))
        assertEquals("application/problem+json", "${type.type}/${type.subtype}", label)
        val body = mapper.readTree(response.body().use { it.readAllBytes() })
        assertEquals(status, body["status"].intValue(), label)
        if (reason != null) {
            assertEquals("after", body["field"].stringValue(), label)
            assertEquals(reason, body["reason"].stringValue(), label)
        }
    }

    private fun awaitTrue(
        what: String,
        within: Duration,
        condition: () -> Boolean,
    ) {
        val deadline = System.nanoTime() + within.toNanos()
        while (!condition()) {
            if (System.nanoTime() > deadline) fail("not within $within: $what")
            Thread.sleep(5)
        }
    }

    @Test
    fun `T005-S1 a stream with no resume point sends the three headers and the connected frame, replays nothing, then the next post`() {
        postMany(3, "s1")
        val latest = store.snapshot().latestId
        Sse().use { sse ->
            val type = MediaType.parseMediaType(assertNotNull(sse.header("Content-Type")))
            assertEquals("text/event-stream", "${type.type}/${type.subtype}")
            assertEquals("no-store", sse.header("Cache-Control"))
            assertEquals("no", sse.header("X-Accel-Buffering"))
            sse.assertConnected()
            // Line breaks in the text stay inside the JSON string: the frame keeps exactly three lines.
            val sent = postMessage("s1\nsecond line\r\nthird")
            assertEquals(latest + 1, sent["id"].longValue())
            val frame = sse.next()
            assertMessage(frame, latest + 1)
            assertEquals(3, frame.lines.size, frame.toString())
            assertEquals(sent, mapper.readTree(frame.field("data")))
            assertEquals("s1\nsecond line\nthird", sent["text"].stringValue())
        }
    }

    @Test
    fun `T005-F1 a malformed or repeated after is a 400 problem, field after, reason malformed`() {
        val values =
            listOf(
                "abc",
                epoch,
                "$epoch.-1",
                "$epoch.x",
                "$epoch.01",
                "$epoch.9223372036854775808",
                "zzzzzzzz.1",
                "0123abc.1",
                "0123ABCD.1",
                // A line break could start a new SSE field if the value ever reached a frame.
                "$epoch.1%0D%0Aevent:x",
                // A full-width digit is not a digit of the form, first or later.
                "$epoch.%EF%BC%91",
                "$epoch.1%EF%BC%92",
            )
        for (value in values) assertProblem("?after=$value", 400, reason = "malformed")
        assertProblem("?after=$epoch.1&after=$epoch.2", 400, reason = "malformed")
        // A blank value does not hide a second one.
        assertProblem("?after=&after=$epoch.1", 400, reason = "malformed")
        assertProblem("?after=abc", 400, reason = "malformed", headers = emptyMap())
    }

    @Test
    fun `T005-F2 an Accept without text event-stream is 406, and POST is a 405 problem`() {
        val response = statusFirst(request("", mapOf("Accept" to "application/json")), 406, "Accept: application/json")
        response.body().close()
        assertEquals(406, response.statusCode())
        assertProblem("", 405, method = "POST", headers = emptyMap())
        // The Accept a stream client sends must not turn the problem into an event.
        assertProblem("", 405, method = "POST")
    }

    @Test
    fun `T005-S4 a Last-Event-ID of E 2 replays 3, 4 and 5, then live`() {
        val first = postMany(5, "s4")
        Sse(headers = EVENT_STREAM + ("Last-Event-ID" to "$epoch.${first + 1}")).use { sse ->
            sse.assertConnected()
            sse.assertReplays(first + 2..first + 4)
            sse.assertLiveNext()
        }
    }

    @Test
    fun `T005-S5 after=E 2 replays 3, 4 and 5, then live`() {
        val first = postMany(5, "s5")
        Sse("?after=$epoch.${first + 1}").use { sse ->
            sse.assertConnected()
            sse.assertReplays(first + 2..first + 4)
            sse.assertLiveNext()
        }
    }

    @Test
    fun `T005-S6 a parsing Last-Event-ID wins and after is not read, not even a malformed one`() {
        val first = postMany(5, "s6")
        val header = EVENT_STREAM + ("Last-Event-ID" to "$epoch.${first + 3}")
        for (query in listOf("?after=$epoch.$first", "?after=abc", "?after=$epoch.1&after=$epoch.2")) {
            // Each case posts one live message, so the replay runs to the newest id.
            val latest = store.snapshot().latestId
            Sse(query, header).use { sse ->
                sse.assertConnected()
                sse.assertReplays(first + 4..latest, query)
                sse.assertLiveNext(query)
            }
        }
    }

    @Test
    fun `T005-S7 a resume point at the latest id replays nothing, then live`() {
        postMany(2, "s7")
        Sse("?after=$epoch.${store.snapshot().latestId}").use { sse ->
            sse.assertConnected()
            sse.assertLiveNext()
        }
    }

    @Test
    fun `T005-S8 no Accept and Accept any are served, and a blank or bare after means live only`() {
        postMany(2, "s8")
        val cases = listOf("" to emptyMap(), "" to mapOf("Accept" to "*/*"), "?after=" to EVENT_STREAM, "?after" to EVENT_STREAM)
        for ((query, headers) in cases) {
            Sse(query, headers).use { sse ->
                sse.assertConnected()
                sse.assertLiveNext("$query $headers")
            }
        }
    }

    @Test
    fun `T005-F3 a malformed Last-Event-ID is ignored - live only alone, and after is used beside it`() {
        val first = postMany(3, "f3")
        for (value in listOf("abc", "$epoch.-1", "$epoch.01", "0123ABCD.1", "$epoch.9223372036854775808")) {
            val headers = EVENT_STREAM + ("Last-Event-ID" to value)
            Sse(headers = headers).use { sse ->
                sse.assertConnected()
                sse.assertLiveNext("header $value alone")
            }
            Sse("?after=$epoch.$first", headers).use { sse ->
                sse.assertConnected()
                sse.assertReplays(first + 1..first + 2, "header $value with after")
            }
        }
    }

    @Test
    fun `T005-F4 over HTTP a resume point of another epoch is a restart resync frame at the latest id, then only newer ids`() {
        postMany(5, "f4")
        for (seq in listOf(2L, 5L, 9L)) {
            val latest = store.snapshot().latestId
            Sse("?after=$other.$seq").use { sse ->
                sse.assertConnected()
                sse.assertResync("restart", latest, "R = X.$seq")
                sse.assertLiveNext("R = X.$seq")
            }
        }
    }

    @Test
    fun `T005-L1 over HTTP closing the connection releases its subscription within 1 s`() {
        // The cases before this one closed their streams. StreamJourneyScenarioTest (T-012) shares this context and
        // closes every stream it opens; no other class on it opens one.
        awaitTrue("no subscription left", Duration.ofSeconds(5)) { store.subscriberCount() == 0 }
        val sse = Sse()
        sse.assertConnected()
        // `:connected` is written just before the chain subscribes to the sink, so the count may lag by a moment.
        awaitTrue("one subscription", Duration.ofSeconds(1)) { store.subscriberCount() > 0 }
        assertEquals(1, store.subscriberCount())
        sse.close()
        awaitTrue("subscriberCount() back to 0", Duration.ofSeconds(1)) { store.subscriberCount() == 0 }
    }

    @Test
    fun `T005-P1 after a warm-up, ten subscribers all receive one post within 2 s`() {
        Sse().use { sse ->
            sse.assertConnected()
            sse.assertLiveNext("warm-up")
        }
        val subscribers = List(10) { Sse() }
        try {
            subscribers.forEach { it.assertConnected() }
            val started = System.nanoTime()
            val sent = postMessage("p1")["id"].longValue()
            // The structural check comes first: every subscriber gets the post, then the time is a backstop.
            subscribers.forEachIndexed { index, sse -> assertMessage(sse.next(), sent, "subscriber $index") }
            val elapsed = Duration.ofNanos(System.nanoTime() - started)
            assertTrue(elapsed < Duration.ofSeconds(2), "ten subscribers took $elapsed")
        } finally {
            subscribers.forEach(Sse::close)
        }
    }

    private companion object {
        val EVENT_STREAM = mapOf("Accept" to "text/event-stream")
    }
}
