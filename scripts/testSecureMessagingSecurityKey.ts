/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, type Plugin } from "esbuild";

import { validateIdentityKeyPairs } from "../src/equicordplugins/secureMessaging.desktop/crypto";
import {
    createOneKeyCipherScript,
    deriveOneKeyBindingPublicKey,
    deriveOneKeyPrivateIdentity,
    isOneKeyClassicDevice,
    oneKeyDeterministicProfileInput,
} from "../src/equicordplugins/secureMessaging.desktop/oneKeyVault";

type SecurityKeyVaultModule = typeof import("../src/equicordplugins/secureMessaging.desktop/securityKeyVault");

const electronStub: Plugin = {
    name: "security-key-vault-electron-stub",
    setup(bundle) {
        bundle.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "security-key-vault-test" }));
        bundle.onLoad({ filter: /^electron$/, namespace: "security-key-vault-test" }, () => ({
            contents: `
                export class BrowserWindow {
                    static fromWebContents() { return null; }
                }
                export const session = {
                    fromPartition() {
                        return {
                            setPermissionRequestHandler() {},
                            setPermissionCheckHandler() {},
                            setDevicePermissionHandler() {},
                            async clearStorageData() {},
                        };
                    },
                };
            `,
            loader: "js",
        }));
    },
};

async function loadModule(): Promise<{ directory: string; module: SecurityKeyVaultModule; }> {
    const directory = await mkdtemp(join(tmpdir(), "pc-security-key-vault-"));
    const output = join(directory, "security-key-vault.mjs");
    await build({
        bundle: true,
        entryPoints: [fileURLToPath(new URL(
            "../src/equicordplugins/secureMessaging.desktop/securityKeyVault.ts",
            import.meta.url,
        ))],
        format: "esm",
        outfile: output,
        platform: "node",
        plugins: [electronStub],
        target: "node24",
    });
    return { directory, module: await import(pathToFileURL(output).href) as SecurityKeyVaultModule };
}

function profile(
    provider: "large_blob" | "onekey" | "prf",
): import("../src/equicordplugins/secureMessaging.desktop/securityKeyVault").SecurityKeyVaultProfile {
    const profileInput = provider === "onekey"
        ? Buffer.from(oneKeyDeterministicProfileInput(), "base64url")
        : randomBytes(32);
    const oneKeySecret = randomBytes(32);
    const publicKeySpki = provider === "onekey"
        ? deriveOneKeyBindingPublicKey(oneKeySecret, profileInput)
        : generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey
            .export({ format: "der", type: "spki" }).toString("base64url");
    const algorithm = provider === "onekey" ? -8 : -7;
    const rootFingerprint = createHash("sha256")
        .update("ProtonnCord/SecureMessaging/security-key-vault-root/v1\0", "utf8")
        .update(`localhost\0${algorithm}\0`, "utf8")
        .update(Buffer.from(publicKeySpki, "base64url"))
        .digest("base64url");
    const result = {
        algorithm,
        createdAt: Date.now(),
        credentialId: profileInput.toString("base64url"),
        provider,
        prfSalt: provider === "prf" ? randomBytes(32).toString("base64url") : null,
        publicKeySpki,
        rootFingerprint,
        transports: provider === "onekey" ? ["usb"] : ["nfc", "usb"],
    } as import("../src/equicordplugins/secureMessaging.desktop/securityKeyVault").SecurityKeyVaultProfile;
    profileInput.fill(0);
    oneKeySecret.fill(0);
    return result;
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0));
    let offset = 0;
    for (const value of values) {
        result.set(value, offset);
        offset += value.byteLength;
    }
    return result;
}

function encodeVarint(value: number): Uint8Array {
    const result: number[] = [];
    let remaining = value;
    do {
        const next = remaining % 128;
        remaining = Math.floor(remaining / 128);
        result.push(next | (remaining > 0 ? 0x80 : 0));
    } while (remaining > 0);
    return Uint8Array.from(result);
}

function protobufUnsigned(field: number, value: number): Uint8Array {
    return concatBytes(encodeVarint(field << 3), encodeVarint(value));
}

function protobufBytes(field: number, value: Uint8Array): Uint8Array {
    return concatBytes(encodeVarint((field << 3) | 2), encodeVarint(value.byteLength), value);
}

function oneKeyPackets(messageType: number, payload: Uint8Array): Uint8Array[] {
    const packets: Uint8Array[] = [];
    let offset = 0;
    let first = true;
    do {
        const packet = new Uint8Array(64);
        packet[0] = 0x3f;
        const payloadOffset = first ? 9 : 1;
        if (first) {
            packet.set([0x23, 0x23, messageType >>> 8, messageType], 1);
            packet[5] = payload.byteLength >>> 24;
            packet[6] = payload.byteLength >>> 16;
            packet[7] = payload.byteLength >>> 8;
            packet[8] = payload.byteLength;
        }
        const count = Math.min(packet.byteLength - payloadOffset, payload.byteLength - offset);
        packet.set(payload.subarray(offset, offset + count), payloadOffset);
        offset += count;
        packets.push(packet);
        first = false;
    } while (offset < payload.byteLength);
    return packets;
}

interface FakeOneKeyRun {
    closed: boolean;
    messages: Array<{ payload: Uint8Array; type: number; }>;
    released: boolean;
    result: { __error?: string; value?: string; };
}

async function runFakeOneKey(
    profileInput: Buffer,
    output: Buffer,
    pinProtected = true,
    productId = 0x53c1,
): Promise<FakeOneKeyRun> {
    const incoming: Uint8Array[] = [];
    const messages: Array<{ payload: Uint8Array; type: number; }> = [];
    let current: { length: number; payload: Uint8Array; received: number; type: number; } | null = null;
    let released = false;
    let closed = false;
    let configuration: any;

    const enqueue = (type: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
        incoming.push(...oneKeyPackets(type, payload));
    const respond = (type: number) => {
        if (type === 0) {
            enqueue(17, concatBytes(
                protobufUnsigned(5, 0),
                protobufUnsigned(7, pinProtected ? 1 : 0),
                protobufUnsigned(12, 1),
                protobufUnsigned(30, 5),
                protobufUnsigned(600, 1),
                protobufBytes(100, new Uint8Array(64)),
            ));
        } else if (type === 23) enqueue(18);
        else if (type === 10_000) enqueue(26);
        else if (type === 27) enqueue(41);
        else if (type === 42) enqueue(48, protobufBytes(1, output));
    };
    const acceptPacket = (packet: Uint8Array) => {
        assert.equal(packet.byteLength, 64);
        assert.equal(packet[0], 0x3f);
        if (packet[1] === 0x23 && packet[2] === 0x23) {
            const length = (packet[5] * 0x1000000) + (packet[6] << 16) + (packet[7] << 8) + packet[8];
            current = {
                length,
                payload: new Uint8Array(length),
                received: Math.min(55, length),
                type: (packet[3] << 8) | packet[4],
            };
            current.payload.set(packet.subarray(9, 9 + current.received));
        } else {
            assert.ok(current);
            const count = Math.min(63, current.length - current.received);
            current.payload.set(packet.subarray(1, 1 + count), current.received);
            current.received += count;
        }
        if (current && current.received === current.length) {
            messages.push({ payload: current.payload, type: current.type });
            respond(current.type);
            current = null;
        }
    };
    const alternate = {
        endpoints: [
            { direction: "in", endpointNumber: 1 },
            { direction: "out", endpointNumber: 1 },
        ],
        interfaceClass: 0xff,
    };
    const device = {
        async claimInterface() {},
        async clearHalt() {},
        async close() {
            this.opened = false;
            closed = true;
        },
        get configuration() { return configuration; },
        opened: false,
        async open() { this.opened = true; },
        productId,
        async releaseInterface() { released = true; },
        async selectConfiguration() {
            configuration = {
                configurationValue: 1,
                interfaces: [{ alternate, alternates: [alternate], interfaceNumber: 0 }],
            };
        },
        async transferIn() {
            const packet = incoming.shift();
            assert.ok(packet, "the fake OneKey must have a queued response");
            return { data: new DataView(packet.buffer), status: "ok" };
        },
        async transferOut(_endpoint: number, data: ArrayBuffer) {
            acceptPacket(new Uint8Array(data));
            return { status: "ok" };
        },
        vendorId: 0x1209,
    };
    const evaluate = new Function("navigator", `return ${createOneKeyCipherScript(profileInput.toString("base64url"))};`);
    const result = await evaluate({ usb: { requestDevice: async () => device } });
    return { closed, messages, released, result };
}

async function main(): Promise<void> {
    assert.equal(isOneKeyClassicDevice({ vendorId: 0x1209, productId: 0x53c1 }), true);
    assert.equal(isOneKeyClassicDevice({ vendorId: 0x1209, productId: 0x4f4b }), true,
        "Classic 1S native mode must be accepted alongside Trezor compatibility mode");
    assert.equal(isOneKeyClassicDevice({ vendorId: 0x1209, productId: 0x53c1, manufacturerName: "SatoshiLabs" }), false,
        "shared USB identifiers must not grant a Trezor access to the OneKey ceremony");
    assert.equal(isOneKeyClassicDevice({ vendorId: 0x1050, productId: 0x0407 }), false);

    const deterministicProfileInput = oneKeyDeterministicProfileInput();
    assert.equal(oneKeyDeterministicProfileInput(), deterministicProfileInput,
        "OneKey setup must use the same device derivation input on every installation");
    assert.equal(Buffer.from(deterministicProfileInput, "base64url").byteLength, 32);

    const identityRoot = randomBytes(32);
    const otherIdentityRoot = Buffer.from(identityRoot);
    otherIdentityRoot[0] ^= 0x80;
    const localUserId = "123456789012345678";
    const firstIdentity = deriveOneKeyPrivateIdentity(identityRoot, localUserId, 1_800_000_000_000);
    const recreatedIdentity = deriveOneKeyPrivateIdentity(identityRoot, localUserId, 1_800_000_000_001);
    const otherRootIdentity = deriveOneKeyPrivateIdentity(otherIdentityRoot, localUserId, 1_800_000_000_002);
    const otherUserIdentity = deriveOneKeyPrivateIdentity(identityRoot, "223456789012345678", 1_800_000_000_003);
    const identityKeyFields = [
        "hpkePrivateKey",
        "hpkePublicKey",
        "signingPrivateKey",
        "signingPublicKey",
    ] as const;
    for (const field of identityKeyFields) {
        assert.equal(recreatedIdentity[field], firstIdentity[field],
            `${field} must be independent of the local creation timestamp`);
        assert.notEqual(otherRootIdentity[field], firstIdentity[field],
            `${field} must be bound to the physical OneKey root`);
        assert.notEqual(otherUserIdentity[field], firstIdentity[field],
            `${field} must be separated by Discord account`);
    }
    await Promise.all([
        firstIdentity,
        recreatedIdentity,
        otherRootIdentity,
        otherUserIdentity,
    ].map(validateIdentityKeyPairs));
    identityRoot.fill(0);
    otherIdentityRoot.fill(0);

    const oneKeyInput = randomBytes(32);
    const oneKeyOutput = randomBytes(32);
    const binding = deriveOneKeyBindingPublicKey(oneKeyOutput, oneKeyInput);
    assert.equal(deriveOneKeyBindingPublicKey(oneKeyOutput, oneKeyInput), binding,
        "the same OneKey result and profile input must reproduce the profile binding");
    const differentOutput = Buffer.from(oneKeyOutput);
    differentOutput[0] ^= 0x80;
    assert.notEqual(deriveOneKeyBindingPublicKey(differentOutput, oneKeyInput), binding,
        "a different hardware-derived result must not match the stored profile");
    differentOutput.fill(0);

    const fakeOneKey = await runFakeOneKey(oneKeyInput, oneKeyOutput);
    assert.deepEqual(fakeOneKey.messages.map(message => message.type), [0, 23, 10_000, 27, 42],
        "the native OneKey flow must initialize, request on-device PIN, acknowledge the button, and keep passphrase entry on-device");
    assert.equal(fakeOneKey.result.value, oneKeyOutput.toString("base64url"));
    assert.equal((await runFakeOneKey(oneKeyInput, oneKeyOutput, true, 0x4f4b)).result.value,
        oneKeyOutput.toString("base64url"), "the native Classic 1S USB product ID must use the same ceremony");
    assert.equal(fakeOneKey.released && fakeOneKey.closed, true,
        "the isolated ceremony must always release the OneKey interface");
    const expectedCipherRequest = concatBytes(
        protobufUnsigned(1, 0x80002720),
        protobufUnsigned(1, 0),
        protobufBytes(2, Buffer.from("ProtonnCord Secure Messaging", "utf8")),
        protobufBytes(3, oneKeyInput),
        protobufUnsigned(4, 1),
        protobufUnsigned(5, 1),
        protobufUnsigned(6, 1),
    );
    assert.deepEqual(fakeOneKey.messages[1].payload, expectedCipherRequest,
        "CipherKeyValue must use the SLIP-0016 path, app label, profile input, and both confirmation flags");
    assert.deepEqual(fakeOneKey.messages[4].payload, Uint8Array.of(0x18, 0x01),
        "wallet passphrases must be entered on the OneKey, never sent through Discord");
    const noPin = await runFakeOneKey(oneKeyInput, oneKeyOutput, false);
    assert.equal(noPin.result.__error, "OneKeyUnsupported:features_validation",
        "a OneKey without PIN protection must be rejected before deriving a vault key");
    assert.deepEqual(noPin.messages.map(message => message.type), [0]);
    const zeroOutput = Buffer.alloc(32);
    const failedCipher = await runFakeOneKey(oneKeyInput, zeroOutput);
    assert.equal(failedCipher.result.__error, "OneKeyFailure",
        "the ignored secure-element error path must not accept an all-zero result");
    const unavailableDevice = Object.assign(new Error("cancelled"), { name: "NotFoundError" });
    const noDevice = await new Function(
        "navigator",
        `return ${createOneKeyCipherScript(oneKeyInput.toString("base64url"))};`,
    )({ usb: { requestDevice: async () => { throw unavailableDevice; } } });
    assert.equal(noDevice.__error, "OneKeyUnavailable",
        "a cancelled Electron device selection must remain distinguishable from unsupported firmware");
    expectedCipherRequest.fill(0);
    oneKeyInput.fill(0);
    oneKeyOutput.fill(0);
    zeroOutput.fill(0);

    const { directory, module } = await loadModule();
    try {
        const prfProfile = profile("prf");
        const largeBlobProfile = profile("large_blob");
        const oneKeyProfile = profile("onekey");

        const exportedPrf = module.serializeSecurityKeyVaultProfile(prfProfile);
        assert.match(exportedPrf, /^PCSKV2:/u);
        assert.deepEqual(module.parseSecurityKeyVaultProfile(exportedPrf), prfProfile);
        const exportedLargeBlob = module.serializeSecurityKeyVaultProfile(largeBlobProfile);
        assert.deepEqual(module.parseSecurityKeyVaultProfile(exportedLargeBlob), largeBlobProfile);
        const exportedOneKey = module.serializeSecurityKeyVaultProfile(oneKeyProfile);
        assert.deepEqual(module.parseSecurityKeyVaultProfile(exportedOneKey), oneKeyProfile);
        const invalidOneKeyTransport = structuredClone(oneKeyProfile);
        invalidOneKeyTransport.transports = ["nfc", "usb"];
        assert.throws(() => module.serializeSecurityKeyVaultProfile(invalidOneKeyTransport), /invalid_profile/u,
            "OneKey vendor profiles must remain bound to the USB-only route");

        const legacy = "PCSKV1:" + JSON.stringify([
            1,
            prfProfile.createdAt,
            prfProfile.credentialId,
            prfProfile.algorithm,
            prfProfile.publicKeySpki,
            prfProfile.rootFingerprint,
            prfProfile.transports,
            prfProfile.prfSalt,
        ]);
        assert.deepEqual(module.parseSecurityKeyVaultProfile(legacy), prfProfile,
            "existing PCSKV1 PRF profiles must remain importable");
        assert.equal(module.formatSecurityKeyVaultFingerprint(prfProfile.rootFingerprint).split(" ").length, 16);
        assert.equal(module.securityKeyVaultProfilesMatch(prfProfile, structuredClone(prfProfile)), true);
        const otherCredential = structuredClone(prfProfile);
        otherCredential.credentialId = randomBytes(32).toString("base64url");
        assert.equal(module.securityKeyVaultProfilesMatch(prfProfile, otherCredential), false,
            "hardware-vault profiles with the same root but another credential must not be interchangeable");

        const largeBlobSeed = randomBytes(32);
        const largeBlobPayload = module.createSecurityKeyLargeBlobPayload(largeBlobSeed, largeBlobProfile);
        assert.deepEqual(module.extractSecurityKeyLargeBlobSeed(largeBlobPayload, largeBlobProfile), largeBlobSeed);
        const wrongProfile = profile("large_blob");
        assert.throws(
            () => module.extractSecurityKeyLargeBlobSeed(largeBlobPayload, wrongProfile),
            /credential_mismatch/u,
            "large-blob secrets must be bound to the registered credential root",
        );
        const tamperedPayload = Buffer.from(largeBlobPayload);
        tamperedPayload[tamperedPayload.length - 1] ^= 0x80;
        assert.notDeepEqual(
            module.extractSecurityKeyLargeBlobSeed(tamperedPayload, largeBlobProfile),
            largeBlobSeed,
            "changing the stored seed must change the derived vault secret",
        );
        largeBlobSeed.fill(0);
        largeBlobPayload.fill(0);
        tamperedPayload.fill(0);

        const plaintextVault = {
            accounts: {
                "100000000000000001": {
                    identity: { signingPrivateKey: "private material must be wrapped" },
                },
            },
            version: 1,
        };
        const protectedChannelIdsByUser = {
            "100000000000000001": ["200000000000000001", "200000000000000002"],
            "100000000000000002": [],
        };
        const key = randomBytes(32);
        const firstPreparedKey = Buffer.from(key);
        module.activatePreparedSecurityKeyVault({ key: firstPreparedKey, profile: prfProfile });
        assert.equal(firstPreparedKey.every(byte => byte === 0), true,
            "the transferred prepared key must be wiped after activation");
        const wrapped = module.wrapSecurityKeyVaultValue(plaintextVault, protectedChannelIdsByUser);
        const envelope = module.parseSecurityKeyVaultEnvelope(wrapped);
        assert.ok(envelope, "an active security key must wrap the Secure Messaging vault");
        assert.deepEqual(envelope.protectedChannelIdsByUser, protectedChannelIdsByUser,
            "the OS-readable outer envelope carries a canonical protected-channel index");
        assert.equal(JSON.stringify(wrapped).includes("private material must be wrapped"), false,
            "private identity material must not remain visible in the OS-protected outer payload");
        assert.equal(module.securityKeyVaultStateForValue(wrapped).status, "unlocked");
        assert.deepEqual(module.unwrapSecurityKeyVaultValue(wrapped), plaintextVault);

        const changedProfileEnvelope = structuredClone(wrapped) as any;
        changedProfileEnvelope.profile.credentialId = randomBytes(32).toString("base64url");
        assert.equal(module.securityKeyVaultStateForValue(changedProfileEnvelope).status, "locked",
            "a vault profile changed during unlock must not reuse an active key from the same public root");
        assert.throws(() => module.unwrapSecurityKeyVaultValue(changedProfileEnvelope), /locked/u);

        const noncanonicalChannels = structuredClone(wrapped) as any;
        noncanonicalChannels.protectedChannelIdsByUser["100000000000000001"].reverse();
        assert.equal(module.parseSecurityKeyVaultEnvelope(noncanonicalChannels), null,
            "protected channel IDs must remain sorted");
        const duplicateChannels = structuredClone(wrapped) as any;
        duplicateChannels.protectedChannelIdsByUser["100000000000000001"] =
            ["200000000000000001", "200000000000000001"];
        assert.equal(module.parseSecurityKeyVaultEnvelope(duplicateChannels), null,
            "protected channel IDs must remain unique");
        const noncanonicalUsers = structuredClone(wrapped) as any;
        noncanonicalUsers.protectedChannelIdsByUser = {
            "100000000000000002": [],
            "100000000000000001": ["200000000000000001"],
        };
        assert.equal(module.parseSecurityKeyVaultEnvelope(noncanonicalUsers), null,
            "local user IDs must remain canonical");
        const oversizedIndex = structuredClone(wrapped) as any;
        oversizedIndex.protectedChannelIdsByUser["100000000000000001"] = Array.from(
            { length: 2_001 },
            (_, index) => (200_000_000_000_001_000n + BigInt(index)).toString(),
        );
        assert.equal(module.parseSecurityKeyVaultEnvelope(oversizedIndex), null,
            "the protected channel index must remain bounded per account");
        const oversizedAccounts = structuredClone(wrapped) as any;
        oversizedAccounts.protectedChannelIdsByUser = Object.fromEntries(Array.from(
            { length: 17 },
            (_, index) => [(100_000_000_000_001_000n + BigInt(index)).toString(), []],
        ));
        assert.equal(module.parseSecurityKeyVaultEnvelope(oversizedAccounts), null,
            "the protected channel index must remain bounded by the vault account limit");

        const legacyProfileEnvelope = structuredClone(wrapped) as any;
        delete legacyProfileEnvelope.profile.provider;
        assert.equal(module.parseSecurityKeyVaultEnvelope(legacyProfileEnvelope)?.profile.provider, "prf",
            "existing encrypted envelopes must normalize to the PRF provider");
        assert.deepEqual(module.unwrapSecurityKeyVaultValue(legacyProfileEnvelope), plaintextVault);
        const legacyIndexEnvelope = structuredClone(wrapped) as any;
        delete legacyIndexEnvelope.protectedChannelIdsByUser;
        assert.equal(module.parseSecurityKeyVaultEnvelope(legacyIndexEnvelope)?.protectedChannelIdsByUser, null,
            "legacy envelopes without an index must remain readable but explicitly unknown");
        assert.deepEqual(module.unwrapSecurityKeyVaultValue(legacyIndexEnvelope), plaintextVault);

        module.clearSecurityKeyVaultSession();
        assert.equal(module.securityKeyVaultStateForValue(wrapped).status, "locked");
        assert.throws(() => module.unwrapSecurityKeyVaultValue(wrapped), /locked/u,
            "the E2E vault must be unavailable without the physical-key-derived session key");

        module.activatePreparedSecurityKeyVault({ key: Buffer.from(key), profile: prfProfile });
        assert.deepEqual(module.unwrapSecurityKeyVaultValue(wrapped), plaintextVault);
        const tampered = structuredClone(envelope!);
        const ciphertext = Buffer.from(tampered.ciphertext, "base64url");
        ciphertext[0] ^= 0x80;
        tampered.ciphertext = ciphertext.toString("base64url");
        assert.throws(() => module.unwrapSecurityKeyVaultValue(tampered), /corrupt/u,
            "authenticated vault encryption must reject modified ciphertext");

        module.clearSecurityKeyVaultSession();
        assert.deepEqual(module.wrapSecurityKeyVaultValue(plaintextVault, {}), plaintextVault,
            "unconfigured vaults remain backwards compatible with OS-only storage");
        key.fill(0);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }

    const implementation = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/securityKeyVault.ts",
        import.meta.url,
    ), "utf8");
    assert.match(implementation, /extensions:\{credProps:true,largeBlob:\{support:"preferred"\},prf:/u,
        "registration must negotiate PRF and large-blob providers together");
    assert.match(implementation, /pubKeyCredParams:\[\{type:"public-key",alg:-7\}/u,
        "registration must retain the ES256 algorithm supported by OneKey FIDO2 firmware");
    assert.match(implementation, /residentKey:"required",requireResidentKey:true/u,
        "large-blob credentials must be discoverable resident credentials");
    assert.match(implementation, /residentKey:extensions\.credProps\?\.rk===true/u,
        "large-blob setup must verify that the created credential is discoverable");
    assert.doesNotMatch(implementation, /ProtonnCord-\$\{localUserId\}/u,
        "discoverable credentials must not store a Discord account identifier");
    assert.match(implementation, /registered\.largeBlobSupported && registered\.residentKey/u);
    assert.match(implementation, /extensions:\{largeBlob:\{write:/u,
        "setup must store the random vault seed with WebAuthn largeBlob.write");
    assert.match(implementation, /extensions:\{largeBlob:\{read:true\}\}/u,
        "unlock must retrieve the vault seed with WebAuthn largeBlob.read");
    assert.match(implementation, /if \(registered\.prfEnabled\)[\s\S]*if \(registered\.largeBlobSupported/u,
        "PRF remains preferred while large blob provides the compatibility fallback");
    assert.match(implementation, /largeBlobWritten !== true/u,
        "setup must fail closed unless the authenticator confirms the blob write");
    assert.match(implementation, /timingSafeEqual\(payloadRoot, expectedRoot\)/u,
        "large-blob payloads must be bound to the credential root");
    assert.match(implementation, /export function securityKeyVaultProfilesMatch/u,
        "an unlocked key must be bound to the complete provider profile");
    assert.match(implementation, /createCipheriv\("aes-256-gcm"/u);
    assert.match(implementation, /hkdfSync\(/u);
    assert.match(implementation, /seed\.fill\(0\)/u);
    assert.match(implementation, /payload\.fill\(0\)/u);
    assert.match(implementation, /plaintext\?\.fill\(0\)|plaintext\.fill\(0\)/u);
    assert.match(implementation, /profile\.provider === "onekey"/u,
        "OneKey profiles must unlock through the vendor hardware route");
    assert.match(implementation, /prepareOneKeySecurityKeyVaultSetup/u,
        "OneKey setup must remain an explicit provider choice");
    assert.match(implementation, /prepareOneKeyVault\(event, oneKeyDeterministicProfileInput\(\)\)/u,
        "OneKey setup must use a fixed device derivation input so clean installations reproduce the same root");
    assert.match(implementation, /profile\.credentialId !== oneKeyDeterministicProfileInput\(\)/u,
        "imported OneKey profiles must not select an attacker-controlled derivation input");
    assert.match(implementation, /process\.platform === "win32"[\s\S]*runOneKeyWindowsVaultCipher/u,
        "Windows must bypass Electron WebUSB and use the built-in WinUSB route");
    assert.match(implementation, /setDevicePermissionHandler[\s\S]*deviceType === "usb"[\s\S]*isOneKeyClassicDevice/u,
        "the isolated Electron session must grant only matching OneKey USB devices");
    assert.match(implementation, /setDevicePermissionHandler\(null\)/u,
        "the isolated Electron session must clear its USB device permission handler");

    const oneKeyImplementation = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/oneKeyVault.ts",
        import.meta.url,
    ), "utf8");
    assert.match(oneKeyImplementation, /\{ productId: 0x4f4b, vendorId: 0x1209 \}[\s\S]*\{ productId: 0x53c1, vendorId: 0x1209 \}/u,
        "WebUSB access must be limited to both official OneKey Classic 1S USB modes");
    assert.match(oneKeyImplementation, /unsignedField\(5, 1\)[\s\S]*unsignedField\(6, 1\)/u,
        "both CipherKeyValue confirmation flags must be bound into the derived key");
    assert.match(oneKeyImplementation, /featureNumber\(7\) !== 1/u,
        "OneKey setup must refuse devices without PIN protection");
    assert.match(oneKeyImplementation, /value\.byteLength !== 32 \|\| value\.every\(byte => byte === 0\)/u,
        "OneKey setup must reject the firmware's all-zero secure-element failure output");

    const oneKeyWindowsImplementation = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/oneKeyWindowsVault.ts",
        import.meta.url,
    ), "utf8");
    assert.match(oneKeyWindowsImplementation, /0263b512-88cb-4136-9613-5c8e109d8ef5/iu,
        "the Windows route must enumerate only OneKey's registered WinUSB interface class");
    assert.match(oneKeyWindowsImplementation, /vid_1209[\s\S]*pid_53c1[\s\S]*pid_4f4b[\s\S]*mi_00/iu,
        "the Windows route must restrict access to both Classic 1S vendor-interface modes");
    assert.match(oneKeyWindowsImplementation, /response\.Type == 18[\s\S]*Send\(interfaceHandle, 10000[\s\S]*response\.Type == 26[\s\S]*Send\(interfaceHandle, 27[\s\S]*response\.Type == 41[\s\S]*Send\(interfaceHandle, 42/iu,
        "the Windows route must keep PIN and passphrase entry on the OneKey while acknowledging physical confirmation");
    assert.match(oneKeyWindowsImplementation, /windowsHide: true/iu);
    assert.match(oneKeyWindowsImplementation, /shell: false/iu);
    assert.match(oneKeyWindowsImplementation, /maxBuffer: 1_024/iu,
        "the hidden OS helper output must remain strictly bounded");
    assert.match(oneKeyWindowsImplementation, /result\[0\] = 0;[\s\S]*Buffer\.BlockCopy\(secret[\s\S]*stdout\.Write\(\$protocol/iu,
        "the hardware-derived value must cross the private child pipe as raw bytes, not logged text");
    assert.doesNotMatch(oneKeyWindowsImplementation, /Console\]::(Write|WriteLine)|console\.(log|error)/iu,
        "the Windows transport must not log hardware-derived material");

    const native = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/native.ts",
        import.meta.url,
    ), "utf8");
    assert.match(native, /security_key_storage_failed/u);
    assert.match(native, /unwrapSecurityKeyVaultValue/u);
    assert.match(native, /wrapSecurityKeyVaultValue/u);
    assert.match(native, /Object\.keys\(vault\.accounts\)[\s\S]*deriveOneKeyPrivateIdentity\(prepared\.key, userId\)/u,
        "OneKey setup must derive every stored account identity from the device-bound root and Discord account");
    assert.match(native, /deriveActiveOneKeyPrivateIdentity\(localUserId\)/u,
        "an account first opened after setup must receive an identity from the active OneKey root");
    assert.match(native, /function oneKeySendCounterFloor\(\)[\s\S]*Date\.now\(\) \* 1_000/u,
        "a clean deterministic identity must seed its monotonic counter from the current clock");
    assert.match(native, /delete existing\.identityHistory\[replacementFingerprint\][\s\S]*retainLocalIdentity\(existing, currentFingerprint\)[\s\S]*existing\.identity = replacement/u,
        "a restored fingerprint must leave retired-key history before the differing current identity is retained and replaced");
    assert.match(native, /conversation\.enabled = false;[\s\S]*conversation\.reviewRequired = "local_identity_changed"/u,
        "OneKey identity replacement must disable protected conversations for explicit identity review");
    assert.match(native, /identityChanged: true[\s\S]*disabledConversationCount/u,
        "the native result must report identity replacement and its disabled-conversation count");
    const lockFunctionStart = native.indexOf("export async function lockSecurityKeyVault");
    const lockFunctionEnd = native.indexOf("export async function removeSecurityKeyVault", lockFunctionStart);
    const lockFunction = native.slice(lockFunctionStart, lockFunctionEnd);
    assert.ok(
        lockFunction.indexOf("clearSecurityKeyVaultSession();") < lockFunction.indexOf("return runSerialized"),
        "locking must clear the in-memory E2E key before fallible storage or mutex work",
    );

    const renderer = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/index.tsx",
        import.meta.url,
    ), "utf8");
    assert.match(renderer, /PRF or large-blob storage/u);
    assert.match(renderer, /OneKey Classic 1S uses its built-in WinUSB connection automatically/u,
        "the setup UI must explain the native Windows 10 route");
    assert.match(renderer, /no administrator rights, custom shortcut, or Discord launch arguments/u,
        "the setup UI must not require a special Discord launch");
    assert.match(renderer, /Fully quit OneKey Desktop from the system tray/u,
        "the setup UI must explain exclusive access to the vendor interface");
    assert.match(renderer, /bound to this physical OneKey’s secure element/u,
        "the setup UI must explain that a wallet recovery phrase cannot recreate the hardware-vault secret");
    assert.match(renderer, /same physical OneKey and Discord account restore the same fingerprint on a clean installation/u,
        "the setup UI must explain deterministic clean-install identity recovery");
    assert.match(renderer, /Derived private keys exist in trusted desktop memory while the vault is unlocked/u,
        "the setup UI must not imply that OneKey performs message signing on-device");
    assert.match(renderer, /result\.status === "unlocked" && result\.identityChanged[\s\S]*result\.disabledConversationCount/u,
        "identity replacement must report how many protected conversations were disabled");
    assert.match(renderer, /result\.status === "local_identity_changed"[\s\S]*verify the new fingerprint[\s\S]*enable encryption again/u,
        "local identity replacement must not be mislabeled as a missing recipient key");
    assert.match(renderer, /keyState\.profile\.provider !== "onekey"[\s\S]*Copy profile/u,
        "the redundant OneKey profile-copy control must stay hidden");
    assert.match(renderer, /oneKeyProtected \?[\s\S]*Remove OneKey protection first[\s\S]*Reset identity/u,
        "OneKey mode must hide rotation controls until protection is removed");
    assert.match(renderer, /installation-local state backup[\s\S]*exact counters[\s\S]*replay records/u,
        "deterministic identity recovery must not be presented as a complete state backup");
    assert.match(renderer, /OS-bound vault file alone is not (?:a portable export|portable)/u,
        "the UI must not present the safeStorage-wrapped vault file as portable");
    assert.match(renderer, /clean restore seeds its send counter from the current clock[\s\S]*one active sending installation/u,
        "the setup UI must state the counter and single-sender portability rule");
    assert.match(renderer, /keyState\.profile\.provider === "large_blob"/u);
    assert.match(renderer, /Native\.setupOneKeyVault/u);
    assert.match(renderer, /Native\.setupSecurityKeyVault/u);
    assert.match(renderer, /Native\.unlockSecurityKeyVault\(context\.localUserId\)/u,
        "unlock must bind deterministic account reconciliation to the active Discord account");
    assert.match(renderer, /await Native\.lockSecurityKeyVault\(\)/u,
        "changing Discord accounts must clear the unlocked E2E vault key");
    assert.match(renderer, /void Native\.lockSecurityKeyVault\(\)/u,
        "stopping the plugin must clear the unlocked E2E vault key");
    assert.doesNotMatch(renderer, /title="Secure Messaging \(PCEM3\)"/u);
    assert.doesNotMatch(renderer, /<Heading tag="h5">Important limitations<\/Heading>/u);

    const documentation = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/README.md",
        import.meta.url,
    ), "utf8");
    assert.match(documentation, /OneKey Classic 1S is supported through its hardware-vault interface/u);
    assert.match(documentation, /OneKey Pro and Touch can use the standard FIDO2 route/u);
    assert.match(documentation, /no administrator rights, custom shortcut, launch arguments, bridge, or driver replacement/u,
        "the guide must not require a special Discord launch on Windows 10");
    assert.match(documentation, /## OneKey setup[\s\S]*click the lock button beside the message box/u,
        "the guide must explain where to open OneKey setup");
    assert.match(documentation, /secret inside that physical device's secure element[\s\S]*wallet recovery phrase does not recreate/u,
        "the guide must warn that OneKey hardware-vault recovery is bound to the physical device");
    assert.match(documentation, /same physical OneKey and Discord account deterministically restore the same fingerprint on a clean installation/u,
        "the guide must document deterministic OneKey identity recovery");
    assert.match(documentation, /replaces a differing Secure Messaging identity[\s\S]*disables protected conversations for explicit review[\s\S]*recipients can verify/u,
        "the guide must explain the identity-replacement consequence before setup");
    assert.match(documentation, /derived private key material exists in the trusted Electron main-process memory while the vault is unlocked/u,
        "the guide must describe the trusted-memory boundary accurately");
    assert.match(documentation, /installation-local Secure Messaging state backup[\s\S]*replay records[\s\S]*retired keys/u,
        "the guide must retain backup guidance for non-deterministic vault state");
    assert.match(documentation, /safeStorage[\s\S]*copying `vault\.bin` alone is not a portable backup or export/u,
        "the guide must explain that the outer OS-bound vault wrapper is not portable");
    assert.match(documentation, /clean OneKey restore seeds its send counter from the current system clock[\s\S]*one active sending installation/u,
        "the guide must document the monotonic-counter portability caveat");
    assert.match(documentation, /state backup preserves the exact send counters and replay records/u);
    assert.match(documentation, /profile-copy control is intentionally hidden/u);
    assert.match(documentation, /deterministic identity rotation is hidden; remove protection first/u);
    assert.match(documentation, /U2F-only OneKey models[\s\S]*not supported/u,
        "OneKey support must not imply that U2F-only models can derive the vault key");

    assert.equal(existsSync(new URL(
        "../src/equicordplugins/secureMessagingSecurityKey.desktop/index.tsx",
        import.meta.url,
    )), false, "hardware-key controls must not register a second chat-bar icon");

    console.log("Secure Messaging PRF, large-blob, and OneKey hardware-vault checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
