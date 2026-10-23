/* SPDX-License-Identifier: GPL-3.0-or-later */

package uk.co.protonn.securemessaging

import android.util.AtomicFile
import java.io.File
import java.io.FileOutputStream

internal fun writeAtomically(file: File, write: (FileOutputStream) -> Unit) {
    val atomic = AtomicFile(file)
    val stream = atomic.startWrite()
    try {
        write(stream)
        stream.fd.sync()
        atomic.finishWrite(stream)
    } catch (error: Exception) {
        atomic.failWrite(stream)
        throw error
    }
}
