package io.github.mrparkerz7.prskill.api.messages.scenario

import io.github.mrparkerz7.prskill.api.messages.MessageStore
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.springframework.http.MediaType
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.random.Random
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The only seed of this class, used by the model-based run. */
private const val SEED = 20261109L

/** What the fixed clock writes into every `createdAt`. */
private const val CREATED = "2026-11-06T10:15:30.000Z"

/**
 * T-011: SPEC-001 A (posting) and B (listing) as scenarios, each on its own boot. `@DirtiesContext` after every method
 * gives each case a fresh store (ids from 1), and the clock is fixed, so every expected body is exact. The nested
 * configuration gives this class its own context, so no other test class shares (or dirties) these contexts.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureWebTestClient
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
class MessagesPostListScenarioTest(
    @Autowired private val client: WebTestClient,
    @Autowired private val mapper: JsonMapper,
    @Autowired private val store: MessageStore,
) {
    @TestConfiguration(proxyBeanMethods = false)
    class FixedClock {
        @Bean
        @Primary
        fun scenarioClock(): Clock = Clock.fixed(Instant.parse("2026-11-06T10:15:30Z"), ZoneOffset.UTC)
    }

    /** The epoch of this boot. */
    private val epoch: String get() = store.epoch

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

    private fun postBytes(bytes: ByteArray): Reply =
        client
            .post()
            .uri("/api/messages")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(bytes)
            .exchange()
            .reply()

    private fun put(body: String): Reply =
        client
            .put()
            .uri("/api/messages")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(body)
            .exchange()
            .reply()

    private fun get(query: String = ""): Reply =
        client
            .get()
            .uri("/api/messages$query")
            .exchange()
            .reply()

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

    private fun json(text: String) = mapper.writeValueAsString(mapOf("text" to text))

    /** A body that is a valid post plus one unknown member of the given content, for the size cases. */
    private fun padded(pad: String) = """{"text":"hi","pad":"$pad"}"""

    private fun around(codePoint: Int) = "a" + String(Character.toChars(codePoint)) + "b"

    /** Every expected node is parsed from JSON text: a reply holds `IntNode`s, which are not equal to `LongNode`s. */
    private fun message(
        id: Long,
        text: String,
    ): JsonNode = mapper.readTree("""{"id":$id,"epoch":"$epoch","text":"$text","createdAt":"$CREATED"}""")

    private fun emptyPage(): JsonNode = mapper.readTree("""{"epoch":"$epoch","messages":[],"latestId":0}""")

    private fun assertCreated(
        reply: Reply,
        id: Long,
        text: String,
        label: String = "",
    ) {
        assertEquals(201, reply.status, label)
        assertEquals(message(id, text), reply.body, label)
    }

    private fun list(
        query: String,
        label: String = "",
    ): JsonNode {
        val reply = get(query)
        assertEquals(200, reply.status, label)
        return assertNotNull(reply.body, label)
    }

    private fun ids(page: JsonNode): List<Long> = page["messages"].values().map { it["id"].longValue() }

    /** The store is empty: its list is exact, and the next post gets id 1. */
    private fun assertStillEmpty() {
        assertEquals(emptyPage(), list(""))
        assertCreated(post(json("after")), 1, "after")
    }

    // serves-spec: SPEC-001 #B1 · Required-Success
    @Test
    fun `SC-messages-RB1-S1 an empty store over HTTP`() {
        val reply = get()
        assertEquals(200, reply.status)
        assertEquals("application/json", "${reply.contentType?.type}/${reply.contentType?.subtype}")
        assertEquals(emptyPage(), reply.body)
        assertTrue(Regex("^[0-9a-f]{8}$").matches(epoch), "epoch $epoch")
    }

    // serves-spec: SPEC-001 #A3 · Required-Fail
    @Test
    fun `SC-messages-RA3-T1 EMPTY × rejected post`() {
        assertProblem(post("""{"text":""}"""), 400, "blank", "text", "blank")
        assertEquals(emptyPage(), list(""))
        assertCreated(post(json("first")), 1, "first")
    }

    // serves-spec: SPEC-001 #A3 · Required-Fail
    @Test
    fun `SC-messages-RA3-T2 PARTIAL × rejected post`() {
        for (id in 1L..3L) assertCreated(post(json("m$id")), id, "m$id")
        val before = list("?limit=100")
        assertEquals(listOf(3L, 2L, 1L), ids(before))
        assertEquals(3L, before["latestId"].longValue())
        assertProblem(post(json("x".repeat(281))), 400, "281 code points", "text", "too_long")
        assertEquals(before, list("?limit=100"))
        assertCreated(post(json("m4")), 4, "m4")
    }

    // serves-spec: SPEC-001 #A3 · Required-Fail
    @Test
    fun `SC-messages-RA3-T3 FULL × rejected post, then the first eviction`() {
        for (id in 1L..100L) assertCreated(post(json("fill")), id, "fill", "post $id")
        val before = list("?limit=100")
        assertEquals((100L downTo 1L).toList(), ids(before))
        assertEquals(100L, before["latestId"].longValue())
        assertTrue(before["messages"].values().all { it["text"].stringValue() == "fill" }, "every listed text is fill")
        assertProblem(post(json(around(0x0007))), 400, "a control character", "text", "control_character")
        assertEquals(before, list("?limit=100"), "the rejection evicted nothing")
        assertCreated(post(json("m101")), 101, "m101")
        val after = list("?limit=100")
        assertEquals((101L downTo 2L).toList(), ids(after))
        assertEquals(101L, after["latestId"].longValue())
    }

    // serves-spec: SPEC-001 #A1 · Boundary
    @Test
    fun `SC-messages-RA1-B1 16383 bytes are accepted`() {
        val body = padded("x".repeat(16361))
        assertEquals(16383, body.toByteArray().size)
        assertCreated(post(body), 1, "hi")
    }

    // serves-spec: SPEC-001 #A4 · Required-Fail
    @Test
    fun `SC-messages-RA4-F1 the limit counts bytes, not characters`() {
        val ko = String(Character.toChars(0x0E01))
        val body = padded(ko.repeat(5454) + "x")
        val bytes = body.toByteArray(Charsets.UTF_8)
        assertEquals(16385, bytes.size)
        assertEquals(5477, body.length)
        assertProblem(postBytes(bytes), 413, "16385 bytes in 5477 characters")
        assertStillEmpty()
    }

    // serves-spec: SPEC-001 #A4 · Required-Fail
    @Test
    fun `SC-messages-RA4-D1 over the limit and too long, the size answers`() {
        val body = json("x".repeat(16400))
        assertEquals(16411, body.toByteArray().size)
        assertProblem(post(body), 413, "over the limit and too long")
        assertStillEmpty()
    }

    // serves-spec: SPEC-001 #A5 · Optional-Fail
    @Test
    fun `SC-messages-RA5-OF1 only unknown keys, one a near-miss of text`() {
        assertProblem(post("""{"Text":"hi","message":"hi"}"""), 400, "only unknown keys", "text", "missing")
        assertStillEmpty()
    }

    /** One step of the model-based run: it checks one reply, and the model says what the store then holds. */
    private class Op(
        val label: String,
        val step: (Model, String) -> Unit,
    )

    /** The model: the next id and the ids the store keeps, oldest first, at most 100. */
    private class Model {
        var nextId = 1L
        val kept = ArrayDeque<Long>()
    }

    /** What a list with this limit must say: the newest [limit] kept ids, newest first, and the newest id (0 when empty). */
    private fun modelPage(
        model: Model,
        limit: Int,
    ): JsonNode {
        val messages =
            model.kept
                .takeLast(limit)
                .reversed()
                .joinToString(",") { """{"id":$it,"epoch":"$epoch","text":"p$it","createdAt":"$CREATED"}""" }
        return mapper.readTree("""{"epoch":"$epoch","messages":[$messages],"latestId":${model.kept.lastOrNull() ?: 0}}""")
    }

    /** Two ops that send something the API rejects and then check that the whole list is still the model's. */
    private fun rejection(
        label: String,
        status: Int,
        field: String?,
        reason: String?,
        send: () -> Reply,
    ): List<Op> =
        List(2) {
            Op(label) { model, at ->
                assertProblem(send(), status, at, field, reason)
                assertEquals(modelPage(model, 100), list("?limit=100", at), at)
            }
        }

    private fun validReads(): List<Op> =
        listOf(
            "" to 20,
            "?limit=" to 20,
            "?limit" to 20,
            "?limit=1" to 1,
            "?limit=2" to 2,
            "?limit=20" to 20,
            "?limit=99" to 99,
            "?limit=100" to 100,
        ).flatMap { (query, limit) ->
            List(
                4,
            ) { Op("GET ${query.ifEmpty { "(no query)" }}") { model, at -> assertEquals(modelPage(model, limit), list(query, at), at) } }
        }

    private fun invalidReads(): List<Op> =
        listOf("?limit=0" to "out_of_range", "?limit=101" to "out_of_range", "?limit=abc" to "not_an_integer")
            .flatMap { (query, reason) ->
                List(4) {
                    Op("GET $query") { model, at ->
                        assertProblem(get(query), 400, at, "limit", reason)
                        assertEquals(modelPage(model, 100), list("?limit=100", at), at)
                    }
                }
            }

    // serves-spec: SPEC-001 #B4 · Required-Success
    @Test
    fun `SC-messages-RB4-S1 a seeded model-based run (property)`() {
        val valid =
            List(130) {
                Op("VALID") { model, at ->
                    val id = model.nextId
                    assertCreated(post(json("p$id")), id, "p$id", at)
                    model.kept.addLast(id)
                    if (model.kept.size > 100) model.kept.removeFirst()
                    model.nextId++
                }
            }
        val oversize = padded("x".repeat(16363))
        assertEquals(16385, oversize.toByteArray().size, "R9 is one byte over the limit")
        val rejections =
            rejection("R1", 400, "text", "blank") { post("""{"text":""}""") } +
                rejection("R2", 400, "text", "missing") { post("{}") } +
                rejection("R3", 400, "text", "not_a_string") { post("""{"text":7}""") } +
                rejection("R4", 400, "text", "bidi_control") { post(json(around(0x202E))) } +
                rejection("R5", 400, "text", "control_character") { post(json(around(0x0007))) } +
                rejection("R6", 400, "text", "too_long") { post(json("x".repeat(281))) } +
                rejection("R7", 400, null, null) { post("[]") } +
                rejection("R8", 415, null, null) { post("""{"text":"ok"}""", MediaType.TEXT_PLAIN) } +
                rejection("R9", 413, null, null) { post(oversize) } +
                rejection("R10", 405, null, null) { put("""{"text":"ok"}""") }
        val notAcceptable =
            List(2) {
                Op("R11") { model, at ->
                    assertEquals(406, post(json("ok"), accept = MediaType.TEXT_HTML).status, at)
                    assertEquals(modelPage(model, 100), list("?limit=100", at), at)
                }
            }
        val ops = (valid + rejections + notAcceptable + validReads() + invalidReads()).shuffled(Random(SEED))
        assertEquals(196, ops.size)

        val model = Model()
        ops.forEachIndexed { index, op -> op.step(model, "seed $SEED, op $index (${op.label})") }

        val end = "seed $SEED, after the last op"
        val last = list("?limit=100", end)
        assertEquals((130L downTo 31L).toList(), ids(last), end)
        assertEquals(130L, last["latestId"].longValue(), end)
        assertCreated(post(json("final")), 131, "final", end)
    }
}
