/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

package uk.co.protonn.securemessaging

import org.junit.Assert.*
import org.junit.Test

class OneKeyWireTest {
    @Test fun initializationAndCipherRequestsUseExpectedMessageTypesAndDomain() {
        val initialize = OneKeyWire.packets(0, byteArrayOf()).single()
        assertArrayEquals(byteArrayOf(0x3f, 0x23, 0x23, 0, 0, 0, 0, 0, 0), initialize.copyOf(9))
        val request = OneKeyWire.cipherRequest()
        val fields = OneKeyWire.fields(request)
        try {
            assertEquals(listOf(0x80002720L, 0L), fields.filter { it.number == 1 }.map { it.numeric })
            assertEquals("ProtonnCord Secure Messaging", fields.single { it.number == 2 }.bytes!!.toString(Charsets.UTF_8))
            assertEquals(32, fields.single { it.number == 3 }.bytes!!.size)
            for (id in 4..6) assertEquals(1L, fields.single { it.number == id }.numeric)
            assertEquals(23, OneKeyWire.header(OneKeyWire.packets(23, request).first()).first)
        } finally { OneKeyWire.wipe(fields); request.fill(0) }
    }

    @Test fun framingKeepsEveryByteAcrossPacketBoundaries() {
        for (size in listOf(0, 1, 55, 56, 118, 4096)) {
            val input = ByteArray(size) { (it % 251).toByte() }
            val packets = OneKeyWire.packets(48, input)
            val (type, length) = OneKeyWire.header(packets.first())
            assertEquals(48, type); assertEquals(size, length)
            val combined = packets.flatMapIndexed { index, packet -> packet.drop(if (index == 0) 9 else 1) }.take(size).toByteArray()
            assertArrayEquals(input, combined)
            assertTrue(packets.all { it.size == 64 && it[0] == 0x3f.toByte() })
        }
    }

    @Test fun oversizedAndTruncatedResponsesAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { OneKeyWire.packets(23, ByteArray(4097)) }
        assertThrows(IllegalArgumentException::class.java) { OneKeyWire.header(ByteArray(63)) }
        val bad = OneKeyWire.packets(48, byteArrayOf()).single()
        bad[5] = 127
        assertThrows(IllegalArgumentException::class.java) { OneKeyWire.header(bad) }
        assertThrows(IllegalArgumentException::class.java) { OneKeyWire.fields(byteArrayOf(0x0a, 0x20, 1)) }
        assertThrows(IllegalArgumentException::class.java) { OneKeyWire.secret(byteArrayOf(0x0a, 0x20) + ByteArray(32)) }
        assertThrows(IllegalArgumentException::class.java) { OneKeyWire.secret(byteArrayOf(0x0a, 0x1f) + ByteArray(31) { 1 }) }
    }

    @Test fun firmwareMustRequireDevicePinAndSupportCipherKeyValue() {
        fun number(id: Int, value: Long) = OneKeyWire.varint((id shl 3).toLong()) + OneKeyWire.varint(value)
        val required = number(7, 1) + number(12, 1) + number(600, 1) + number(30, 5)
        OneKeyWire.validateFeatures(required)
        assertThrows(IllegalArgumentException::class.java) { OneKeyWire.validateFeatures(number(5, 1) + required) }
        assertThrows(IllegalArgumentException::class.java) { OneKeyWire.validateFeatures(number(7, 0) + number(12, 1) + number(600, 1) + number(30, 5)) }
    }
}
