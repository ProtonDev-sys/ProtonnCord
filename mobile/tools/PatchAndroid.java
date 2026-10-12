/* SPDX-License-Identifier: GPL-3.0-or-later */

import java.io.File;
import java.io.OutputStream;
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
    }
}
