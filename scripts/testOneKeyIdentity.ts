/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import {
    deriveOneKeyPrivateIdentity,
    oneKeyDeterministicProfileInput,
} from "../src/equicordplugins/secureMessaging.desktop/oneKeyVault";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const X25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const CREATED_AT = 1_800_000_000_000;
const USER_ID = "123456789012345678";

const rootKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const untouchedRootKey = Buffer.from(rootKey);
const identity = deriveOneKeyPrivateIdentity(rootKey, USER_ID, CREATED_AT);
assert.deepEqual(rootKey, untouchedRootKey);
assert.deepEqual(identity, deriveOneKeyPrivateIdentity(Buffer.from(rootKey), USER_ID, CREATED_AT));
assert.deepEqual(identity, {
    createdAt: CREATED_AT,
    hpkePrivateKey: "a-iJ-B5fzik0XUHFar7S5NLTiZ8dex3iP4UeVCCBYCE",
    hpkePublicKey: "vdMdMnGmbsBtbVNMxqP-DDSltS3U30CAz3OTg9Lcvng",
    signingPrivateKey: "MC4CAQAwBQYDK2VwBCIEIJgLm9nEf41evh-zn8MOgM6AN4SDPx_-084BiKReL5Uq",
    signingPublicKey: "MIn6bM9bMYTmxrhj6PhMcGjpE7Ir2DRWVxQ-64X1EuE",
});
assert.notEqual(
    identity.signingPublicKey,
    deriveOneKeyPrivateIdentity(rootKey, "123456789012345679", CREATED_AT).signingPublicKey,
);

const signingPrivateKey = createPrivateKey({
    key: Buffer.from(identity.signingPrivateKey, "base64url"),
    format: "der",
    type: "pkcs8",
});
const signingPublicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(identity.signingPublicKey, "base64url")]),
    format: "der",
    type: "spki",
});
const message = Buffer.from("ProtonnCord OneKey identity test", "utf8");
const signature = sign(null, message, signingPrivateKey);
assert.equal(verify(null, message, signingPublicKey, signature), true);

const hpkePrivateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_SEED_PREFIX, Buffer.from(identity.hpkePrivateKey, "base64url")]),
    format: "der",
    type: "pkcs8",
});
const hpkePublicDer = createPublicKey(
    hpkePrivateKey as unknown as Parameters<typeof createPublicKey>[0],
).export({ format: "der", type: "spki" });
assert.deepEqual(
    hpkePublicDer,
    Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(identity.hpkePublicKey, "base64url")]),
);

const profileInput = oneKeyDeterministicProfileInput();
assert.equal(profileInput, "m4V7ieO-eIkqSYH-XVWZg-dTdFe3TsoIKMnS6lKHLAs");
assert.equal(Buffer.from(profileInput, "base64url").byteLength, 32);
assert.equal(Buffer.from(profileInput, "base64url").toString("base64url"), profileInput);

console.log("OneKey deterministic identity test passed.");
