import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repository = "ProtonDev-sys/ProtonnCord";
const patcher = readFileSync("dist/desktop/patcher.js", "utf8");

assert.match(patcher, /\/\/ Development: false/u, "the repository test must inspect a production build");
assert.match(patcher, /\/\/ Updater Disabled: false/u, "the repository test must inspect an updater-enabled build");
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
console.log("production updater repository checks passed");
