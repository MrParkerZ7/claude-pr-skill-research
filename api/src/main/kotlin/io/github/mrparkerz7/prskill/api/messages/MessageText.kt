package io.github.mrparkerz7.prskill.api.messages

/**
 * A message text that passed SPEC-001 A2 and A3. Bean Validation is not used, because its `@Size` counts UTF-16 units
 * and the limit is in code points. A value class's getter is never called from Kotlin, so the text is read with
 * [toString], which is the checked text.
 */
@JvmInline
value class MessageText private constructor(
    private val value: String,
) {
    override fun toString(): String = value

    companion object {
        const val MAX_CODE_POINTS = 280

        private const val FIELD = "text"
        private const val RANGE = "Message text must be 1 to $MAX_CODE_POINTS characters."

        /**
         * Checks [raw] in A3's order, so the first failing check gives the reason: `missing`, `not_a_string`, `blank`,
         * `bidi_control`, `control_character`, `too_long`. Line endings become `\n` and the text is trimmed before the
         * checks that follow `not_a_string`.
         */
        fun parse(raw: Any?): MessageText {
            val text =
                when (raw) {
                    null -> reject("missing", RANGE)
                    is String -> raw
                    else -> reject("not_a_string", "Message text must be a string.")
                }
            val normalized = text.replace("\r\n", "\n").replace('\r', '\n').trim()
            if (normalized.isEmpty()) reject("blank", RANGE)
            val codePoints = normalized.codePoints().toArray()
            if (codePoints.any(::isBidiControl)) {
                reject("bidi_control", "Message text must not contain bidirectional control characters.")
            }
            if (codePoints.any(::isForbiddenControl)) {
                reject("control_character", "Message text must not contain control characters.")
            }
            if (codePoints.size > MAX_CODE_POINTS) reject("too_long", RANGE)
            return MessageText(normalized)
        }

        private fun reject(
            reason: String,
            detail: String,
        ): Nothing = throw InvalidRequestException(FIELD, reason, detail)

        private fun isBidiControl(codePoint: Int) = codePoint in 0x202A..0x202E || codePoint in 0x2066..0x2069

        /** A Unicode Cc code point other than `\n` and `\t`, or a surrogate that is not half of a pair. */
        private fun isForbiddenControl(codePoint: Int) =
            (Character.isISOControl(codePoint) && codePoint != '\n'.code && codePoint != '\t'.code) ||
                codePoint in 0xD800..0xDFFF
    }
}
