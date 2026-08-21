/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import {
    createHash,
    generateKeyPairSync,
    type KeyObject,
    sign,
} from "node:crypto";
import { readFileSync } from "node:fs";

import {
    createKeyAnnouncement,
    generateIdentity,
} from "../src/equicordplugins/secureMessaging.desktop/crypto";
import { removePeerFromSecurityKeyRoot } from "../src/equicordplugins/secureMessagingSecurityKey.desktop/rootLinks";
import {
    decodeBase64Url,
    encodeBase64Url,
    formatSecurityKeyFingerprint,
    parseSecurityKeyProfile,
    parseSecurityKeyProof,
    type SecurityKeyAlgorithm,
    type SecurityKeyProof,
    securityKeyProofBinding,
    securityKeyProofChallenge,
    type SecurityKeyPublicProfile,
    securityKeyRootFingerprint,
    serializeSecurityKeyProfile,
    serializeSecurityKeyProof,
} from "../src/equicordplugins/secureMessagingSecurityKey.desktop/protocol";
import {
    verifySecurityKeyProfile,
    verifySecurityKeyProof,
    verifyWebAuthnAssertion,
    verifyWebAuthnRegistration,
} from "../src/equicordplugins/secureMessagingSecurityKey.desktop/verification";

const USER_ID = "710514340855545878";
const OTHER_USER_ID = "895063026686885909";
const NOW = 1_787_000_000_000;

function snowflake(timestamp: number): string {
    return ((BigInt(timestamp - 1_420_070_400_000) << 22n) + 1n).toString();
}

function authenticatorData(flags = 0x05, signCount = 1): Uint8Array {
    const result = new Uint8Array(37);
    result.set(createHash("sha256").update("localhost").digest(), 0);
    result[32] = flags;
    new DataView(result.buffer).setUint32(33, signCount);
    return result;
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin = "http://localhost:49152") {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

interface TestKey {
    algorithm: SecurityKeyAlgorithm;
    privateKey: KeyObject;
    publicKeySpki: string;
}

function generateTestKey(algorithm: SecurityKeyAlgorithm): TestKey {
    const pair = algorithm === -7
        ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        : algorithm === -8
            ? generateKeyPairSync("ed25519")
            : generateKeyPairSync("rsa", { modulusLength: 2_048, publicExponent: 0x10001 });
    return {
        algorithm,
        privateKey: pair.privateKey,
        publicKeySpki: encodeBase64Url(pair.publicKey.export({ format: "der", type: "spki" })),
    };
}

function signAssertion(key: TestKey, authData: Uint8Array, clientJson: Uint8Array): string {
    const signed = Buffer.concat([
        Buffer.from(authData),
        createHash("sha256").update(clientJson).digest(),
    ]);
    return encodeBase64Url(sign(key.algorithm === -8 ? null : "sha256", signed, key.privateKey));
}

async function makeProof(key: TestKey, announcement: string, options: {
    flags?: number;
    origin?: string;
    signCount?: number;
    userId?: string;
} = {}): Promise<SecurityKeyProof> {
    const rootFingerprint = await securityKeyRootFingerprint(key.algorithm, key.publicKeySpki);
    const base = {
        userId: options.userId ?? USER_ID,
        issuedAt: NOW,
        nonce: encodeBase64Url(new Uint8Array(16).fill(7)),
        announcement,
        rootFingerprint,
    };
    const challenge = await securityKeyProofChallenge(base);
    const clientJson = clientData("webauthn.get", challenge, options.origin);
    const authData = authenticatorData(options.flags, options.signCount);
    return {
        ...base,
        algorithm: key.algorithm,
        publicKeySpki: key.publicKeySpki,
        clientDataJson: encodeBase64Url(clientJson),
        authenticatorData: encodeBase64Url(authData),
        signature: signAssertion(key, authData, clientJson),
    };
}

async function expectReject(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
    await assert.rejects(operation, pattern);
}

async function main(): Promise<void> {
    const encryptionIdentity = await generateIdentity();
    const announcement = await createKeyAnnouncement(encryptionIdentity, USER_ID);
    const messageId = snowflake(NOW + 1_000);

    for (const algorithm of [-7, -8, -257] as const) {
        const key = generateTestKey(algorithm);
        const proof = await makeProof(key, announcement);
        const content = serializeSecurityKeyProof(proof);
        assert.equal(parseSecurityKeyProof(content).rootFingerprint, proof.rootFingerprint);
        const verified = await verifySecurityKeyProof(proof, USER_ID, NOW + 1_000, NOW + 2_000);
        assert.equal(verified.signCount, 1);
        assert.equal(verified.origin, "http://localhost:49152");
        assert.doesNotMatch(content, /credentialId|credential_id/iu,
            "chat proofs must not reveal the stable WebAuthn credential identifier");
        assert.equal(formatSecurityKeyFingerprint(proof.rootFingerprint).split(" ").length, 16);
        if (algorithm === -7) assert.ok(content.length < 2_000, "ordinary ES256 proofs must fit Discord's message limit");

        const profile: SecurityKeyPublicProfile = {
            algorithm,
            createdAt: NOW,
            credentialId: encodeBase64Url(new Uint8Array(32).fill(3)),
            publicKeySpki: key.publicKeySpki,
            rootFingerprint: proof.rootFingerprint,
            transports: ["nfc", "usb"],
        };
        const exported = serializeSecurityKeyProfile(profile);
        assert.deepEqual(parseSecurityKeyProfile(exported), profile);
        await verifySecurityKeyProfile(profile);

        const importChallenge = encodeBase64Url(new Uint8Array(32).fill(8));
        const importClientData = clientData("webauthn.get", importChallenge);
        const importAuthData = authenticatorData(0x05, 2);
        await verifyWebAuthnAssertion(profile, {
            authenticatorAttachment: "cross-platform",
            credentialId: profile.credentialId,
            clientDataJson: encodeBase64Url(importClientData),
            authenticatorData: encodeBase64Url(importAuthData),
            signature: signAssertion(key, importAuthData, importClientData),
        }, importChallenge);

        const registrationChallenge = encodeBase64Url(new Uint8Array(32).fill(9));
        const registration = await verifyWebAuthnRegistration({
            algorithm,
            authenticatorAttachment: "cross-platform",
            authenticatorData: encodeBase64Url(authenticatorData(0x05, 3)),
            clientDataJson: encodeBase64Url(clientData("webauthn.create", registrationChallenge)),
            credentialId: profile.credentialId,
            publicKeySpki: profile.publicKeySpki,
            transports: ["usb", "nfc", "usb"],
        }, registrationChallenge);
        assert.equal(registration.profile.rootFingerprint, profile.rootFingerprint);
        assert.deepEqual(registration.profile.transports, ["nfc", "usb"]);
    }

    const key = generateTestKey(-7);
    const validProof = await makeProof(key, announcement);
    await expectReject(
        verifySecurityKeyProof(validProof, OTHER_USER_ID, NOW + 1_000, NOW + 2_000),
        /does not match its Discord author/iu,
    );

    const noUv = await makeProof(key, announcement, { flags: 0x01 });
    await expectReject(
        verifySecurityKeyProof(noUv, USER_ID, NOW + 1_000, NOW + 2_000),
        /PIN or biometric verification is required/iu,
    );

    const evilOrigin = await makeProof(key, announcement, { origin: "https://evil.example" });
    await expectReject(
        verifySecurityKeyProof(evilOrigin, USER_ID, NOW + 1_000, NOW + 2_000),
        /unexpected origin/iu,
    );

    const tamperedSignature = structuredClone(validProof);
    const signatureBytes = decodeBase64Url(tamperedSignature.signature);
    signatureBytes[0] ^= 0x80;
    tamperedSignature.signature = encodeBase64Url(signatureBytes);
    await expectReject(
        verifySecurityKeyProof(tamperedSignature, USER_ID, NOW + 1_000, NOW + 2_000),
        /signature is invalid/iu,
    );

    const tamperedBinding = structuredClone(validProof);
    tamperedBinding.announcement += "x";
    await expectReject(
        verifySecurityKeyProof(tamperedBinding, USER_ID, NOW + 1_000, NOW + 2_000),
        /does not match this operation/iu,
    );

    await expectReject(
        verifySecurityKeyProof(validProof, USER_ID, NOW + 20 * 60_000, NOW + 20 * 60_000),
        /timestamp is outside/iu,
    );

    const linkedRoots = {
    old: { userIds: [USER_ID, OTHER_USER_ID] },
    replacement: { userIds: [] as string[] },
};
removePeerFromSecurityKeyRoot(linkedRoots, "old", USER_ID);
assert.deepEqual(linkedRoots.old.userIds, [OTHER_USER_ID],
    "replacing one account must remove it from the previous hardware root");
removePeerFromSecurityKeyRoot(linkedRoots, "old", OTHER_USER_ID);
assert.equal("old" in linkedRoots, false,
    "an unreferenced previous hardware root must be removed");

    const sameRootOnAnotherAccount = await securityKeyRootFingerprint(key.algorithm, key.publicKeySpki);
    assert.equal(sameRootOnAnotherAccount, validProof.rootFingerprint,
        "hardware-root fingerprints must remain stable across explicitly linked Discord accounts");
    assert.deepEqual(securityKeyProofBinding(validProof), {
        announcement,
        issuedAt: NOW,
        nonce: validProof.nonce,
        rootFingerprint: validProof.rootFingerprint,
        userId: USER_ID,
    });

    const nativeSource = readFileSync(new URL(
        "../src/equicordplugins/secureMessagingSecurityKey.desktop/native.ts",
        import.meta.url,
    ), "utf8");
    assert.match(nativeSource, /authenticatorAttachment:\s*"cross-platform"/u);
    assert.match(nativeSource, /userVerification:\s*"required"/u);
    assert.match(nativeSource, /nodeIntegration:\s*false/u);
    assert.match(nativeSource, /contextIsolation:\s*true/u);
    assert.match(nativeSource, /sandbox:\s*true/u);
    assert.match(nativeSource, /session\.fromPartition\(`pc-security-key-/u);
    assert.match(nativeSource, /safeStorage\.encryptString/u);
    assert.match(nativeSource, /safeStorage\.getSelectedStorageBackend\(\) === "basic_text"/u);
    assert.match(nativeSource, /http:\/\/\$\{SECURITY_KEY_RP_ID\}:/u);
    assert.doesNotMatch(nativeSource, /SECURITY_KEY_PROOF_PREFIX[\s\S]{0,400}credentialId/u,
        "the proof serializer must not add the credential identifier");

    const rendererSource = readFileSync(new URL(
        "../src/equicordplugins/secureMessagingSecurityKey.desktop/index.tsx",
        import.meta.url,
    ), "utf8");
    assert.match(rendererSource, /Share verified identity in this chat/u);
    assert.match(rendererSource, /SecureNative\.createAnnouncement/u);
    assert.match(rendererSource, /Native\.createSecurityKeyProof/u);
    assert.match(rendererSource, /Native\.reviewSecurityKeyProof/u);
    assert.match(rendererSource, /SecureNative\.trustReviewedKey/u);
    assert.match(rendererSource, /isSecurityKeyProof\(result\.plaintext\)/u);
    assert.match(rendererSource, /getOptimisticOutgoingPlaintext\(message\.content\)/u,
    "outgoing hardware proofs must render continuously through the optimistic message transition");

const securityKeyStyles = readFileSync(new URL(
    "../src/equicordplugins/secureMessagingSecurityKey.desktop/styles.css",
    import.meta.url,
), "utf8");
assert.match(securityKeyStyles, /:has\(\.pc-security-key-proof\) \[class\*="messageContent"\]/u,
    "raw proof payloads and encrypted envelopes must be hidden once the verified card is mounted");

    const secureRendererSource = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/index.tsx",
        import.meta.url,
    ), "utf8");
    assert.match(secureRendererSource, /SECURITY_KEY_PROOF_PREFIX/u,
        "the generic encrypted renderer must recognize hardware proof system messages");
    assert.match(secureRendererSource, /visiblePlaintext\?\.startsWith\(SECURITY_KEY_PROOF_PREFIX\)/u,
        "raw PCSK1 proof text must not flash through the generic encrypted card");

    console.log("Secure Messaging hardware security-key checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
