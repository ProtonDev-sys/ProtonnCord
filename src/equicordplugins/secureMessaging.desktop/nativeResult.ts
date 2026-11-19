/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NativeFailure } from "./native";

export function isNativeFailure(result: { status: string; }): result is NativeFailure {
    return result.status === "invalid_input" || result.status === "unavailable" || result.status === "failed";
}

export function failureMessage(failure: NativeFailure): string {
    if (failure.status === "invalid_input") return failure.error;
    if (failure.status === "unavailable") {
        if (failure.reason === "encryption_unavailable") return "Your operating system's secure key storage is unavailable.";
        if (failure.reason === "unsafe_linux_backend") return "Secure Messaging refuses Linux's unencrypted basic_text key-storage backend.";
        if (failure.reason === "vault_unreadable") return "The encrypted Secure Messaging vault could not be read. It was not reset.";
        if (failure.reason === "security_key_locked") return "Unlock the security key in Secure Messaging to read or send encrypted messages.";
        if (failure.reason === "security_key_unsupported") return "No supported hardware-vault route was available. On Windows 10, connect a PIN-enabled OneKey Classic 1S by USB; on other systems, use a security key with PRF or large-blob support.";
        return "Secure key storage is unavailable.";
    }
    if (failure.error === "attachment_download_failed") return "The encrypted attachment could not be downloaded from Discord.";
    if (failure.error === "attachment_too_large") return "The encrypted attachment exceeds Secure Messaging's safety limit.";
    if (failure.error === "message_too_long") return "The encrypted header still exceeds Discord's 2,000 character limit. Select fewer recipients.";
    if (failure.error === "counter_exhausted") return "This identity's message counter is exhausted. Rotate the identity before sending again.";
    if (failure.error === "capacity_exceeded") return "The encrypted vault reached a safety limit.";
    if (failure.error === "cryptographic_operation_failed") return "The cryptographic operation failed.";
    if (failure.error === "screen_capture_protection_failed") return "Encrypted content visibility could not be updated safely.";
    if (failure.error === "security_key_busy") return "OneKey is busy. Fully quit OneKey Desktop or another wallet app from the system tray, then retry.";
    if (failure.error === "security_key_cancelled") return "The security-key operation was cancelled or timed out.";
    if (failure.error === "security_key_operation_failed") return "OneKey could not complete the hardware-vault operation. Unlock the device and retry.";
    if (failure.error === "security_key_unavailable") return "No OneKey Classic 1S was found. Connect it directly by USB, unlock it, and retry.";
    if (failure.error === "security_key_mismatch") return "The wrong security key answered, or its profile no longer matches this vault.";
    if (failure.error === "security_key_storage_failed") return "The security key could not store the encrypted vault seed. Check its resident-key and large-blob capacity, then retry.";
    return "The encrypted vault could not be saved.";
}
