/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";

import puppeteer from "puppeteer-core";

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
        if (process.env.CI) throw new Error("A Chromium executable is required for the WebAuthn large-blob CI test");
        console.log("Skipping WebAuthn large-blob browser test because Chromium was not found");
        return;
    }

    const server = createServer((_request, response) => {
        response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'",
            "Content-Type": "text/html; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
        });
        response.end("<!doctype html><meta charset=utf-8><title>WebAuthn largeBlob test</title>");
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
            const result = await page.evaluate(async storedPayload => {
                const credential = await navigator.credentials.create({
                    publicKey: {
                        attestation: "none",
                        authenticatorSelection: {
                            authenticatorAttachment: "cross-platform",
                            requireResidentKey: true,
                            residentKey: "required",
                            userVerification: "required",
                        },
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        extensions: {
                            credProps: true,
                            largeBlob: { support: "required" },
                        } as any,
                        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
                        rp: { id: "localhost", name: "ProtonnCord Secure Messaging test" },
                        timeout: 30_000,
                        user: {
                            displayName: "ProtonnCord test vault",
                            id: crypto.getRandomValues(new Uint8Array(32)),
                            name: "ProtonnCord test vault",
                        },
                    },
                }) as PublicKeyCredential;
                const registrationExtensions = credential.getClientExtensionResults() as any;

                const write = await navigator.credentials.get({
                    publicKey: {
                        allowCredentials: [{ id: credential.rawId, type: "public-key" }],
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        extensions: {
                            largeBlob: { write: new Uint8Array(storedPayload) },
                        } as any,
                        rpId: "localhost",
                        timeout: 30_000,
                        userVerification: "required",
                    },
                }) as PublicKeyCredential;
                const writeExtensions = write.getClientExtensionResults() as any;

                const read = await navigator.credentials.get({
                    publicKey: {
                        allowCredentials: [{ id: credential.rawId, type: "public-key" }],
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        extensions: { largeBlob: { read: true } } as any,
                        rpId: "localhost",
                        timeout: 30_000,
                        userVerification: "required",
                    },
                }) as PublicKeyCredential;
                const readExtensions = read.getClientExtensionResults() as any;
                const blob = readExtensions.largeBlob?.blob;

                return {
                    blob: blob ? [...new Uint8Array(blob)] : null,
                    residentKey: registrationExtensions.credProps?.rk === true,
                    supported: registrationExtensions.largeBlob?.supported === true,
                    written: writeExtensions.largeBlob?.written === true,
                };
            }, payload);

            assert.equal(result.residentKey, true, "large-blob credentials must be discoverable");
            assert.equal(result.supported, true, "registration must report large-blob support");
            assert.equal(result.written, true, "the authenticator must confirm the large-blob write");
            assert.deepEqual(result.blob, payload, "the authenticated large-blob read must return the stored vault payload");
        } finally {
            await (session as any).send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
            await (session as any).send("WebAuthn.disable");
        }
    } finally {
        await browser.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    console.log("WebAuthn virtual security-key large-blob round trip passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
