#!/usr/bin/env python3
"""Exercise the patched Android client on a fresh emulator without a Discord account."""
# SPDX-License-Identifier: GPL-3.0-or-later

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import struct
import subprocess
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile

from patch_android import MOBILE, bootstrap_files, file_digest

PLUGIN = "uk.co.protonn.secure-messaging"
PROBE = "uk.co.protonn.android-smoke"
DATA = "/data/user/0/com.discord"
PIXEL_LAUNCHER = "com.google.android.apps.nexuslauncher"


def command(args, binary=False, timeout=90):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=not binary, timeout=timeout)
    if result.returncode:
        error = result.stderr or result.stdout
        if isinstance(error, bytes):
            error = error.decode(errors="replace")
        raise RuntimeError(f"Android command failed: {error[-8000:]}")
    return result.stdout if binary else result.stdout.strip()


def seed_probe(directory, defaults, runtime_url):
    """Add observation only after the APK's own first launch has been verified."""
    target = directory / "files/revenge/plugins/dist" / PLUGIN
    target.mkdir(parents=True)
    prefix = f"files/revenge/plugins/dist/{PLUGIN}/"
    manifest = json.loads(defaults[prefix + "manifest.json"].decode("utf-8"))
    script = target / "index.js"
    observer = (MOBILE / "tools/android_client_start.js").read_text()
    script.write_text("(" + observer.replace("__PROTONNCORD_PLUGIN_SCRIPT__", json.dumps(defaults[prefix + "index.js"].decode("utf-8"))) + ")()")
    probe = target.parent / PROBE
    probe.mkdir()
    (probe / "manifest.json").write_text(json.dumps({
        "format": 1, "id": PROBE, "name": "Protonn Cord Android test", "version": "0.0.1",
        "description": "Disposable emulator probe", "author": "Protonn Cord",
        "dependencies": {**manifest["dependencies"], PLUGIN: {}}, "dist": {"script": "index.js"},
    }))
    source = (MOBILE / "tools/android_client_probe.js").read_text()
    # Native evaluates `return <script>`; put comments inside the expression so
    # a leading license newline cannot trigger automatic semicolon insertion.
    (probe / "index.js").write_text("(" + source.replace("__PROTONNCORD_RUNTIME_URL__", json.dumps(runtime_url)) + ")()")
    # Preserve an explicit disabled/removed entry across restart, using the pinned V1 format.
    flags = bytearray(struct.pack(">ii", 1, 3))
    for plugin_id, enabled in ((PLUGIN, 1), (PROBE, 1), ("uk.co.protonn.removed-example", 0)):
        encoded = plugin_id.encode("ascii")
        flags.extend(struct.pack(">H", len(encoded)) + encoded + struct.pack(">i", enabled))
    (directory / "files/revenge/plugins/states").write_bytes(flags)
    sentinel = directory / "files/revenge/plugins/storage" / PROBE / "preserved.bin"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_bytes(b"existing plugin data\x00\xff")
    return {path.relative_to(directory).as_posix(): path.read_bytes() for path in directory.rglob("*") if path.is_file()}


def verify_inputs(options):
    pins = json.loads((MOBILE / "android-distribution.json").read_text())
    toolchain = json.loads((MOBILE / "toolchain.json").read_text())
    receipt = json.loads((options.apk_dir / "build-receipt.json").read_text())
    if receipt["packageName"] != "com.discord" or receipt["versionCode"] != pins["discord"]["versionCode"]:
        raise ValueError("Unexpected Discord build receipt")
    if any(receipt[name] != pins[name] for name in ("loader", "lspatch", "editor", "xposedApi", "patcherSource")) \
            or receipt["runtime"] != toolchain or receipt["inputs"] != pins["discord"]["apks"]:
        raise ValueError("The standalone APK does not match the current toolchain")
    if receipt["abi"] != "universal" or set(receipt["outputs"]) != {"ProtonnCord.apk"}:
        raise ValueError("Expected one standalone APK with both 64-bit ABIs")
    if receipt["sourceCommit"] != command(["git", "-C", MOBILE.parent, "rev-parse", "HEAD"]):
        raise ValueError("The APK was built from a different source checkout")
    apk = options.apk_dir / "ProtonnCord.apk"
    if file_digest(apk) != receipt["outputs"][apk.name]:
        raise ValueError("An APK changed after build verification")
    version, defaults = bootstrap_files(options.plugin, options.runtime, toolchain)
    if receipt["bootstrap"]["pluginVersion"] != version \
            or receipt["bootstrap"]["files"] != {name: hashlib.sha256(value).hexdigest() for name, value in defaults.items()}:
        raise ValueError("The APK does not bundle the supplied plugin and pinned runtime")
    return receipt, apk, defaults, f"https://github.com/ProtonDev-sys/ProtonnCord/releases/download/{toolchain['runtimeRelease']}/revenge.bundle"


def set_adbd_root(adb, enabled):
    action, expected_uid = ("root", "0") if enabled else ("unroot", "2000")
    closed = False
    try:
        adb(action, timeout=15)
    except RuntimeError as error:
        # adbd can close the control connection while restarting. Do not repeat
        # the mutation: wait for that same serial and prove the requested UID.
        if str(error).strip() != f"Android command failed: adb: unable to connect for {action}: closed":
            raise
        closed = True
    adb("wait-for-device", timeout=30)
    if adb("shell", "id -u", timeout=10) != expected_uid:
        raise ValueError(f"ADB {action} did not reach expected UID {expected_uid}")
    return closed


def check_files(adb, expected, native_config=False):
    hashes = {}
    for name, value in sorted(expected.items()):
        actual = adb("exec-out", "cat", f"{DATA}/{name}", binary=True)
        # The probe exercises the native AtomicFile writer, which omits the final LF.
        if actual != value and not (native_config and name == "files/pyoncord/loader.json" and actual == value[:-1]):
            raise RuntimeError(f"The client changed or did not install {name}")
        hashes[name] = hashlib.sha256(actual).hexdigest()
    vault = f"{DATA}/files/revenge/plugins/storage/{PLUGIN}/secure-vault.bin"
    adb("shell", f"test ! -e {vault} && test ! -e {vault}.bak && test ! -e {vault}.new")
    return hashes


def wait_for_login_screen(adb, remote_ui, output, progress, original_pid, timeout=45):
    started = time.monotonic()
    deadline = started + timeout

    def bounded_adb(*args, limit=10, **kwargs):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Discord's signed-out login/register screen did not become ready; inspect screen.png")
        return adb(*args, timeout=min(limit, remaining), **kwargs)

    try:
        if not re.fullmatch(r"\d+", original_pid):
            raise RuntimeError("Discord's client process is missing or ambiguous")
        while time.monotonic() < deadline:
            progress["attempts"] = progress.get("attempts", 0) + 1
            bounded_adb("shell", f"rm -f {remote_ui}")
            # DumpCommand can exit zero without writing XML. Its idle wait alone takes up to 10 seconds.
            dump = bounded_adb("shell", f"uiautomator dump {remote_ui} 2>&1", limit=20)
            if f"UI hierchary dumped to: {remote_ui}" not in dump.splitlines():
                progress["lastDumpError"] = dump[-1000:]
                if not {"ERROR: null root node returned by UiTestAutomationBridge.",
                        "ERROR: could not get idle state."}.intersection(dump.splitlines()):
                    raise RuntimeError("Android did not confirm a fresh UI hierarchy dump")
                time.sleep(min(2, max(0, deadline - time.monotonic())))
                continue
            hierarchy = bounded_adb("shell", f"cat {remote_ui}")
            (output / "hierarchy.xml").write_text(hierarchy)
            windows = bounded_adb("shell", "dumpsys window displays")
            focuses = re.findall(r"^\s*mCurrentFocus=(.+)$", windows, re.MULTILINE)
            focus = focuses[0].strip() if len(focuses) == 1 else ""
            progress["lastFocus"] = focus
            if bounded_adb("shell", "pidof com.discord") != original_pid:
                raise RuntimeError("Discord's client process changed while waiting for the login screen")
            nodes = list(ET.fromstring(hierarchy).iter("node"))

            def system_node(resource_id, text, clickable=False):
                matches = [node for node in nodes if node.get("resource-id") == resource_id]
                return len(matches) == 1 and matches[0].get("package") == "android" \
                    and matches[0].get("text") == text and matches[0].get("enabled") == "true" \
                    and (not clickable or matches[0].get("clickable") == "true")

            # Android's ANR window title identifies the process independently of its display name.
            launcher_anr = re.fullmatch(r"Window\{[0-9a-f]+ u0 Application Not Responding: "
                                        + re.escape(PIXEL_LAUNCHER) + r"\}", focus) \
                and system_node("android:id/alertTitle", "Pixel Launcher isn't responding") \
                and system_node("android:id/aerr_close", "Close app", True) \
                and system_node("android:id/aerr_wait", "Wait", True)
            error_dialog = any(node.get("resource-id", "").split(":")[-1] in
                               {"id/alertTitle", "id/aerr_close", "id/aerr_wait", "id/aerr_restart"} for node in nodes)
            if launcher_anr and "launcherRecovery" not in progress:
                # run() has already verified a fresh emulator. Never tap a dialog button or restart Discord.
                progress["launcherRecovery"] = {"package": PIXEL_LAUNCHER, "action": "force-stop",
                                                "focus": focus, "hierarchy": hierarchy}
                bounded_adb("shell", f"am force-stop --user 0 {PIXEL_LAUNCHER}")
            elif error_dialog or "Application Not Responding:" in focus or "Application Error:" in focus:
                raise RuntimeError("An unexpected or repeated Android error dialog covers Discord; inspect hierarchy.xml")
            else:
                labels = {node.get(field, "").casefold() for node in nodes
                          if node.get("package") == "com.discord" and node.get("enabled") == "true"
                          for field in ("text", "content-desc")}
                if re.fullmatch(r"Window\{[0-9a-f]+ u0 com\.discord/[A-Za-z0-9_.$]+\}", focus) \
                        and labels.intersection({"log in", "login"}) \
                        and labels.intersection({"register", "sign up", "create an account"}):
                    (output / "screen.png").write_bytes(bounded_adb("exec-out", "screencap", "-p", binary=True))
                    return
            time.sleep(min(2, max(0, deadline - time.monotonic())))
        raise RuntimeError("Discord's signed-out login/register screen did not become ready; inspect screen.png")
    finally:
        progress["elapsedSeconds"] = round(time.monotonic() - started, 3)


def launch_client(adb, activity, remote_ui, output, progress, runtime_url, first=False):
    adb("logcat", "-c")
    adb("shell", f"am start -W -n {shlex.quote(activity)}", timeout=60)
    pid = adb("shell", "pidof com.discord")
    if not re.fullmatch(r"\d+", pid):
        raise RuntimeError("Discord's client process is missing or ambiguous")
    progress["pid"] = pid
    expected = {"loader": {"name": "RevengeXposed", "version": "1.6.2"}, "signedOut": True,
                "nativePlugin": PLUGIN, "vault": "absent", "runtimeUrl": runtime_url}
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        log = adb("logcat", "-d", "-v", "brief", timeout=10)
        (output / "logcat.txt").write_text(log)
        if adb("shell", "pidof com.discord", timeout=10) != pid:
            raise RuntimeError("Discord restarted before its startup checks completed")
        lines = re.findall(r"^[A-Z]/[^\n(]+\(\s*" + re.escape(pid) + r"\): (.*)$", log, re.MULTILINE)
        if any("PROTONNCORD_ANDROID_FAIL " in line for line in lines):
            raise RuntimeError("The in-client native/plugin probe failed; inspect logcat.txt")
        if any(f"Plugin {PLUGIN} threw in start()" in line or f"Failed to load plugin {PLUGIN}:" in line for line in lines):
            raise RuntimeError("The APK's native plugin failed to start; inspect logcat.txt")
        if first:
            ready = "ProtonnCord: bundled runtime and plugin installed" in lines \
                and f"pluginLoader - Started plugin: {PLUGIN}" in lines
        else:
            markers = {}
            for line in lines:
                match = re.fullmatch(r"(PROTONNCORD_ANDROID_PASS|PROTONNCORD_ANDROID_JS_STARTED) (\{.*\})", line)
                if match:
                    markers[match[1]] = json.loads(match[2])
            ready = markers.get("PROTONNCORD_ANDROID_PASS") == expected \
                and markers.get("PROTONNCORD_ANDROID_JS_STARTED") == {"plugin": PLUGIN, "started": True}
        if ready:
            progress["uiReadiness"] = {}
            wait_for_login_screen(adb, remote_ui, output, progress["uiReadiness"], pid)
            progress.update(loginScreen=True, nativePluginStarted=True)
            if not first:
                progress.update(smoke=expected, javaScriptStarted=True)
            return
        time.sleep(2)
    raise RuntimeError("The APK bootstrap or native/JavaScript startup checks did not complete; inspect logcat.txt")


def run(options):
    receipt, apk, defaults, runtime_url = verify_inputs(options)
    if not re.fullmatch(r"emulator-\d+", options.serial):
        raise ValueError("Use an explicit emulator-NNNN serial; physical devices are not accepted")
    adb = lambda *args, **kwargs: command([os.environ.get("ADB_BIN", "adb"), "-s", options.serial, *args], **kwargs)
    if adb("shell", "getprop ro.kernel.qemu") != "1":
        raise ValueError("The selected target is not an Android emulator")
    if adb("shell", "pm list packages -u com.discord"):
        raise ValueError("Use a fresh emulator without an existing Discord installation")
    api = int(adb("shell", "getprop ro.build.version.sdk"))
    abi = adb("shell", "getprop ro.product.cpu.abilist").split(",")[0]
    if api < 28 or abi not in ("arm64-v8a", "x86_64"):
        raise ValueError("The emulator API or ABI does not match the standalone APK")
    options.output.mkdir(parents=True, exist_ok=False)
    first_output = options.output / "first-launch"
    first_output.mkdir()
    installed = False
    remote_seed = "/data/local/tmp/protonncord-client-" + uuid.uuid4().hex
    remote_ui = remote_seed + ".xml"
    result = {"status": "failed", "api": api, "abi": abi, "firstLaunch": {}, "restart": {}}
    try:
        # Prove a normal APK-owned first launch before any private-data fixture writes.
        result["firstLaunch"]["adbdRestartConnectionClosed"] = set_adbd_root(adb, False)
        adb("install", apk, timeout=180)
        installed = True
        uid = re.fullmatch(r"package:com\.discord uid:(\d+)", adb("shell", "pm list packages -U com.discord"))
        if not uid or int(uid[1]) < 10000:
            raise ValueError("Unexpected Discord sandbox UID")
        activity = adb("shell", "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.discord").splitlines()[-1]
        if not re.fullmatch(r"com\.discord/[A-Za-z0-9_.$]+", activity):
            raise ValueError("Discord launcher activity was not resolved")
        launch_client(adb, activity, remote_ui, first_output, result["firstLaunch"], runtime_url, first=True)
        adb("shell", "am force-stop com.discord")
        result["firstLaunch"]["inspectionAdbdRestartConnectionClosed"] = set_adbd_root(adb, True)
        result["firstLaunch"].update(status="passed", verifiedBeforeTestWrites=True, files=check_files(adb, defaults))

        with tempfile.TemporaryDirectory(prefix="android-client-probe-", dir=options.output) as temporary:
            seed = Path(temporary)
            observed = seed_probe(seed, defaults, runtime_url)
            adb("shell", f"mkdir {remote_seed}")
            adb("push", f"{seed}/.", remote_seed)
            adb("shell", f"cp -R {remote_seed}/. {DATA}/ && chown -R {uid[1]}:{uid[1]} {DATA}/files && restorecon -R {DATA}/files")
            adb("shell", f"rm -rf {remote_seed}")
            # Android may evict cache at any time. The APK must restore its owned
            # runtime without resetting the observed script, disabled flags or data.
            adb("shell", f"rm {DATA}/cache/revenge/bundle.js && test ! -e {DATA}/cache/revenge/bundle.js")
            result["restart"]["cacheRemovedBeforeLaunch"] = True
            result["restart"]["adbdRestartConnectionClosed"] = set_adbd_root(adb, False)
            launch_client(adb, activity, remote_ui, options.output, result["restart"], runtime_url)
            adb("shell", "am force-stop com.discord")
            result["restart"]["inspectionAdbdRestartConnectionClosed"] = set_adbd_root(adb, True)
            files = check_files(adb, {**defaults, **observed}, native_config=True)
            adb("shell", f"test ! -e {DATA}/files/revenge/plugins/dist/uk.co.protonn.removed-example")
            result["restart"].update(status="passed", cacheRestored=True, statePreserved=True, files=files)
        result.update(status="passed", smoke=result["restart"]["smoke"], javaScriptStarted=True, loginScreen=True,
                      runtimeSha256=file_digest(options.runtime), pluginSha256=file_digest(options.plugin), apkReceipt=receipt)
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        if installed:
            if result["status"] != "passed":
                for args, path, binary in [(('logcat', '-d', '-v', 'brief'), 'failure-logcat.txt', False),
                                           (('exec-out', 'screencap', '-p'), 'failure-screen.png', True)]:
                    try:
                        content = adb(*args, binary=binary)
                        (options.output / path).write_bytes(content if binary else content.encode())
                    except Exception:
                        pass
            for args in [("shell", "am force-stop com.discord"), ("uninstall", "com.discord"),
                         ("shell", f"rm -rf {remote_seed} {remote_ui}"), ("unroot",)]:
                try:
                    adb(*args)
                except Exception:
                    pass
        (options.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"Standalone APK smoke passed: API {api}, {abi}; reports in {options.output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--apk-dir", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--plugin", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    try:
        run(parser.parse_args())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, zipfile.BadZipFile) as error:
        parser.exit(1, f"Android client smoke stopped: {error}\n")
