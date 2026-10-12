# SPDX-License-Identifier: GPL-3.0-or-later

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

import patch_android as android

CERT = "a" * 64
SIGNATURE = ("Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\n"
             f"Number of signers: 1\nSigner #1 certificate SHA-256 digest: {CERT}\n")
PACKAGE = "package: name='com.discord' versionCode='348010' versionName='348.10 - Stable'\n"
DISCORD = {"packageName": "com.discord", "versionCode": "348010"}
ASSETS = [{"split": ""}, {"split": "config.arm64_v8a"}]
INFOS = [{**DISCORD, **asset, "signer": CERT} for asset in ASSETS]


class ApkAuthenticationTests(unittest.TestCase):
    def test_wall_clock_deadline_interrupts_blocked_download(self):
        started = time.monotonic()
        with self.assertRaisesRegex(TimeoutError, "total time limit"), android.download_deadline(0.02):
            time.sleep(2)
        self.assertLess(time.monotonic() - started, 1)

    def test_tool_failure_redacts_signing_passwords(self):
        failure = SimpleNamespace(returncode=1, stdout="", stderr="failure: private-store and private-key")
        with patch.dict(os.environ, {"PROTONNCORD_STORE_PASS": "private-store", "PROTONNCORD_KEY_PASS": "private-key"}), \
                patch.object(android.subprocess, "run", return_value=failure):
            with self.assertRaisesRegex(RuntimeError, r"failure: \[redacted\] and \[redacted\]"):
                android.run(["java"])

    def test_google_source_stamp_is_not_the_app_signer(self):
        output = SIGNATURE + f"Source Stamp Signer certificate SHA-256 digest: {'b' * 64}\n"
        self.assertEqual(android.parse_apk_info(output, PACKAGE), INFOS[0])
        with self.assertRaisesRegex(ValueError, "one APK signer"):
            android.parse_apk_info(output.replace(f"Signer #1 certificate SHA-256 digest: {CERT}\n", ""), PACKAGE)

    def test_multiple_or_inconsistent_signers_are_rejected(self):
        for output in [SIGNATURE.replace("signers: 1", "signers: 2"),
                       SIGNATURE.replace("Signer #1", "Signer #2"),
                       SIGNATURE + f"Signer #2 certificate SHA-256 digest: {CERT}\n"]:
            with self.subTest(output=output), self.assertRaises(ValueError):
                android.parse_apk_info(output, PACKAGE)

    def test_v1_alone_is_insufficient(self):
        with self.assertRaisesRegex(ValueError, "v2 or newer"):
            android.parse_apk_info(SIGNATURE.replace("v2", "v1"), PACKAGE)

    def test_bad_package_metadata_is_rejected(self):
        for badging in ["", "warning\n" + PACKAGE, PACKAGE.replace("versionCode='348010'", "versionCode='invalid'")]:
            with self.subTest(badging=badging), self.assertRaises(ValueError):
                android.parse_apk_info(SIGNATURE, badging)

    def test_matching_set_has_one_trusted_signer(self):
        self.assertEqual(android.check_set(INFOS, ASSETS, DISCORD, [CERT]), CERT)
        with self.assertRaisesRegex(ValueError, "not trusted"):
            android.check_set(INFOS, ASSETS, DISCORD, ["b" * 64])

    def test_mixed_packages_versions_splits_and_signers_are_rejected(self):
        for field, value in [("packageName", "other.app"), ("versionCode", "348011"),
                             ("split", "config.x86_64"), ("signer", "b" * 64)]:
            changed = deepcopy(INFOS)
            changed[1][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "pinned set"):
                android.check_set(changed, ASSETS, DISCORD, [CERT])

    def test_incomplete_or_duplicate_sets_are_rejected(self):
        for infos, assets in [([], []), (INFOS[:1], ASSETS), (INFOS + [INFOS[1]], ASSETS + [ASSETS[1]]),
                              (INFOS[1:], ASSETS[1:])]:
            with self.subTest(infos=infos), self.assertRaises(ValueError):
                android.check_set(infos, assets, DISCORD, [CERT])

    def test_failed_signature_is_not_parsed_by_aapt(self):
        with patch.object(android, "run", side_effect=RuntimeError("DOES NOT VERIFY")) as run:
            with self.assertRaisesRegex(RuntimeError, "DOES NOT VERIFY"):
                android.inspect_apk(Path("java"), Path("sdk"), Path("base.apk"))
        self.assertEqual(run.call_count, 1)

    def test_split_verification_uses_the_checked_base_minimum(self):
        badging = PACKAGE + "minSdkVersion:'28'\n"
        with patch.object(android, "run", side_effect=[SIGNATURE, badging]) as run:
            self.assertEqual(android.inspect_apk(Path("java"), Path("sdk"), Path("base.apk"), 28), INFOS[0])
        self.assertIn("--min-sdk-version", run.call_args_list[0].args[0])
        for invalid in [badging.replace("'28'", "'24'"), badging + "application-debuggable\n"]:
            with patch.object(android, "run", side_effect=[SIGNATURE, invalid]), self.assertRaises(ValueError):
                android.inspect_apk(Path("java"), Path("sdk"), Path("base.apk"), 28)
        with patch.object(android, "run", side_effect=[SIGNATURE, PACKAGE]) as run:
            android.inspect_apk(Path("java"), Path("sdk"), Path("base.apk"))
        self.assertNotIn("--min-sdk-version", run.call_args_list[0].args[0])

    def test_same_size_tampering_and_insecure_downloads_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.apk"
            path.write_bytes(b"original")
            asset = {"size": 8, "sha256": hashlib.sha256(b"original").hexdigest(), "file": "input.apk", "url": "http://example.com/apk"}
            android.check_hash(path, asset)
            path.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                android.check_hash(path, asset)
            with self.assertRaisesRegex(ValueError, "Only HTTPS"):
                android.download(asset, Path(directory))
            with self.assertRaisesRegex(ValueError, "away from HTTPS"):
                android.HttpsRedirect().redirect_request(None, None, 302, "", {}, "http://example.com/apk")

    def test_cached_inputs_are_reauthenticated(self):
        with tempfile.TemporaryDirectory() as directory:
            asset = {"size": 8, "sha256": hashlib.sha256(b"original").hexdigest(), "file": "input.apk"}
            target = Path(directory) / (asset["sha256"][:12] + "-input.apk")
            target.write_bytes(b"original")
            self.assertEqual(android.download(asset, Path(directory)), target)
            target.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                android.download(asset, Path(directory))

    def test_patcher_must_report_original_hash_and_signer(self):
        original = {"sha256": "b" * 64}
        report = f"PROTONNCORD_SIGNER={CERT}\nPROTONNCORD_ORIGINAL={'b' * 64}\n"
        self.assertEqual(android.check_patch_report(report, original), CERT)
        for invalid in ["", report + report, report.replace("b" * 64, "c" * 64), report.splitlines()[0]]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                android.check_patch_report(invalid, original)

    def test_embedded_loader_and_privilege_flags_are_checked(self):
        config = {"useManager": False, "debuggable": False, "sigBypassLevel": 0,
                  "injectDex": False, "addedPermissions": [], "injectDocumentsProvider": False}
        loader = {"sha256": hashlib.sha256(b"loader").hexdigest()}
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "base.apk"

            def write(module=b"loader", settings=config):
                with zipfile.ZipFile(apk, "w") as output:
                    output.writestr("assets/lspatch/modules/io.github.revenge.xposed.apk", module)
                    output.writestr("assets/lspatch/config.json", json.dumps(settings))

            write()
            android.check_embedded_loader(apk, loader)
            for kwargs in [{"module": b"other"},
                           *[{"settings": {**config, field: value}} for field, value in
                             [("useManager", True), ("debuggable", True), ("sigBypassLevel", 2),
                              ("injectDocumentsProvider", True), ("addedPermissions", ["android.permission.MANAGE_EXTERNAL_STORAGE"])]]]:
                write(**kwargs)
                with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                    android.check_embedded_loader(apk, loader)

    def test_alignment_backport_changes_only_the_two_authenticated_rules(self):
        source = ('AlignmentRules.constantForSuffix(".so", 4096);\n'
                  'AlignmentRules.constantForSuffix(ORIGINAL_APK_ASSET_PATH, 4096);\n'
                  'int unrelated = 4096;\n')
        actual = android.patcher_alignment_source(source)
        self.assertEqual(actual.count("16384"), 2)
        self.assertIn("int unrelated = 4096;", actual)
        for changed in (source.replace('".so"', '".other"'), source + source, source.replace("4096", "8192")):
            with self.subTest(source=changed), self.assertRaisesRegex(ValueError, "alignment rules changed"):
                android.patcher_alignment_source(changed)

    def test_standalone_requires_both_abis_and_no_remaining_split_requirements(self):
        badging = PACKAGE + "native-code: 'arm64-v8a' 'x86_64'\n"
        for manifest in ("E: manifest", "A: android:isSplitRequired=0xffffffff", "E: uses-split",
                         'A: android:name="com.android.vending.splits.required"'):
            with patch.object(android, "run", side_effect=[badging, manifest]):
                if manifest == "E: manifest":
                    android.check_universal_apk(Path("sdk"), Path("client.apk"), DISCORD)
                else:
                    with self.assertRaisesRegex(ValueError, "separate splits"):
                        android.check_universal_apk(Path("sdk"), Path("client.apk"), DISCORD)
        with patch.object(android, "run", return_value=badging.replace(" 'x86_64'", "")), \
                self.assertRaisesRegex(ValueError, "both supported"):
            android.check_universal_apk(Path("sdk"), Path("client.apk"), DISCORD)

    def test_bootstrap_requires_the_real_manifest_shape_and_compiled_runtime(self):
        toolchain = json.loads((android.MOBILE / "toolchain.json").read_text())
        manifest = json.loads((android.MOBILE / "plugins/secure-messaging/manifest.json").read_text())
        manifest["version"] = "0.2.176.1-nightly"
        with tempfile.TemporaryDirectory() as directory:
            plugin, runtime = Path(directory) / "plugin.zip", Path(directory) / "revenge.bundle"
            runtime.write_bytes(bytes.fromhex("c61fbc03c103191f") + b"fixture")

            def write(value=manifest, extra=False):
                with zipfile.ZipFile(plugin, "w") as archive:
                    archive.writestr("manifest.json", json.dumps(value))
                    archive.writestr("index.js", b"plugin script")
                    archive.writestr("plugin.jar", b"native plugin")
                    if extra:
                        archive.writestr("../unexpected", b"bad")

            write()
            version, files = android.bootstrap_files(plugin, runtime, toolchain)
            self.assertEqual(version, manifest["version"])
            self.assertEqual(len(files), 8)
            self.assertEqual(files["cache/revenge/bundle.js"], runtime.read_bytes())
            source = json.loads(files["files/revenge/plugins/repos/sources.json"])
            self.assertEqual(source["sources"][android.PLUGIN], {"repo": android.REPOSITORY, "channel": "nightly"})
            for changed, extra in [({**manifest, "format": True}, False), ({**manifest, "version": "wrong"}, False),
                                   ({**manifest, "id": "other.plugin"}, False), (manifest, True)]:
                write(changed, extra)
                with self.subTest(manifest=changed, extra=extra), self.assertRaises(ValueError):
                    android.bootstrap_files(plugin, runtime, toolchain)
            write()
            runtime.write_bytes(b"plain JavaScript")
            with self.assertRaisesRegex(ValueError, "Hermes bytecode"):
                android.bootstrap_files(plugin, runtime, toolchain)


if __name__ == "__main__":
    unittest.main()
