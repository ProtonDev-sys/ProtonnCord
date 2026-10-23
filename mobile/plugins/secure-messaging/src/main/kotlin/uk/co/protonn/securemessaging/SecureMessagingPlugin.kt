@file:JvmName("SecureMessagingPlugin")

package uk.co.protonn.securemessaging

import android.net.Uri
import android.util.Base64
import io.github.revenge.bridge.asDelegate
import io.github.revenge.plugins.plugin
import io.github.revenge.xposed.api.registerNativeAsyncMethod
import io.github.revenge.xposed.api.registerNativeMethod
import java.io.File
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import revenge.plugin.secure_messaging.BuildConfig

private const val VAULT_FILE = "secure-vault.bin"
private const val MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
private val storageLock = Any()

@Suppress("UNUSED")
val secureMessagingPlugin = plugin {
    var stopNative: (() -> Unit)? = null

    start {
        val vault = VaultStorage(File(storageDir, VAULT_FILE))
        val active = AtomicBoolean(true)
        val oneKeySession = AtomicReference<OneKeyUsb?>()
        stopNative = {
            active.set(false)
            oneKeySession.getAndSet(null)?.close()
            // Finish the current storage transaction before stop completes.
            // Queued handlers must check active under this same monitor.
            synchronized(storageLock) { Unit }
        }

        registerNativeMethod("uk.co.protonn.secure-messaging.random") { rawArgs ->
            val args = rawArgs.asDelegate()
            val size: Int by args.int()
            require(size in 1..4096) { "Invalid random-byte request" }
            Base64.encodeToString(
                ByteArray(size).also(SecureRandom()::nextBytes),
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
            )
        }

        registerNativeMethod("uk.co.protonn.secure-messaging.loader.runtimeUrl") {
            BuildConfig.REVENGE_RUNTIME_URL
        }

		withAppContext { context ->
			val oneKey = OneKeyUsb(context)
			oneKeySession.set(oneKey)
			if (!active.get()) {
				oneKeySession.getAndSet(null)?.close()
				return@withAppContext
			}
			registerNativeAsyncMethod("uk.co.protonn.secure-messaging.loader.configure") { rawArgs ->
				val args = rawArgs.asDelegate()
				val runtimeUrl: String by args.string()
				require(runtimeUrl == BuildConfig.REVENGE_RUNTIME_URL) { "The native mobile runtime pin changed; retry the update" }
				synchronized(storageLock) {
					check(active.get()) { "Secure Messaging has stopped" }
					configureLoader(context.filesDir, runtimeUrl)
					true
				}
			}
			registerNativeAsyncMethod("uk.co.protonn.secure-messaging.attachment.cleanup") {
				val cacheRoot = context.cacheDir.canonicalFile
				val owned = listOf(
					"share-media/protonn-cord" to Regex("^[0-9]{17,20}-[0-9]-.+$"),
					"protonn-cord/uploads" to Regex("^pc-[A-Za-z0-9_-]{22}-[0-9]\\.pcaf$"),
				)
				var cleaned = true
				for ((path, pattern) in owned) {
					val directory = File(cacheRoot, path).absoluteFile
					require(directory.canonicalFile == directory) { "Invalid attachment cache directory" }
					if (!directory.exists()) continue
					require(directory.isDirectory) { "Invalid attachment cache directory" }
					val entries = directory.listFiles() ?: error("Attachment cache could not be read")
					for (file in entries) {
						if (!pattern.matches(file.name)) continue
						if (file.canonicalFile != file.absoluteFile || !file.isFile || !file.delete()) cleaned = false
					}
				}
				cleaned
			}
			registerNativeMethod("uk.co.protonn.secure-messaging.onekey.status") { oneKey.status() }
			registerNativeMethod("uk.co.protonn.secure-messaging.onekey.cancel") { oneKey.cancel(); true }
			registerNativeAsyncMethod("uk.co.protonn.secure-messaging.onekey.unlock") {
				try {
					val secret = oneKey.unlock()
					try { mapOf("status" to "unlocked", "secret" to Base64.encodeToString(secret, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)) }
					finally { secret.fill(0) }
				} catch (_: kotlinx.coroutines.TimeoutCancellationException) {
					mapOf("status" to "error", "message" to "OneKey approval timed out. Try again when the device is ready.")
				} catch (error: Exception) {
					mapOf("status" to "error", "message" to (error.message?.lineSequence()?.firstOrNull() ?: "OneKey could not be opened. Reconnect the USB cable and try again."))
				}
			}
			registerNativeAsyncMethod("uk.co.protonn.secure-messaging.attachment.read") { rawArgs ->
				val args = rawArgs.asDelegate()
				val value: String by args.string()
				val uri = Uri.parse(value)
				require(uri.scheme == "content" || uri.scheme == "file") { "Unsupported attachment URI" }
				val output = ByteArrayOutputStream()
				context.contentResolver.openInputStream(uri).use { input ->
					requireNotNull(input) { "Attachment could not be opened" }
					val buffer = ByteArray(64 * 1024)
					var total = 0
					while (true) {
						val read = input.read(buffer)
						if (read < 0) break
						total += read
						require(total <= MAX_ATTACHMENT_BYTES) { "Attachment exceeds the mobile safety limit" }
						output.write(buffer, 0, read)
					}
				}
				Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
			}
			registerNativeAsyncMethod("uk.co.protonn.secure-messaging.attachment.share") { rawArgs ->
				val args = rawArgs.asDelegate()
				val value: String by args.string()
				val file = File(value).canonicalFile
				val allowed = File(context.cacheDir, "share-media/protonn-cord").canonicalFile
				require(file.path.startsWith("${allowed.path}${File.separator}")) { "Invalid attachment cache path" }
				val provider = Class.forName("androidx.core.content.FileProvider")
				val method = provider.getMethod(
					"getUriForFile",
					android.content.Context::class.java,
					String::class.java,
					File::class.java,
				)
				(method.invoke(null, context, "${context.packageName}.file-provider", file) as Uri).toString()
			}
		}

        registerNativeAsyncMethod("uk.co.protonn.secure-messaging.vault.load") {
            synchronized(storageLock) {
                check(active.get()) { "Secure Messaging has stopped" }
                vault.load()
            }
        }
        registerNativeAsyncMethod("uk.co.protonn.secure-messaging.vault.save") { rawArgs ->
            val args = rawArgs.asDelegate()
            val plaintext: String by args.string()
            synchronized(storageLock) {
                check(active.get()) { "Secure Messaging has stopped" }
                vault.save(plaintext)
                true
            }
        }
        registerNativeAsyncMethod("uk.co.protonn.secure-messaging.vault.reset") {
            synchronized(storageLock) {
                check(active.get()) { "Secure Messaging has stopped" }
                vault.reset()
            }
        }
    }

    stop {
        stopNative?.invoke()
        stopNative = null
    }
}
