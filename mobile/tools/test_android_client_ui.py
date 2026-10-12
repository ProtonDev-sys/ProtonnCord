# SPDX-License-Identifier: GPL-3.0-or-later

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_android_client as client

DISCORD_FOCUS = "Window{66e8b98 u0 com.discord/com.discord.main.MainDefault}"
LAUNCHER_FOCUS = "Window{93676b8 u0 Application Not Responding: com.google.android.apps.nexuslauncher}"
LOGIN = ('<hierarchy><node package="com.discord" enabled="true" text="Register" />'
         '<node package="com.discord" enabled="true" content-desc="Log In" /></hierarchy>')
# Relevant system nodes from the Pixel Launcher ANR in run 38214211499, attempt 1.
LAUNCHER_ANR = '''<hierarchy><node package="android" resource-id="android:id/alertTitle"
    enabled="true" text="Pixel Launcher isn't responding" />
    <node package="android" resource-id="android:id/aerr_close" enabled="true" clickable="true" text="Close app" />
    <node package="android" resource-id="android:id/aerr_wait" enabled="true" clickable="true" text="Wait" /></hierarchy>'''


class LoginReadinessTests(unittest.TestCase):
    def test_unroot_reconciles_only_the_observed_restart_connection_close(self):
        closed = RuntimeError("Android command failed: adb: unable to connect for unroot: closed\n")
        for response in ("restarting adbd as non root", closed):
            with patch.object(client, "command", side_effect=[response, "", "2000"]) as adb:
                self.assertEqual(client.unroot(adb), isinstance(response, Exception))
                self.assertEqual([call.args for call in adb.call_args_list],
                                 [("unroot",), ("wait-for-device",), ("shell", "id -u")])
                self.assertEqual([call.kwargs["timeout"] for call in adb.call_args_list], [15, 30, 10])

    def test_unroot_unknown_errors_wrong_uid_and_timeout_remain_fatal(self):
        for error in (RuntimeError("Android command failed: device offline"), client.subprocess.TimeoutExpired("adb", 15)):
            with patch.object(client, "command", side_effect=error) as adb, self.assertRaises(type(error)):
                client.unroot(adb)
            self.assertEqual(adb.call_count, 1)
        for uid in ("0", "1000", ""):
            with patch.object(client, "command", side_effect=["", "", uid]), self.assertRaisesRegex(ValueError, "unprivileged"):
                client.unroot(client.command)
        with patch.object(client, "command", side_effect=["", client.subprocess.TimeoutExpired("wait", 30)]), \
                self.assertRaises(client.subprocess.TimeoutExpired):
            client.unroot(client.command)

    def exercise(self, frames, error=None, timeout=5):
        now = [0]
        frames = iter(frames)
        current = {"hierarchy": "<hierarchy />", "focus": DISCORD_FOCUS, "pid": "1234"}
        remote_xml = [None]
        calls = []
        progress = {}

        def adb(*args, **kwargs):
            calls.append((args, kwargs))
            self.assertGreater(kwargs["timeout"], 0)
            self.assertLessEqual(kwargs["timeout"], timeout - now[0])
            if args == ("shell", "pidof com.discord"):
                return current["pid"]
            if args == ("shell", "rm -f /fixture.xml"):
                remote_xml[0] = None
                return ""
            if args == ("shell", "uiautomator dump /fixture.xml 2>&1"):
                self.assertLessEqual(kwargs["timeout"], 20)
                current.update(next(frames, {}))
                if current.get("dump_timeout"):
                    raise client.subprocess.TimeoutExpired(args, kwargs["timeout"])
                if current.get("dump_output") is not None:
                    return current["dump_output"]
                remote_xml[0] = current["hierarchy"]
                return "UI hierchary dumped to: /fixture.xml"
            if args == ("shell", "cat /fixture.xml"):
                if remote_xml[0] is None:
                    raise RuntimeError("The remote UI hierarchy does not exist")
                return remote_xml[0]
            if args == ("shell", "dumpsys window displays"):
                return "  mCurrentFocus=" + current["focus"] + "\n"
            if args == ("exec-out", "screencap", "-p"):
                self.assertTrue(kwargs["binary"])
                return b"fixture-screen"
            self.assertEqual(args, ("shell", "am force-stop --user 0 " + client.PIXEL_LAUNCHER))
            return ""

        with tempfile.TemporaryDirectory() as directory, patch.object(client.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(client.time, "sleep", side_effect=lambda seconds: now.__setitem__(0, now[0] + seconds)):
            output = Path(directory)
            if error:
                with self.assertRaisesRegex(RuntimeError, error):
                    client.wait_for_login_screen(adb, "/fixture.xml", output, progress, "1234", timeout)
                self.assertFalse((output / "screen.png").exists())
            else:
                client.wait_for_login_screen(adb, "/fixture.xml", output, progress, "1234", timeout)
                self.assertEqual((output / "screen.png").read_bytes(), b"fixture-screen")
                self.assertEqual((output / "hierarchy.xml").read_text(), LOGIN)
        return progress, [args for args, _kwargs in calls if "force-stop" in " ".join(args)]

    def test_waits_for_the_actual_discord_screen(self):
        progress, recovery = self.exercise([{}, {"hierarchy": LOGIN}])
        self.assertEqual(progress["attempts"], 2)
        self.assertEqual(progress["elapsedSeconds"], 2)
        self.assertEqual(recovery, [])

    def test_recovers_the_identified_launcher_once_and_keeps_evidence(self):
        progress, recovery = self.exercise([
            {"hierarchy": LAUNCHER_ANR, "focus": LAUNCHER_FOCUS},
            {"hierarchy": LOGIN, "focus": DISCORD_FOCUS},
        ])
        self.assertEqual(len(recovery), 1)
        self.assertEqual(progress["launcherRecovery"], {"package": client.PIXEL_LAUNCHER, "action": "force-stop",
                                                       "focus": LAUNCHER_FOCUS, "hierarchy": LAUNCHER_ANR})

    def test_does_not_recover_a_repeated_launcher_anr(self):
        progress, recovery = self.exercise([{"hierarchy": LAUNCHER_ANR, "focus": LAUNCHER_FOCUS}], "repeated")
        self.assertEqual(len(recovery), 1)
        self.assertEqual(progress["attempts"], 2)

    def test_rejects_discord_crashes_anrs_and_unidentified_dialogs_without_actions(self):
        cases = [
            (LAUNCHER_ANR.replace("Pixel Launcher", "Discord"), LAUNCHER_FOCUS.replace(client.PIXEL_LAUNCHER, "com.discord")),
            (LAUNCHER_ANR.replace("isn't responding", "keeps stopping"), LAUNCHER_FOCUS.replace("Not Responding", "Error")),
            (LAUNCHER_ANR, DISCORD_FOCUS),
            (LAUNCHER_ANR, LAUNCHER_FOCUS.replace(client.PIXEL_LAUNCHER, client.PIXEL_LAUNCHER + ".other")),
            (LAUNCHER_ANR.replace('package="android"', 'package="com.discord"'), LAUNCHER_FOCUS),
            (LAUNCHER_ANR.replace('clickable="true"', 'clickable="false"'), LAUNCHER_FOCUS),
            (LAUNCHER_ANR.replace('resource-id="android:id/aerr_wait"', 'resource-id="android:id/button1"'), LAUNCHER_FOCUS),
            (LAUNCHER_ANR.replace("Pixel Launcher isn't responding", "Unrelated confirmation"), LAUNCHER_FOCUS),
        ]
        for hierarchy, focus in cases:
            with self.subTest(hierarchy=hierarchy, focus=focus):
                progress, recovery = self.exercise([{"hierarchy": hierarchy, "focus": focus}], "unexpected")
                self.assertEqual(recovery, [])
                self.assertNotIn("launcherRecovery", progress)

    def test_unrelated_or_obscured_labels_cannot_pass_and_the_wait_is_bounded(self):
        for hierarchy, focus in [(LOGIN.replace("com.discord", "other.app"), DISCORD_FOCUS),
                                 (LOGIN.replace('enabled="true"', 'enabled="false"'), DISCORD_FOCUS),
                                 (LOGIN, "Window{123abc u0 other.app/Dialog}"),
                                 (LOGIN.replace("Register", "Welcome"), DISCORD_FOCUS)]:
            with self.subTest(hierarchy=hierarchy, focus=focus):
                progress, recovery = self.exercise([{"hierarchy": hierarchy, "focus": focus}], "did not become ready")
                self.assertEqual(progress["elapsedSeconds"], 5)
                self.assertEqual(recovery, [])

    def test_a_restarted_client_cannot_reuse_prior_plugin_markers(self):
        for frames in [[{"hierarchy": LOGIN, "pid": "5678"}], [{}, {"hierarchy": LOGIN, "pid": "5678"}]]:
            with self.subTest(frames=frames):
                _progress, recovery = self.exercise(frames, "process changed")
                self.assertEqual(recovery, [])

    def test_a_failed_dump_cannot_reuse_an_earlier_login_hierarchy(self):
        for output, error in [("", "fresh UI hierarchy"),
                              ("UI hierchary dumped to: /fixture.xml", "does not exist")]:
            with self.subTest(output=output):
                _progress, recovery = self.exercise([
                    {"hierarchy": LOGIN, "focus": "Window{123abc u0 other.app/Dialog}"},
                    {"focus": DISCORD_FOCUS, "dump_output": output},
                ], error)
                self.assertEqual(recovery, [])

    def test_transient_dump_errors_require_a_later_fresh_capture(self):
        for error in ["ERROR: could not get idle state.", "ERROR: null root node returned by UiTestAutomationBridge."]:
            with self.subTest(error=error):
                progress, recovery = self.exercise([
                    {"hierarchy": LOGIN, "focus": "Window{123abc u0 other.app/Dialog}"},
                    {"focus": DISCORD_FOCUS, "dump_output": error},
                    {"dump_output": None},
                ])
                self.assertEqual(progress["attempts"], 3)
                self.assertEqual(progress["lastDumpError"], error)
                self.assertEqual(recovery, [])
                progress, recovery = self.exercise([{"dump_output": error}], "did not become ready")
                self.assertEqual(progress["elapsedSeconds"], 5)
                self.assertEqual(recovery, [])

    def test_a_timed_out_dump_fails_without_reusing_a_prior_capture(self):
        with self.assertRaises(client.subprocess.TimeoutExpired) as caught:
            self.exercise([
                {"hierarchy": LOGIN, "focus": "Window{123abc u0 other.app/Dialog}"},
                {"focus": DISCORD_FOCUS, "dump_timeout": True},
            ], timeout=30)
        self.assertEqual(caught.exception.timeout, 20)


if __name__ == "__main__":
    unittest.main()
