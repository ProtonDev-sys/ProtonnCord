// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const test = [process.execPath, "--import", "tsx", "scripts/testSecureMessagingNative.ts"];
let command = test.shift();
let args = test;
if (process.platform === "linux" && process.env.PROTONN_CI_NATIVE_NETNS === "1") {
    const home = process.env.HOME;
    if (!home || !isAbsolute(home)) throw new Error("Native CI tests require an absolute build home");
    // Keep the real TCP mutex behavior, in a fresh loopback namespace without
    // unrelated host ephemeral ports or earlier suites' TIME_WAIT connections.
    args = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-net", "--ro-bind", "/", "/",
        "--bind", home, home, "--tmpfs", "/tmp", "--proc", "/proc", "--cap-drop", "ALL", "--chdir", process.cwd(), command, ...test];
    command = "bwrap";
}
const result = spawnSync(command, args, { stdio: "inherit", env: process.env, timeout: 120_000, killSignal: "SIGKILL", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
