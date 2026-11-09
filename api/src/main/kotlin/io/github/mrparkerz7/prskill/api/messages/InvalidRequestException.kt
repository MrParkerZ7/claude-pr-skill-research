package io.github.mrparkerz7.prskill.api.messages

/**
 * A request value that failed a check. `ProblemAdvice` turns it into the 400 problem of SPEC-001 A3 and B3, with
 * [field] and [reason] as extra members. It is an expected outcome of bad input, so it carries no stack trace.
 */
class InvalidRequestException(
    val field: String,
    val reason: String,
    val detail: String,
) : RuntimeException(detail, null, false, false)
