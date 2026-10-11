import { MAX_ATTACHMENT_CIPHERTEXT_BYTES, MAX_ATTACHMENT_COUNT, MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES } from "./attachments";

export class DiscordUploadLimitUnavailableError extends Error {
    constructor() {
        super("Discord's attachment upload limit is unavailable. File sends are blocked until Discord reports a valid allowance.");
        this.name = "DiscordUploadLimitUnavailableError";
    }
}

export function readDiscordUploadLimit(user: unknown, getUserMaxFileSize: (user: unknown) => unknown): number {
    try {
        const value = user ? getUserMaxFileSize(user) : null;
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 21) return value;
    } catch { /* A missing or changed host module is unknown, not a default tier. */ }
    throw new DiscordUploadLimitUnavailableError();
}

export function formatUploadBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KiB`;
    // Exact bytes keep rounded sizes from implying that a file at the boundary fits.
    return `${(value / (1024 * 1024)).toFixed(2)} MiB (${value.toLocaleString("en-US")} bytes)`;
}

export function encryptedUploadLimitsDescription(discordBytes: number | null): string {
    const discord = discordBytes === null
        ? "Discord's current account allowance is unavailable; file sends are blocked."
        : `Discord reports ${formatUploadBytes(discordBytes)} per file for this account in DMs and group DMs. Encrypted files can use up to ${formatUploadBytes(Math.min(discordBytes, MAX_ATTACHMENT_CIPHERTEXT_BYTES))} each.`;
    return `${discord} Secure Messaging's safety limits are ${formatUploadBytes(MAX_ATTACHMENT_CIPHERTEXT_BYTES)} per file, ${formatUploadBytes(MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES)} total, and ${MAX_ATTACHMENT_COUNT} attachments per message. Private metadata, framing and encryption tags count toward these limits. Long message text uses one attachment slot. The allowance is checked again before uploading.`;
}
