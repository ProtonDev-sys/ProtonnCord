@file:JvmName("SecureMessagingPlugin")

package uk.co.protonn.securemessaging

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.net.Uri
import android.util.Base64
import android.util.AtomicFile
import io.github.revenge.bridge.asDelegate
import io.github.revenge.plugins.plugin
import io.github.revenge.xposed.api.registerNativeAsyncMethod
import io.github.revenge.xposed.api.registerNativeMethod
import java.io.File
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val KEY_ALIAS = "uk.co.protonn.secure-messaging.vault"
private const val VAULT_FILE = "secure-vault.bin"
private const val MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
private val AAD = "ProtonnCord-Mobile/SecureMessaging/v1".toByteArray(Charsets.UTF_8)

private fun vaultKey(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
        init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        generateKey()
    }
}

private fun encryptVault(plaintext: String): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.ENCRYPT_MODE, vaultKey())
        updateAAD(AAD)
    }
    val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
    require(cipher.iv.size in 12..16)
    return byteArrayOf(1, cipher.iv.size.toByte()) + cipher.iv + ciphertext
}

private fun decryptVault(bytes: ByteArray): String {
    require(bytes.size >= 2 + 12 + 16 && bytes[0].toInt() == 1) { "Unsupported secure vault" }
    val ivLength = bytes[1].toInt() and 0xff
    require(ivLength in 12..16 && bytes.size >= 2 + ivLength + 16) { "Invalid secure vault" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.DECRYPT_MODE, vaultKey(), GCMParameterSpec(128, bytes.copyOfRange(2, 2 + ivLength)))
        updateAAD(AAD)
    }
    return cipher.doFinal(bytes.copyOfRange(2 + ivLength, bytes.size)).toString(Charsets.UTF_8)
}

@Suppress("UNUSED")
val secureMessagingPlugin = plugin {
    start {
        val vault = File(storageDir, VAULT_FILE)

        registerNativeMethod("uk.co.protonn.secure-messaging.random") { rawArgs ->
            val args = rawArgs.asDelegate()
            val size: Int by args.int()
            require(size in 1..4096) { "Invalid random-byte request" }
            Base64.encodeToString(
                ByteArray(size).also(SecureRandom()::nextBytes),
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
            )
        }

		withAppContext { context ->
			val oneKey = OneKeyUsb(context)
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
            if (!vault.exists() && !File(vault.path + ".bak").exists()) null
            else decryptVault(AtomicFile(vault).openRead().use { it.readBytes() })
        }
        registerNativeAsyncMethod("uk.co.protonn.secure-messaging.vault.save") { rawArgs ->
            val args = rawArgs.asDelegate()
            val plaintext: String by args.string()
            require(plaintext.toByteArray(Charsets.UTF_8).size <= 4 * 1024 * 1024) { "Secure vault is too large" }
            storageDir.mkdirs()
            val atomic = AtomicFile(vault)
            val stream = atomic.startWrite()
            try {
                stream.write(encryptVault(plaintext))
                atomic.finishWrite(stream)
            } catch (error: Exception) {
                atomic.failWrite(stream)
                throw error
            }
            true
        }
        registerNativeAsyncMethod("uk.co.protonn.secure-messaging.vault.reset") {
            vault.delete()
        }
    }
}
