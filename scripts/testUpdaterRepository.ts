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
assert.match(
    gitUpdater,
    /inspectGitUpdates\([\s\S]*?git,[\s\S]*?UPDATE_REPOSITORY,[\s\S]*?lastBuiltHead,[\s\S]*?parseUpdaterBranch\(branch\),?[\s\S]*?\)/u,
    "the source updater must inspect the locally selected, validated branch",
);
assert.match(
    gitUpdater,
    /pullGitUpdates\(git, UPDATE_REPOSITORY, lastBuiltHead, parseUpdaterBranch\(branch\)\)/u,
    "the source updater must apply the locally selected, validated branch",
);
assert.match(gitUpdater, /GIT_TERMINAL_PROMPT: "0"/u);
assert.match(gitUpdater, /timeout: GIT_TIMEOUT_MS/u);
assert.match(gitUpdater, /timeout: BUILD_TIMEOUT_MS/u);
assert.match(gitOperations, /"rev-list",\s*"--left-right",\s*"--count"/u);
assert.match(gitOperations, /"ls-remote",\s*"--heads",\s*repository,\s*remoteBranch/u);
assert.match(gitOperations, /git\("fetch", "--no-tags", repository, remoteBranch\)/u);
assert.match(gitOperations, /git\("switch", state\.branch\)/u);
assert.match(gitOperations, /git\("switch", "--create", state\.branch, "FETCH_HEAD"\)/u);
assert.match(gitOperations, /git\("merge", "--ff-only", "FETCH_HEAD"\)/u);
assert.match(gitOperations, /git\("status", "--porcelain=v1", "--untracked-files=all"\)/u);
assert.doesNotMatch(gitUpdater, /origin\/\$\{branch\}/u);
assert.doesNotMatch(gitOperations, /origin\/\$\{branch\}/u);

assert.match(workflow, /branches:\s+- main\s+- staging\s+- nightly/u);
assert.match(workflow, /concurrency:\s+group: protonn-cord-release-\$\{\{ github\.ref \}\}\s+cancel-in-progress: false/u);
assert.match(workflow, /branch="\$GITHUB_REF_NAME"/u);
assert.match(workflow, /git fetch --no-tags origin "refs\/heads\/\$branch"/u);
assert.doesNotMatch(workflow, /git fetch --no-tags origin "\$branch"/u,
    "release freshness checks must not resolve a same-named channel tag");
assert.match(workflow, /git rev-parse HEAD[^\n]+git rev-parse FETCH_HEAD/u);
assert.doesNotMatch(workflow, /git rev-parse origin\/main/u);
assert.match(workflow, /if \[\[ "\$branch" == "main" \]\]; then\s+tag="latest"\s+release_flags=\(--latest\)/u);
assert.match(workflow, /else\s+tag="\$branch"\s+release_flags=\(--prerelease\)/u);
assert.match(workflow, /title="Protonn Cord \$branch \$GITHUB_SHA"/u);
assert.match(workflow, /git push origin "refs\/tags\/\$tag" --force/u);
assert.match(workflow, /gh release edit "\$tag" --target "\$GITHUB_SHA" --title "\$title" "\$\{release_flags\[@\]\}"/u);
assert.match(workflow, /gh release create "\$tag" --target "\$GITHUB_SHA" --title "\$title"/u);
assert.match(workflow, /gh release upload "\$tag" --clobber dist\/release\/\*/u);
assert.match(workflow, /cp ProtonnCord\.user\.\{js,js\.LEGAL\.txt\} release/u);
assert.doesNotMatch(workflow, /cp Equicord\.user/u);
assert.match(workflow, /shopt -s nullglob/u);
assert.doesNotMatch(workflow, /cp \*\.\{json,zip,asar\} release/u);
assert.match(workflow, /find release -type f -size 0 -delete/u);

console.log("updater repository and release pipeline checks passed");
