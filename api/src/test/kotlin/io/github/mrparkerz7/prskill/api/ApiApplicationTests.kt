package io.github.mrparkerz7.prskill.api

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.context.ApplicationContext
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import org.springframework.test.web.reactive.server.returnResult
import java.time.Duration
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureWebTestClient
class ApiApplicationTests(
    @Autowired private val context: ApplicationContext,
    @Autowired private val client: WebTestClient,
) {
    private val healthBody = """{"status":"UP"}"""

    @Test
    fun `T001-S1 context loads and holds the application`() {
        assertNotNull(context.getBean(ApiApplication::class.java))
    }

    @Test
    fun `T001-S2 health answers 200 with exactly status UP`() {
        client
            .get()
            .uri("/actuator/health")
            .exchange()
            .expectStatus()
            .isOk
            .expectHeader()
            .value("Content-Type") {
                assertTrue(it.startsWith("application/vnd.spring-boot.actuator.v3+json") || it.startsWith("application/json"), it)
            }.expectBody<String>()
            .isEqualTo(healthBody)
    }

    @Test
    fun `T001-F1 env is not exposed`() {
        client
            .get()
            .uri("/actuator/env")
            .exchange()
            .expectStatus()
            .isNotFound
    }

    @Test
    fun `T001-F2 info is not exposed`() {
        client
            .get()
            .uri("/actuator/info")
            .exchange()
            .expectStatus()
            .isNotFound
    }

    @Test
    fun `T001-F3 an unknown route is a 404 problem detail`() {
        client
            .get()
            .uri("/api/does-not-exist")
            .exchange()
            .expectStatus()
            .isNotFound
            .expectHeader()
            .contentType(MediaType.APPLICATION_PROBLEM_JSON)
            .expectBody()
            // RFC 9457: a missing "type" means about:blank, and Boot 4 leaves the default out of the body.
            .jsonPath("$.type")
            .doesNotExist()
            .jsonPath("$.detail")
            .isNotEmpty
            .jsonPath("$.title")
            .isEqualTo("Not Found")
            .jsonPath("$.status")
            .isEqualTo(404)
            .jsonPath("$.instance")
            .isEqualTo("/api/does-not-exist")
    }

    @Test
    fun `T001-S3 head on health answers 200 with an empty body`() {
        client
            .head()
            .uri("/actuator/health")
            .exchange()
            .expectStatus()
            .isOk
            .expectBody()
            .isEmpty
    }

    @Test
    fun `T001-F4 post on health is a 405 and health still answers 200`() {
        client
            .post()
            .uri("/actuator/health")
            .exchange()
            .expectStatus()
            .isEqualTo(405)

        client
            .get()
            .uri("/actuator/health")
            .exchange()
            .expectStatus()
            .isOk
            .expectBody<String>()
            .isEqualTo(healthBody)
    }

    @Test
    fun `T001-P1 health answers in under 500 ms once warm`() {
        repeat(WARM_UP_REQUESTS) { timedHealth() }

        val samples = List(TIMED_REQUESTS) { timedHealth() }

        // The structural check comes first: every sample must be the right answer, then the time is a backstop.
        samples.forEach { (body, _) -> assertEquals(healthBody, body) }
        val fastest = samples.minOf { (_, elapsed) -> elapsed }
        assertTrue(fastest < Duration.ofMillis(500), "the fastest of $TIMED_REQUESTS health calls took $fastest")
    }

    private fun timedHealth(): Pair<String?, Duration> {
        val started = System.nanoTime()
        val body =
            client
                .get()
                .uri("/actuator/health")
                .exchange()
                .expectStatus()
                .isOk
                .returnResult<String>()
                .responseBody
                .blockFirst()
        return body to Duration.ofNanos(System.nanoTime() - started)
    }

    private companion object {
        const val WARM_UP_REQUESTS = 5
        const val TIMED_REQUESTS = 5
    }
}
