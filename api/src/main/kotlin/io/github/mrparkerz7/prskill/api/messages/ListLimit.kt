package io.github.mrparkerz7.prskill.api.messages

/** The `limit` query parameter of `GET /api/messages` (SPEC-001 B2 and B3). */
object ListLimit {
    const val DEFAULT = 20
    const val MAX = 100

    private const val FIELD = "limit"
    private val DIGITS = Regex("[0-9]+")

    /**
     * [values] are the raw values of the parameter. Absent, or one blank value, means [DEFAULT]; so does a bare `?limit`,
     * which Spring reports as one null value. More than one value, anything but digits, or a number that does not fit an
     * `Int` is `not_an_integer`; outside 1..[MAX] is `out_of_range`.
     */
    fun parse(values: List<String?>?): Int {
        if (values.isNullOrEmpty()) return DEFAULT
        if (values.size > 1) notAnInteger()
        val value = values.single().orEmpty()
        if (value.isBlank()) return DEFAULT
        if (!DIGITS.matches(value)) notAnInteger()
        val limit = value.toIntOrNull() ?: notAnInteger()
        if (limit !in 1..MAX) {
            throw InvalidRequestException(FIELD, "out_of_range", "limit must be a whole number from 1 to $MAX.")
        }
        return limit
    }

    private fun notAnInteger(): Nothing =
        throw InvalidRequestException(FIELD, "not_an_integer", "limit must be a whole number from 1 to $MAX.")
}
