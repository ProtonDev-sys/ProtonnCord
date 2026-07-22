import assert from "node:assert/strict";

import { classifyUpdateChanges, hashesReferToSameCommit } from "../src/utils/updateClassification";

const currentHash = "bd547e2f3faabda7e293925f1bb6052b43a779af";

assert.equal(hashesReferToSameCommit(currentHash, currentHash), true, "full hashes match");
assert.equal(hashesReferToSameCommit("bd547e2", currentHash), true, "abbreviated git hashes match full build hashes");
assert.equal(hashesReferToSameCommit("bd547e", currentHash), false, "unsafe short prefixes do not match");

assert.deepEqual(
    classifyUpdateChanges([{ hash: "bd547e2" }], currentHash),
    { isNewer: true, isOutdated: false },
    "a local-ahead commit is not presented as a downloadable update",
);
assert.deepEqual(
    classifyUpdateChanges([{ hash: "0123456789abcdef0123456789abcdef01234567" }], currentHash),
    { isNewer: false, isOutdated: true },
    "a remote commit is presented as an update",
);
assert.deepEqual(
    classifyUpdateChanges([], currentHash),
    { isNewer: false, isOutdated: false },
    "an empty change list is current",
);

console.log("updater classification checks passed");
