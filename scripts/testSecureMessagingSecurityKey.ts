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
    provider: "large_blob" | "prf",
): import("../src/equicordplugins/secureMessaging.desktop/securityKeyVault").SecurityKeyVaultProfile {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const rootFingerprint = createHash("sha256")
        .update("ProtonnCord/SecureMessaging/security-key-vault-root/v1\0", "utf8")
        .update("localhost\0-7\0", "utf8")
        .update(Buffer.from(publicKeySpki, "base64url"))
        .digest("base64url");
    return {
        algorithm: -7,
        createdAt: Date.now(),
        credentialId: randomBytes(32).toString("base64url"),
        provider,
        prfSalt: provider === "prf" ? randomBytes(32).toString("base64url") : null,
        publicKeySpki,
        rootFingerprint,
        transports: ["nfc", "usb"],
    };
}

async function main(): Promise<void> {
    const { directory, module } = await loadModule();
    try {
        const prfProfile = profile("prf");
        const largeBlobProfile = profile("large_blob");

        const exportedPrf = module.serializeSecurityKeyVaultProfile(prfProfile);
        assert.match(exportedPrf, /^PCSKV2:/u);
        assert.deepEqual(module.parseSecurityKeyVaultProfile(exportedPrf), prfProfile);
        const exportedLargeBlob = module.serializeSecurityKeyVaultProfile(largeBlobProfile);
        assert.deepEqual(module.parseSecurityKeyVaultProfile(exportedLargeBlob), largeBlobProfile);

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
        const key = randomBytes(32);
        const firstPreparedKey = Buffer.from(key);
        module.activatePreparedSecurityKeyVault({ key: firstPreparedKey, profile: prfProfile });
        assert.equal(firstPreparedKey.every(byte => byte === 0), true,
            "the transferred prepared key must be wiped after activation");
        const wrapped = module.wrapSecurityKeyVaultValue(plaintextVault);
        const envelope = module.parseSecurityKeyVaultEnvelope(wrapped);
        assert.ok(envelope, "an active security key must wrap the Secure Messaging vault");
        assert.equal(JSON.stringify(wrapped).includes("private material must be wrapped"), false,
            "private identity material must not remain visible in the OS-protected outer payload");
        assert.equal(module.securityKeyVaultStateForValue(wrapped).status, "unlocked");
        assert.deepEqual(module.unwrapSecurityKeyVaultValue(wrapped), plaintextVault);

        const changedProfileEnvelope = structuredClone(wrapped) as any;
        changedProfileEnvelope.profile.credentialId = randomBytes(32).toString("base64url");
        assert.equal(module.securityKeyVaultStateForValue(changedProfileEnvelope).status, "locked",
            "a vault profile changed during unlock must not reuse an active key from the same public root");
        assert.throws(() => module.unwrapSecurityKeyVaultValue(changedProfileEnvelope), /locked/u);

        const legacyEnvelope = structuredClone(wrapped) as any;
        delete legacyEnvelope.profile.provider;
        assert.equal(module.parseSecurityKeyVaultEnvelope(legacyEnvelope)?.profile.provider, "prf",
            "existing encrypted envelopes must normalize to the PRF provider");
        assert.deepEqual(module.unwrapSecurityKeyVaultValue(legacyEnvelope), plaintextVault);

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
        assert.deepEqual(module.wrapSecurityKeyVaultValue(plaintextVault), plaintextVault,
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

    const native = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/native.ts",
        import.meta.url,
    ), "utf8");
    assert.match(native, /security_key_storage_failed/u);
    assert.match(native, /unwrapSecurityKeyVaultValue/u);
    assert.match(native, /wrapSecurityKeyVaultValue/u);
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
    assert.match(renderer, /up-to-date, PIN-enabled Pro, Touch, or 1S over USB/u,
        "the setup UI must state the supported OneKey models and transport");
    assert.match(renderer, /keyState\.profile\.provider === "large_blob"/u);
    assert.match(renderer, /Native\.setupSecurityKeyVault/u);
    assert.match(renderer, /Native\.unlockSecurityKeyVault/u);
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
    assert.match(documentation, /OneKey Pro, Touch, and 1S devices with current firmware and a PIN over USB/u);
    assert.match(documentation, /U2F-only OneKey models[\s\S]*not supported/u,
        "OneKey support must not imply that U2F-only models can derive the vault key");

    assert.equal(existsSync(new URL(
        "../src/equicordplugins/secureMessagingSecurityKey.desktop/index.tsx",
        import.meta.url,
    )), false, "hardware-key controls must not register a second chat-bar icon");

    console.log("Secure Messaging PRF and large-blob security-key vault checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
