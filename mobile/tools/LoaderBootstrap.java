/* SPDX-License-Identifier: GPL-3.0-or-later */
package uk.co.protonn.bootstrap;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.IXposedHookZygoteInit;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/** Seed a fresh installation, then delegate to the unchanged, pinned Revenge loader. */
public final class LoaderBootstrap implements IXposedHookZygoteInit, IXposedHookLoadPackage {
    private Object delegate;
    private File module;

    @Override
    public void initZygote(StartupParam param) throws Throwable {
        module = new File(param.modulePath);
        delegate = Class.forName("io.github.revenge.xposed.Main", true, getClass().getClassLoader())
                .getDeclaredConstructor().newInstance();
        ((IXposedHookZygoteInit) delegate).initZygote(param);
    }

    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam param) throws Throwable {
        if (!"com.discord".equals(param.packageName) || !param.packageName.equals(param.processName)) return;
        Object appInfo = XposedHelpers.getObjectField(param, "appInfo");
        File data = new File((String) XposedHelpers.getObjectField(appInfo, "dataDir"));
        if (install(data.toPath(), module)) XposedBridge.log("ProtonnCord: bundled runtime and plugin installed");
        ((IXposedHookLoadPackage) delegate).handleLoadPackage(param);
    }

    static final String PLUGIN = "files/revenge/plugins/dist/uk.co.protonn.secure-messaging/";
    static final Set<String> FILES = new HashSet<>(Arrays.asList(
            PLUGIN + "manifest.json", PLUGIN + "index.js", PLUGIN + "plugin.jar",
            "files/revenge/plugins/states", "files/revenge/plugins/repos/repos.json",
            "files/revenge/plugins/repos/sources.json", "files/pyoncord/loader.json", "cache/revenge/bundle.js"));

    /** The private staging directory also records an interrupted first install. */
    static boolean install(Path data, File module) throws IOException {
        Path target = data.resolve("files/revenge");
        Path stage = data.resolve("files/.protonncord-installing");
        // Never restore removed plugins, reset flags, or replace an existing mod configuration.
        if (Files.exists(target)) {
            restoreRuntime(data, module);
            return false;
        }
        if (!Files.exists(stage)
                && (Files.exists(data.resolve("files/pyoncord")) || Files.exists(data.resolve("cache/revenge")))) return false;
        Files.createDirectories(stage);
        try (ZipFile apk = new ZipFile(module)) {
            if (apk.getEntry("assets/protonncord/bootstrap.zip") == null) throw new IOException("Missing bundled defaults");
            Set<String> pending = new HashSet<>(FILES);
            long total = 0;
            try (ZipInputStream input = new ZipInputStream(apk.getInputStream(apk.getEntry("assets/protonncord/bootstrap.zip")))) {
                for (java.util.zip.ZipEntry entry; (entry = input.getNextEntry()) != null;) {
                    if (!pending.remove(entry.getName()) || entry.isDirectory()) throw new IOException("Unexpected bundled default");
                    Path output = stage.resolve(entry.getName());
                    Files.createDirectories(output.getParent());
                    try (FileOutputStream stream = new FileOutputStream(output.toFile())) {
                        byte[] buffer = new byte[65536];
                        for (int count; (count = input.read(buffer)) != -1;) {
                            total += count;
                            if (total > 64 * 1024 * 1024) throw new IOException("Bundled defaults exceed the size limit");
                            stream.write(buffer, 0, count);
                        }
                        stream.getFD().sync();
                    }
                }
            }
            if (!pending.isEmpty()) throw new IOException("Incomplete bundled defaults");
        }
        // Commit the plugin directory last: a failed write never exposes a partially installed plugin.
        // On retry, already committed cache/config files must still contain our exact initial bytes.
        commitDefault(stage, data, "cache/revenge/bundle.js");
        commitDefault(stage, data, "files/pyoncord/loader.json");
        Files.move(stage.resolve("files/revenge"), target, StandardCopyOption.ATOMIC_MOVE);
        try (java.util.stream.Stream<Path> paths = Files.walk(stage)) {
            for (Path path : (Iterable<Path>) paths.sorted(Comparator.reverseOrder())::iterator) Files.delete(path);
        } catch (IOException ignored) {
            // The plugin is already committed; temporary-directory cleanup must not prevent startup.
        }
        return true;
    }

    private static byte[] bundledFile(File module, String name) throws IOException {
        try (ZipFile apk = new ZipFile(module);
             ZipInputStream input = new ZipInputStream(apk.getInputStream(apk.getEntry("assets/protonncord/bootstrap.zip")))) {
            for (java.util.zip.ZipEntry entry; (entry = input.getNextEntry()) != null;) {
                if (!name.equals(entry.getName())) continue;
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[65536];
                for (int count; (count = input.read(buffer)) != -1;) {
                    if (output.size() + count > 16 * 1024 * 1024) throw new IOException("Bundled runtime exceeds the size limit");
                    output.write(buffer, 0, count);
                }
                return output.toByteArray();
            }
        }
        throw new IOException("Missing bundled runtime configuration");
    }

    private static void restoreRuntime(Path data, File module) throws IOException {
        Path cache = data.resolve("cache/revenge/bundle.js");
        Path config = data.resolve("files/pyoncord/loader.json");
        if ((Files.exists(cache) && Files.size(cache) != 0) || !Files.isRegularFile(config)) return;
        byte[] expected = bundledFile(module, "files/pyoncord/loader.json");
        byte[] actual = Files.readAllBytes(config);
        // The native updater serializes the same object without the seed's final newline.
        // Any other configuration is user-owned, so leave its runtime selection untouched.
        if (!Arrays.equals(expected, actual)
                && !Arrays.equals(Arrays.copyOf(expected, expected.length - 1), actual)) return;
        byte[] bundle = bundledFile(module, "cache/revenge/bundle.js");
        Files.createDirectories(cache.getParent());
        Path temporary = cache.resolveSibling(".protonncord-bundle.tmp");
        try (FileOutputStream stream = new FileOutputStream(temporary.toFile())) {
            stream.write(bundle);
            stream.getFD().sync();
        }
        Files.move(temporary, cache, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    private static void commitDefault(Path stage, Path data, String name) throws IOException {
        Path source = stage.resolve(name);
        Path target = data.resolve(name);
        Files.createDirectories(target.getParent());
        if (Files.exists(target)) {
            if (!Arrays.equals(Files.readAllBytes(source), Files.readAllBytes(target))) {
                throw new IOException("An existing loader file changed during initial setup");
            }
            Files.delete(source);
        } else {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        }
    }
}
