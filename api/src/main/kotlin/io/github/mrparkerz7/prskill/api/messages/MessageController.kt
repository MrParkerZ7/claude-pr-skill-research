package io.github.mrparkerz7.prskill.api.messages

import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.codec.ServerSentEvent
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Flux
import reactor.core.publisher.Mono

/** The body of `POST /api/messages`. [text] is `Any?` so that a non-string arrives as itself and gets its own reason. */
data class CreateMessageRequest(
    val text: Any? = null,
)

/**
 * `POST /api/messages` and `GET /api/messages` (SPEC-001 A and B), and `GET /api/messages/stream` (SPEC-001 C). Each
 * mapping produces one type only (JSON, or `text/event-stream` for the stream), so a request that cannot accept it is
 * answered 406 before the handler runs and nothing is appended.
 */
@RestController
@RequestMapping("/api/messages")
class MessageController(
    private val store: MessageStore,
    private val stream: MessageStream,
) {
    @PostMapping(produces = [MediaType.APPLICATION_JSON_VALUE])
    @ResponseStatus(HttpStatus.CREATED)
    fun create(
        @RequestBody request: CreateMessageRequest,
    ): Mono<Message> = Mono.fromCallable { store.append(MessageText.parse(request.text)) }

    /** The raw `limit` values are read from the query, so a repeated or comma-joined value is not converted away. */
    @GetMapping(produces = [MediaType.APPLICATION_JSON_VALUE])
    fun list(exchange: ServerWebExchange): Mono<MessagePage> =
        Mono.fromCallable { store.page(ListLimit.parse(exchange.request.queryParams["limit"])) }

    /**
     * The resume point is resolved before the response starts, from `Last-Event-ID` or else the raw `after` values, so
     * a malformed `after` is a 400 problem. The first frame is `retry` and the `:connected` comment; the response is
     * never cached, and a buffering proxy (nginx) is told not to hold it.
     */
    @GetMapping("/stream", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    fun stream(exchange: ServerWebExchange): Flux<ServerSentEvent<Any>> {
        val request = exchange.request
        val resumePoint = ResumePoint.resolve(request.headers.getFirst(ResumePoint.LAST_EVENT_ID), request.queryParams["after"])
        exchange.response.headers.apply {
            cacheControl = "no-store"
            set(ACCEL_BUFFERING, "no")
        }
        val connected =
            ServerSentEvent
                .builder<Any>()
                .comment("connected")
                .retry(stream.settings.retry)
                .build()
        return stream.stream(resumePoint).map(::toServerSentEvent).startWith(connected)
    }

    private companion object {
        const val ACCEL_BUFFERING = "X-Accel-Buffering"
    }
}
