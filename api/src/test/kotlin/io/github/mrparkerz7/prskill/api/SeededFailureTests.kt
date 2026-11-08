package io.github.mrparkerz7.prskill.api

import org.junit.jupiter.api.Test
import kotlin.test.fail

class SeededFailureTests {
    @Test
    fun `T003-B1 a seeded failing test`() {
        fail("seeded failure for the CI proof")
    }
}
