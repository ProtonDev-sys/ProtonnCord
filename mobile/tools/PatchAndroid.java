/* SPDX-License-Identifier: GPL-3.0-or-later */

import java.io.File;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.DigestInputStream;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.zip.ZipFile;
import org.lsposed.patch.ApkPatcher;
import org.lsposed.patch.LSPatch;
import org.lsposed.patch.util.JavaLogger;

/** Keep signing passwords out of the OS command line; never use LSPatch's public key. */
class PatchAndroid {
    public static void main(String[] args) throws Exception {
        var options = new ArrayList<>(List.of(args));
        var standalone = options.remove("--protonncord-standalone");
        options.add("--keystore");
        for (var name : List.of("PROTONNCORD_KEYSTORE", "PROTONNCORD_STORE_PASS",
                "PROTONNCORD_KEY_ALIAS", "PROTONNCORD_KEY_PASS")) {
            var value = System.getenv(name);
            if (value == null || value.isEmpty()) throw new IllegalArgumentException("Missing " + name);
            options.add(value);
        }
        var store = KeyStore.getInstance(new File(System.getenv("PROTONNCORD_KEYSTORE")),
                System.getenv("PROTONNCORD_STORE_PASS").toCharArray());
        var certificate = store.getCertificate(System.getenv("PROTONNCORD_KEY_ALIAS"));
        if (certificate == null) throw new IllegalArgumentException("Signing alias has no certificate");
        var fingerprint = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(certificate.getEncoded()));
        var outputs = new ApkPatcher(new JavaLogger(), new LSPatch(options.toArray(String[]::new)).toSpec()).patch();
        // LSPatch deliberately links entries inside the nested original ZIP.
        // Java's ZIP reader supports this layout; Python rejects overlapping entries.
        var originalDigest = MessageDigest.getInstance("SHA-256");
        try (var apk = new ZipFile(outputs.getFirst());
             var input = new DigestInputStream(apk.getInputStream(apk.getEntry("assets/lspatch/origin.apk")), originalDigest)) {
            input.transferTo(OutputStream.nullOutputStream());
        }
        System.out.println("PROTONNCORD_ORIGINAL=" + HexFormat.of().formatHex(originalDigest.digest()));
        System.out.println("PROTONNCORD_SIGNER=" + fingerprint);
        if (standalone) checkNativeAlignment(outputs.getFirst());
    }

    private static void checkNativeAlignment(File output) throws Exception {
        int count = 0;
        try (var apk = new ZipFile(output)) {
            for (var entry : apk.stream().filter(e -> e.getName().matches(
                    "(?:lib|assets/lspatch/so)/(?:arm64-v8a|x86_64)/[^/]+\\.so")).toList()) {
                try (var input = apk.getInputStream(entry)) {
                    var bytes = input.readNBytes(8192);
                    var elf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
                    if (bytes.length < 64 || elf.getInt(0) != 0x464c457f || bytes[4] != 2 || bytes[5] != 1) {
                        throw new IllegalArgumentException("Unexpected 64-bit ELF header: " + entry.getName());
                    }
                    long table = elf.getLong(32);
                    int size = Short.toUnsignedInt(elf.getShort(54));
                    int segments = Short.toUnsignedInt(elf.getShort(56));
                    if (table < 64 || table > bytes.length || size < 56 || segments == 0
                            || (long) size * segments > bytes.length - table) {
                        throw new IllegalArgumentException("Invalid ELF program headers: " + entry.getName());
                    }
                    boolean loaded = false;
                    for (int i = 0; i < segments; i++) {
                        int start = (int) table + i * size;
                        if (elf.getInt(start) != 1) continue;
                        loaded = true;
                        if (elf.getLong(start + 48) < 16384
                                || elf.getLong(start + 8) % 16384 != elf.getLong(start + 16) % 16384) {
                            throw new IllegalArgumentException("ELF LOAD segment is not 16 KiB aligned: " + entry.getName());
                        }
                    }
                    if (!loaded) throw new IllegalArgumentException("ELF has no LOAD segment: " + entry.getName());
                    count++;
                }
            }
        }
        System.out.println("PROTONNCORD_ALIGNED_ELFS=" + count);
    }
}
