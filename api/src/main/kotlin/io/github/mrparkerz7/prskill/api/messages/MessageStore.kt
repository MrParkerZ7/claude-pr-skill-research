package io.github.mrparkerz7.prskill.api.messages

import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Component
import java.security.SecureRandom
import java.time.Clock
import java.time.temporal.ChronoUnit
import java.util.HexFormat

/**
 * The latest [CAPACITY] messages, in memory, under a per-boot [epoch] (ADR-002). One lock guards the ring and the last
 * id, so ids are gap-free and a read sees them together. The lock is reentrant: a caller that already holds it (the
 * stream, T-005) may call [snapshot].
 *
 * The text arrives as a [MessageText], so a rejected request never reaches [append] and never takes an id.
 */
@Component
class MessageStore(
    private val clock: Clock,
    val epoch: String,
) {
    @Autowired
    constructor(clock: Clock) : this(clock, mintEpoch())

    private val lock = Any()
    private val ring = ArrayDeque<Message>()
    private var lastId = 0L

    fun append(text: MessageText): Message =
        synchronized(lock) {
            val message = Message(++lastId, epoch, text.toString(), clock.instant().truncatedTo(ChronoUnit.MILLIS))
            ring.addLast(message)
            if (ring.size > CAPACITY) ring.removeFirst()
            message
        }

    /** The newest [limit] messages, newest first, with the epoch and the newest id from the same locked read. */
    fun page(limit: Int): MessagePage =
        synchronized(lock) {
            val newest = ring.asReversed().take(limit)
            MessagePage(epoch, newest, newest.firstOrNull()?.id ?: 0L)
        }

    fun snapshot(): StoreSnapshot = synchronized(lock) { StoreSnapshot(epoch, lastId) }

    companion object {
        const val CAPACITY = 100

        private const val EPOCH_BYTES = 4

        /** 8 lowercase hex characters from `SecureRandom`. */
        private fun mintEpoch(): String {
            val bytes = ByteArray(EPOCH_BYTES)
            SecureRandom().nextBytes(bytes)
            return HexFormat.of().formatHex(bytes)
        }
    }
}
