package io.github.mrparkerz7.prskill.api.messages

import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MessageStoreTest {
    private val fixedClock = Clock.fixed(Instant.parse("2026-11-06T10:15:30.123456789Z"), ZoneOffset.UTC)

    private fun store() = MessageStore(fixedClock, "0123abcd")

    private fun MessageStore.add(text: String) = append(MessageText.parse(text))

    @Test
    fun `T004-S1 an appended message takes the next id, the epoch and a millisecond createdAt`() {
        val message = store().add("hello")
        assertEquals(1L, message.id)
        assertEquals("0123abcd", message.epoch)
        assertEquals("hello", message.text)
        assertEquals(Instant.parse("2026-11-06T10:15:30.123Z"), message.createdAt)
    }

    @Test
    fun `T004-S3 a page is newest first and names the newest id`() {
        val store = store()
        repeat(3) { store.add("m$it") }
        val page = store.page(20)
        assertEquals(listOf(3L, 2L, 1L), page.messages.map { it.id })
        assertEquals(3L, page.latestId)
    }

    @Test
    fun `T004-S4 an empty store gives an empty page, id 0 and its epoch`() {
        val page = store().page(20)
        assertEquals(emptyList(), page.messages)
        assertEquals(0L, page.latestId)
        assertEquals("0123abcd", page.epoch)
    }

    @Test
    fun `T004-S5 the epoch is 8 lowercase hex characters, minted once, and each store starts at id 1`() {
        val first = MessageStore(Clock.systemUTC())
        val second = MessageStore(Clock.systemUTC())
        val pattern = Regex("^[0-9a-f]{8}$")
        assertTrue(pattern.matches(first.epoch), first.epoch)
        assertTrue(pattern.matches(second.epoch), second.epoch)
        assertEquals(first.epoch, first.page(1).epoch)
        assertEquals(first.epoch, first.snapshot().epoch)
        assertEquals(first.epoch, first.add("x").epoch)
        assertEquals(1L, second.add("x").id)
    }

    @Test
    fun `T004-B5 a limit of 1 returns only the newest`() {
        val store = store()
        repeat(3) { store.add("m$it") }
        assertEquals(listOf(3L), store.page(1).messages.map { it.id })
    }

    @Test
    fun `T004-B6 99, 100 and 101 appends retain 99, 100 and the latest 100`() {
        for ((count, expected) in listOf(99 to (99L downTo 1L), 100 to (100L downTo 1L), 101 to (101L downTo 2L))) {
            val store = store()
            repeat(count) { store.add("m$it") }
            // 1_000 is above the capacity, so a wrong CAPACITY shows; page(100) could never return more than 100.
            assertEquals(expected.toList(), store.page(1_000).messages.map { it.id }, "after $count")
        }
    }

    @Test
    fun `T004-S3 a snapshot names the epoch and the newest id`() {
        val store = store()
        assertEquals(StoreSnapshot("0123abcd", 0L), store.snapshot())
        repeat(2) { store.add("m$it") }
        assertEquals(StoreSnapshot("0123abcd", 2L), store.snapshot())
    }

    @Test
    fun `T004-C1 100 appends from 8 threads get ids exactly 1 to 100, and the page is strictly descending`() {
        val store = store()
        val pool = Executors.newFixedThreadPool(8)
        try {
            val ids = pool.invokeAll(List(100) { Callable { store.add("m$it").id } }).map { it.get() }
            assertEquals((1L..100L).toList(), ids.sorted())
            val listed = store.page(1_000).messages.map { it.id }
            assertEquals(listed.sortedDescending(), listed)
            assertEquals(100, listed.distinct().size)
        } finally {
            pool.shutdownNow()
        }
    }

    /**
     * `latestId` comes from the same copied list as `messages`, so this holds for any copy. It proves the contract of
     * one read, not the lock around `page()`: a mutant without that lock still passes, and the lock is held by
     * inspection. The lock around `append()` is proved by C1 (distinct, gap-free ids).
     */
    @Test
    fun `T004-C2 a page read while 8 threads append always has latestId equal to its first id`() {
        val store = store()
        val pool = Executors.newFixedThreadPool(12)
        try {
            val writers =
                List(8) { writer ->
                    Callable {
                        repeat(50) { store.add("w$writer-$it") }
                        0
                    }
                }
            val readers =
                List(4) {
                    Callable {
                        var violations = 0
                        repeat(1_000) {
                            val page = store.page(20)
                            if (page.latestId != (page.messages.firstOrNull()?.id ?: 0L)) violations++
                        }
                        violations
                    }
                }
            val results = pool.invokeAll(writers + readers).map { it.get() }
            assertEquals(0, results.sum())
            assertEquals(400L, store.snapshot().latestId)
        } finally {
            pool.shutdownNow()
        }
    }
}
