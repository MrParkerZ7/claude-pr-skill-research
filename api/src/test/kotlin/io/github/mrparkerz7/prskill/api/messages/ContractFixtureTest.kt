package io.github.mrparkerz7.prskill.api.messages

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import kotlin.test.assertEquals

/**
 * `contracts/messages/` holds the shapes the web app reads (T-006). Each fixture must survive a trip through the API's
 * own types unchanged, and a real error response must have the problem fixture's members. The Gradle test working
 * directory is `api/`.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureWebTestClient
class ContractFixtureTest(
    @Autowired private val client: WebTestClient,
    @Autowired private val mapper: JsonMapper,
) {
    private fun fixture(name: String): JsonNode = mapper.readTree(Files.readString(Path.of("..", "contracts", "messages", name)))

    private inline fun <reified T : Any> assertRoundTrip(name: String) {
        val expected = fixture(name)
        val actual = mapper.readTree(mapper.writeValueAsString(mapper.treeToValue(expected, T::class.java)))
        assertEquals(expected, actual, name)
    }

    @Test
    fun `T004-K1 the message and list fixtures deserialize and serialize to the same JSON`() {
        assertRoundTrip<Message>("message.json")
        assertRoundTrip<MessagePage>("message-list.json")
    }

    @Test
    fun `T004-S1 createdAt is written with three fraction digits, also when the millisecond is 0`() {
        val message = Message(1, "0123abcd", "x", Instant.parse("2026-11-06T10:15:30Z"))
        assertEquals("2026-11-06T10:15:30.000Z", mapper.readTree(mapper.writeValueAsString(message))["createdAt"].stringValue())
    }

    @Test
    fun `T004-K1 a real blank-text response has the members of the problem fixture`() {
        val result =
            client
                .post()
                .uri("/api/messages")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue("""{"text":""}""")
                .exchange()
                .expectStatus()
                .isBadRequest
                .expectBody<String>()
                .returnResult()
        val actual = mapper.readTree(requireNotNull(result.responseBody))
        assertEquals(fixture("problem-invalid-request.json"), actual)
    }
}
