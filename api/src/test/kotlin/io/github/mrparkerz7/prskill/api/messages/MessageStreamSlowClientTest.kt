package io.github.mrparkerz7.prskill.api.messages

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.io.BufferedReader
import java.io.InputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * SPEC-001 C7 over a real socket: a client that stops reading is cut off, its subscription is released, and a reconnect
 * carries on from the last id it saw. `MessageStreamTest` and `StreamLifecycleScenarioTest` prove the cut-off on the
 * operator chain with a subscriber that requests nothing; this is the one case where the demand has to come back
 * through the server's socket. It posts messages of the longest text until the transport's buffers and the stream's
 * bound are full, which would swell the list every other class reads from a shared store, so the nested configuration
 * gives it a context and a store of its own (as `MessagesPostListScenarioTest` does).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureWebTestClient
class MessageStreamSlowClientTest(
    @Autowired private val client: WebTestClient,
    @Autowired private val mapper: JsonMapper,
    @Autowired private val store: MessageStore,
    @param:LocalServerPort private val port: Int,
) {
    /** A heartbeat that never falls due, so every frame read here is a message, a resync or the cut-off comment. */
    @TestConfiguration(proxyBeanMethods = false)
    class NoHeartbeat {
        @Bean
        @Primary
        fun quietStreamSettings(): StreamSettings = StreamSettings(heartbeat = Duration.ofHours(1))
    }

    private val http: HttpClient = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()

    @Test
    fun `T005-L2 over HTTP a client that stops reading is cut off, its subscription released, and a reconnect carries on`() {
        // The response is held and nothing is read from its socket, as a client that has stalled.
        val slow = open(emptyMap())
        try {
            // `:connected` is written just before the chain subscribes to the sink, so the count may lag by a moment.
            awaitSubscribers(1)
            val text = "x".repeat(MessageText.MAX_CODE_POINTS)
            val deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos()
            var posts = 0
            // The transport's buffers fill first and the stream's bound after them, so this ends when the demand has come
            // back through the server's socket and the stream was cut off; the client has still read nothing.
            while (store.subscriberCount() != 0) {
                if (System.nanoTime() > deadline) fail("the stream was not cut off after $posts posts of ${text.length} characters")
                postMessage(text)
                posts++
            }

            // Now the client reads what the server managed to send: every message in order, the cut-off comment, the end.
            val frames = within { slow.body().bufferedReader(Charsets.UTF_8).frames(Int.MAX_VALUE) }
            assertEquals(listOf(":overflow"), frames.last(), "the last frame, of ${frames.size}")
            val messages = frames.filter { it.field("event") == "message" }
            val ids = messages.map { it.dataId() }
            assertTrue(ids.size > MessageStore.CAPACITY, "only ${ids.size} messages were delivered before the cut-off")
            assertEquals((ids.first()..ids.last()).toList(), ids, "a message was skipped before the cut-off")

            // Its last id is where it carries on: the retained messages after it, or a gap resync when more than the store
            // keeps went by while it was cut off, and then the live ones.
            val last = ids.last()
            val newest = store.snapshot().latestId
            val replayed = newest - last <= MessageStore.CAPACITY
            val again = open(mapOf("Last-Event-ID" to messages.last().field("id").orEmpty()))
            try {
                val reader = again.body().bufferedReader(Charsets.UTF_8)
                val head = within { reader.frames(if (replayed) 1 + (newest - last).toInt() else 2) }
                assertEquals(setOf("retry:3000", ":connected"), head.first().toSet())
                if (replayed) {
                    head.drop(1).forEachIndexed { index, frame ->
                        assertEquals("${store.epoch}.${last + 1 + index}", frame.field("id"), "resume after $last: $frame")
                        assertEquals("message", frame.field("event"), "resume after $last: $frame")
                    }
                } else {
                    val resync = head[1]
                    assertEquals("${store.epoch}.$newest", resync.field("id"), "resume after $last: $resync")
                    assertEquals("resync", resync.field("event"), "resume after $last: $resync")
                    val expected = mapper.readTree("""{"reason":"gap","epoch":"${store.epoch}","latestId":$newest}""")
                    assertEquals(expected, mapper.readTree(resync.field("data")), "resume after $last")
                }
                val sent = postMessage("live")
                assertEquals(sent["id"].longValue(), within { reader.frames(1) }.single().dataId(), "the live post after resuming")
            } finally {
                again.body().close()
            }
        } finally {
            slow.body().close()
        }
    }

    private fun open(headers: Map<String, String>): HttpResponse<InputStream> {
        val builder =
            HttpRequest
                .newBuilder(URI.create("http://localhost:$port/api/messages/stream"))
                .timeout(Duration.ofSeconds(10))
                .header("Accept", "text/event-stream")
        headers.forEach { (name, value) -> builder.header(name, value) }
        val response = http.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream())
        if (response.statusCode() != 200) response.body().close()
        assertEquals(200, response.statusCode(), "GET stream $headers")
        return response
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

    private fun awaitSubscribers(count: Int) {
        val deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos()
        while (store.subscriberCount() != count) {
            if (System.nanoTime() > deadline) fail("subscriberCount() is ${store.subscriberCount()}, not $count")
            Thread.sleep(5)
        }
    }

    /** A read that never ends fails the case in 10 s instead of blocking it. */
    private fun <T> within(read: () -> T): T = CompletableFuture.supplyAsync(read).get(10, TimeUnit.SECONDS)

    /** The next [count] frames (each a list of lines, without the blank line that ends it), or all of them to the end. */
    private fun BufferedReader.frames(count: Int): List<List<String>> {
        val frames = mutableListOf<List<String>>()
        val frame = mutableListOf<String>()
        while (frames.size < count) {
            val line = readLine() ?: break
            if (line.isNotEmpty()) {
                frame += line
            } else {
                frames += frame.toList()
                frame.clear()
            }
        }
        return frames
    }

    private fun List<String>.field(name: String): String? = firstOrNull { it.startsWith("$name:") }?.substringAfter(':')

    private fun List<String>.dataId(): Long = mapper.readTree(field("data"))["id"].longValue()
}
