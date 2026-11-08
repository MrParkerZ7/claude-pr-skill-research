package io.github.mrparkerz7.prskill.api.web

import io.github.mrparkerz7.prskill.api.messages.InvalidRequestException
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ProblemDetail
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.reactive.result.method.annotation.ResponseEntityExceptionHandler
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono

/**
 * Turns a value that failed a check into the 400 problem of SPEC-001 A3 and B3. Everything else keeps Spring's problem
 * body: this class extends the handler that renders it, so the standard exceptions (405, 406, 415, a malformed body and
 * a body over the codec limit, which Spring itself answers 413) are still handled, with `application/problem+json`.
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
}
