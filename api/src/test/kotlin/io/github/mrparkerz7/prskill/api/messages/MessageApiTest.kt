package io.github.mrparkerz7.prskill.api.messages

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.io.ByteArrayInputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Instant
import kotlin.system.measureTimeMillis
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * SPEC-001 A and B over real HTTP. The context and its store are shared with the other test classes, so every case reads
 * the newest id first and asserts relative to it.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureWebTestClient
class MessageApiTest(
    @Autowired private val client: WebTestClient,
    @Autowired private val mapper: JsonMapper,
    @param:LocalServerPort private val port: Int,
) {
    private class Reply(
        val status: Int,
        val contentType: MediaType?,
        val body: JsonNode?,
    )

    private fun WebTestClient.ResponseSpec.reply(): Reply {
        val result = expectBody<String>().returnResult()
        val raw = result.responseBody
        val body = if (raw.isNullOrBlank()) null else mapper.readTree(raw)
        return Reply(result.status.value(), result.responseHeaders.contentType, body)
    }

    private fun post(
        body: String,
        contentType: MediaType = MediaType.APPLICATION_JSON,
        accept: MediaType? = null,
    ): Reply {
        val request = client.post().uri("/api/messages").contentType(contentType)
        if (accept != null) request.accept(accept)
        return request.bodyValue(body).exchange().reply()
    }

    private fun get(
        query: String = "",
        accept: MediaType? = null,
    ): Reply {
        val request = client.get().uri("/api/messages$query")
        if (accept != null) request.accept(accept)
        return request.exchange().reply()
    }

    private fun page(limit: Int = 100): JsonNode {
        val reply = get("?limit=$limit")
        assertEquals(200, reply.status)
        return requireNotNull(reply.body)
    }

    private fun json(text: String) = mapper.writeValueAsString(mapOf("text" to text))

    private fun send(text: String) = post(json(text))

    private fun created(reply: Reply): JsonNode {
        assertEquals(201, reply.status, reply.body.toString())
        return requireNotNull(reply.body)
    }

    private fun ids(page: JsonNode): List<Long> = page["messages"].values().map { it["id"].longValue() }

    private fun fill(count: Int) {
        while (page()["messages"].size() < count) created(send("fill"))
    }

    private fun assertProblem(
        reply: Reply,
        status: Int,
        label: String,
        field: String? = null,
        reason: String? = null,
    ) {
        assertEquals(status, reply.status, label)
        val type = assertNotNull(reply.contentType, label)
        assertEquals("application/problem+json", "${type.type}/${type.subtype}", label)
        val body = assertNotNull(reply.body, label)
        assertEquals(status, body["status"].intValue(), label)
        if (reason == null) assertNull(body["reason"], label) else assertEquals(reason, body["reason"].stringValue(), label)
        if (field == null) assertNull(body["field"], label) else assertEquals(field, body["field"].stringValue(), label)
    }

    /** A rejection leaves the store unchanged: same page, and the next valid post gets the next id (SPEC-001 A3). */
    private fun assertUnchanged(
        before: JsonNode,
        label: String,
    ) {
        assertEquals(before, page(), "$label: the store changed")
        val next = created(send("after $label"))
        assertEquals(before["latestId"].longValue() + 1, next["id"].longValue(), label)
    }

    private fun assertRejected(
        body: String,
        label: String,
        status: Int = 400,
        field: String? = "text",
        reason: String? = null,
        contentType: MediaType = MediaType.APPLICATION_JSON,
    ) {
        val before = page()
        assertProblem(post(body, contentType), status, label, field, reason)
        assertUnchanged(before, label)
    }

    private fun assertTextRejected(
        text: String,
        reason: String,
        label: String = reason,
    ) = assertRejected(json(text), label, reason = reason)

    private fun around(codePoint: Int) = "a${String(Character.toChars(codePoint))}b"

    @Test
    fun `T004-S1 a valid post is created with the next id, the epoch and a parsable createdAt`() {
        val before = page(1)
        val reply = send("hello")
        val message = created(reply)
        assertEquals("application/json", "${reply.contentType?.type}/${reply.contentType?.subtype}")
        assertEquals(before["latestId"].longValue() + 1, message["id"].longValue())
        assertEquals(before["epoch"].stringValue(), message["epoch"].stringValue())
        assertEquals("hello", message["text"].stringValue())
        val createdAt = message["createdAt"].stringValue()
        assertNotNull(Instant.parse(createdAt))
        assertTrue(Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$""").matches(createdAt), createdAt)
        assertEquals(setOf("id", "epoch", "text", "createdAt"), message.propertyNames().toSet())
    }

    @Test
    fun `T004-S2 the text is trimmed`() {
        assertEquals("hi", created(send("  hi  "))["text"].stringValue())
    }

    @Test
    fun `T004-S6 an absent, blank or bare limit lists the 20 newest`() {
        repeat(25) { created(send("s6-$it")) }
        for (query in listOf("", "?limit=", "?limit")) {
            val listed = requireNotNull(get(query).body)
            val latest = listed["latestId"].longValue()
            assertEquals((latest downTo latest - 19).toList(), ids(listed), "query '$query'")
        }
    }

    @Test
    fun `T004-B5 limit 1 lists the newest and limit 100 lists 100`() {
        fill(100)
        val one = page(1)
        assertEquals(listOf(one["latestId"].longValue()), ids(one))
        assertEquals(100, page(100)["messages"].size())
    }

    @Test
    fun `T004-S3 over HTTP a list names its epoch, its messages and the newest id from the same read`() {
        created(send("b1"))
        val listed = page(5)
        assertEquals(setOf("epoch", "messages", "latestId"), listed.propertyNames().toSet())
        assertEquals(listed["messages"][0]["id"].longValue(), listed["latestId"].longValue())
        assertTrue(Regex("^[0-9a-f]{8}$").matches(listed["epoch"].stringValue()))
    }

    @Test
    fun `T004-S7 unknown fields are ignored and the last duplicate key wins`() {
        assertEquals("hi", created(post("""{"text":"hi","extra":1}"""))["text"].stringValue())
        assertEquals("b", created(post("""{"text":"a","text":"b"}"""))["text"].stringValue())
    }

    @Test
    fun `T004-S8 line endings become newlines, tabs stay and a joiner sequence is stored`() {
        assertEquals("a\nb\tc", created(send("a\r\nb\tc"))["text"].stringValue())
        assertEquals("a\nb", created(send("a\rb"))["text"].stringValue())
        val womanTechnologist = "👩‍💻"
        assertEquals(womanTechnologist, created(send(womanTechnologist))["text"].stringValue())
    }

    @Test
    fun `T004-S9 the neighbours of the forbidden ranges are accepted`() {
        for (codePoint in listOf(0x0020, 0x00A0, 0x2029, 0x202F, 0x2065, 0x206A)) {
            assertEquals(around(codePoint), created(send(around(codePoint)))["text"].stringValue(), "U+%04X".format(codePoint))
        }
    }

    @Test
    fun `T004-F1 a blank text is rejected`() {
        assertTextRejected("", "blank", "empty")
        assertTextRejected("  \n\t ", "blank", "whitespace")
    }

    @Test
    fun `T004-F2 an absent or null text is missing`() {
        assertRejected("{}", "absent", reason = "missing")
        assertRejected("""{"text":null}""", "null", reason = "missing")
    }

    @Test
    fun `T004-F3 a text that is not a string is rejected`() {
        for (body in listOf("""{"text":123}""", """{"text":true}""", """{"text":{}}""", """{"text":[]}""")) {
            assertRejected(body, body, reason = "not_a_string")
        }
    }

    @Test
    fun `T004-F4 a malformed, empty or non-object body is a 400 without a reason`() {
        for (body in listOf("""{"text":""", "", "null", "\"hi\"", "[]")) {
            assertRejected(body, "body '$body'", field = null)
        }
    }

    @Test
    fun `T004-F5 a missing or non-JSON content type is a 415`() {
        assertRejected("""{"text":"x"}""", "text/plain", status = 415, field = null, contentType = MediaType.TEXT_PLAIN)
        val before = page()
        val request =
            HttpRequest
                .newBuilder(URI.create("http://localhost:$port/api/messages"))
                .POST(HttpRequest.BodyPublishers.ofString("""{"text":"x"}"""))
                .build()
        val response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString())
        assertEquals(415, response.statusCode())
        assertEquals("application/problem+json", response.headers().firstValue("Content-Type").orElse(""))
        assertEquals(415, mapper.readTree(response.body())["status"].intValue())
        assertUnchanged(before, "no content type")
    }

    @Test
    fun `T004-F6 a control character inside the text is rejected`() {
        for (codePoint in listOf(0x0000, 0x0007, 0x001F, 0x007F, 0x0080, 0x009F)) {
            assertTextRejected(around(codePoint), "control_character", "U+%04X".format(codePoint))
        }
    }

    @Test
    fun `T004-F7 a bidirectional control character is rejected`() {
        for (codePoint in listOf(0x202A, 0x202E, 0x2066, 0x2069)) {
            assertTextRejected(around(codePoint), "bidi_control", "U+%04X".format(codePoint))
        }
    }

    @Test
    fun `T004-F8 a surrogate that is not half of a pair is a control character, never a 5xx`() {
        assertRejected("""{"text":"\uD800"}""", "high surrogate", reason = "control_character")
        assertRejected("""{"text":"a\uDC00b"}""", "low surrogate", reason = "control_character")
    }

    @Test
    fun `T004-F9 PUT, PATCH and DELETE are 405, and a client that cannot take JSON gets 406`() {
        for (method in listOf(HttpMethod.PUT, HttpMethod.PATCH, HttpMethod.DELETE)) {
            val reply =
                client
                    .method(
                        method,
                    ).uri("/api/messages")
                    .contentType(MediaType.APPLICATION_JSON)
                    .bodyValue("{}")
                    .exchange()
                    .reply()
            assertProblem(reply, 405, method.name())
        }
        val before = page()
        assertEquals(406, post(json("x"), accept = MediaType.TEXT_HTML).status)
        assertUnchanged(before, "406")
        assertEquals(406, get(accept = MediaType.TEXT_HTML).status)
    }

    @Test
    fun `T004-F10 a limit outside 1 to 100 is out of range`() {
        for (limit in listOf("0", "101")) {
            val before = page()
            assertProblem(get("?limit=$limit"), 400, "limit=$limit", field = "limit", reason = "out_of_range")
            assertUnchanged(before, "limit=$limit")
        }
    }

    @Test
    fun `T004-F11 a limit that is not a whole number, or is repeated, is not an integer`() {
        val queries = listOf("-1", "%2B5", "abc", "1.5", "99999999999", "5&limit=7").map { "?limit=$it" } + "?limit&limit"
        for (query in queries) {
            val before = page()
            assertProblem(get(query), 400, query, field = "limit", reason = "not_an_integer")
            assertUnchanged(before, query)
        }
    }

    @Test
    fun `T004-B1 text of 1 and of 280 code points is accepted, also outside the BMP`() {
        assertEquals("x", created(send("x"))["text"].stringValue())
        val emoji = "😀".repeat(280)
        assertEquals(emoji, created(send(emoji))["text"].stringValue())
    }

    @Test
    fun `T004-B3 a text of 281 code points is too long, and the length is counted after the trim`() {
        assertTextRejected("x".repeat(281), "too_long")
        val core = "x".repeat(280)
        assertEquals(core, created(send("  $core  "))["text"].stringValue())
    }

    @Test
    fun `T004-B8 the trim strips U+001F at the edges`() {
        assertEquals("hi", created(send("hi\u001F"))["text"].stringValue())
        assertTextRejected("\u001F", "blank")
    }

    @Test
    fun `T004-B7 a body of exactly 16384 bytes is accepted and one byte more is a 413`() {
        val frame = """{"text":"hi","pad":""""

        fun body(bytes: Int) = frame + "x".repeat(bytes - frame.length - 2) + "\"}"
        assertEquals(16384, body(16384).toByteArray().size)
        assertEquals("hi", created(post(body(16384)))["text"].stringValue())
        assertRejected(body(16385), "16385 bytes", status = 413, field = null)
    }

    @Test
    fun `T004-B7 a chunked body over 16384 bytes is a 413 too`() {
        val before = page()
        val bytes = ("""{"text":"hi","pad":"""" + "x".repeat(20_000) + "\"}").toByteArray()
        val request =
            HttpRequest
                .newBuilder(URI.create("http://localhost:$port/api/messages"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofInputStream { ByteArrayInputStream(bytes) })
                .build()
        val response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString())
        assertEquals(413, response.statusCode())
        assertEquals("application/problem+json", response.headers().firstValue("Content-Type").orElse(""))
        assertEquals(413, mapper.readTree(response.body())["status"].intValue())
        assertUnchanged(before, "chunked 16 KB+")
    }

    @Test
    fun `T004-P1 after 20 warm-up posts, 200 more all succeed within 20 seconds`() {
        repeat(20) { created(send("warm-$it")) }
        val elapsed = measureTimeMillis { repeat(200) { created(send("timed-$it")) } }
        assertTrue(elapsed < 20_000, "200 posts took $elapsed ms")
    }
}
