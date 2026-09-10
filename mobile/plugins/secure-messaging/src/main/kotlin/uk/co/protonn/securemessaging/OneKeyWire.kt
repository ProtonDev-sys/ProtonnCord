/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

package uk.co.protonn.securemessaging

import java.io.ByteArrayOutputStream
import java.security.MessageDigest

internal object OneKeyWire {
    const val MAX_PAYLOAD = 4096
    data class Message(val type: Int, val payload: ByteArray)
    data class Field(val number: Int, val numeric: Long? = null, val bytes: ByteArray? = null)

    fun varint(value: Long): ByteArray {
        require(value in 0..0xffff_ffffL) { "Invalid OneKey integer" }
        val out = ByteArrayOutputStream()
        var remaining = value
        do {
            out.write(((remaining and 127) or if (remaining > 127) 128 else 0).toInt())
            remaining = remaining ushr 7
        } while (remaining > 0)
        return out.toByteArray()
    }

    private fun numeric(number: Int, value: Long) = varint((number shl 3).toLong()) + varint(value)
    private fun bytes(number: Int, value: ByteArray) = varint(((number shl 3) or 2).toLong()) + varint(value.size.toLong()) + value

    fun cipherRequest(): ByteArray {
        val input = MessageDigest.getInstance("SHA-256")
            .digest("ProtonnCord/SecureMessaging/OneKey/CKV/profile-input/v1".toByteArray(Charsets.UTF_8))
        return numeric(1, 0x80002720L) + numeric(1, 0) +
            bytes(2, "ProtonnCord Secure Messaging".toByteArray(Charsets.UTF_8)) + bytes(3, input) +
            numeric(4, 1) + numeric(5, 1) + numeric(6, 1)
    }

    private fun readVarint(data: ByteArray, start: Int): Pair<Long, Int> {
        var value = 0L
        var offset = start
        repeat(5) { index ->
            require(offset < data.size) { "Truncated OneKey response" }
            val byte = data[offset++].toInt() and 255
            if (index == 4) require(byte <= 15) { "Invalid OneKey integer" }
            value = value or ((byte and 127).toLong() shl (index * 7))
            if (byte and 128 == 0) return value to offset
        }
        error("Invalid OneKey integer")
    }

    fun fields(data: ByteArray): List<Field> {
        require(data.size <= MAX_PAYLOAD) { "OneKey response is too large" }
        val result = mutableListOf<Field>()
        try {
            var offset = 0
            while (offset < data.size) {
                val (tag, next) = readVarint(data, offset)
                offset = next
                val number = (tag ushr 3).toInt()
                require(number > 0) { "Invalid OneKey field" }
                when (tag.toInt() and 7) {
                    0 -> {
                        val (value, end) = readVarint(data, offset)
                        offset = end
                        result.add(Field(number, numeric = value))
                    }
                    2 -> {
                        val (length, end) = readVarint(data, offset)
                        require(length <= MAX_PAYLOAD && end.toLong() + length <= data.size) { "Truncated OneKey field" }
                        offset = end + length.toInt()
                        result.add(Field(number, bytes = data.copyOfRange(end, offset)))
                    }
                    1 -> { require(offset + 8 <= data.size); offset += 8 }
                    5 -> { require(offset + 4 <= data.size); offset += 4 }
                    else -> error("Unsupported OneKey field")
                }
            }
            return result
        } catch (error: Throwable) {
            wipe(result)
            throw error
        }
    }

    fun wipe(fields: List<Field>) = fields.forEach { it.bytes?.fill(0) }

    fun validateFeatures(payload: ByteArray) {
        val fields = fields(payload)
        try {
            fun number(id: Int) = fields.firstOrNull { it.number == id && it.numeric != null }?.numeric
            val capabilities = fields.filter { it.number == 30 }.flatMap { field ->
                field.numeric?.let { listOf(it) } ?: field.bytes?.let { packed ->
                    val values = mutableListOf<Long>()
                    var offset = 0
                    while (offset < packed.size) {
                        val (value, end) = readVarint(packed, offset)
                        values.add(value)
                        offset = end
                    }
                    values
                } ?: emptyList()
            }
            require(number(5) != 1L && number(7) == 1L && number(12) == 1L && number(600) == 1L && 5L in capabilities) {
                "OneKey needs current Classic 1S firmware, a device PIN, and on-device approval support"
            }
        } finally { wipe(fields) }
    }

    fun secret(payload: ByteArray): ByteArray {
        val fields = fields(payload)
        try {
            val values = fields.filter { it.number == 1 && it.bytes != null }
            require(values.size == 1) { "Invalid OneKey cipher response" }
            val value = requireNotNull(values.single().bytes)
            require(value.size == 32 && value.any { it != 0.toByte() }) { "Invalid OneKey secret" }
            return value.copyOf()
        } finally { wipe(fields) }
    }

    fun failure(payload: ByteArray): Nothing {
        val fields = fields(payload)
        try {
            val code = fields.firstOrNull { it.number == 1 }?.numeric
            error(if (code == 4L || code == 6L) "OneKey approval was cancelled" else "OneKey could not unlock Secure Messaging")
        } finally { wipe(fields) }
    }

    fun packets(type: Int, payload: ByteArray): List<ByteArray> {
        require(type in 0..65535 && payload.size <= MAX_PAYLOAD) { "Invalid OneKey request" }
        val result = mutableListOf<ByteArray>()
        var offset = 0
        do {
            val packet = ByteArray(64)
            packet[0] = 0x3f
            val start = if (result.isEmpty()) 9 else 1
            if (result.isEmpty()) {
                packet[1] = 0x23; packet[2] = 0x23
                packet[3] = (type ushr 8).toByte(); packet[4] = type.toByte()
                for (index in 0..3) packet[5 + index] = (payload.size ushr ((3 - index) * 8)).toByte()
            }
            val count = minOf(64 - start, payload.size - offset)
            payload.copyInto(packet, start, offset, offset + count)
            offset += count
            result.add(packet)
        } while (offset < payload.size)
        return result
    }

    fun header(packet: ByteArray): Pair<Int, Int> {
        require(packet.size == 64 && packet[0] == 0x3f.toByte() && packet[1] == 0x23.toByte() && packet[2] == 0x23.toByte()) {
            "Invalid OneKey USB response"
        }
        val type = ((packet[3].toInt() and 255) shl 8) or (packet[4].toInt() and 255)
        var length = 0L
        for (index in 5..8) length = (length shl 8) or (packet[index].toLong() and 255)
        require(length <= MAX_PAYLOAD) { "OneKey USB response is too large" }
        return type to length.toInt()
    }
}
