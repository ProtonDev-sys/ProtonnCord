/* SPDX-License-Identifier: GPL-3.0-or-later */

package uk.co.protonn.securemessaging

import android.os.Process
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.util.UUID
import javax.crypto.SecretKey
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.JUnit4
import revenge.plugin.secure_messaging.BuildConfig

@RunWith(JUnit4::class)
class NativeStorageTest {
    private lateinit var root: File
    private val alias = "uk.co.protonn.secure-messaging.vault"
    private val runtimeUrl get() = BuildConfig.REVENGE_RUNTIME_URL
    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val loader get() = File(root, "pyoncord/loader.json")
    private val backup get() = File(loader.path + ".protonn-backup")

    @Before fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(Process.myUid() >= 10000 && context.packageName != "com.discord") {
            "Storage tests must run in their own ordinary app sandbox"
        }
        root = File(context.cacheDir, "protonn-storage-test-${UUID.randomUUID()}")
        check(root.mkdirs())
        keyStore().deleteEntry(alias)
    }

    @After fun tearDown() {
        if (::root.isInitialized) {
            keyStore().deleteEntry(alias)
            root.deleteRecursively()
        }
    }

    private fun seedLoader(text: String): ByteArray {
        loader.parentFile!!.mkdirs()
        val bytes = text.toByteArray(Charsets.UTF_8)
        loader.writeBytes(bytes)
        return bytes
    }

    @Test fun vaultRoundTripsAcrossInstancesWithANonExportablePersistentKey() {
        val file = File(root, "vault.bin")
        val plaintext = "{\"secret\":\"account-free storage test — 🔐\"}"
        VaultStorage(file).save(plaintext)
        val first = file.readBytes()
        assertEquals(1, first[0].toInt()) // Keep the existing on-disk format.
        assertEquals(plaintext, VaultStorage(file).load())
        val key = keyStore().getKey(alias, null) as SecretKey
        assertNull(key.encoded)
        VaultStorage(file).save(plaintext)
        assertFalse(first.contentEquals(file.readBytes()))
        assertEquals(plaintext, VaultStorage(file).load())
        // A new save must not replace the key and orphan previous ciphertext.
        file.writeBytes(first)
        assertEquals(plaintext, VaultStorage(file).load())
    }

    @Test fun malformedAndTamperedVaultsCannotReturnPlaintext() {
        val file = File(root, "vault.bin")
        val vault = VaultStorage(file)
        assertNull(vault.load())
        vault.save("private test value")
        val original = file.readBytes()
        for (invalid in listOf(
            byteArrayOf(), original.copyOf(12),
            original.copyOf().apply { this[0] = 2 },
            original.copyOf().apply { this[1] = 11 },
        )) {
            file.writeBytes(invalid)
            assertThrows(IllegalArgumentException::class.java) { vault.load() }
        }
        for (index in listOf(2, original.lastIndex)) {
            file.writeBytes(original.copyOf().apply { this[index] = (this[index].toInt() xor 1).toByte() })
            assertThrows(GeneralSecurityException::class.java) { vault.load() }
        }
        file.writeBytes(original)
        assertEquals("private test value", vault.load())
    }

    @Test fun aReplacedKeystoreKeyCannotOpenThePreviousVault() {
        val file = File(root, "vault.bin")
        VaultStorage(file).save("private test value")
        val original = file.readBytes()
        keyStore().deleteEntry(alias)
        assertThrows(GeneralSecurityException::class.java) { VaultStorage(file).load() }
        assertArrayEquals(original, file.readBytes())
    }

    @Test fun interruptedAtomicSaveRetainsThePreviousVaultAndAllowsRetry() {
        val file = File(root, "vault.bin")
        VaultStorage(file).save("previous value")
        val original = file.readBytes()
        assertThrows(IOException::class.java) {
            writeAtomically(file) {
                it.write("interrupted partial write".toByteArray())
                throw IOException("simulated storage failure")
            }
        }
        assertEquals("previous value", VaultStorage(file).load())
        assertArrayEquals(original, file.readBytes())
        VaultStorage(file).save("retried value")
        assertEquals("retried value", VaultStorage(file).load())
    }

    @Test fun legacyAtomicBackupRecoversBeforeAReadAndResetRemovesAllVersions() {
        val file = File(root, "vault.bin")
        val vault = VaultStorage(file)
        vault.save("recovered value")
        File(file.path + ".bak").writeBytes(file.readBytes())
        file.writeText("incomplete write")
        assertEquals("recovered value", VaultStorage(file).load())
        File(file.path + ".bak").writeBytes(file.readBytes())
        File(file.path + ".new").writeText("abandoned future write")
        assertTrue(vault.reset())
        assertNull(VaultStorage(file).load())
        assertFalse(File(file.path + ".bak").exists())
        assertFalse(File(file.path + ".new").exists())
        vault.save("new vault")
        assertEquals("new vault", VaultStorage(file).load())
    }

    @Test fun oversizedUtf8SaveCannotOverwriteAValidVault() {
        val file = File(root, "vault.bin")
        val vault = VaultStorage(file)
        vault.save("previous value")
        val original = file.readBytes()
        assertThrows(IllegalArgumentException::class.java) { vault.save("€".repeat(1_400_000)) }
        assertArrayEquals(original, file.readBytes())
        assertEquals("previous value", vault.load())
    }

    @Test fun loaderUpdatePreservesUnknownFieldsAndTheExactOriginalBackup() {
        val original = seedLoader("""{
            "theme": "dark", "future": {"keep": [1, true, null]},
            "customLoadUrl": {"enabled": false, "url": "http://localhost:8080", "futureOption": 7}
        }""")
        configureLoader(root, runtimeUrl)
        val config = JSONObject(loader.readText())
        assertEquals("dark", config.getString("theme"))
        assertEquals("[1,true,null]", config.getJSONObject("future").getJSONArray("keep").toString())
        val custom = config.getJSONObject("customLoadUrl")
        assertTrue(custom.getBoolean("enabled"))
        assertEquals(runtimeUrl, custom.getString("url"))
        assertEquals(7, custom.getInt("futureOption"))
        assertArrayEquals(original, backup.readBytes())
        configureLoader(root, runtimeUrl)
        assertArrayEquals(original, backup.readBytes())
    }

    @Test fun aNewLoaderConfigurationCanBeCreatedWithoutDiscardingAnExistingBackup() {
        configureLoader(root, runtimeUrl)
        assertEquals(runtimeUrl, JSONObject(loader.readText()).getJSONObject("customLoadUrl").getString("url"))
        assertEquals("{}", backup.readText())
        val previousBackup = "{\"previous\":true}".toByteArray()
        backup.writeBytes(previousBackup)
        configureLoader(root, runtimeUrl)
        assertArrayEquals(previousBackup, backup.readBytes())
    }

    @Test fun invalidLoaderConfigurationsAndBackupsArePreservedOnFailure() {
        for (text in listOf("null", "[]", "{\"broken\":", "not JSON", " ".repeat(65537))) {
            val original = seedLoader(text)
            assertThrows(Exception::class.java) { configureLoader(root, runtimeUrl) }
            assertArrayEquals(original, loader.readBytes())
            assertFalse(backup.exists())
        }
        val original = seedLoader("{\"preserve\":true}")
        backup.writeText("broken backup")
        assertThrows(Exception::class.java) { configureLoader(root, runtimeUrl) }
        assertArrayEquals(original, loader.readBytes())
        assertEquals("broken backup", backup.readText())
    }

    @Test fun aFailedBackupCommitLeavesTheActiveLoaderUnchanged() {
        val original = seedLoader("{\"preserve\":true}")
        val blocked = File(backup.path + ".protonn-update")
        check(blocked.mkdirs())
        File(blocked, "blocker").writeText("cannot replace this nonempty directory")
        assertThrows(IllegalStateException::class.java) { configureLoader(root, runtimeUrl) }
        assertArrayEquals(original, loader.readBytes())
        assertFalse(backup.exists())
    }

    @Test fun aFailedLoaderCommitPreservesBothFilesAndCanBeRetried() {
        val original = seedLoader("{\"preserve\":true}")
        val blocked = File(loader.path + ".protonn-update")
        check(blocked.mkdirs())
        File(blocked, "blocker").writeText("cannot replace this nonempty directory")
        assertThrows(IllegalStateException::class.java) { configureLoader(root, runtimeUrl) }
        assertArrayEquals(original, loader.readBytes())
        assertArrayEquals(original, backup.readBytes())
        assertTrue(blocked.deleteRecursively())
        configureLoader(root, runtimeUrl)
        assertEquals(runtimeUrl, JSONObject(loader.readText()).getJSONObject("customLoadUrl").getString("url"))
        assertArrayEquals(original, backup.readBytes())
    }

    @Test fun abandonedLoaderStagingCannotReplaceTheCurrentConfiguration() {
        val original = seedLoader("{\"preserve\":true}")
        File(loader.path + ".protonn-update").writeText("incomplete staged config")
        File(loader.path + ".protonn-update.new").writeText("incomplete staged config")
        // A direct reader, as used by Revenge, still sees the complete old config.
        assertArrayEquals(original, loader.readBytes())
        configureLoader(root, runtimeUrl)
        assertArrayEquals(original, backup.readBytes())
        assertTrue(JSONObject(loader.readText()).getBoolean("preserve"))
    }

    @Test fun loaderConfigurationRejectsUntrustedUrlsBeforeCreatingFiles() {
        for (url in listOf(
            runtimeUrl.replace("https:", "http:"),
            runtimeUrl.replace("github.com", "github.com.evil.invalid"),
            runtimeUrl.replace("github.com/", "user@github.com/"),
            runtimeUrl.replace("ProtonDev-sys", "another-account"),
            "$runtimeUrl?redirect=elsewhere", "$runtimeUrl#fragment",
            runtimeUrl.replace("/revenge.bundle", "/../elsewhere/revenge.bundle"),
        )) {
            assertThrows(IllegalArgumentException::class.java) { configureLoader(root, url) }
            assertFalse(loader.exists())
            assertFalse(backup.exists())
        }
    }
}
