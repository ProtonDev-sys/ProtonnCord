/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build, type Plugin } from "esbuild";
import type { IpcMainInvokeEvent } from "electron";

import {
    attachmentBundleRoot,
    DETACHED_TEXT_FILENAME,
    DETACHED_TEXT_MIME_TYPE,
    encryptAttachmentBytes,
    generateAttachmentBundleMaterial,
    serializeSecurePlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/attachments";
import type { ConversationSnapshot } from "../src/equicordplugins/secureMessaging.desktop/native";
import { parseEncryptedEnvelope } from "../src/equicordplugins/secureMessaging.desktop/protocol";

type NativeModule = typeof import("../src/equicordplugins/secureMessaging.desktop/native");

const ALICE_ID = "100000000000000001";
const BOB_ID = "100000000000000002";
const CAROL_ID = "100000000000000003";
const OUTSIDER_ID = "100000000000000004";
const DM_CHANNEL_ID = "200000000000000001";
const GROUP_CHANNEL_ID = "200000000000000002";
const OUTSIDER_CHANNEL_ID = "200000000000000003";
const DISCORD_EVENT = discordEvent("https://discord.com/channels/@me/200000000000000001");

class AuthenticatedProtector {
    available = true;
    backend = "kwallet6";
    failFinalFileSync = false;
    failDownloadWrite = false;
    failParentDirectorySync = false;
    failVaultDirectorySync = false;
    finalFileSyncCalls = 0;
    parentDirectorySyncCalls = 0;
    vaultDirectorySyncCalls = 0;
    readonly key = createHash("sha256").update("secure-messaging-native-test-protector").digest();

    isEncryptionAvailable(): boolean {
        return this.available;
    }

    getSelectedStorageBackend(): string {
        return this.backend;
    }

    encryptString(plaintext: string): Buffer {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return Buffer.concat([Buffer.from("SMT1"), nonce, cipher.getAuthTag(), ciphertext]);
    }

    decryptString(protectedValue: Buffer): string {
        if (protectedValue.byteLength < 33 || protectedValue.subarray(0, 4).toString("ascii") !== "SMT1")
            throw new Error("Invalid protected value");
        const decipher = createDecipheriv("aes-256-gcm", this.key, protectedValue.subarray(4, 16));
        decipher.setAuthTag(protectedValue.subarray(16, 32));
        return Buffer.concat([decipher.update(protectedValue.subarray(32)), decipher.final()]).toString("utf8");
    }
}

interface HarnessRuntime {
    appListeners?: Array<[string, (event: unknown, window: HarnessWindow) => void]>;
    browserWindows?: HarnessWindow[];
    dataDir: string;
    oneKeySecret?: Buffer;
    protector: AuthenticatedProtector;
}

interface HarnessWindow {
    failWhen?: boolean;
    scripts: string[];
    values: boolean[];
    webContents: {
        fail?: boolean;
        executeJavaScript(script: string): Promise<void>;
    };
    setContentProtection(enabled: boolean): void;
}

interface HarnessGlobal {
    __secureMessagingNativeHarness: HarnessRuntime;
}

const harnessGlobal = globalThis as typeof globalThis & HarnessGlobal;
const protector = new AuthenticatedProtector();

function captureWindow(failWhen?: boolean): HarnessWindow {
    const scripts: string[] = [];
    const webContents: HarnessWindow["webContents"] = {
        async executeJavaScript(script) {
            scripts.push(script);
            if (this.fail) throw new Error("Injected encrypted-content visibility failure");
        },
    };
    return {
        failWhen,
        scripts,
        values: [],
        webContents,
        setContentProtection(enabled) {
            this.values.push(enabled);
            if (this.failWhen === enabled) throw new Error("Injected screen-capture protection failure");
        },
    };
}

function discordEvent(url: string): IpcMainInvokeEvent {
    return {
        senderFrame: { url } as IpcMainInvokeEvent["senderFrame"],
    } as IpcMainInvokeEvent;
}

function messageId(index: number): string {
    return (30_000_000_000_000_000n + BigInt(index)).toString();
}

function messageIdAt(timestamp: number): string {
    return ((BigInt(timestamp) - 1_420_070_400_000n) << 22n).toString();
}

function lastNumber(values: number[], label: string): number {
    const value = values.at(-1);
    if (value === undefined) assert.fail(`${label} must not be empty`);
    return value;
}

type WithStatus<T, S extends string> = T extends { status: infer Status extends string; }
    ? S extends Status ? T & { status: S; } : never
    : never;

function expectStatus<T extends { status: string; }, S extends string>(
    result: T,
    expected: S,
    label: string,
): asserts result is WithStatus<T, S> {
    assert.equal(result.status, expected, `${label}: ${JSON.stringify(result)}`);
}

function dmSnapshot(channelId: string, peerId: string): ConversationSnapshot {
    return { channelId, kind: "DM", participantUserIds: [peerId] };
}

function groupSnapshot(...participantUserIds: string[]): ConversationSnapshot {
    return { channelId: GROUP_CHANNEL_ID, kind: "GROUP_DM", participantUserIds };
}

const runtimeStubs: Plugin = {
    name: "secure-messaging-native-runtime-stubs",
    setup(bundle) {
        bundle.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "secure-native-test" }));
        bundle.onResolve({ filter: /^@main\/utils\/constants$/ }, () => ({ path: "constants", namespace: "secure-native-test" }));
        bundle.onResolve({ filter: /^fs\/promises$/ }, () => ({ path: "fs-promises", namespace: "secure-native-test" }));
        bundle.onResolve({ filter: /^\.\/oneKeyWindowsVault$/ }, () => ({
            path: "onekey-windows-vault",
            namespace: "secure-native-test",
        }));
        bundle.onLoad({ filter: /^electron$/, namespace: "secure-native-test" }, () => ({
            contents: `
                const runtime = globalThis.__secureMessagingNativeHarness;
                export const safeStorage = {
                    isEncryptionAvailable: () => runtime.protector.isEncryptionAvailable(),
                    getSelectedStorageBackend: () => runtime.protector.getSelectedStorageBackend(),
                    encryptString: value => runtime.protector.encryptString(value),
                    decryptString: value => runtime.protector.decryptString(value),
                };
                export const BrowserWindow = {
                    fromWebContents: () => null,
                    getAllWindows: () => runtime.browserWindows ?? [],
                };
                export const session = {
                    fromPartition: () => ({
                        setPermissionRequestHandler() {},
                        async clearStorageData() {},
                    }),
                };
                export const app = {
                    getPath: name => {
                        if (name !== "downloads") throw new Error("Unexpected app path request");
                        return runtime.dataDir + "/Downloads";
                    },
                    on: (event, listener) => {
                        (runtime.appListeners ??= []).push([event, listener]);
                    },
                };
            `,
            loader: "js",
        }));
        bundle.onLoad({ filter: /^constants$/, namespace: "secure-native-test" }, () => ({
            contents: "export const DATA_DIR = globalThis.__secureMessagingNativeHarness.dataDir;",
            loader: "js",
        }));
        bundle.onLoad({ filter: /^onekey-windows-vault$/, namespace: "secure-native-test" }, () => ({
            contents: `
                import { Buffer } from "node:buffer";
                export async function runOneKeyWindowsVaultCipher() {
                    const configured = globalThis.__secureMessagingNativeHarness.oneKeySecret;
                    return { ok: true, value: configured ? Buffer.from(configured) : Buffer.alloc(32, 0x51) };
                }
            `,
            loader: "js",
        }));
        bundle.onLoad({ filter: /^fs-promises$/, namespace: "secure-native-test" }, () => ({
            contents: `
                import * as fs from "node:fs/promises";
                export * from "node:fs/promises";
                export async function open(path, flags, mode) {
                    const handle = await fs.open(path, flags, mode);
                    const runtime = globalThis.__secureMessagingNativeHarness;
                    if (flags === "wx" && String(path).replaceAll("\\\\", "/").includes("/Downloads/") &&
                        runtime.protector.failDownloadWrite) {
                        handle.writeFile = async () => {
                            const error = new Error("Injected download write failure");
                            error.code = "EIO";
                            throw error;
                        };
                    } else if (flags === "r" && (await fs.stat(path)).isDirectory()) {
                        const vaultDirectory = String(path).replaceAll("\\\\", "/").endsWith("/secure-messaging");
                        handle.sync = async () => {
                            if (vaultDirectory) runtime.protector.vaultDirectorySyncCalls++;
                            else runtime.protector.parentDirectorySyncCalls++;
                            if ((vaultDirectory && runtime.protector.failVaultDirectorySync) ||
                                (!vaultDirectory && runtime.protector.failParentDirectorySync)) {
                                const error = new Error("Injected directory fsync failure");
                                error.code = "EIO";
                                throw error;
                            }
                        };
                    } else if (flags === "r+" && runtime.protector.failFinalFileSync) {
                        handle.sync = async () => {
                            runtime.protector.finalFileSyncCalls++;
                            const error = new Error("Injected final-file fsync failure");
                            error.code = "EIO";
                            throw error;
                        };
                    } else if (flags === "r+") {
                        const sync = handle.sync.bind(handle);
                        handle.sync = async () => {
                            runtime.protector.finalFileSyncCalls++;
                            await sync();
                        };
                    }
                    return handle;
                }
            `,
            loader: "js",
        }));
    },
};

async function buildNativeBundle(bundlePath: string, emulatePlatform?: "linux" | "win32"): Promise<void> {
    await build({
        absWorkingDir: resolve("."),
        bundle: true,
        define: emulatePlatform ? { "process.platform": JSON.stringify(emulatePlatform) } : undefined,
        entryPoints: ["src/equicordplugins/secureMessaging.desktop/native.ts"],
        format: "esm",
        outfile: bundlePath,
        platform: "node",
        plugins: [runtimeStubs],
        target: "node22",
    });
}

let loadSequence = 0;

async function loadNative(bundlePath: string, dataDir: string, oneKeySecret?: Buffer): Promise<NativeModule> {
    harnessGlobal.__secureMessagingNativeHarness = { dataDir, oneKeySecret, protector };
    const url = pathToFileURL(bundlePath);
    url.searchParams.set("instance", String(++loadSequence));
    return import(url.href) as Promise<NativeModule>;
}

async function createAnnouncement(native: NativeModule, userId: string): Promise<string> {
    const result = await native.createAnnouncement(DISCORD_EVENT, userId);
    expectStatus(result, "created", `create announcement for ${userId}`);
    return result.content;
}

async function trustAnnouncement(
    native: NativeModule,
    localUserId: string,
    peerUserId: string,
    announcement: string,
    publishedAt = Date.now(),
): Promise<void> {
    const review = await native.reviewAnnouncement(
        DISCORD_EVENT,
        localUserId,
        peerUserId,
        announcement,
        messageIdAt(publishedAt),
        null,
    );
    expectStatus(review, "trust_required", `${localUserId} explicitly reviews ${peerUserId}`);
    const trusted = await native.trustReviewedKey(
        DISCORD_EVENT,
        localUserId,
        peerUserId,
        review.reviewToken,
        review.identity.fingerprint,
    );
    expectStatus(trusted, "trusted", `${localUserId} explicitly trusts ${peerUserId}`);
}

async function testInvalidInputs(native: NativeModule): Promise<void> {
    const hostileEvent = discordEvent("https://example.com/channels/@me/200000000000000001");
    const acknowledgementName = "PROTONN_CORD_SECURE_MESSAGING_LIVE_TEST";
    const dataDirectoryName = "PROTONN_CORD_SECURE_MESSAGING_LIVE_DATA_DIR";
    const previousAcknowledgement = process.env[acknowledgementName];
    const previousDataDirectory = process.env[dataDirectoryName];
    try {
        delete process.env[acknowledgementName];
        delete process.env[dataDirectoryName];
        expectStatus(
            await native.getLiveTestDownloadsDirectory(DISCORD_EVENT),
            "invalid_input",
            "ordinary production renderers cannot query the Downloads path",
        );
        process.env[acknowledgementName] = "I_UNDERSTAND_THIS_IS_DISPOSABLE";
        process.env[dataDirectoryName] = join(harnessGlobal.__secureMessagingNativeHarness.dataDir, "secure-messaging-live-mismatch");
        expectStatus(
            await native.getLiveTestDownloadsDirectory(DISCORD_EVENT),
            "invalid_input",
            "a mismatched disposable data directory cannot query the Downloads path",
        );
        expectStatus(
            await native.getLiveTestDownloadsDirectory(hostileEvent),
            "invalid_input",
            "a non-Discord IPC caller cannot query the live-test Downloads path",
        );
        process.env[dataDirectoryName] = harnessGlobal.__secureMessagingNativeHarness.dataDir;
        const downloadsDirectory = await native.getLiveTestDownloadsDirectory(DISCORD_EVENT);
        expectStatus(downloadsDirectory, "ready", "an acknowledged disposable profile can query its Downloads path");
        assert.equal(downloadsDirectory.path, resolve(harnessGlobal.__secureMessagingNativeHarness.dataDir, "Downloads"));
    } finally {
        if (previousAcknowledgement === undefined) delete process.env[acknowledgementName];
        else process.env[acknowledgementName] = previousAcknowledgement;
        if (previousDataDirectory === undefined) delete process.env[dataDirectoryName];
        else process.env[dataDirectoryName] = previousDataDirectory;
    }
    expectStatus(await native.setScreenCaptureProtection(hostileEvent, true), "invalid_input", "non-Discord capture-protection IPC origin");
    expectStatus(
        await native.setScreenCaptureProtection(DISCORD_EVENT, "true" as never),
        "invalid_input",
        "capture-protection input must be boolean",
    );
    expectStatus(await native.getIdentity(hostileEvent, ALICE_ID), "invalid_input", "non-Discord IPC origin");
    expectStatus(await native.getIdentity(DISCORD_EVENT, "not-a-snowflake"), "invalid_input", "invalid local user");
    expectStatus(await native.getChannelProtection(DISCORD_EVENT, ALICE_ID, "not-a-snowflake"), "invalid_input", "invalid protection channel");
    expectStatus(await native.rotateIdentity(DISCORD_EVENT, ALICE_ID, "bad"), "invalid_input", "invalid rotation fingerprint");
    expectStatus(
        await native.reviewAnnouncement(DISCORD_EVENT, ALICE_ID, ALICE_ID, "bad", messageIdAt(Date.now()), null),
        "invalid_input",
        "self review",
    );
    expectStatus(
        await native.reviewAnnouncement(DISCORD_EVENT, ALICE_ID, BOB_ID, "", messageIdAt(Date.now()), null),
        "invalid_input",
        "empty announcement",
    );
    expectStatus(
        await native.reviewAnnouncement(DISCORD_EVENT, ALICE_ID, BOB_ID, "bad", "not-a-snowflake", null),
        "invalid_input",
        "invalid announcement Discord message ID",
    );
    expectStatus(
        await native.reviewAnnouncement(
            DISCORD_EVENT,
            ALICE_ID,
            BOB_ID,
            "bad",
            messageIdAt(Date.now()),
            "9999-99-99T99:99:99.999Z",
        ),
        "invalid_input",
        "invalid announcement edited timestamp",
    );
    expectStatus(await native.trustReviewedKey(DISCORD_EVENT, ALICE_ID, BOB_ID, "bad", "bad"), "invalid_input", "invalid review proof");
    expectStatus(await native.forgetPeer(DISCORD_EVENT, ALICE_ID, ALICE_ID), "invalid_input", "forget self");
    expectStatus(await native.getConversation(DISCORD_EVENT, ALICE_ID, {
        channelId: DM_CHANNEL_ID,
        kind: "DM",
        participantUserIds: [ALICE_ID],
    }), "invalid_input", "snapshot containing local user");
    expectStatus(await native.getConversation(DISCORD_EVENT, ALICE_ID, {
        channelId: GROUP_CHANNEL_ID,
        kind: "GROUP_DM",
        participantUserIds: [BOB_ID, BOB_ID],
    }), "invalid_input", "snapshot duplicate participants");
    expectStatus(await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [],
        snapshot: dmSnapshot(DM_CHANNEL_ID, BOB_ID),
    }), "invalid_input", "enabled conversation without recipients");
    expectStatus(await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [CAROL_ID],
        snapshot: dmSnapshot(DM_CHANNEL_ID, BOB_ID),
    }), "invalid_input", "recipient outside snapshot");
    expectStatus(await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "",
        snapshot: dmSnapshot(DM_CHANNEL_ID, BOB_ID),
    }), "invalid_input", "empty plaintext");
    expectStatus(await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "x".repeat(2_001),
        snapshot: dmSnapshot(DM_CHANNEL_ID, BOB_ID),
    }), "invalid_input", "oversized plaintext input");
    expectStatus(await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        channelId: DM_CHANNEL_ID,
        content: "",
        discordAuthorId: BOB_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(1),
    }), "invalid_input", "empty encrypted content");
    expectStatus(await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        channelId: DM_CHANNEL_ID,
        content: "not-an-envelope",
        discordAuthorId: BOB_ID,
        discordEditedTimestamp: "9999-99-99T99:99:99.999Z",
        discordMessageId: messageId(1),
    }), "invalid_input", "invalid canonical-shaped edited timestamp");
}

async function testScreenCaptureProtection(native: NativeModule): Promise<void> {
    const primary = captureWindow();
    const failing = captureWindow(false);
    const runtime = harnessGlobal.__secureMessagingNativeHarness;
    runtime.browserWindows = [primary, failing];

    const failedEnable = await native.setScreenCaptureProtection(DISCORD_EVENT, true);
    expectStatus(failedEnable, "failed", "window capture-protection failure is structured across IPC");
    assert.equal(failedEnable.error, "screen_capture_protection_failed");
    assert.deepEqual(primary.values, [false, false], "capture blocking stays disabled during a partial visibility failure");
    assert.deepEqual(failing.values, [false, false], "the failing window never receives capture blocking during rollback");
    assert.ok(primary.values.every(value => value === false), "whole-window content protection is never enabled");

    failing.failWhen = undefined;
    runtime.browserWindows = [primary];
    const enabled = await native.setScreenCaptureProtection(DISCORD_EVENT, true);
    expectStatus(enabled, "applied", "normal encrypted-content visibility restores after the injected failure clears");
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.windowCount, 1);
    assert.ok(primary.scripts.at(-1)?.includes("classList.remove"), "encrypted DOM content is revealed after visibility restoration");
    assert.ok(primary.scripts.at(-1)?.includes("document.visibilityState==='visible'"), "hidden Discord windows cannot deadlock visibility restoration");
    assert.ok(primary.scripts.at(-1)?.includes("setTimeout(complete,250)"), "falsely visible Discord windows cannot deadlock visibility restoration");
    assert.equal(runtime.appListeners?.filter(([event]) => event === "browser-window-created").length, 1, "future-window hook installs once");

    const futureWindow = captureWindow();
    const windowHook = runtime.appListeners?.find(([event]) => event === "browser-window-created")?.[1];
    assert.ok(windowHook, "future-window screenshot-mode hook is registered");
    windowHook({}, futureWindow);
    assert.deepEqual(futureWindow.values, [false], "a future window remains capturable while encrypted content is visible");
    assert.ok(futureWindow.scripts.at(-1)?.includes("classList.remove"), "a normal future window is not left in screenshot mode");

    const failingFutureWindow = captureWindow(false);
    runtime.browserWindows = [primary, failingFutureWindow];
    windowHook({}, failingFutureWindow);
    assert.equal(primary.values.at(-1), false, "a future-window failure never enables capture blocking on existing windows");
    const decryptAfterVisibilityFailure = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        channelId: DM_CHANNEL_ID,
        content: "PCEM1:blocked-until-protection-recovers",
        discordAuthorId: BOB_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(2),
    });
    expectStatus(decryptAfterVisibilityFailure, "invalid_message", "capture visibility failures do not block cryptographic processing");

    runtime.browserWindows = [primary];
    expectStatus(await native.setScreenCaptureProtection(DISCORD_EVENT, true), "applied", "visibility recovers after a future-window failure");
    expectStatus(await native.setScreenCaptureProtection(DISCORD_EVENT, false), "applied", "screenshot mode enables cleanly");
    assert.ok(primary.scripts.at(-1)?.includes("classList.add"), "screenshot mode hides encrypted DOM content");
    assert.ok(primary.scripts.at(-1)?.includes("querySelectorAll('video,audio')"), "screenshot mode pauses detached blob media");
    assert.ok(primary.scripts.at(-1)?.includes("exitPictureInPicture"), "screenshot mode exits picture-in-picture media");
    assert.ok(primary.scripts.at(-1)?.includes("exitFullscreen"), "screenshot mode exits fullscreen media");
    expectStatus(await native.setScreenCaptureProtection(DISCORD_EVENT, true), "applied", "encrypted content becomes visible serially");
    assert.ok(primary.scripts.at(-1)?.includes("classList.remove"), "encrypted DOM content is revealed after screenshot mode");
    assert.ok(primary.values.every(value => value === false), "every screenshot-mode transition keeps Discord capturable");
    assert.equal(runtime.appListeners?.filter(([event]) => event === "browser-window-created").length, 1, "re-enabling does not duplicate hooks");
}

async function testStorageFailures(bundlePath: string, linuxBundlePath: string, windowsBundlePath: string, root: string): Promise<void> {
    protector.available = false;
    let native = await loadNative(bundlePath, join(root, "unavailable"));
    let result = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(result, "unavailable", "safeStorage unavailable");
    assert.equal(result.reason, "encryption_unavailable");

    protector.available = true;
    protector.backend = "basic_text";
    native = await loadNative(linuxBundlePath, join(root, "unsafe-backend"));
    result = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(result, "unavailable", "unsafe Linux safeStorage backend");
    assert.equal(result.reason, "unsafe_linux_backend");

    protector.backend = "kwallet6";
    const corruptDir = join(root, "corrupt-vault");
    await mkdir(join(corruptDir, "secure-messaging"), { recursive: true });
    await writeFile(join(corruptDir, "secure-messaging", "vault.bin"), Buffer.from("not authenticated ciphertext"));
    native = await loadNative(bundlePath, corruptDir);
    result = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(result, "unavailable", "corrupt vault");
    assert.equal(result.reason, "vault_unreadable");

    const legacyQuarantineDir = join(root, "legacy-quarantine-order");
    const legacyQuarantineVaultDir = join(legacyQuarantineDir, "secure-messaging");
    await mkdir(legacyQuarantineVaultDir, { recursive: true });
    const legacyPairs = [
        `${ALICE_ID}:${BOB_ID}`,
        `${ALICE_ID}:${CAROL_ID}`,
        `${ALICE_ID}0:${OUTSIDER_ID}`,
    ];
    await writeFile(
        join(legacyQuarantineVaultDir, "quarantine.bin"),
        protector.encryptString(JSON.stringify({ pairs: legacyPairs, version: 1 })),
    );
    native = await loadNative(bundlePath, legacyQuarantineDir);
    expectStatus(await native.getIdentity(DISCORD_EVENT, ALICE_ID), "ready", "legacy locale-sorted quarantine journal loads");
    expectStatus(
        await native.forgetPeer(DISCORD_EVENT, ALICE_ID, BOB_ID),
        "forgotten",
        "legacy quarantine entry can be cleared and migrated",
    );
    const migratedJournal = JSON.parse(protector.decryptString(
        await readFile(join(legacyQuarantineVaultDir, "quarantine.bin")),
    )) as { entries: Array<{ pair: string; }>; version: number; };
    assert.equal(migratedJournal.version, 2, "legacy quarantine journal migrates to timestamped v2");
    const migratedPairs = migratedJournal.entries.map(entry => entry.pair);
    assert.deepEqual(
        migratedPairs,
        [...migratedPairs].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
        "v2 quarantine writer uses the parser's code-unit ordering for mixed snowflake lengths",
    );
    const migratedQuarantineNative = await loadNative(bundlePath, legacyQuarantineDir);
    expectStatus(
        await migratedQuarantineNative.getIdentity(DISCORD_EVENT, ALICE_ID),
        "ready",
        "migrated mixed-length v2 quarantine journal reloads",
    );

    const parentSyncDir = join(root, "parent-sync-failure");
    native = await loadNative(linuxBundlePath, parentSyncDir);
    const parentSyncCalls = protector.parentDirectorySyncCalls;
    protector.failParentDirectorySync = true;
    const parentSyncFailure = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(parentSyncFailure, "failed", "first-write parent directory fsync failure propagates");
    assert.equal(parentSyncFailure.error, "storage_error");
    assert.ok(protector.parentDirectorySyncCalls > parentSyncCalls, "first write attempted a parent directory fsync");
    protector.failParentDirectorySync = false;
    const failedParentSyncCalls = protector.parentDirectorySyncCalls;
    expectStatus(await native.getIdentity(DISCORD_EVENT, ALICE_ID), "ready", "first-write parent fsync is retried");
    assert.ok(protector.parentDirectorySyncCalls > failedParentSyncCalls, "retry flushes the already-created parent directory");

    const directorySyncDir = join(root, "directory-sync-failure");
    native = await loadNative(linuxBundlePath, directorySyncDir);
    const beforeDirectoryFailure = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(beforeDirectoryFailure, "ready", "identity before directory fsync fault");
    const vaultDirectorySyncCalls = protector.vaultDirectorySyncCalls;
    protector.failVaultDirectorySync = true;
    const directoryFailure = await native.rotateIdentity(
        DISCORD_EVENT,
        ALICE_ID,
        beforeDirectoryFailure.identity.fingerprint,
    );
    expectStatus(directoryFailure, "failed", "supported-platform directory fsync failure propagates");
    assert.equal(directoryFailure.error, "storage_error");
    assert.ok(protector.vaultDirectorySyncCalls > vaultDirectorySyncCalls, "post-rename vault directory fsync was attempted");
    protector.failVaultDirectorySync = false;
    const failedVaultDirectorySyncCalls = protector.vaultDirectorySyncCalls;
    const afterDirectoryFailure = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(afterDirectoryFailure, "ready", "vault reloads after post-rename directory fsync fault");
    assert.ok(protector.vaultDirectorySyncCalls > failedVaultDirectorySyncCalls, "reload retries the failed vault directory fsync");
    assert.notEqual(afterDirectoryFailure.identity.fingerprint, beforeDirectoryFailure.identity.fingerprint);

    const finalSyncDir = join(root, "windows-final-sync-failure");
    native = await loadNative(windowsBundlePath, finalSyncDir);
    const finalFileSyncCalls = protector.finalFileSyncCalls;
    protector.failFinalFileSync = true;
    const finalSyncFailure = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(finalSyncFailure, "failed", "Windows final-file fsync failure propagates");
    assert.equal(finalSyncFailure.error, "storage_error");
    assert.ok(protector.finalFileSyncCalls > finalFileSyncCalls, "Windows write attempted a final-file flush");
    protector.failFinalFileSync = false;
    const failedFinalFileSyncCalls = protector.finalFileSyncCalls;
    expectStatus(await native.getIdentity(DISCORD_EVENT, ALICE_ID), "ready", "Windows strategy succeeds after sync fault clears");
    assert.ok(protector.finalFileSyncCalls > failedFinalFileSyncCalls, "Windows reload retries the failed final-file flush");
}

async function testNativeLifecycle(bundlePath: string, dataDir: string): Promise<void> {
    const vaultDirectory = join(dataDir, "secure-messaging");
    const staleVaultTemporary = join(vaultDirectory, "vault.00000000-0000-4000-8000-000000000001.tmp");
    const staleQuarantineTemporary = join(vaultDirectory, "quarantine.00000000-0000-4000-8000-000000000002.tmp");
    await mkdir(vaultDirectory, { recursive: true });
    await writeFile(staleVaultTemporary, "interrupted vault write");
    await writeFile(staleQuarantineTemporary, "interrupted quarantine write");
    const native = await loadNative(bundlePath, dataDir);
    await testInvalidInputs(native);
    await testScreenCaptureProtection(native);

    const aliceIdentity = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    await assert.rejects(readFile(staleVaultTemporary), "startup removes an orphaned encrypted-vault temporary file");
    await assert.rejects(readFile(staleQuarantineTemporary), "startup removes an orphaned quarantine temporary file");
    const bobIdentity = await native.getIdentity(DISCORD_EVENT, BOB_ID);
    const carolIdentity = await native.getIdentity(DISCORD_EVENT, CAROL_ID);
    const outsiderIdentity = await native.getIdentity(DISCORD_EVENT, OUTSIDER_ID);
    expectStatus(aliceIdentity, "ready", "Alice identity creation");
    expectStatus(bobIdentity, "ready", "Bob identity creation");
    expectStatus(carolIdentity, "ready", "Carol identity creation");
    expectStatus(outsiderIdentity, "ready", "outsider identity creation");
    assert.equal(new Set([
        aliceIdentity.identity.fingerprint,
        bobIdentity.identity.fingerprint,
        carolIdentity.identity.fingerprint,
        outsiderIdentity.identity.fingerprint,
    ]).size, 4, "each account receives an independent identity");

    const [aliceAnnouncement, bobAnnouncement, carolAnnouncement, outsiderAnnouncement] = await Promise.all([
        createAnnouncement(native, ALICE_ID),
        createAnnouncement(native, BOB_ID),
        createAnnouncement(native, CAROL_ID),
        createAnnouncement(native, OUTSIDER_ID),
    ]);
    const bobOriginalPublishedAt = Date.now();
    await trustAnnouncement(native, ALICE_ID, BOB_ID, bobAnnouncement, bobOriginalPublishedAt);
    await trustAnnouncement(native, ALICE_ID, CAROL_ID, carolAnnouncement);
    await trustAnnouncement(native, BOB_ID, ALICE_ID, aliceAnnouncement);
    await trustAnnouncement(native, CAROL_ID, ALICE_ID, aliceAnnouncement);
    await trustAnnouncement(native, OUTSIDER_ID, ALICE_ID, aliceAnnouncement);

    const vaultPath = join(dataDir, "secure-messaging", "vault.bin");
    const legacyVault = JSON.parse(protector.decryptString(await readFile(vaultPath))) as {
        accounts: Record<string, Record<string, unknown>>;
    };
    for (const account of Object.values(legacyVault.accounts)) {
        delete account.identityHistory;
        delete account.peerIdentityHistory;
        const trustedPeers = account.trustedPeers as Record<string, Record<string, unknown>>;
        for (const peer of Object.values(trustedPeers)) {
            delete peer.keyChangedAt;
            delete peer.publishedAt;
        }
    }
    await writeFile(vaultPath, protector.encryptString(JSON.stringify(legacyVault)));
    const migratedNative = await loadNative(bundlePath, dataDir);
    expectStatus(await migratedNative.getIdentity(DISCORD_EVENT, ALICE_ID), "ready", "legacy v1 account migrates without losing identity");

    const aliceDm = dmSnapshot(DM_CHANNEL_ID, BOB_ID);
    const bobDm = dmSnapshot(DM_CHANNEL_ID, ALICE_ID);
    let conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID],
        snapshot: aliceDm,
    });
    expectStatus(conversation, "enabled", "Alice DM recipient configuration");
    conversation = await native.configureConversation(DISCORD_EVENT, BOB_ID, {
        enabled: true,
        selectedRecipientIds: [ALICE_ID],
        snapshot: bobDm,
    });
    expectStatus(conversation, "enabled", "Bob DM recipient configuration");
    expectStatus(await native.getChannelProtection(DISCORD_EVENT, ALICE_ID, DM_CHANNEL_ID), "protected", "persisted protection lookup");
    expectStatus(await native.getChannelProtection(DISCORD_EVENT, ALICE_ID, "200000000000000099"), "unconfigured", "unknown channel protection lookup");

    const aliceGroup = groupSnapshot(BOB_ID, CAROL_ID);
    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID, CAROL_ID],
        snapshot: aliceGroup,
    });
    expectStatus(conversation, "enabled", "selected group recipient configuration");
    const groupPlaintext = "one shared group envelope";
    const encryptedGroup = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: groupPlaintext,
        snapshot: aliceGroup,
    });
    expectStatus(encryptedGroup, "encrypted", "one encryption call creates the shared group envelope");
    for (const [recipientId, label] of [[BOB_ID, "Bob"], [CAROL_ID, "Carol"]] as const) {
        const groupDecryption = await native.decryptIncoming(DISCORD_EVENT, recipientId, {
            channelId: GROUP_CHANNEL_ID,
            content: encryptedGroup.content,
            discordAuthorId: ALICE_ID,
            discordEditedTimestamp: null,
            discordMessageId: messageId(8),
        });
        expectStatus(groupDecryption, "decrypted", `${label} decrypts the same shared group envelope`);
        assert.equal(groupDecryption.plaintext, groupPlaintext);
    }

    const bobHistoricalPlaintext = "Bob message before either key rotation";
    const bobBeforeReplacement = await native.encryptOutgoing(DISCORD_EVENT, BOB_ID, {
        plaintext: bobHistoricalPlaintext,
        snapshot: bobDm,
    });
    expectStatus(bobBeforeReplacement, "encrypted", "Bob encrypts before key replacement");
    const aliceHistoricalInput = {
        channelId: DM_CHANNEL_ID,
        content: bobBeforeReplacement.content,
        discordAuthorId: BOB_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(9),
    };
    let decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceHistoricalInput);
    expectStatus(decrypted, "decrypted", "Alice initially decrypts Bob pre-replacement message");
    assert.equal(decrypted.plaintext, bobHistoricalPlaintext);

    const dmPlaintext = `native DM secret <@${ALICE_ID}> <@${BOB_ID}> α`;
    const encryptedDm = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        mentionedUserIds: [ALICE_ID, BOB_ID],
        plaintext: dmPlaintext,
        snapshot: aliceDm,
    });
    expectStatus(encryptedDm, "encrypted", "Alice encrypts for Bob");
    assert.deepEqual(
        parseEncryptedEnvelope(encryptedDm.content, { channelId: DM_CHANNEL_ID, discordAuthorId: ALICE_ID }).m,
        [ALICE_ID, BOB_ID],
        "native encryption authenticates selected mentioned participants, including the author",
    );
    assert.ok(encryptedDm.content.includes(`<@${ALICE_ID}>`), "the author's local mentioned state is available before decryption");
    assert.ok(encryptedDm.content.includes(`<@${BOB_ID}>`), "the recipient target is visible to Discord's mention parser");
    expectStatus(await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        mentionedUserIds: [CAROL_ID],
        plaintext: `must not ping <@${CAROL_ID}>`,
        snapshot: aliceDm,
    }), "invalid_input", "mentioned user outside selected encrypted participants");
    const bobDmInput = {
        channelId: DM_CHANNEL_ID,
        content: encryptedDm.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(10),
    };
    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, bobDmInput);
    expectStatus(decrypted, "decrypted", "Bob decrypts Alice DM");
    assert.equal(decrypted.plaintext, dmPlaintext);
    const aliceOwnDmInput = {
        ...bobDmInput,
        discordMessageId: messageId(11),
        discordNonce: messageId(11),
    };
    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceOwnDmInput);
    expectStatus(decrypted, "decrypted", "sender decrypts own message");
    assert.equal(decrypted.plaintext, dmPlaintext);
    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        discordMessageId: messageId(13),
        discordNonce: messageId(11),
    });
    expectStatus(decrypted, "decrypted", "sender decrypts the canonical message after Discord replaces its optimistic nonce ID");
    assert.equal(decrypted.plaintext, dmPlaintext);
    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        discordMessageId: messageId(13),
        discordNonce: messageId(11),
    });
    expectStatus(decrypted, "decrypted", "the canonical sender message remains idempotent after nonce reconciliation");
    const repeatedSenderCopy = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        discordMessageId: messageId(14),
    });
    expectStatus(repeatedSenderCopy, "replay_detected", "a copied sender envelope remains rejected after nonce reconciliation");
    const forgedReplacement = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        discordMessageId: messageId(15),
        discordNonce: messageId(11),
    });
    expectStatus(forgedReplacement, "replay_detected", "the optimistic nonce can reconcile exactly one server message ID");

    const attachmentMaterial = generateAttachmentBundleMaterial(2);
    const encryptedAttachmentMessage = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: serializeSecurePlaintext("", {
            ...attachmentMaterial.descriptor,
            root: attachmentMaterial.descriptor.key,
        }),
        snapshot: aliceDm,
    });
    attachmentMaterial.keyBytes.fill(0);
    expectStatus(encryptedAttachmentMessage, "encrypted", "Alice encrypts an attachment bundle descriptor");
    const attachmentMessageInput = {
        channelId: DM_CHANNEL_ID,
        content: encryptedAttachmentMessage.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(14),
    };
    const decryptedAttachmentMessage = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, attachmentMessageInput);
    expectStatus(decryptedAttachmentMessage, "decrypted", "Bob authenticates the attachment bundle descriptor");
    assert.equal(decryptedAttachmentMessage.plaintext, "");
    assert.equal(decryptedAttachmentMessage.attachmentBundle?.count, 2);
    assert.deepEqual(decryptedAttachmentMessage.stickers, []);
    const secureSticker = { formatType: 3, id: "749054660769218631", name: "Wave" };
    const encryptedStickerMessage = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: serializeSecurePlaintext("", null, [secureSticker]),
        snapshot: aliceDm,
    });
    expectStatus(encryptedStickerMessage, "encrypted", "Alice encrypts a sticker item");
    const decryptedStickerMessage = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        channelId: DM_CHANNEL_ID,
        content: encryptedStickerMessage.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(15),
    });
    expectStatus(decryptedStickerMessage, "decrypted", "Bob authenticates encrypted sticker metadata");
    assert.equal(decryptedStickerMessage.plaintext, "");
    assert.equal(decryptedStickerMessage.attachmentBundle, null);
    assert.deepEqual(decryptedStickerMessage.stickers, [secureSticker]);
    const invalidAttachmentUrl = await native.decryptIncomingAttachments(DISCORD_EVENT, BOB_ID, {
        ...attachmentMessageInput,
        attachments: [{
            id: messageId(101),
            proxyUrl: "https://example.com/not-discord",
            size: 100,
            url: "https://example.com/not-discord",
        }],
    });
    expectStatus(invalidAttachmentUrl, "invalid_input", "native attachment downloads reject non-Discord origins");
    const oneOfTwoAttachments = await native.decryptIncomingAttachments(DISCORD_EVENT, BOB_ID, {
        ...attachmentMessageInput,
        attachments: [{
            id: messageId(101),
            proxyUrl: `https://media.discordapp.net/attachments/${DM_CHANNEL_ID}/${messageId(101)}/pc-test.pcaf`,
            size: 100,
            url: `https://cdn.discordapp.com/attachments/${DM_CHANNEL_ID}/${messageId(101)}/pc-test.pcaf`,
        }],
    });
    expectStatus(oneOfTwoAttachments, "invalid_message", "missing ciphertext attachments fail before any download");

    const incomingAttachmentBytes = new TextEncoder().encode("authenticated incoming attachment bytes");
    const incomingAttachmentMaterial = generateAttachmentBundleMaterial(1);
    const incomingAttachmentCiphertext = await encryptAttachmentBytes({
        bundleId: incomingAttachmentMaterial.descriptor.id,
        channelId: DM_CHANNEL_ID,
        count: 1,
        data: incomingAttachmentBytes,
        index: 0,
        masterKey: incomingAttachmentMaterial.keyBytes,
        metadata: {
            description: null,
            duration: null,
            height: null,
            mimeType: "text/plain",
            name: "incoming-secret.txt",
            size: incomingAttachmentBytes.byteLength,
            spoiler: false,
            waveform: null,
            width: null,
        },
        senderUserId: ALICE_ID,
    });
    const incomingAttachmentRoot = await attachmentBundleRoot(
        incomingAttachmentMaterial.descriptor.id,
        [incomingAttachmentCiphertext],
    );
    const incomingAttachmentMessage = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: serializeSecurePlaintext("incoming file", {
            ...incomingAttachmentMaterial.descriptor,
            root: incomingAttachmentRoot,
        }),
        snapshot: aliceDm,
    });
    incomingAttachmentMaterial.keyBytes.fill(0);
    expectStatus(incomingAttachmentMessage, "encrypted", "Alice encrypts a downloadable attachment");
    const incomingAttachmentId = messageId(102);
    const incomingAttachmentInput = {
        channelId: DM_CHANNEL_ID,
        content: incomingAttachmentMessage.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(103),
        attachments: [{
            id: incomingAttachmentId,
            proxyUrl: `https://media.discordapp.net/attachments/${DM_CHANNEL_ID}/${incomingAttachmentId}/encrypted.pcaf`,
            size: incomingAttachmentCiphertext.byteLength,
            url: `https://cdn.discordapp.com/attachments/${DM_CHANNEL_ID}/${incomingAttachmentId}/encrypted.pcaf`,
        }],
    };
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => { throw new Error("Injected attachment connection failure"); };
        const disconnectedDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(disconnectedDownload, "failed", "attachment downloads fail closed while disconnected");
        assert.equal(disconnectedDownload.error, "attachment_download_failed");

        globalThis.fetch = async () => new Response(Buffer.from(incomingAttachmentCiphertext), { status: 503 });
        const unavailableDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(unavailableDownload, "failed", "attachment downloads reject non-success responses");
        assert.equal(unavailableDownload.error, "attachment_download_failed");

        globalThis.fetch = async () => new Response(null, { status: 200 });
        const bodylessDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(bodylessDownload, "failed", "attachment downloads reject a missing response body");
        assert.equal(bodylessDownload.error, "attachment_download_failed");

        globalThis.fetch = async () => new Response(Buffer.from(incomingAttachmentCiphertext), {
            headers: { "content-length": String(incomingAttachmentCiphertext.byteLength + 1) },
        });
        const changedLengthDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(changedLengthDownload, "failed", "attachment downloads reject changed declared lengths");
        assert.equal(changedLengthDownload.error, "attachment_download_failed");

        globalThis.fetch = async () => new Response(Buffer.from(incomingAttachmentCiphertext.subarray(0, -1)));
        const truncatedDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(truncatedDownload, "failed", "attachment downloads reject truncated streams");
        assert.equal(truncatedDownload.error, "attachment_download_failed");

        globalThis.fetch = async () => new Response(Buffer.concat([Buffer.from(incomingAttachmentCiphertext), Buffer.from([0])]));
        const oversizedDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(oversizedDownload, "failed", "attachment downloads reject oversized streams");
        assert.equal(oversizedDownload.error, "attachment_download_failed");

        globalThis.fetch = async () => new Response(null, {
            headers: { location: "https://example.com/stolen.pcaf" },
            status: 302,
        });
        const unsafeRedirectDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(unsafeRedirectDownload, "failed", "attachment downloads reject redirects away from Discord CDN hosts");
        assert.equal(unsafeRedirectDownload.error, "attachment_download_failed");

        const tamperedAttachmentCiphertext = Uint8Array.from(incomingAttachmentCiphertext);
        tamperedAttachmentCiphertext[tamperedAttachmentCiphertext.length - 1] ^= 1;
        globalThis.fetch = async () => new Response(Buffer.from(tamperedAttachmentCiphertext), {
            headers: { "content-length": String(tamperedAttachmentCiphertext.byteLength) },
        });
        const tamperedDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(tamperedDownload, "invalid_message", "downloaded attachment ciphertext must authenticate before saving");

        globalThis.fetch = async input => {
            if (String(input).startsWith("https://cdn.discordapp.com/")) throw new Error("Injected primary CDN failure");
            return new Response(Buffer.from(tamperedAttachmentCiphertext), {
                headers: { "content-length": String(tamperedAttachmentCiphertext.byteLength) },
            });
        };
        const failedPrimaryInvalidProxy = await native.decryptIncomingAttachments(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
        );
        expectStatus(
            failedPrimaryInvalidProxy,
            "failed",
            "a failed primary plus unauthenticated proxy remains retryable after connectivity recovers",
        );
        assert.equal(failedPrimaryInvalidProxy.error, "attachment_download_failed");

        globalThis.fetch = async input => {
            if (String(input).startsWith("https://cdn.discordapp.com/")) {
                return new Response(Buffer.from(tamperedAttachmentCiphertext), {
                    headers: { "content-length": String(tamperedAttachmentCiphertext.byteLength) },
                });
            }
            throw new Error("Injected proxy CDN failure");
        };
        const invalidPrimaryFailedProxy = await native.decryptIncomingAttachments(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
        );
        expectStatus(
            invalidPrimaryFailedProxy,
            "failed",
            "an unauthenticated primary plus failed proxy remains retryable after connectivity recovers",
        );
        assert.equal(invalidPrimaryFailedProxy.error, "attachment_download_failed");

        const originalSetTimeout = globalThis.setTimeout;
        const originalClearTimeout = globalThis.clearTimeout;
        const authenticatedCacheTimerCapture: { callback?: () => void; } = {};
        const authenticatedCacheTimer = { unref: () => authenticatedCacheTimer } as NodeJS.Timeout;
        globalThis.setTimeout = ((callback: () => void, delay?: number) => {
            if ((delay ?? 0) >= 9 * 60_000) {
                authenticatedCacheTimerCapture.callback = callback;
                return authenticatedCacheTimer;
            }
            return originalSetTimeout(callback, delay);
        }) as typeof setTimeout;
        globalThis.clearTimeout = ((timer?: NodeJS.Timeout | number) => {
            if (timer === authenticatedCacheTimer) {
                delete authenticatedCacheTimerCapture.callback;
                return;
            }
            originalClearTimeout(timer);
        }) as typeof clearTimeout;
        try {
        let cacheMissDownloadAttempts = 0;
        globalThis.fetch = async () => {
            cacheMissDownloadAttempts++;
            return new Response(Buffer.from(incomingAttachmentCiphertext), {
                headers: { "content-length": String(incomingAttachmentCiphertext.byteLength) },
            });
        };
        const cacheMissDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(cacheMissDownload, "saved", "a cache-miss download authenticates, decrypts, and saves in one operation");
        assert.equal(cacheMissDownloadAttempts, 1, "a cache-miss download fetches the ciphertext bundle once");
        assert.equal(cacheMissDownload.filename, "incoming-secret.txt");
        assert.deepEqual(
            await readFile(join(dataDir, "Downloads", cacheMissDownload.filename)),
            Buffer.from(incomingAttachmentBytes),
            "a cache-miss download writes only authenticated plaintext bytes",
        );
        await rm(join(dataDir, "Downloads", cacheMissDownload.filename), { force: true });

        let mismatchedPrimaryAttempts = 0;
        globalThis.fetch = async input => {
            mismatchedPrimaryAttempts++;
            const bytes = String(input).startsWith("https://cdn.discordapp.com/")
                ? tamperedAttachmentCiphertext
                : incomingAttachmentCiphertext;
            return new Response(Buffer.from(bytes), {
                headers: { "content-length": String(bytes.byteLength) },
            });
        };
        const authenticatedProxyFallback = await native.decryptIncomingAttachments(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
        );
        expectStatus(
            authenticatedProxyFallback,
            "decrypted",
            "a same-length stale primary CDN response falls back to the authenticated proxy response",
        );
        assert.equal(mismatchedPrimaryAttempts, 2);
        assert.deepEqual(authenticatedProxyFallback.attachments[0].data, incomingAttachmentBytes);

        let cachedDownloadFetchAttempts = 0;
        globalThis.fetch = async () => {
            cachedDownloadFetchAttempts++;
            throw new Error("An already-authenticated attachment download must work offline");
        };
        const firstDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(firstDownload, "saved", "Bob saves Alice's authenticated attachment");
        assert.equal(cachedDownloadFetchAttempts, 0, "saving an already-rendered authenticated attachment performs no network request");
        assert.equal(firstDownload.filename, "incoming-secret.txt");
        assert.deepEqual(
            await readFile(join(dataDir, "Downloads", firstDownload.filename)),
            Buffer.from(incomingAttachmentBytes),
            "the Downloads file exactly matches the authenticated plaintext bytes",
        );
        const duplicateDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(duplicateDownload, "saved", "a repeated attachment download remains safe");
        assert.equal(cachedDownloadFetchAttempts, 0, "repeated authenticated downloads do not multiply bundle requests");
        assert.equal(duplicateDownload.filename, "incoming-secret (1).txt");
        assert.deepEqual(await readFile(join(dataDir, "Downloads", duplicateDownload.filename)), Buffer.from(incomingAttachmentBytes));
        const unknownAttachment = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            messageId(104),
        );
        expectStatus(unknownAttachment, "invalid_input", "download requests are bound to an authenticated attachment ID");

        protector.failDownloadWrite = true;
        const storageFailure = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(storageFailure, "failed", "attachment storage failures are reported safely");
        assert.equal(storageFailure.error, "storage_error");
        await assert.rejects(
            readFile(join(dataDir, "Downloads", "incoming-secret (2).txt")),
            "a failed attachment write must not leave a partial download",
        );
        const expireAuthenticatedCache = authenticatedCacheTimerCapture.callback;
        assert.ok(expireAuthenticatedCache, "authenticated attachment plaintext schedules an eager expiry timer");
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        const originalDateNow = Date.now;
        Date.now = () => originalDateNow() + 11 * 60_000;
        try {
            expireAuthenticatedCache();
        } finally {
            Date.now = originalDateNow;
        }
        let expiredCacheFetchAttempts = 0;
        globalThis.fetch = async () => {
            expiredCacheFetchAttempts++;
            throw new Error("Expired authenticated plaintext must be fetched and authenticated again");
        };
        const expiredCacheDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            incomingAttachmentInput,
            incomingAttachmentId,
        );
        expectStatus(expiredCacheDownload, "failed", "authenticated attachment plaintext expires without another cache operation");
        assert.equal(expiredCacheDownload.error, "attachment_download_failed");
        assert.ok(expiredCacheFetchAttempts > 0, "an expired plaintext cache entry is never reused offline");
        } finally {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        }
    } finally {
        protector.failDownloadWrite = false;
        globalThis.fetch = originalFetch;
    }

    const detachedText = `detached encrypted message ${"large body ".repeat(600)}`;
    const detachedTextBytes = new TextEncoder().encode(detachedText);
    const detachedTextMaterial = generateAttachmentBundleMaterial(1);
    const detachedTextCiphertext = await encryptAttachmentBytes({
        bundleId: detachedTextMaterial.descriptor.id,
        channelId: DM_CHANNEL_ID,
        count: 1,
        data: detachedTextBytes,
        index: 0,
        masterKey: detachedTextMaterial.keyBytes,
        metadata: {
            description: null,
            duration: null,
            height: null,
            mimeType: DETACHED_TEXT_MIME_TYPE,
            name: DETACHED_TEXT_FILENAME,
            size: detachedTextBytes.byteLength,
            spoiler: false,
            waveform: null,
            width: null,
        },
        senderUserId: ALICE_ID,
    });
    const detachedTextRoot = await attachmentBundleRoot(detachedTextMaterial.descriptor.id, [detachedTextCiphertext]);
    const detachedTextMessage = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: serializeSecurePlaintext("", {
            ...detachedTextMaterial.descriptor,
            root: detachedTextRoot,
        }, [], 0),
        snapshot: aliceDm,
    });
    detachedTextMaterial.keyBytes.fill(0);
    expectStatus(detachedTextMessage, "encrypted", "Alice encrypts a detached large text descriptor");
    const detachedTextAttachmentId = messageId(105);
    const detachedTextInput = {
        channelId: DM_CHANNEL_ID,
        content: detachedTextMessage.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(106),
        attachments: [{
            id: detachedTextAttachmentId,
            proxyUrl: `https://media.discordapp.net/attachments/${DM_CHANNEL_ID}/${detachedTextAttachmentId}/encrypted.pcaf`,
            size: detachedTextCiphertext.byteLength,
            url: `https://cdn.discordapp.com/attachments/${DM_CHANNEL_ID}/${detachedTextAttachmentId}/encrypted.pcaf`,
        }],
    };
    const { attachments: _detachedAttachments, ...detachedTextMessageInput } = detachedTextInput;
    const detachedDescriptor = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, detachedTextMessageInput);
    expectStatus(detachedDescriptor, "decrypted", "Bob authenticates the detached large text descriptor");
    assert.equal(detachedDescriptor.plaintext, "");
    assert.equal(detachedDescriptor.detachedTextIndex, 0);
    try {
        globalThis.fetch = async () => new Response(Buffer.from(detachedTextCiphertext), {
            headers: { "content-length": String(detachedTextCiphertext.byteLength) },
        });
        const expandedDetachedText = await native.decryptIncomingAttachments(DISCORD_EVENT, BOB_ID, detachedTextInput);
        expectStatus(expandedDetachedText, "decrypted", "Bob reconstructs detached large text after attachment authentication");
        assert.equal(expandedDetachedText.plaintext, detachedText);
        assert.deepEqual(expandedDetachedText.attachments, [], "the message text transport is hidden from ordinary attachment UI");
        globalThis.fetch = async () => { throw new Error("Detached text should reuse the authenticated native cache"); };
        const cachedDetachedText = await native.decryptIncomingAttachments(DISCORD_EVENT, BOB_ID, detachedTextInput);
        expectStatus(cachedDetachedText, "decrypted", "detached text is reused without downloading its ciphertext twice");
        assert.equal(cachedDetachedText.plaintext, detachedText);
        const blockedDetachedDownload = await native.downloadIncomingAttachment(
            DISCORD_EVENT,
            BOB_ID,
            detachedTextInput,
            detachedTextAttachmentId,
        );
        expectStatus(blockedDetachedDownload, "invalid_message", "detached text transport cannot be downloaded as an ordinary file");
    } finally {
        globalThis.fetch = originalFetch;
    }

    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, bobDmInput);
    expectStatus(decrypted, "decrypted", "exact message rerender is idempotent");
    const copiedReplay = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        ...bobDmInput,
        discordMessageId: messageId(12),
    });
    expectStatus(copiedReplay, "replay_detected", "copied ciphertext under another Discord message");

    const secondDm = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, { plaintext: "second native secret", snapshot: aliceDm });
    expectStatus(secondDm, "encrypted", "second Alice DM encryption");
    const differentMessageReplay = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        ...bobDmInput,
        content: secondDm.content,
    });
    expectStatus(differentMessageReplay, "replay_detected", "different ciphertext reusing a Discord message ID");
    const senderMessageIdCollision = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        content: secondDm.content,
        discordMessageId: messageId(13),
        discordNonce: messageId(11),
    });
    expectStatus(senderMessageIdCollision, "replay_detected", "sender still rejects different ciphertext reusing a Discord message ID");
    const canonicalOwnMessage = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        content: secondDm.content,
        discordMessageId: messageId(17),
        discordNonce: messageId(16),
    });
    expectStatus(canonicalOwnMessage, "decrypted", "sender decrypts a message first observed under its canonical server ID");
    const canonicalOwnMessageCopy = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        content: secondDm.content,
        discordMessageId: messageId(18),
        discordNonce: messageId(17),
    });
    expectStatus(canonicalOwnMessageCopy, "replay_detected", "a canonical sender record is never eligible for optimistic-ID replacement");

    const historyPlaintext = "sender history after Discord discarded its nonce";
    const encryptedHistory = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: historyPlaintext,
        snapshot: aliceDm,
    });
    expectStatus(encryptedHistory, "encrypted", "Alice encrypts a sender-history compatibility message");
    const historyEnvelopeTimestamp = JSON.parse(encryptedHistory.content.slice("PCEM2:".length))[1] as number;
    const optimisticHistoryId = messageIdAt(historyEnvelopeTimestamp + 5);
    const canonicalHistoryId = messageIdAt(historyEnvelopeTimestamp - 700);
    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        content: encryptedHistory.content,
        discordMessageId: optimisticHistoryId,
        discordNonce: optimisticHistoryId,
    });
    expectStatus(decrypted, "decrypted", "sender decrypts the optimistic history row");
    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        content: encryptedHistory.content,
        discordMessageId: canonicalHistoryId,
        discordNonce: null,
    });
    expectStatus(decrypted, "decrypted", "older canonical ID reconciles after Discord history discards the nonce");
    assert.equal(decrypted.plaintext, historyPlaintext);
    const copiedHistory = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        content: encryptedHistory.content,
        discordMessageId: messageIdAt(historyEnvelopeTimestamp + 1_000),
        discordNonce: null,
    });
    expectStatus(copiedHistory, "replay_detected", "a later copy cannot use the nonce-less history compatibility path");

    const editableDm = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "native secret before edit",
        snapshot: aliceDm,
    });
    expectStatus(editableDm, "encrypted", "Alice encrypts a message that will be edited");
    const editableDmInput = {
        ...bobDmInput,
        content: editableDm.content,
        discordMessageId: messageId(16),
    };
    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, editableDmInput);
    expectStatus(decrypted, "decrypted", "Bob decrypts the original editable message");

    const editedDm = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "edited native secret",
        snapshot: aliceDm,
    });
    expectStatus(editedDm, "encrypted", "Alice encrypts a legitimate message edit");
    const editedDmInput = {
        ...editableDmInput,
        content: editedDm.content,
        discordEditedTimestamp: "2026-01-01T00:00:01.000Z",
    };
    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, editedDmInput);
    expectStatus(decrypted, "decrypted", "a freshly signed higher-counter Discord edit decrypts");
    assert.equal(decrypted.plaintext, "edited native secret");
    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, editedDmInput);
    expectStatus(decrypted, "decrypted", "an exact edited-message rerender remains idempotent");
    const rolledBackEdit = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        ...editableDmInput,
        discordEditedTimestamp: "2026-01-01T00:00:02.000Z",
    });
    expectStatus(rolledBackEdit, "replay_detected", "an older encrypted version cannot roll back an edited Discord message");
    const copiedRolledBackEdit = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        ...editableDmInput,
        discordEditedTimestamp: null,
        discordMessageId: messageId(105),
    });
    expectStatus(
        copiedRolledBackEdit,
        "replay_detected",
        "a superseded encrypted version remains a replay when copied under a fresh Discord message ID",
    );
    const outOfOrderEdit = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        ...editableDmInput,
        content: secondDm.content,
        discordEditedTimestamp: "2026-01-01T00:00:03.000Z",
    });
    expectStatus(outOfOrderEdit, "replay_detected", "a lower-counter edit arriving after a newer edit is rejected");

    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID],
        snapshot: aliceGroup,
    });
    expectStatus(conversation, "enabled", "group can deliberately leave a participant unselected");
    const selectedOnly = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "Bob only in this group",
        snapshot: aliceGroup,
    });
    expectStatus(selectedOnly, "encrypted", "group message for selected recipients");
    const unselected = await native.decryptIncoming(DISCORD_EVENT, CAROL_ID, {
        channelId: GROUP_CHANNEL_ID,
        content: selectedOnly.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(20),
    });
    expectStatus(unselected, "invalid_message", "trusted but unselected participant cannot decrypt");
    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID, CAROL_ID],
        snapshot: aliceGroup,
    });
    expectStatus(conversation, "enabled", "group is explicitly reconfigured after selecting Carol");
    const oldMessageAfterSelection = await native.decryptIncoming(DISCORD_EVENT, CAROL_ID, {
        channelId: GROUP_CHANNEL_ID,
        content: selectedOnly.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(20),
    });
    expectStatus(oldMessageAfterSelection, "invalid_message", "a newly selected participant receives no key for old group history");
    const selectedAfterJoin = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "Bob and Carol after selection",
        snapshot: aliceGroup,
    });
    expectStatus(selectedAfterJoin, "encrypted", "one new group envelope is created after the recipient change");
    const newlySelected = await native.decryptIncoming(DISCORD_EVENT, CAROL_ID, {
        channelId: GROUP_CHANNEL_ID,
        content: selectedAfterJoin.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(106),
    });
    expectStatus(newlySelected, "decrypted", "the newly selected participant decrypts only subsequent group messages");
    assert.equal(newlySelected.plaintext, "Bob and Carol after selection");

    const outsiderDm = dmSnapshot(OUTSIDER_CHANNEL_ID, ALICE_ID);
    conversation = await native.configureConversation(DISCORD_EVENT, OUTSIDER_ID, {
        enabled: true,
        selectedRecipientIds: [ALICE_ID],
        snapshot: outsiderDm,
    });
    expectStatus(conversation, "enabled", "outsider configures Alice as recipient");
    const outsiderMessage = await native.encryptOutgoing(DISCORD_EVENT, OUTSIDER_ID, {
        plaintext: "untrusted sender message",
        snapshot: outsiderDm,
    });
    expectStatus(outsiderMessage, "encrypted", "outsider encrypts for Alice");
    const untrustedAuthor = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        channelId: OUTSIDER_CHANNEL_ID,
        content: outsiderMessage.content,
        discordAuthorId: OUTSIDER_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(21),
    });
    expectStatus(untrustedAuthor, "untrusted_author", "untrusted author is rejected before decryption");

    const changedGroup = groupSnapshot(BOB_ID, CAROL_ID, OUTSIDER_ID);
    const participantChanged = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "must not send",
        snapshot: changedGroup,
    });
    expectStatus(participantChanged, "not_enabled", "participant snapshot change disables send");
    assert.equal(participantChanged.reason, "participant_changed");
    const remainsDisabled = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "still must not send",
        snapshot: aliceGroup,
    });
    expectStatus(remainsDisabled, "not_enabled", "changed conversation remains disabled");
    assert.equal(remainsDisabled.reason, "participant_changed", "participant-change latch persists until explicit reconfiguration");
    expectStatus(
        await native.getChannelProtection(DISCORD_EVENT, ALICE_ID, GROUP_CHANNEL_ID),
        "protected",
        "background sends remain fail-closed after a participant-change auto-disable",
    );

    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID],
        snapshot: aliceDm,
    });
    expectStatus(conversation, "enabled", "DM enabled before counter stress");
    const concurrent = await Promise.all(Array.from({ length: 16 }, (_, index) => native.encryptOutgoing(
        DISCORD_EVENT,
        ALICE_ID,
        { plaintext: `concurrent ${index}`, snapshot: aliceDm },
    )));
    const encryptedConcurrent = concurrent.map((result, index) => {
        expectStatus(result, "encrypted", `concurrent encryption ${index}`);
        return result;
    });
    const counters = encryptedConcurrent.map(result => result.counter);
    assert.equal(new Set(counters).size, counters.length, "concurrent sends receive unique counters");
    assert.deepEqual([...counters].sort((left, right) => left - right), counters, "serialized concurrent counters are monotonic");

    const [moduleA, moduleB] = await Promise.all([
        loadNative(bundlePath, dataDir),
        loadNative(bundlePath, dataDir),
    ]);
    const warmed = await Promise.all([
        moduleA.getConversation(DISCORD_EVENT, ALICE_ID, aliceDm),
        moduleB.getConversation(DISCORD_EVENT, ALICE_ID, aliceDm),
    ]);
    warmed.forEach((result, index) => expectStatus(result, "enabled", `module ${index + 1} warms its vault cache`));
    const beforeCrossModule = lastNumber(counters, "single-module counters");
    const crossModule = await Promise.all(Array.from({ length: 16 }, (_, index) => {
        const module = index % 2 === 0 ? moduleA : moduleB;
        return module.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
            plaintext: `cross-module concurrent ${index}`,
            snapshot: aliceDm,
        });
    }));
    const encryptedCrossModule = crossModule.map((result, index) => {
        expectStatus(result, "encrypted", `cross-module encryption ${index}`);
        return result;
    });
    const crossModuleCounters = encryptedCrossModule.map(result => result.counter);
    const sortedCrossModuleCounters = [...crossModuleCounters].sort((left, right) => left - right);
    assert.equal(new Set(crossModuleCounters).size, crossModuleCounters.length, "two module instances allocate unique counters");
    assert.deepEqual(
        sortedCrossModuleCounters,
        Array.from({ length: crossModuleCounters.length }, (_, index) => beforeCrossModule + index + 1),
        "cross-module counters are contiguous with no lost vault updates",
    );
    for (const parity of [0, 1]) {
        const moduleCounters = crossModuleCounters.filter((_, index) => index % 2 === parity);
        assert.deepEqual(
            [...moduleCounters].sort((left, right) => left - right),
            moduleCounters,
            `module ${parity + 1} observes monotonic counters`,
        );
    }

    const freshlyLoaded = await loadNative(bundlePath, dataDir);
    expectStatus(
        await freshlyLoaded.setScreenCaptureProtection(DISCORD_EVENT, true),
        "applied",
        "fresh native bundle restores encrypted-content visibility before decrypting",
    );
    const durableCounter = await freshlyLoaded.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "counter after fresh module load",
        snapshot: aliceDm,
    });
    expectStatus(durableCounter, "encrypted", "counter survives a freshly loaded native bundle");
    assert.equal(
        durableCounter.counter,
        lastNumber(sortedCrossModuleCounters, "cross-module counters") + 1,
        "fresh reload observes every cross-module counter update",
    );
    decrypted = await freshlyLoaded.decryptIncoming(DISCORD_EVENT, BOB_ID, bobDmInput);
    expectStatus(decrypted, "decrypted", "exact replay remains allowed after reload");
    decrypted = await freshlyLoaded.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        discordMessageId: messageId(13),
        discordNonce: messageId(11),
    });
    expectStatus(decrypted, "decrypted", "reconciled sender message ID remains canonical after reload");
    const persistedReplay = await freshlyLoaded.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        ...bobDmInput,
        discordMessageId: messageId(13),
    });
    expectStatus(persistedReplay, "replay_detected", "replay cache survives a freshly loaded native bundle");

    const preRetirementEditTimestamp = new Date().toISOString();
    const bobRotated = await native.rotateIdentity(DISCORD_EVENT, BOB_ID, bobIdentity.identity.fingerprint);
    expectStatus(bobRotated, "rotated", "Bob rotates identity");
    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, bobDmInput);
    expectStatus(decrypted, "decrypted", "Bob retains the old private identity for pre-rotation history");
    assert.equal(decrypted.plaintext, dmPlaintext);
    const bobChangedAnnouncement = await createAnnouncement(native, BOB_ID);
    const peerReplacementPublishedAt = Math.max(Date.now(), bobOriginalPublishedAt + 1);
    const realDateNow = Date.now;
    let changedReview: Awaited<ReturnType<NativeModule["reviewAnnouncement"]>>;
    Date.now = () => peerReplacementPublishedAt + 5 * 60_000;
    try {
        changedReview = await native.reviewAnnouncement(
            DISCORD_EVENT,
            ALICE_ID,
            BOB_ID,
            bobChangedAnnouncement,
            messageIdAt(peerReplacementPublishedAt),
            null,
        );
    } finally {
        Date.now = realDateNow;
    }
    expectStatus(changedReview, "key_changed", "Alice fails closed on Bob key change");
    expectStatus(
        await native.reviewAnnouncement(
            DISCORD_EVENT,
            ALICE_ID,
            BOB_ID,
            bobAnnouncement,
            messageIdAt(bobOriginalPublishedAt),
            null,
        ),
        "key_changed",
        "current-key replay cannot clear an active replacement quarantine",
    );
    const quarantineAfterCurrentReplay = JSON.parse(protector.decryptString(
        await readFile(join(dataDir, "secure-messaging", "quarantine.bin")),
    )) as { entries: Array<{ detectedAt: number; pair: string; }>; };
    assert.equal(
        quarantineAfterCurrentReplay.entries.find(entry => entry.pair === `${ALICE_ID}:${BOB_ID}`)?.detectedAt,
        peerReplacementPublishedAt,
        "current or stale replays cannot move the authoritative replacement cutoff",
    );
    const quarantinedHistoricalMessage = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceHistoricalInput);
    expectStatus(quarantinedHistoricalMessage, "untrusted_author", "quarantine blocks even previously readable retired peer keys");
    const keyChangedSend = await freshlyLoaded.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "must not use changed key",
        snapshot: aliceDm,
    });
    expectStatus(keyChangedSend, "not_enabled", "key quarantine blocks a second module with a stale warm cache");
    assert.equal(keyChangedSend.reason, "unverified_recipients");
    const forgotten = await native.forgetPeer(DISCORD_EVENT, ALICE_ID, BOB_ID);
    expectStatus(forgotten, "forgotten", "Alice explicitly forgets Bob old key");
    await trustAnnouncement(native, ALICE_ID, BOB_ID, bobChangedAnnouncement, peerReplacementPublishedAt);
    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID],
        snapshot: aliceDm,
    });
    expectStatus(conversation, "enabled", "Alice reconfigures DM after retrust");
    const afterReplacementReload = await loadNative(bundlePath, dataDir);
    const staleOldAnnouncement = await afterReplacementReload.reviewAnnouncement(
        DISCORD_EVENT,
        ALICE_ID,
        BOB_ID,
        bobAnnouncement,
        messageIdAt(bobOriginalPublishedAt),
        null,
    );
    expectStatus(
        staleOldAnnouncement,
        "stale_announcement",
        "reloaded historical A announcement cannot quarantine current B",
    );
    assert.equal(
        staleOldAnnouncement.trustedIdentity.fingerprint,
        bobRotated.identity.fingerprint,
        "stale announcement result identifies the unchanged current key",
    );
    expectStatus(
        await afterReplacementReload.reviewAnnouncement(
            DISCORD_EVENT,
            ALICE_ID,
            BOB_ID,
            bobChangedAnnouncement,
            messageIdAt(peerReplacementPublishedAt + 10_000),
            null,
        ),
        "trusted",
        "later replay of current B announcement remains trusted",
    );
    const publicationWatermarkVault = JSON.parse(protector.decryptString(await readFile(vaultPath))) as {
        accounts: Record<string, { trustedPeers: Record<string, { publishedAt: number | null; }>; }>;
    };
    assert.equal(
        publicationWatermarkVault.accounts[ALICE_ID].trustedPeers[BOB_ID].publishedAt,
        peerReplacementPublishedAt,
        "same-key re-announcements cannot advance the trusted publication watermark",
    );
    expectStatus(
        await afterReplacementReload.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
            plaintext: "stale announcement did not disable B",
            snapshot: aliceDm,
        }),
        "encrypted",
        "historical A replay leaves the B conversation enabled",
    );
    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceHistoricalInput);
    expectStatus(decrypted, "decrypted", "Alice retains Bob's previously trusted key after explicit replacement");
    assert.equal(decrypted.plaintext, bobHistoricalPlaintext);
    const editedBeforeRetirement = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordEditedTimestamp: preRetirementEditTimestamp,
    });
    expectStatus(editedBeforeRetirement, "decrypted", "an authoritative edit before retirement remains historically readable");
    const editedAfterRetirement = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordEditedTimestamp: new Date(peerReplacementPublishedAt + 1_000).toISOString(),
    });
    expectStatus(editedAfterRetirement, "invalid_message", "an edit after retirement cannot reuse a retired peer key");
    const retiredKeyNewMessage = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordMessageId: messageIdAt(peerReplacementPublishedAt + 1),
    });
    expectStatus(
        retiredKeyNewMessage,
        "invalid_message",
        "server publication cutoff rejects retired-key posts despite a forward-skewed local clock",
    );
    const retiredKeyBoundaryMessage = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordMessageId: messageIdAt(peerReplacementPublishedAt),
    });
    expectStatus(
        retiredKeyBoundaryMessage,
        "invalid_message",
        "retirement boundary is strict when an old-key post shares the announcement millisecond",
    );
    const afterRetrust = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "trusted again",
        snapshot: aliceDm,
    });
    expectStatus(afterRetrust, "encrypted", "encryption resumes only after forget, retrust, and reconfigure");
    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        channelId: DM_CHANNEL_ID,
        content: afterRetrust.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(30),
    });
    expectStatus(decrypted, "decrypted", "Bob decrypts after his rotation");
    assert.equal(decrypted.plaintext, "trusted again");

    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID, CAROL_ID],
        snapshot: aliceGroup,
    });
    expectStatus(conversation, "enabled", "group re-enabled before local rotation");
    const aliceBeforeRotation = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(aliceBeforeRotation, "ready", "Alice identity before rotation");
    const aliceRotated = await native.rotateIdentity(DISCORD_EVENT, ALICE_ID, aliceBeforeRotation.identity.fingerprint);
    expectStatus(aliceRotated, "rotated", "Alice rotates identity");
    assert.equal(aliceRotated.disabledConversationCount, 2, "local rotation disables every enabled configuration");
    assert.notEqual(aliceRotated.identity.fingerprint, aliceBeforeRotation.identity.fingerprint);
    const rotationDisabled = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "must reconfigure after rotation",
        snapshot: aliceDm,
    });
    expectStatus(rotationDisabled, "not_enabled", "local rotation disables sending");
    assert.equal(rotationDisabled.reason, "local_identity_changed", "rotation review latch persists until reconfiguration");

    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceHistoricalInput);
    expectStatus(decrypted, "decrypted", "historical message survives both local rotation and peer replacement");
    assert.equal(decrypted.plaintext, bobHistoricalPlaintext);
    const retiredKeysRemainBoundedToOldMessages = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordMessageId: messageIdAt(Date.now() + 120_000),
    });
    expectStatus(retiredKeysRemainBoundedToOldMessages, "invalid_message", "historical local and peer keys reject new messages");

    for (let replacementIndex = 0; replacementIndex < 5; replacementIndex++) {
        const bobBeforeReplacement = await native.getIdentity(DISCORD_EVENT, BOB_ID);
        expectStatus(bobBeforeReplacement, "ready", `Bob identity before bounded replacement ${replacementIndex}`);
        expectStatus(
            await native.rotateIdentity(DISCORD_EVENT, BOB_ID, bobBeforeReplacement.identity.fingerprint),
            "rotated",
            `Bob bounded replacement ${replacementIndex}`,
        );
        const replacementAnnouncement = await createAnnouncement(native, BOB_ID);
        expectStatus(
            await native.reviewAnnouncement(
                DISCORD_EVENT,
                ALICE_ID,
                BOB_ID,
                replacementAnnouncement,
                messageIdAt(Date.now()),
                null,
            ),
            "key_changed",
            `Alice detects bounded Bob replacement ${replacementIndex}`,
        );
        expectStatus(
            await native.forgetPeer(DISCORD_EVENT, ALICE_ID, BOB_ID),
            "forgotten",
            `Alice retires bounded Bob key ${replacementIndex}`,
        );
        await trustAnnouncement(native, ALICE_ID, BOB_ID, replacementAnnouncement);
    }

    const vaultBytes = await readFile(vaultPath);
    const vaultPlaintext = protector.decryptString(vaultBytes);
    const vaultState = JSON.parse(vaultPlaintext) as {
        accounts: Record<string, {
            identityHistory: Record<string, unknown>;
            peerIdentityHistory: Record<string, Record<string, unknown>>;
        }>;
    };
    assert.equal(Object.keys(vaultState.accounts[BOB_ID].identityHistory).length, 4, "local private identity history is capped");
    assert.equal(
        Object.keys(vaultState.accounts[ALICE_ID].peerIdentityHistory[BOB_ID]).length,
        4,
        "retired peer identity history is capped per Discord user",
    );
    const privateKeys = [...vaultPlaintext.matchAll(/"(?:hpkePrivateKey|signingPrivateKey)":"([^"]+)"/gu)]
        .map(match => match[1]);
    assert.ok(privateKeys.length >= 8, "test protector can authenticate and inspect all persisted private keys");
    for (const privateKey of privateKeys)
        assert.equal(vaultBytes.includes(Buffer.from(privateKey, "utf8")), false, "vault bytes do not expose raw private keys");
    for (const plaintext of [dmPlaintext, bobHistoricalPlaintext, "second native secret", "trusted again", "counter after fresh module load"])
        assert.equal(vaultBytes.includes(Buffer.from(plaintext, "utf8")), false, "vault bytes do not expose message plaintext");
}

async function testOneKeyIdentityLifecycle(bundlePath: string, root: string): Promise<void> {
    const oneKeySecret = Buffer.alloc(32, 0x6b);
    const otherOneKeySecret = Buffer.alloc(32, 0x9d);
    try {
        const firstDataDir = join(root, "secure-messaging-live-onekey-identity-first");
        const native = await loadNative(bundlePath, firstDataDir, oneKeySecret);
        const aliceBefore = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
        const bobBefore = await native.getIdentity(DISCORD_EVENT, BOB_ID);
        expectStatus(aliceBefore, "ready", "Alice software identity before OneKey migration");
        expectStatus(bobBefore, "ready", "Bob software identity before OneKey migration");

        await trustAnnouncement(native, ALICE_ID, BOB_ID, await createAnnouncement(native, BOB_ID));
        const configured = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
            enabled: true,
            selectedRecipientIds: [BOB_ID],
            snapshot: dmSnapshot(DM_CHANNEL_ID, BOB_ID),
        });
        expectStatus(configured, "enabled", "conversation enabled before OneKey identity migration");

        const setupStartedAt = Date.now();
        const setup = await native.setupOneKeyVault(DISCORD_EVENT, ALICE_ID);
        expectStatus(setup, "unlocked", "OneKey setup");
        assert.equal(setup.profile.provider, "onekey");
        assert.equal(setup.identityChanged, true, "setup reports deterministic identity installation");
        assert.equal(setup.disabledConversationCount, 1, "setup disables conversations under replaced identities");

        const aliceOneKey = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
        const bobOneKey = await native.getIdentity(DISCORD_EVENT, BOB_ID);
        expectStatus(aliceOneKey, "ready", "Alice OneKey identity");
        expectStatus(bobOneKey, "ready", "Bob OneKey identity");
        assert.notEqual(aliceOneKey.identity.fingerprint, aliceBefore.identity.fingerprint);
        assert.notEqual(bobOneKey.identity.fingerprint, bobBefore.identity.fingerprint,
            "setup migrates every Discord account already stored in the shared vault");
        const disabled = await native.getConversation(DISCORD_EVENT, ALICE_ID, dmSnapshot(DM_CHANNEL_ID, BOB_ID));
        expectStatus(disabled, "local_identity_changed", "identity replacement requires explicit conversation review");

        const blockedRotation = await native.rotateIdentity(
            DISCORD_EVENT,
            ALICE_ID,
            aliceOneKey.identity.fingerprint,
        );
        expectStatus(blockedRotation, "invalid_input", "OneKey-derived identity rotation remains blocked while protected");

        expectStatus(await native.lockSecurityKeyVault(DISCORD_EVENT), "locked", "OneKey vault lock");
        const unlocked = await native.unlockSecurityKeyVault(DISCORD_EVENT, ALICE_ID);
        expectStatus(unlocked, "unlocked", "OneKey vault unlock");
        assert.equal(unlocked.identityChanged, undefined, "unlocking with the same OneKey does not rotate identities");
        expectStatus(await native.removeSecurityKeyVault(DISCORD_EVENT), "not_configured", "remove OneKey protection");

        const stored = JSON.parse(protector.decryptString(await readFile(
            join(firstDataDir, "secure-messaging", "vault.bin"),
        ))) as {
            accounts: Record<string, {
                identityHistory: Record<string, unknown>;
                sendCounter: number;
            }>;
        };
        for (const [userId, identity] of [[ALICE_ID, aliceOneKey], [BOB_ID, bobOneKey]] as const) {
            assert.ok(stored.accounts[userId].sendCounter >= setupStartedAt * 1_000,
                "OneKey migration seeds a portable monotonic send-counter floor");
            assert.equal(identity.status, "ready");
            assert.equal(identity.identity.fingerprint in stored.accounts[userId].identityHistory, false,
                "the current deterministic fingerprint is not duplicated in retired-key history");
        }

        const repeatedSetup = await native.setupOneKeyVault(DISCORD_EVENT, ALICE_ID);
        expectStatus(repeatedSetup, "unlocked", "repeat setup with the same OneKey");
        assert.equal(repeatedSetup.identityChanged, undefined, "repeat setup preserves the current deterministic identity");

        const cleanNative = await loadNative(
            bundlePath,
            join(root, "secure-messaging-live-onekey-identity-clean"),
            oneKeySecret,
        );
        expectStatus(await cleanNative.setupOneKeyVault(DISCORD_EVENT, ALICE_ID), "unlocked", "clean OneKey setup");
        const cleanAlice = await cleanNative.getIdentity(DISCORD_EVENT, ALICE_ID);
        const cleanBob = await cleanNative.getIdentity(DISCORD_EVENT, BOB_ID);
        expectStatus(cleanAlice, "ready", "clean Alice OneKey identity");
        expectStatus(cleanBob, "ready", "account first opened after OneKey setup");
        assert.equal(cleanAlice.identity.fingerprint, aliceOneKey.identity.fingerprint,
            "the same OneKey and Discord account restore Alice's fingerprint on a clean installation");
        assert.equal(cleanBob.identity.fingerprint, bobOneKey.identity.fingerprint,
            "an account first opened later is still derived from the active OneKey root");
        assert.notEqual(cleanAlice.identity.fingerprint, cleanBob.identity.fingerprint,
            "Discord account IDs domain-separate identities derived from one OneKey");

        const otherNative = await loadNative(
            bundlePath,
            join(root, "secure-messaging-live-onekey-identity-other-key"),
            otherOneKeySecret,
        );
        expectStatus(await otherNative.setupOneKeyVault(DISCORD_EVENT, ALICE_ID), "unlocked", "other OneKey setup");
        const otherAlice = await otherNative.getIdentity(DISCORD_EVENT, ALICE_ID);
        expectStatus(otherAlice, "ready", "other OneKey Alice identity");
        assert.notEqual(otherAlice.identity.fingerprint, aliceOneKey.identity.fingerprint,
            "a different physical OneKey derives a different public identity");
    } finally {
        oneKeySecret.fill(0);
        otherOneKeySecret.fill(0);
    }
}

async function main(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "protonncord-secure-native-"));
    const bundlePath = join(root, "secure-messaging-native.mjs");
    const linuxBundlePath = join(root, "secure-messaging-native-linux.mjs");
    const windowsBundlePath = join(root, "secure-messaging-native-windows.mjs");
    try {
        await buildNativeBundle(bundlePath);
        await buildNativeBundle(linuxBundlePath, "linux");
        await buildNativeBundle(windowsBundlePath, "win32");
        await testStorageFailures(bundlePath, linuxBundlePath, windowsBundlePath, root);
        await testNativeLifecycle(bundlePath, join(root, "secure-messaging-live-lifecycle"));
        await testOneKeyIdentityLifecycle(windowsBundlePath, root);
        console.log("secure-messaging native IPC checks passed");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
