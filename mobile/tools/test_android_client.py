#!/usr/bin/env python3
"""Exercise the patched Android client on a fresh emulator without a Discord account."""
# SPDX-License-Identifier: GPL-3.0-or-later

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile

from patch_android import MOBILE, file_digest

PLUGIN = "uk.co.protonn.secure-messaging"
PROBE = "uk.co.protonn.android-smoke"
DATA = "/data/user/0/com.discord"


def command(args, binary=False, timeout=90):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=not binary, timeout=timeout)
    if result.returncode:
        error = result.stderr or result.stdout
        if isinstance(error, bytes):
            error = error.decode(errors="replace")
        raise RuntimeError(f"Android command failed: {error[-8000:]}")
    return result.stdout if binary else result.stdout.strip()


def seed_files(directory, plugin_zip, runtime, runtime_url, fixture_url):
    target = directory / "files/revenge/plugins/dist" / PLUGIN
    target.mkdir(parents=True)
    with zipfile.ZipFile(plugin_zip) as archive:
        for name in ("manifest.json", "index.js", "plugin.jar"):
            if archive.getinfo(name).file_size > 64 * 1024 * 1024:
                raise ValueError("Unexpectedly large plugin fixture")
            (target / name).write_bytes(archive.read(name))
    manifest = json.loads((target / "manifest.json").read_text())
    if manifest["id"] != PLUGIN or manifest["dist"].get("script") != "index.js" or manifest["dist"]["android"]["path"] != "plugin.jar":
        raise ValueError("The input is not the expected Secure Messaging plugin")
    script = target / "index.js"
    observer = (MOBILE / "tools/android_client_start.js").read_text()
    script.write_text("(" + observer.replace("__PROTONNCORD_PLUGIN_SCRIPT__", json.dumps(script.read_text())) + ")()")
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
    # RevengeXposed 1602's DataOutputStream V1 state format. Both IDs are ASCII.
    flags = bytearray(struct.pack(">ii", 1, 2))
    for plugin_id in (PLUGIN, PROBE):
        encoded = plugin_id.encode("ascii")
        flags.extend(struct.pack(">H", len(encoded)) + encoded + struct.pack(">i", 1))
    (directory / "files/revenge/plugins/states").write_bytes(flags)
    loader = directory / "files/pyoncord"
    loader.mkdir(parents=True)
    (loader / "loader.json").write_text(json.dumps({"customLoadUrl": {"enabled": True, "url": fixture_url}}))
    cache = directory / "cache/revenge"
    cache.mkdir(parents=True)
    shutil.copyfile(runtime, cache / "bundle.js")
    (cache / "etag.txt").write_text('"protonncord-fixture"')


def verify_inputs(options):
    pins = json.loads((MOBILE / "android-distribution.json").read_text())
    toolchain = json.loads((MOBILE / "toolchain.json").read_text())
    receipt = json.loads((options.apk_dir / "build-receipt.json").read_text())
    if receipt["packageName"] != "com.discord" or receipt["versionCode"] != pins["discord"]["versionCode"]:
        raise ValueError("Unexpected Discord build receipt")
    if receipt["loader"] != pins["loader"] or receipt["lspatch"] != pins["lspatch"] or receipt["runtime"] != toolchain:
        raise ValueError("The APK set does not match the current toolchain")
    assets = [asset for asset in pins["discord"]["apks"] if asset.get("abi", receipt["abi"]) == receipt["abi"]]
    expected = {Path(asset["file"]).stem + "-487-lspatched.apk" for asset in assets}
    if receipt["abi"] not in ("arm64-v8a", "x86_64") or set(receipt["outputs"]) != expected:
        raise ValueError("Unexpected APK split set")
    apks = [options.apk_dir / name for name in sorted(expected)]
    if any(file_digest(path) != receipt["outputs"][path.name] for path in apks):
        raise ValueError("An APK changed after build verification")
    if options.runtime.stat().st_size == 0:
        raise ValueError("The compiled Revenge runtime is empty")
    return receipt, apks, f"https://github.com/ProtonDev-sys/ProtonnCord/releases/download/{toolchain['runtimeRelease']}/revenge.bundle"


def run(options):
    receipt, apks, runtime_url = verify_inputs(options)
    if not re.fullmatch(r"emulator-\d+", options.serial):
        raise ValueError("Use an explicit emulator-NNNN serial; physical devices are not accepted")
    adb = lambda *args, **kwargs: command([os.environ.get("ADB_BIN", "adb"), "-s", options.serial, *args], **kwargs)
    if adb("shell", "getprop ro.kernel.qemu") != "1":
        raise ValueError("The selected target is not an Android emulator")
    if adb("shell", "pm list packages -u com.discord"):
        raise ValueError("Use a fresh emulator without an existing Discord installation")
    api = int(adb("shell", "getprop ro.build.version.sdk"))
    if api < 28 or receipt["abi"] not in adb("shell", "getprop ro.product.cpu.abilist").split(","):
        raise ValueError("The emulator API or ABI does not match this APK set")
    options.output.mkdir(parents=True, exist_ok=False)
    installed = False
    server = None
    remote_seed = "/data/local/tmp/protonncord-client-" + uuid.uuid4().hex
    remote_ui = remote_seed + ".xml"
    result = {"status": "failed", "api": api, "abi": receipt["abi"]}
    try:
        class CachedRuntime(BaseHTTPRequestHandler):
            requests = 0

            def do_GET(self):
                if self.path != "/revenge.bundle":
                    self.send_error(404)
                    return
                type(self).requests += 1
                self.send_response(304)
                self.send_header("ETag", '"protonncord-fixture"')
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), CachedRuntime)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with tempfile.TemporaryDirectory(prefix="android-client-seed-", dir=options.output) as temporary:
            seed = Path(temporary)
            seed_files(seed, options.plugin, options.runtime, runtime_url, f"http://127.0.0.1:{port}/revenge.bundle")
            adb("install-multiple", *apks, timeout=180)
            installed = True
            adb("root")
            adb("wait-for-device")
            if adb("shell", "id -u") != "0":
                raise ValueError("Use a userdebug emulator supporting adb root for fixture setup")
            uid = re.fullmatch(r"package:com\.discord uid:(\d+)", adb("shell", "pm list packages -U com.discord"))
            if not uid or int(uid[1]) < 10000:
                raise ValueError("Unexpected Discord sandbox UID")
            adb("shell", f"mkdir {remote_seed}")
            adb("push", f"{seed}/.", remote_seed)
            adb("shell", f"cp -R {remote_seed}/. {DATA}/ && chown -R {uid[1]}:{uid[1]} {DATA}/files {DATA}/cache && restorecon -R {DATA}/files {DATA}/cache")
            adb("shell", f"rm -rf {remote_seed}")
            adb("unroot")
            adb("wait-for-device")
            if adb("shell", "id -u") == "0":
                raise ValueError("ADB must be unprivileged during the client launch")
            # An adbd restart discards reverse mappings, so install it after unroot.
            adb("reverse", f"tcp:{port}", f"tcp:{port}")
            adb("logcat", "-c")
            activity = adb("shell", "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.discord").splitlines()[-1]
            if not re.fullmatch(r"com\.discord/[A-Za-z0-9_.$]+", activity):
                raise ValueError("Discord launcher activity was not resolved")
            adb("shell", f"am start -W -n {shlex.quote(activity)}")
            deadline = time.monotonic() + 90
            smoke = None
            js_started = False
            while time.monotonic() < deadline:
                log = adb("logcat", "-d", "-v", "brief")
                (options.output / "logcat.txt").write_text(log)
                if "PROTONNCORD_ANDROID_FAIL " in log:
                    raise RuntimeError("The in-client native/plugin probe failed; inspect logcat.txt")
                match = re.search(r"PROTONNCORD_ANDROID_PASS (\{[^\n]+\})", log)
                if match:
                    smoke = json.loads(match[1])
                match = re.search(r"PROTONNCORD_ANDROID_JS_STARTED (\{[^\n]+\})", log)
                if match:
                    js_started = json.loads(match[1]) == {"plugin": PLUGIN, "started": True}
                if smoke and js_started:
                    break
                adb("shell", "pidof com.discord")
                time.sleep(2)
            if smoke != {"loader": {"name": "RevengeXposed", "version": "1.6.2"}, "signedOut": True,
                         "nativePlugin": PLUGIN, "vault": "absent", "runtimeUrl": runtime_url} or not js_started:
                raise RuntimeError("The native probe and plugin start did not both succeed; inspect logcat.txt")
            adb("shell", f"uiautomator dump {remote_ui}")
            hierarchy = adb("shell", f"cat {remote_ui}")
            (options.output / "hierarchy.xml").write_text(hierarchy)
            (options.output / "screen.png").write_bytes(adb("exec-out", "screencap", "-p", binary=True))
            labels = {node.get(field, "").casefold() for node in ET.fromstring(hierarchy).iter("node") for field in ("text", "content-desc")}
            if not labels.intersection({"log in", "login"}) or not labels.intersection({"register", "sign up", "create an account"}):
                raise RuntimeError("Discord's signed-out login/register screen is missing; inspect screen.png")
            if not CachedRuntime.requests:
                raise RuntimeError("The pinned runtime cache fixture was not used")
            adb("root")
            adb("wait-for-device")
            actual_hash = adb("shell", f"sha256sum {DATA}/cache/revenge/bundle.js").split()[0]
            if actual_hash != file_digest(options.runtime):
                raise RuntimeError("The running runtime was replaced after fixture setup")
            vault = f"{DATA}/files/revenge/plugins/storage/{PLUGIN}/secure-vault.bin"
            adb("shell", f"test ! -e {vault} && test ! -e {vault}.bak && test ! -e {vault}.new")
            result.update(status="passed", smoke=smoke, javaScriptStarted=js_started, loginScreen=True, runtimeSha256=actual_hash,
                          pluginSha256=file_digest(options.plugin), apkReceipt=receipt)
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        if installed:
            for args, path, binary in [(('logcat', '-d', '-v', 'brief'), 'logcat.txt', False),
                                       (('exec-out', 'screencap', '-p'), 'screen.png', True)]:
                try:
                    content = adb(*args, binary=binary)
                    (options.output / path).write_bytes(content if binary else content.encode())
                except Exception:
                    pass
            for args in [("shell", "am force-stop com.discord"), ("uninstall", "com.discord"),
                         ("reverse", "--remove", f"tcp:{port}"), ("shell", f"rm -rf {remote_seed} {remote_ui}"), ("unroot",)]:
                try:
                    adb(*args)
                except Exception:
                    pass
        if server is not None:
            server.shutdown()
            server.server_close()
        (options.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"Android client smoke passed: API {api}, {receipt['abi']}; reports in {options.output}")


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
