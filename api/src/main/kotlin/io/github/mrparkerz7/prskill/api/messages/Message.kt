package io.github.mrparkerz7.prskill.api.messages

import com.fasterxml.jackson.annotation.JsonFormat
import java.time.Instant

/**
 * A stored message (SPEC-001 A1). [createdAt] has millisecond precision, and is always written with three fraction
 * digits (`...30.000Z`): the default ISO instant format leaves the fraction out when the millisecond is 0.
 */
data class Message(
    val id: Long,
    val epoch: String,
    val text: String,
    @get:JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd'T'HH:mm:ss.SSSX", timezone = "UTC")
    val createdAt: Instant,
)

/** The list response (SPEC-001 B1): [messages] newest first, and [latestId] read in the same locked call. */
data class MessagePage(
    val epoch: String,
    val messages: List<Message>,
    val latestId: Long,
)

/** The store's epoch and its newest id, read together. */
data class StoreSnapshot(
    val epoch: String,
    val latestId: Long,
)
