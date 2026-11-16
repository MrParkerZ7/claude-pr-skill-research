package io.github.mrparkerz7.prskill.api.probe

import kotlin.test.Test
import kotlin.test.assertEquals

class SlugTest {
    @Test
    fun `T060-S1 words are joined by hyphens in lower case`() {
        assertEquals("hello-world", slugOf("Hello World"))
    }
}
