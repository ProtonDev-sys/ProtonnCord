import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repository = "ProtonDev-sys/ProtonnCord";
const buildCommon = readFileSync("scripts/build/common.mjs", "utf8");
const patcher = readFileSync("dist/desktop/patcher.js", "utf8");
const gitUpdater = readFileSync("src/main/updater/git.ts", "utf8");
const gitOperations = readFileSync("src/main/updater/gitOperations.ts", "utf8");
const workflow = readFileSync(".github/workflows/build.yml", "utf8");

assert.match(patcher, /\/\/ Standalone: true/u, "the repository test must inspect a freshly built standalone updater");
assert.match(
    buildCommon,
    /IS_UPDATER_DISABLED = IS_DEV \|\| process\.argv\.includes\("--disable-updater"\)/u,
    "development builds must disable the updater even when --disable-updater was not passed separately",
);
assert.ok(
    patcher.includes("https://api.github.com/repos/") && patcher.includes(repository),
    "the production updater checks the Protonn Cord GitHub repository",
);
assert.ok(
    patcher.includes("https://github.com/") && patcher.includes(repository),
    "the updater UI links to the Protonn Cord GitHub repository",
);
assert.equal(
    patcher.includes("https://api.github.com/repos/Equicord/Equicord"),
    false,
    "the production updater never falls back to the upstream Equicord repository",
);
assert.match(gitUpdater, /inspectGitUpdates\(git, UPDATE_REPOSITORY, lastBuiltHead\)/u);
assert.match(gitUpdater, /pullGitUpdates\(git, UPDATE_REPOSITORY, lastBuiltHead\)/u);
assert.match(gitUpdater, /GIT_TERMINAL_PROMPT: "0"/u);
assert.match(gitUpdater, /timeout: GIT_TIMEOUT_MS/u);
assert.match(gitUpdater, /timeout: BUILD_TIMEOUT_MS/u);
assert.match(gitOperations, /"rev-list",\s*"--left-right",\s*"--count"/u);
assert.match(gitOperations, /git\("pull", "--ff-only", repository, state\.branch\)/u);
assert.match(gitOperations, /git\("status", "--porcelain=v1", "--untracked-files=all"\)/u);
assert.doesNotMatch(gitUpdater, /origin\/\$\{branch\}/u);
assert.doesNotMatch(gitOperations, /origin\/\$\{branch\}/u);
assert.match(workflow, /gh release create latest[^\n]+Protonn Cord \$GITHUB_SHA/);
assert.match(workflow, /concurrency:\s+group: protonn-cord-release-\$\{\{ github\.ref \}\}\s+cancel-in-progress: false/u);
assert.match(workflow, /git fetch --no-tags origin main/u);
assert.match(workflow, /git rev-parse HEAD[^\n]+git rev-parse FETCH_HEAD/u);
assert.doesNotMatch(workflow, /git rev-parse origin\/main/u);
assert.match(workflow, /git push origin refs\/tags\/latest --force/u);
assert.match(workflow, /gh release edit latest --target "\$GITHUB_SHA" --title "Protonn Cord \$GITHUB_SHA" --latest/);
assert.match(workflow, /gh release upload latest --clobber dist\/release\/\*/);
assert.match(workflow, /cp ProtonnCord\.user\.\{js,js\.LEGAL\.txt\} release/);
assert.doesNotMatch(workflow, /cp Equicord\.user/);
assert.match(workflow, /shopt -s nullglob/);
assert.doesNotMatch(workflow, /cp \*\.\{json,zip,asar\} release/);
assert.match(workflow, /find release -type f -size 0 -delete/);

console.log("updater repository and release pipeline checks passed");
