/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";

import puppeteer from "puppeteer-core";

interface LargeBlobRoundTripResult {
    blob: number[] | null;
    residentKey: boolean;
    supported: boolean;
    written: boolean;
}

interface PrfRoundTripResult {
    creationOutput: number[] | null;
    different: number[];
    enabled: boolean;
    first: number[];
    repeated: number[];
    residentKey: boolean;
}

function browserExecutable(): string | null {
    const candidates = [
        process.env.CHROMIUM_BIN,
        process.env.CHROME_PATH,
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ];
    return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

async function main(): Promise<void> {
    const executablePath = browserExecutable();
    if (!executablePath) {
        if (process.env.CI) throw new Error("A Chromium executable is required for the WebAuthn security-key CI test");
        console.log("Skipping WebAuthn security-key browser test because Chromium was not found");
        return;
    }

    const server = createServer((_request, response) => {
        response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'",
            "Content-Type": "text/html; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
        });
        response.end("<!doctype html><meta charset=utf-8><title>WebAuthn security-key test</title>");
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "localhost", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const browser = await puppeteer.launch({
        args: ["--disable-dev-shm-usage", "--no-sandbox"],
        executablePath,
        headless: true,
    });
    try {
        const page = await browser.newPage();
        await page.goto(`http://localhost:${address.port}/`, { waitUntil: "domcontentloaded" });
        const session = await page.createCDPSession();
        await (session as any).send("WebAuthn.enable", { enableUI: false });
        try {
            const { authenticatorId } = await (session as any).send("WebAuthn.addVirtualAuthenticator", {
                options: {
                    automaticPresenceSimulation: true,
                    ctap2Version: "ctap2_1",
                    hasLargeBlob: true,
                    hasResidentKey: true,
                    hasUserVerification: true,
                    isUserVerified: true,
                    protocol: "ctap2",
                    transport: "usb",
                },
            });
            try {
                const payload = Array.from({ length: 70 }, (_value, index) => (index * 29 + 7) & 0xff);
                const result = await page.evaluate(`(async () => {
                const storedPayload = ${JSON.stringify(payload)};
                const credential = await navigator.credentials.create({
                    publicKey: {
                        attestation: "none",
                        authenticatorSelection: {
                            authenticatorAttachment: "cross-platform",
                            requireResidentKey: true,
                            residentKey: "required",
                            userVerification: "required"
                        },
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        extensions: {
                            credProps: true,
                            largeBlob: { support: "required" }
                        },
                        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
                        rp: { id: "localhost", name: "ProtonnCord Secure Messaging test" },
                        timeout: 30000,
                        user: {
                            displayName: "ProtonnCord test vault",
                            id: crypto.getRandomValues(new Uint8Array(32)),
                            name: "ProtonnCord test vault"
                        }
                    }
                });
                if (!(credential instanceof PublicKeyCredential)) throw new Error("registration returned no public-key credential");
                const registrationExtensions = credential.getClientExtensionResults();

                const write = await navigator.credentials.get({
                    publicKey: {
                        allowCredentials: [{ id: credential.rawId, type: "public-key" }],
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        extensions: {
                            largeBlob: { write: new Uint8Array(storedPayload) }
                        },
                        rpId: "localhost",
                        timeout: 30000,
                        userVerification: "required"
                    }
                });
                if (!(write instanceof PublicKeyCredential)) throw new Error("write returned no public-key credential");
                const writeExtensions = write.getClientExtensionResults();

                const read = await navigator.credentials.get({
                    publicKey: {
                        allowCredentials: [{ id: credential.rawId, type: "public-key" }],
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        extensions: { largeBlob: { read: true } },
                        rpId: "localhost",
                        timeout: 30000,
                        userVerification: "required"
                    }
                });
                if (!(read instanceof PublicKeyCredential)) throw new Error("read returned no public-key credential");
                const readExtensions = read.getClientExtensionResults();
                const blob = readExtensions.largeBlob?.blob;

                return {
                    blob: blob ? [...new Uint8Array(blob)] : null,
                    residentKey: registrationExtensions.credProps?.rk === true,
                    supported: registrationExtensions.largeBlob?.supported === true,
                    written: writeExtensions.largeBlob?.written === true
                };
                })()`) as LargeBlobRoundTripResult;

                assert.equal(result.residentKey, true, "large-blob credentials must be discoverable");
                assert.equal(result.supported, true, "registration must report large-blob support");
                assert.equal(result.written, true, "the authenticator must confirm the large-blob write");
                assert.deepEqual(result.blob, payload, "the authenticated large-blob read must return the stored vault payload");
            } finally {
                await (session as any).send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
            }

            const { authenticatorId: prfAuthenticatorId } = await (session as any).send("WebAuthn.addVirtualAuthenticator", {
                options: {
                    automaticPresenceSimulation: true,
                    ctap2Version: "ctap2_0",
                    hasHmacSecret: true,
                    hasResidentKey: true,
                    hasUserVerification: true,
                    isUserVerified: true,
                    protocol: "ctap2",
                    transport: "usb",
                },
            });
            try {
                const result = await page.evaluate(`(async () => {
                    const salt = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
                    const differentSalt = Uint8Array.from({ length: 32 }, (_value, index) => 255 - index);
                    const credential = await navigator.credentials.create({
                        publicKey: {
                            attestation: "none",
                            authenticatorSelection: {
                                authenticatorAttachment: "cross-platform",
                                requireResidentKey: true,
                                residentKey: "required",
                                userVerification: "required"
                            },
                            challenge: crypto.getRandomValues(new Uint8Array(32)),
                            extensions: {
                                credProps: true,
                                largeBlob: { support: "preferred" },
                                prf: { eval: { first: salt } }
                            },
                            pubKeyCredParams: [
                                { alg: -7, type: "public-key" },
                                { alg: -8, type: "public-key" },
                                { alg: -257, type: "public-key" }
                            ],
                            rp: { id: "localhost", name: "ProtonnCord Secure Messaging test" },
                            timeout: 30000,
                            user: {
                                displayName: "ProtonnCord test vault",
                                id: crypto.getRandomValues(new Uint8Array(32)),
                                name: "ProtonnCord test vault"
                            }
                        }
                    });
                    if (!(credential instanceof PublicKeyCredential)) throw new Error("registration returned no public-key credential");
                    const registrationExtensions = credential.getClientExtensionResults();
                    const evaluate = async input => {
                        const assertion = await navigator.credentials.get({
                            publicKey: {
                                allowCredentials: [{ id: credential.rawId, type: "public-key" }],
                                challenge: crypto.getRandomValues(new Uint8Array(32)),
                                extensions: { prf: { eval: { first: input } } },
                                rpId: "localhost",
                                timeout: 30000,
                                userVerification: "required"
                            }
                        });
                        if (!(assertion instanceof PublicKeyCredential)) throw new Error("assertion returned no public-key credential");
                        const output = assertion.getClientExtensionResults().prf?.results?.first;
                        if (!output) throw new Error("assertion returned no PRF output");
                        return [...new Uint8Array(output)];
                    };
                    const creationOutput = registrationExtensions.prf?.results?.first;
                    return {
                        creationOutput: creationOutput ? [...new Uint8Array(creationOutput)] : null,
                        different: await evaluate(differentSalt),
                        enabled: registrationExtensions.prf?.enabled === true,
                        first: await evaluate(salt),
                        repeated: await evaluate(salt),
                        residentKey: registrationExtensions.credProps?.rk === true
                    };
                })()`) as PrfRoundTripResult;

                assert.equal(result.enabled, true, "OneKey-style hmac-secret credentials must expose WebAuthn PRF");
                assert.equal(result.creationOutput, null,
                    "hmac-secret credentials without makeCredential support must use the plugin's second assertion path");
                assert.equal(result.residentKey, true, "the OneKey-compatible credential must remain discoverable");
                assert.equal(result.first.length, 32, "PRF output must supply a 256-bit vault secret");
                assert.deepEqual(result.repeated, result.first, "the same credential and salt must reproduce the vault secret");
                assert.notDeepEqual(result.different, result.first, "a different PRF salt must produce another vault secret");
            } finally {
                await (session as any).send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: prfAuthenticatorId });
            }
        } finally {
            await (session as any).send("WebAuthn.disable");
        }
    } finally {
        await browser.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    console.log("WebAuthn virtual security-key PRF and large-blob round trips passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
