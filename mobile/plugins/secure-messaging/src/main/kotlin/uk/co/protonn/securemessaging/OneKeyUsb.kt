/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

package uk.co.protonn.securemessaging

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.os.Build
import android.os.SystemClock
import java.nio.ByteBuffer
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal class OneKeyUsb(private val context: Context) {
    private val busy = Mutex()
    private val cancelled = AtomicBoolean(false)
    fun cancel() { cancelled.set(true) }

    private fun devices(manager: UsbManager): List<UsbDevice> = manager.deviceList.values.filter {
        it.vendorId == 0x1209 && it.productId in setOf(0x4f4b, 0x53c1) &&
            it.manufacturerName?.trim()?.lowercase() !in setOf("trezor", "trezor company", "satoshilabs")
    }

    fun status(): String {
        val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
        val connected = devices(manager)
        return when {
            busy.isLocked -> "busy"
            connected.isEmpty() -> "disconnected"
            connected.size > 1 -> "multiple_devices"
            manager.hasPermission(connected.single()) -> "ready"
            else -> "permission_required"
        }
    }

    private suspend fun permission(manager: UsbManager, device: UsbDevice) {
        if (manager.hasPermission(device)) return
        val action = "${context.packageName}.PROTONNCORD_ONEKEY_PERMISSION"
        val result = CompletableDeferred<Unit>()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receivedContext: Context, intent: Intent) {
                if (intent.action == action) {
                    if (manager.hasPermission(device)) result.complete(Unit)
                    else result.completeExceptionally(IllegalStateException("USB permission was declined"))
                }
            }
        }
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
        else context.registerReceiver(receiver, IntentFilter(action))
        val pending = PendingIntent.getBroadcast(context, 8721, Intent(action).setPackage(context.packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT)
        try {
            manager.requestPermission(device, pending)
            withTimeout(120_000) { result.await() }
        } finally {
            pending.cancel()
            context.unregisterReceiver(receiver)
        }
    }

    suspend fun unlock(): ByteArray {
        check(busy.tryLock()) { "A OneKey unlock is already in progress" }
        cancelled.set(false)
        try {
            check(Build.VERSION.SDK_INT >= 26) { "OneKey USB requires Android 8 or newer" }
            val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
            val devices = devices(manager)
            check(devices.size == 1) {
                if (devices.isEmpty()) "Connect the Classic 1S directly to this phone using a USB data cable or OTG adapter"
                else "Connect only one OneKey at a time"
            }
            val device = devices.single()
            permission(manager, device)
            return withContext(Dispatchers.IO) { withTimeout(120_000) { exchange(manager, device) } }
        } finally { busy.unlock() }
    }

    private suspend fun transfer(connection: UsbDeviceConnection, endpoint: UsbEndpoint, packet: ByteArray, deadline: Long): ByteArray {
        val buffer = ByteBuffer.allocate(64)
        if (endpoint.direction == UsbConstants.USB_DIR_OUT) { buffer.put(packet); buffer.flip() }
        val request = UsbRequest()
        try {
            check(request.initialize(connection, endpoint)) { "OneKey USB request could not be initialized" }
            check(request.queue(buffer)) { "OneKey USB transfer could not be queued" }
            while (true) {
                currentCoroutineContext().ensureActive()
                check(!cancelled.get()) { "OneKey unlock was cancelled" }
                check(SystemClock.elapsedRealtime() < deadline) { "OneKey approval timed out" }
                val completed = try { connection.requestWait(1_000) } catch (_: TimeoutException) { continue }
                check(completed === request && buffer.position() == 64) { "OneKey USB transfer failed; reconnect the device" }
                return buffer.array().copyOf()
            }
        } finally {
            request.cancel()
            request.close()
            buffer.array().fill(0)
        }
    }

    private suspend fun exchange(manager: UsbManager, device: UsbDevice): ByteArray {
        val usbInterface = (0 until device.interfaceCount).map(device::getInterface).firstOrNull { candidate ->
            candidate.id == 0 && candidate.interfaceClass == 255 &&
                (0 until candidate.endpointCount).map(candidate::getEndpoint).let { endpoints ->
                    endpoints.any { it.address == 0x81 } && endpoints.any { it.address == 1 }
                }
        } ?: error("This OneKey USB interface is not supported")
        val endpoints = (0 until usbInterface.endpointCount).map(usbInterface::getEndpoint)
        val input = endpoints.first { it.address == 0x81 }
        val output = endpoints.first { it.address == 1 }
        val connection = manager.openDevice(device) ?: error("OneKey USB access failed")
        var claimed = false
        val deadline = SystemClock.elapsedRealtime() + 120_000
        try {
            check(connection.claimInterface(usbInterface, false)) { "OneKey is busy in another app" }
            claimed = true
            suspend fun send(type: Int, payload: ByteArray) {
                val packets = OneKeyWire.packets(type, payload)
                try {
                    for (packet in packets) transfer(connection, output, packet, deadline).fill(0)
                } finally { packets.forEach { it.fill(0) } }
            }
            suspend fun receive(): OneKeyWire.Message {
                val first = transfer(connection, input, ByteArray(64), deadline)
                var payload: ByteArray? = null
                try {
                    val (type, size) = OneKeyWire.header(first)
                    val data = ByteArray(size)
                    payload = data
                    var offset = minOf(size, 55)
                    first.copyInto(data, 0, 9, 9 + offset)
                    while (offset < size) {
                        val packet = transfer(connection, input, ByteArray(64), deadline)
                        try {
                            require(packet[0] == 0x3f.toByte()) { "Invalid OneKey continuation packet" }
                            val count = minOf(63, size - offset)
                            packet.copyInto(data, offset, 1, 1 + count)
                            offset += count
                        } finally { packet.fill(0) }
                    }
                    return OneKeyWire.Message(type, data)
                } catch (error: Throwable) {
                    payload?.fill(0)
                    throw error
                } finally { first.fill(0) }
            }
            send(0, byteArrayOf())
            val features = receive()
            try {
                if (features.type == 3) OneKeyWire.failure(features.payload)
                require(features.type == 17) { "Unexpected OneKey initialization response" }
                OneKeyWire.validateFeatures(features.payload)
            } finally { features.payload.fill(0) }
            val request = OneKeyWire.cipherRequest()
            try { send(23, request) } finally { request.fill(0) }
            repeat(12) {
                val response = receive()
                try {
                    when (response.type) {
                        3 -> OneKeyWire.failure(response.payload)
                        18 -> send(10_000, byteArrayOf())
                        26 -> send(27, byteArrayOf())
                        41 -> send(42, byteArrayOf(0x18, 0x01))
                        48 -> return OneKeyWire.secret(response.payload)
                        else -> error("Unexpected OneKey approval response")
                    }
                } finally { response.payload.fill(0) }
            }
            error("Too many OneKey approval requests")
        } finally {
            if (claimed) connection.releaseInterface(usbInterface)
            connection.close()
        }
    }
}
