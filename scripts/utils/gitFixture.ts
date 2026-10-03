import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GitRunner } from "../../src/main/updater/gitOperations";

const execFile = promisify(execFileCallback);

export async function run(cwd: string, ...args: string[]): Promise<{ stderr: string; stdout: string; }> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
    const result = await execFile("git", ["-c", `core.hooksPath=${join(cwd, ".fixture-disabled-hooks")}`, "-c", "commit.gpgSign=false", ...args], {
        cwd,
        env: {
            ...env,
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0"
        },
        timeout: 30_000
    });
    return { stderr: String(result.stderr), stdout: String(result.stdout) };
}

export function runner(cwd: string): GitRunner {
    return (...args) => run(cwd, ...args);
}

export async function commitFile(repository: string, filename: string, content: string, message: string): Promise<string> {
    await writeFile(join(repository, filename), content);
    await run(repository, "add", "--", filename);
    await run(repository, "commit", "-m", message);
    return (await run(repository, "rev-parse", "HEAD")).stdout.trim();
}
