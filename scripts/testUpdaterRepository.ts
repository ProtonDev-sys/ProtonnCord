import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repository = "ProtonDev-sys/ProtonnCord";
const patcher = readFileSync("dist/desktop/patcher.js", "utf8");
const workflow = readFileSync(".github/workflows/build.yml", "utf8");

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
assert.match(workflow, /gh release create latest[^\n]+Protonn Cord \$GITHUB_SHA/);
assert.match(workflow, /gh release edit latest --title "Protonn Cord \$GITHUB_SHA" --latest/);
assert.match(workflow, /gh release upload latest --clobber dist\/release\/\*/);
assert.match(workflow, /cp ProtonnCord\.user\.\{js,js\.LEGAL\.txt\} release/);
assert.doesNotMatch(workflow, /cp Equicord\.user/);
assert.match(workflow, /shopt -s nullglob/);
assert.doesNotMatch(workflow, /cp \*\.\{json,zip,asar\} release/);
assert.match(workflow, /find release -type f -size 0 -delete/);

console.log("updater repository and release pipeline checks passed");
