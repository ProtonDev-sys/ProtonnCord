/* SPDX-License-Identifier: GPL-3.0-or-later */

package uk.co.protonn.securemessaging

import android.util.AtomicFile
import android.system.Os
import java.io.File
import org.json.JSONObject

private const val MAX_CONFIG_BYTES = 64 * 1024
private val RUNTIME_URL = Regex(
    "^https://github\\.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-runtime-[A-Za-z0-9._-]+/revenge\\.bundle$",
)

private fun readConfig(file: File): ByteArray? {
    if (!file.exists() && !File(file.path + ".bak").exists()) return null
    return AtomicFile(file).openRead().use { input ->
        require(input.channel.size() <= MAX_CONFIG_BYTES) { "The Revenge loader configuration is too large" }
        input.readBytes()
    }
}

private fun commitConfig(file: File, bytes: ByteArray) {
    // Older Android AtomicFile implementations write the base file in place.
    // Revenge reads loader.json directly, so only expose a fully written sibling.
    val staged = File(file.path + ".protonn-update")
    val atomic = AtomicFile(staged)
    atomic.delete()
    File(staged.path + ".new").delete() // Also clear newer-format staging on older Android.
    check(!staged.exists() && !File(staged.path + ".bak").exists() && !File(staged.path + ".new").exists()) {
        "The Revenge loader staging file could not be cleared"
    }
    try {
        writeAtomically(staged) { it.write(bytes) }
        Os.rename(staged.path, file.path)
    } finally {
        atomic.delete()
    }
}

internal fun configureLoader(filesDir: File, runtimeUrl: String) {
    require(RUNTIME_URL.matches(runtimeUrl)) { "Invalid Protonn Cord runtime URL" }
    val loader = File(filesDir, "pyoncord/loader.json")
    val original = readConfig(loader) ?: "{}".toByteArray(Charsets.UTF_8)
    val config = JSONObject(original.toString(Charsets.UTF_8))
    val backup = File(loader.path + ".protonn-backup")
    val saved = readConfig(backup)
    if (saved == null) commitConfig(backup, original)
    else JSONObject(saved.toString(Charsets.UTF_8)) // Do not discard an unreadable original backup.
    val customLoadUrl = config.optJSONObject("customLoadUrl") ?: JSONObject()
    config.put("customLoadUrl", customLoadUrl.put("enabled", true).put("url", runtimeUrl))
    commitConfig(loader, config.toString().toByteArray(Charsets.UTF_8))
}
