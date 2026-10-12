/* SPDX-License-Identifier: GPL-3.0-or-later */

package uk.co.protonn.securemessaging

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val KEY_ALIAS = "uk.co.protonn.secure-messaging.vault"
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

// The native bridge serializes complete transactions with its lifecycle monitor.
internal class VaultStorage(private val file: File) {
    fun load(): String? =
        if (!file.exists() && !File(file.path + ".bak").exists()) null
        else decryptVault(AtomicFile(file).openRead().use { it.readBytes() })

    fun save(plaintext: String) {
        require(plaintext.toByteArray(Charsets.UTF_8).size <= 4 * 1024 * 1024) { "Secure vault is too large" }
        writeAtomically(file) { it.write(encryptVault(plaintext)) }
    }

    fun reset(): Boolean {
        AtomicFile(file).delete()
        // Android versions before 11 do not know the newer AtomicFile staging suffix.
        File(file.path + ".new").delete()
        return !file.exists() && !File(file.path + ".bak").exists() && !File(file.path + ".new").exists()
    }
}
