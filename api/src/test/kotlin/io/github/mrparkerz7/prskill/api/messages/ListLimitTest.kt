package io.github.mrparkerz7.prskill.api.messages

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ListLimitTest {
    private fun reasonOf(vararg values: String?): String {
        val failure = assertFailsWith<InvalidRequestException> { ListLimit.parse(values.toList()) }
        assertEquals("limit", failure.field)
        return failure.reason
    }

    @Test
    fun `T004-S6 an absent or blank limit means 20`() {
        assertEquals(20, ListLimit.parse(null))
        assertEquals(20, ListLimit.parse(emptyList()))
        assertEquals(20, ListLimit.parse(listOf("")))
        assertEquals(20, ListLimit.parse(listOf("  ")))
        assertEquals(20, ListLimit.parse(listOf(null)))
    }

    @Test
    fun `T004-B5 the edges 1 and 100 are accepted`() {
        assertEquals(1, ListLimit.parse(listOf("1")))
        assertEquals(100, ListLimit.parse(listOf("100")))
        assertEquals(7, ListLimit.parse(listOf("0007")))
    }

    @Test
    fun `T004-F10 a limit outside 1 to 100 is out of range`() {
        assertEquals("out_of_range", reasonOf("0"))
        assertEquals("out_of_range", reasonOf("101"))
    }

    @Test
    fun `T004-F11 a limit that is not a whole number, or is repeated, is not an integer`() {
        for (value in listOf("-1", "+5", "abc", "1.5", "99999999999", "5 ", "٣")) {
            assertEquals("not_an_integer", reasonOf(value), value)
        }
        assertEquals("not_an_integer", reasonOf("5", "7"))
        assertEquals("not_an_integer", reasonOf("", ""))
        assertEquals("not_an_integer", reasonOf(null, null))
    }
}
