/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";

import { decodeBase64Url, isSnowflake } from "./protocol";

const CONTEXT = "ProtonnCord/SecureMessaging/mobile-pairing/v1";

/** Only the main process receives rootKey; the renderer receives ciphertext. */
export function sealMobilePairing(rootKey: Uint8Array, rootFingerprint: string, localUserId: string, state: unknown): string {
    if (rootKey.byteLength !== 32 || !isSnowflake(localUserId)) throw new Error("Invalid mobile pairing context");
    const salt = decodeBase64Url(rootFingerprint, 32);
    const plaintext = Buffer.from(JSON.stringify(state), "utf8");
    let key: Buffer | null = null;
    try {
        if (plaintext.byteLength > 2 * 1024 * 1024) throw new Error("Mobile pairing state is too large");
        key = Buffer.from(hkdfSync("sha256", rootKey, salt, CONTEXT, 32));
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from(JSON.stringify([CONTEXT, localUserId, rootFingerprint]), "utf8"));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
        return `PCMP1:${localUserId}.${rootFingerprint}.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}`;
    } finally {
        plaintext.fill(0);
        key?.fill(0);
        salt.fill(0);
    }
}
