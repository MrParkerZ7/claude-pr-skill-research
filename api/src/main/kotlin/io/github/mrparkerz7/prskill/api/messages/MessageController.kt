package io.github.mrparkerz7.prskill.api.messages

import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono

/** The body of `POST /api/messages`. [text] is `Any?` so that a non-string arrives as itself and gets its own reason. */
data class CreateMessageRequest(
    val text: Any? = null,
)

/**
 * `POST /api/messages` and `GET /api/messages` (SPEC-001 A and B). Both mappings produce JSON only, so a request that
 * cannot accept it is answered 406 before the handler runs and nothing is appended.
 */
@RestController
@RequestMapping("/api/messages")
class MessageController(
    private val store: MessageStore,
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
}
