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
import { pathToFileURL } from "node:url";

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
        entryPoints: [new URL(
            "../src/equicordplugins/secureMessaging.desktop/securityKeyVault.ts",
            import.meta.url,
        ).pathname],
        format: "esm",
        outfile: output,
        platform: "node",
        plugins: [electronStub],
        target: "node24",
    });
    return { directory, module: await import(pathToFileURL(output).href) as SecurityKeyVaultModule };
}

function testProfile(): import("../src/equicordplugins/secureMessaging.desktop/securityKeyVault").SecurityKeyVaultProfile {
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
        prfSalt: randomBytes(32).toString("base64url"),
        publicKeySpki,
        rootFingerprint,
        transports: ["nfc", "usb"],
    };
}

async function main(): Promise<void> {
    const { directory, module } = await loadModule();
    try {
        const profile = testProfile();
        const exported = module.serializeSecurityKeyVaultProfile(profile);
        assert.match(exported, /^PCSKV1:/u);
        assert.deepEqual(module.parseSecurityKeyVaultProfile(exported), profile);
        assert.equal(module.formatSecurityKeyVaultFingerprint(profile.rootFingerprint).split(" ").length, 16);

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
        module.activatePreparedSecurityKeyVault({ key: firstPreparedKey, profile });
        assert.equal(firstPreparedKey.every(byte => byte === 0), true,
            "the transferred prepared key must be wiped after activation");
        const wrapped = module.wrapSecurityKeyVaultValue(plaintextVault);
        const envelope = module.parseSecurityKeyVaultEnvelope(wrapped);
        assert.ok(envelope, "an active security key must wrap the Secure Messaging vault");
        assert.equal(JSON.stringify(wrapped).includes("private material must be wrapped"), false,
            "private identity material must not remain visible in the OS-protected outer payload");
        assert.equal(module.securityKeyVaultStateForValue(wrapped).status, "unlocked");
        assert.deepEqual(module.unwrapSecurityKeyVaultValue(wrapped), plaintextVault);

        module.clearSecurityKeyVaultSession();
        assert.equal(module.securityKeyVaultStateForValue(wrapped).status, "locked");
        assert.throws(() => module.unwrapSecurityKeyVaultValue(wrapped), /locked/u,
            "the E2E vault must be unavailable without the physical-key-derived session key");

        module.activatePreparedSecurityKeyVault({ key: Buffer.from(key), profile });
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
    } finally {
        await rm(directory, { force: true, recursive: true });
    }

    const implementation = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/securityKeyVault.ts",
        import.meta.url,
    ), "utf8");
    assert.match(implementation, /extensions:\{prf:\{eval:\{first:/u,
        "WebAuthn PRF/hmac-secret output must derive the vault wrapping key");
    assert.match(implementation, /userVerification:"required"/u);
    assert.match(implementation, /authenticatorAttachment:"cross-platform"/u);
    assert.match(implementation, /session\.fromPartition\(`pc-secure-vault-/u);
    assert.match(implementation, /createCipheriv\("aes-256-gcm"/u);
    assert.match(implementation, /hkdfSync\(/u);
    assert.match(implementation, /output\.fill\(0\)/u);
    assert.match(implementation, /plaintext\?\.fill\(0\)|plaintext\.fill\(0\)/u);

    const native = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/native.ts",
        import.meta.url,
    ), "utf8");
    assert.match(native, /unwrapSecurityKeyVaultValue/u);
    assert.match(native, /wrapSecurityKeyVaultValue/u);
    assert.match(native, /setupSecurityKeyVault/u);
    assert.match(native, /unlockSecurityKeyVault/u);
    assert.match(native, /lockSecurityKeyVault/u);
    assert.match(native, /removeSecurityKeyVault/u);

    const renderer = readFileSync(new URL(
        "../src/equicordplugins/secureMessaging.desktop/index.tsx",
        import.meta.url,
    ), "utf8");
    assert.match(renderer, /<Heading tag="h5">Security key<\/Heading>/u);
    assert.match(renderer, /Native\.setupSecurityKeyVault/u);
    assert.match(renderer, /Native\.unlockSecurityKeyVault/u);
    assert.match(renderer, /await Native\.lockSecurityKeyVault\(\)/u,
        "changing Discord accounts must clear the unlocked E2E vault key");
    assert.match(renderer, /void Native\.lockSecurityKeyVault\(\)/u,
        "stopping the plugin must clear the unlocked E2E vault key");
    assert.doesNotMatch(renderer, /title="Secure Messaging \(PCEM3\)"/u);
    assert.doesNotMatch(renderer, /<Heading tag="h5">Important limitations<\/Heading>/u);
    assert.doesNotMatch(renderer, /Non-ratcheting end-to-end encryption for selected people/u);

    assert.equal(existsSync(new URL(
        "../src/equicordplugins/secureMessagingSecurityKey.desktop/index.tsx",
        import.meta.url,
    )), false, "hardware-key controls must not register a second chat-bar icon");

    console.log("Secure Messaging PRF-backed security-key vault checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
