#!/usr/bin/env python3
"""Build a locally signed non-root APK set from independently authenticated inputs."""
# SPDX-License-Identifier: GPL-3.0-or-later

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import urllib.request
from urllib.parse import urlsplit
import zipfile

MOBILE = Path(__file__).resolve().parents[1]


def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(chunk)
    return result.hexdigest()


def file_digest(path):
    with path.open("rb") as stream:
        return digest(stream)


def check_hash(path, asset):
    if path.stat().st_size != asset["size"] or file_digest(path) != asset["sha256"]:
        raise ValueError(f"Input checksum mismatch: {path.name}")


class HttpsRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        if urlsplit(url).scheme != "https":
            raise ValueError("Download redirected away from HTTPS")
        return super().redirect_request(request, response, code, message, headers, url)


@contextmanager
def download_deadline(seconds=300):
    def expired(_signal, _frame):
        raise TimeoutError("Input download exceeded its total time limit")

    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def download(asset, cache):
    target = cache / (asset["sha256"][:12] + "-" + asset["file"])
    if target.exists():
        check_hash(target, asset)
        return target
    if urlsplit(asset["url"]).scheme != "https":
        raise ValueError("Only HTTPS input URLs are accepted")
    cache.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {asset['file']}", flush=True)
    with tempfile.TemporaryDirectory(prefix="download-", dir=cache) as directory:
        partial = Path(directory) / "input"
        request = urllib.request.Request(asset["url"], headers={"User-Agent": "ProtonnCord-build"})
        with download_deadline(), urllib.request.build_opener(HttpsRedirect()).open(request, timeout=60) as response:
            with partial.open("wb") as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > asset["size"]:
                        raise ValueError(f"Oversized download: {asset['file']}")
                    output.write(chunk)
        check_hash(partial, asset)
        partial.replace(target)
    return target


def run(args):
    result = subprocess.run([str(arg) for arg in args], text=True, capture_output=True, timeout=300)
    if result.returncode:
        error = result.stderr.strip() or result.stdout.strip() or "Android tool failed"
        for name in ("PROTONNCORD_STORE_PASS", "PROTONNCORD_KEY_PASS"):
            if secret := os.environ.get(name):
                error = error.replace(secret, "[redacted]")
        raise RuntimeError(error)
    return result.stdout


def parse_apk_info(signature, badging):
    certificates = re.findall(r"^Signer #(\d+) certificate SHA-256 digest: ([0-9a-fA-F]{64})$",
                              signature, re.MULTILINE)
    if len(certificates) != 1 or certificates[0][0] != "1" or "Number of signers: 1\n" not in signature:
        raise ValueError("Expected exactly one APK signer")
    if not re.search(r"^Verified using v[23](?:\.1)? scheme .*: true$", signature, re.MULTILINE):
        raise ValueError("APK must verify with a v2 or newer signature")
    if not badging.startswith("package: "):
        raise ValueError("Missing signed APK package metadata")
    fields = dict(re.findall(r"(\w+)='([^']*)'", badging.splitlines()[0]))
    if not fields.get("name") or not fields.get("versionCode", "").isdigit():
        raise ValueError("Invalid signed APK package metadata")
    return {"packageName": fields["name"], "versionCode": fields["versionCode"],
            "split": fields.get("split", ""), "signer": certificates[0][1].lower()}


def inspect_apk(java, build_tools, path, minimum_sdk=None):
    # Authenticate before asking aapt2 to parse the original package's resources.
    flags = [] if minimum_sdk is None else ["--min-sdk-version", str(minimum_sdk)]
    signature = run([java, "-jar", build_tools / "lib/apksigner.jar", "verify", "--verbose", "--print-certs", *flags, path])
    badging = run([build_tools / "aapt2", "dump", "badging", path])
    info = parse_apk_info(signature, badging)
    if minimum_sdk is not None and not info["split"]:
        if f"minSdkVersion:'{minimum_sdk}'" not in badging.splitlines() or "application-debuggable" in badging.splitlines():
            raise ValueError("Unexpected minimum Android version or debuggable base APK")
    return info


def check_set(infos, assets, discord, allowed_signers):
    if len(infos) != len(assets) or not infos:
        raise ValueError("Incomplete APK set")
    signer = infos[0]["signer"]
    if signer not in allowed_signers:
        raise ValueError("APK signer is not trusted")
    for info, asset in zip(infos, assets):
        if info != {"packageName": discord["packageName"], "versionCode": discord["versionCode"],
                    "split": asset["split"], "signer": signer}:
            raise ValueError("APK package, version, split, or signer does not match the pinned set")
    splits = [info["split"] for info in infos]
    if splits.count("") != 1 or len(set(splits)) != len(splits):
        raise ValueError("APK set must contain one base and unique splits")
    return signer


def check_patch_report(log, original):
    signer = re.findall(r"^PROTONNCORD_SIGNER=([0-9a-f]{64})$", log, re.MULTILINE)
    embedded = re.findall(r"^PROTONNCORD_ORIGINAL=([0-9a-f]{64})$", log, re.MULTILINE)
    if len(signer) != 1 or embedded != [original["sha256"]]:
        raise ValueError("Missing signing certificate or changed embedded original APK")
    return signer[0]


def check_embedded_loader(base, loader):
    with zipfile.ZipFile(base) as apk:
        module = "assets/lspatch/modules/io.github.revenge.xposed.apk"
        with apk.open(module) as stream:
            if digest(stream) != loader["sha256"]:
                raise ValueError("Embedded native loader differs from the verified input")
        config = json.loads(apk.read("assets/lspatch/config.json"))
        for key, expected in {"useManager": False, "debuggable": False, "sigBypassLevel": 0,
                              "injectDex": False, "addedPermissions": [], "injectDocumentsProvider": False}.items():
            if config.get(key) != expected:
                raise ValueError(f"Unexpected LSPatch configuration: {key}")


def build(options):
    pins = json.loads((MOBILE / "android-distribution.json").read_text())
    toolchain = json.loads((MOBILE / "toolchain.json").read_text())
    if pins["loader"]["revision"] != toolchain["revengeNativeRevision"]:
        raise ValueError("Review the distribution loader pin after changing the mobile toolchain")
    java_home = os.environ.get("JAVA_HOME")
    if not java_home:
        raise ValueError("Set JAVA_HOME to a JDK 21 or newer installation")
    java = Path(java_home).resolve() / "bin/java"
    version = re.search(r"(?:openjdk|java) (\d+)", run([java, "--version"]))
    if not version or int(version[1]) < 21 or not (java.parent / "javac").is_file():
        raise ValueError("JDK 21 or newer is required for the pinned LSPatch source launcher")
    build_tools = options.build_tools.resolve()
    if not (build_tools / "aapt2").is_file() or not (build_tools / "lib/apksigner.jar").is_file():
        raise ValueError("--build-tools must contain Android SDK aapt2 and lib/apksigner.jar")
    if not options.verify_only:
        for name in ("PROTONNCORD_KEYSTORE", "PROTONNCORD_STORE_PASS", "PROTONNCORD_KEY_ALIAS", "PROTONNCORD_KEY_PASS"):
            if not os.environ.get(name):
                raise ValueError(f"Set {name}; the build never generates a release signing key")
        if not Path(os.environ["PROTONNCORD_KEYSTORE"]).is_file():
            raise ValueError("The signing keystore does not exist")
        if options.output.exists():
            raise ValueError("Output directory already exists; choose a new directory")

    assets = [asset for asset in pins["discord"]["apks"] if asset.get("abi", options.abi) == options.abi]
    options.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="protonncord-android-", dir=options.output.parent) as temporary:
        workspace = Path(temporary)
        originals = []
        for asset in assets:
            source = options.input_dir / asset["file"] if options.input_dir else download(asset, options.cache)
            target = workspace / asset["file"]
            shutil.copyfile(source, target)
            check_hash(target, asset)
            originals.append(target)
        infos = [inspect_apk(java, build_tools, path) for path in originals]
        signer = check_set(infos, assets, pins["discord"], pins["discord"]["certificateSha256"])
        print(f"Authenticated {len(infos)} Discord {pins['discord']['versionCode']} APKs; signer {signer}", flush=True)
        if options.verify_only:
            return

        patcher = download(pins["lspatch"], options.cache)
        loader = download(pins["loader"], options.cache)
        patched = workspace / "patched"
        print("Patching and signing with the supplied persistent keystore…", flush=True)
        log = run([java, f"-Djava.io.tmpdir={workspace}", "--class-path", patcher, MOBILE / "tools/PatchAndroid.java", *originals,
                   "--output", patched, "--sigbypasslv", "0", "--name", "Protonn Cord", "--embed", loader])
        output_signer = check_patch_report(log, assets[0])
        outputs = [patched / (path.stem + "-487-lspatched.apk") for path in originals]
        if set(patched.iterdir()) != set(outputs):
            raise ValueError("Unexpected or missing patched APK outputs")
        # Split manifests omit minSdkVersion. Verify them against the base app's
        # Android 9 requirement, and check that the base actually declares it.
        check_set([inspect_apk(java, build_tools, path, minimum_sdk=28) for path in outputs], assets, pins["discord"], [output_signer])
        check_embedded_loader(outputs[0], pins["loader"])
        receipt = {"format": 1, "abi": options.abi, "packageName": pins["discord"]["packageName"],
                   "versionCode": pins["discord"]["versionCode"], "originalSignerSha256": signer,
                   "signerSha256": output_signer, "runtime": toolchain,
                   "loader": pins["loader"], "lspatch": pins["lspatch"], "inputs": assets,
                   "outputs": {path.name: file_digest(path) for path in outputs}}
        (patched / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (patched / "loader-config.json").write_text(json.dumps({"customLoadUrl": {"enabled": True,
            "url": f"https://github.com/ProtonDev-sys/ProtonnCord/releases/download/{toolchain['runtimeRelease']}/revenge.bundle"}}, indent=2) + "\n")
        patched.rename(options.output)
        print(f"Verified APK set: {options.output.resolve()}\nSigner SHA-256: {output_signer}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--abi", choices=("arm64-v8a", "x86_64"), default="arm64-v8a")
    parser.add_argument("--build-tools", type=Path, required=True, help="Android SDK build-tools/36.0.0 directory")
    parser.add_argument("--cache", type=Path, default=MOBILE / "build/nonroot-cache")
    parser.add_argument("--output", type=Path, default=MOBILE / "build/nonroot")
    parser.add_argument("--input-dir", type=Path, help="Use a local copy of the exact pinned original APK set")
    parser.add_argument("--verify-only", action="store_true", help="Authenticate original APKs without patching or signing")
    try:
        build(parser.parse_args())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, zipfile.BadZipFile) as error:
        parser.exit(1, f"Android build stopped: {error}\n")


if __name__ == "__main__":
    main()
