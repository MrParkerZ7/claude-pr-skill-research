package io.github.mrparkerz7.prskill.api.web

import io.github.mrparkerz7.prskill.api.messages.InvalidRequestException
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import org.springframework.http.MediaType
import org.springframework.http.ProblemDetail
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.reactive.result.method.annotation.ResponseEntityExceptionHandler
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono

/**
 * Turns a value that failed a check into the 400 problem of SPEC-001 A3, B3 and C4. Everything else keeps Spring's
 * problem body: this class extends the handler that renders it, so the standard exceptions (405, 406, 415, a malformed
 * body and a body over the codec limit, which Spring itself answers 413) are still handled, with
 * `application/problem+json`.
 */
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
class ProblemAdvice : ResponseEntityExceptionHandler() {
    /** 400 with `title` "Invalid request", and the failed `field` and its `reason` as extra members. */
    @ExceptionHandler(InvalidRequestException::class)
    fun handleInvalidRequest(
        ex: InvalidRequestException,
        exchange: ServerWebExchange,
    ): Mono<ResponseEntity<Any>> {
        val problem = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, ex.detail)
        problem.title = "Invalid request"
        problem.setProperty("field", ex.field)
        problem.setProperty("reason", ex.reason)
        return handleExceptionInternal(ex, problem, HttpHeaders.EMPTY, HttpStatus.BAD_REQUEST, exchange)
    }

    /**
     * Every problem this advice answers is `application/problem+json`. The type is set, not negotiated: a stream client
     * sends `Accept: text/event-stream`, and Spring's SSE writer accepts any object, so it would otherwise send the
     * problem as an event (the 400 `after` problem and the 405 of `/api/messages/stream`). For any other `Accept`,
     * Spring already falls back to this type.
     */
    override fun createResponseEntity(
        body: Any?,
        headers: HttpHeaders?,
        status: HttpStatusCode,
        exchange: ServerWebExchange,
    ): Mono<ResponseEntity<Any>> =
        Mono.just(
            ResponseEntity
                .status(status)
                .headers(headers)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(body),
        )
}
