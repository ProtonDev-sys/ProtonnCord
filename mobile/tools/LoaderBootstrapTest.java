/* SPDX-License-Identifier: GPL-3.0-or-later */
package uk.co.protonn.bootstrap;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/** JVM failure/retry checks for the actual bootstrap and exact bundled payload. Never DEXed. */
public final class LoaderBootstrapTest {
    private static void require(boolean condition) {
        if (!condition) throw new AssertionError("Bootstrap invariant failed");
    }

    private static void fails(Path data, File module) throws Exception {
        try {
            LoaderBootstrap.install(data, module);
            throw new AssertionError("Invalid or interrupted setup succeeded");
        } catch (IOException expected) {
            require(!Files.exists(data.resolve("files/revenge")));
        }
    }

    public static void main(String[] args) throws Exception {
        File module = new File(args[0]);
        Path root = Files.createTempDirectory(new File(args[1]).toPath(), "bootstrap-test-");
        Path fresh = root.resolve("fresh");
        require(LoaderBootstrap.install(fresh, module));
        for (String name : LoaderBootstrap.FILES) require(Files.size(fresh.resolve(name)) > 0);
        require(!Files.exists(fresh.resolve("files/.protonncord-installing")));
        require(!Files.exists(fresh.resolve("files/revenge/plugins/storage")));

        // Preserve a disabled plugin, its removal, unrelated flags, and opaque saved data on restart.
        Path states = fresh.resolve("files/revenge/plugins/states");
        byte[] disabled = Files.readAllBytes(states);
        disabled[disabled.length - 1] = 0;
        Files.write(states, disabled);
        Path script = fresh.resolve(LoaderBootstrap.PLUGIN + "index.js");
        Files.delete(script);
        Path saved = fresh.resolve("files/revenge/plugins/storage/user-data");
        Files.createDirectories(saved.getParent());
        Files.write(saved, new byte[] {7, 8, 9});
        require(!LoaderBootstrap.install(fresh, module));
        require(!Files.exists(script) && Arrays.equals(Files.readAllBytes(states), disabled));
        require(Arrays.equals(Files.readAllBytes(saved), new byte[] {7, 8, 9}));

        Path evicted = fresh.resolve("cache/revenge/bundle.js");
        byte[] runtime = Files.readAllBytes(evicted);
        Files.delete(evicted);
        require(!LoaderBootstrap.install(fresh, module));
        require(Arrays.equals(runtime, Files.readAllBytes(evicted)));
        require(!Files.exists(script) && Arrays.equals(Files.readAllBytes(states), disabled));
        Path selected = fresh.resolve("files/pyoncord/loader.json");
        byte[] selection = Files.readAllBytes(selected);
        Files.write(selected, Arrays.copyOf(selection, selection.length - 1));
        Files.write(evicted, new byte[0]);
        require(!LoaderBootstrap.install(fresh, module));
        require(Arrays.equals(runtime, Files.readAllBytes(evicted)));
        Files.write(selected, new byte[] {1, 2, 3});
        Files.delete(evicted);
        require(!LoaderBootstrap.install(fresh, module));
        require(!Files.exists(evicted) && Arrays.equals(Files.readAllBytes(selected), new byte[] {1, 2, 3}));

        Path classic = root.resolve("classic");
        Path config = classic.resolve("files/pyoncord/loader.json");
        Files.createDirectories(config.getParent());
        Files.write(config, new byte[] {1, 2, 3});
        require(!LoaderBootstrap.install(classic, module));
        require(!Files.exists(classic.resolve("files/revenge")));
        require(Arrays.equals(Files.readAllBytes(config), new byte[] {1, 2, 3}));

        // A write failure after cache commit leaves no partial plugin and can be retried.
        Path retry = root.resolve("retry");
        Files.createDirectories(retry.resolve("files/.protonncord-installing"));
        Path blocker = retry.resolve("files/pyoncord");
        Files.write(blocker, new byte[] {0});
        fails(retry, module);
        require(Files.size(retry.resolve("cache/revenge/bundle.js")) > 0);
        Files.delete(blocker);
        require(LoaderBootstrap.install(retry, module));

        // A user change during interrupted setup cannot be silently overwritten on retry.
        Path changed = root.resolve("changed");
        Files.createDirectories(changed.resolve("files/.protonncord-installing"));
        Files.write(changed.resolve("files/pyoncord"), new byte[] {0});
        fails(changed, module);
        Path cache = changed.resolve("cache/revenge/bundle.js");
        Files.write(cache, new byte[] {3, 4, 5});
        Files.delete(changed.resolve("files/pyoncord"));
        fails(changed, module);
        require(Arrays.equals(Files.readAllBytes(cache), new byte[] {3, 4, 5}));

        // Reject incomplete payloads and path traversal before exposing a plugin directory.
        for (boolean traversal : new boolean[] {false, true}) {
            File malformed = root.resolve("malformed-" + traversal + ".apk").toFile();
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (ZipOutputStream payload = new ZipOutputStream(bytes); ZipFile original = new ZipFile(module);
                 ZipInputStream input = new ZipInputStream(original.getInputStream(original.getEntry("assets/protonncord/bootstrap.zip")))) {
                byte[] buffer = new byte[65536];
                for (ZipEntry entry; (entry = input.getNextEntry()) != null;) {
                    if (entry.getName().equals("files/revenge/plugins/states")) continue;
                    payload.putNextEntry(new ZipEntry(entry.getName()));
                    for (int count; (count = input.read(buffer)) != -1;) payload.write(buffer, 0, count);
                }
                if (traversal) {
                    payload.putNextEntry(new ZipEntry("../../escaped"));
                    payload.write(1);
                }
            }
            try (ZipOutputStream apk = new ZipOutputStream(Files.newOutputStream(malformed.toPath()))) {
                apk.putNextEntry(new ZipEntry("assets/protonncord/bootstrap.zip"));
                apk.write(bytes.toByteArray());
            }
            fails(root.resolve("invalid-" + traversal), malformed);
            require(!Files.exists(root.resolve("escaped")));
        }
        System.out.println("Bootstrap: fresh install, preservation, failure/retry, conflict, and archive checks passed");
    }
}
