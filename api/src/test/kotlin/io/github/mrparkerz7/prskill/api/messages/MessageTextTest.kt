package io.github.mrparkerz7.prskill.api.messages

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class MessageTextTest {
    private fun reasonOf(raw: Any?): String {
        val failure = assertFailsWith<InvalidRequestException> { MessageText.parse(raw) }
        assertEquals("text", failure.field)
        return failure.reason
    }

    private fun accepted(raw: String): String = MessageText.parse(raw).toString()

    private fun around(codePoint: Int) = "a${String(Character.toChars(codePoint))}b"

    @Test
    fun `T004-S2 the text is trimmed`() {
        assertEquals("hi", accepted("  hi  "))
    }

    @Test
    fun `T004-S8 line endings become newlines, tabs stay and a joiner sequence is accepted`() {
        assertEquals("a\nb\tc", accepted("a\r\nb\tc"))
        assertEquals("a\nb", accepted("a\rb"))
        val womanTechnologist = "👩‍💻"
        assertEquals(womanTechnologist, accepted(womanTechnologist))
    }

    @Test
    fun `T004-S9 the neighbours of the forbidden ranges are accepted`() {
        for (codePoint in listOf(0x0020, 0x00A0, 0x2029, 0x202F, 0x2065, 0x206A)) {
            assertEquals(around(codePoint), accepted(around(codePoint)), "U+%04X".format(codePoint))
        }
    }

    @Test
    fun `T004-F1 an empty text, or one that is only whitespace, is blank`() {
        assertEquals("blank", reasonOf(""))
        assertEquals("blank", reasonOf("  \n\t "))
    }

    @Test
    fun `T004-F2 an absent text is missing`() {
        assertEquals("missing", reasonOf(null))
    }

    @Test
    fun `T004-F3 a text that is not a string says so`() {
        for (raw in listOf<Any>(123, true, emptyMap<String, Any>(), emptyList<Any>())) {
            assertEquals("not_a_string", reasonOf(raw), raw.toString())
        }
    }

    @Test
    fun `T004-F6 a control character inside the text is rejected`() {
        for (codePoint in listOf(0x0000, 0x0007, 0x001F, 0x007F, 0x0080, 0x009F)) {
            assertEquals("control_character", reasonOf(around(codePoint)), "U+%04X".format(codePoint))
        }
    }

    @Test
    fun `T004-F7 a bidirectional control character is rejected`() {
        for (codePoint in listOf(0x202A, 0x202E, 0x2066, 0x2069)) {
            assertEquals("bidi_control", reasonOf(around(codePoint)), "U+%04X".format(codePoint))
        }
    }

    @Test
    fun `T004-F8 a surrogate that is not half of a pair is a control character`() {
        assertEquals("control_character", reasonOf("\uD800"))
        assertEquals("control_character", reasonOf("a\uDC00b"))
    }

    @Test
    fun `T004-F12 the checks run in order, bidi before control before length`() {
        assertEquals("bidi_control", reasonOf("a‮b\u0007c"))
        assertEquals("control_character", reasonOf("x".repeat(279) + "\u0007" + "xx"))
        assertEquals("bidi_control", reasonOf("x".repeat(279) + "‮" + "xx"))
    }

    @Test
    fun `T004-B1 one code point is accepted`() {
        assertEquals("x", accepted("x"))
    }

    @Test
    fun `T004-B2 280 code points outside the BMP are accepted`() {
        val emoji = "😀".repeat(280)
        assertEquals(560, emoji.length)
        assertEquals(emoji, accepted(emoji))
    }

    @Test
    fun `T004-B3 281 code points are too long`() {
        assertEquals("too_long", reasonOf("x".repeat(281)))
    }

    @Test
    fun `T004-B4 the length is counted after the trim`() {
        val core = "x".repeat(280)
        assertEquals(core, accepted("  $core  "))
    }

    @Test
    fun `T004-B8 the trim strips U+001F at the edges, so it can leave nothing`() {
        assertEquals("hi", accepted("hi\u001F"))
        assertEquals("blank", reasonOf("\u001F"))
    }
}
