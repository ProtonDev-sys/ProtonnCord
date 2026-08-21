/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface SecurityKeyRootLinks {
    userIds: string[];
}

export function removePeerFromSecurityKeyRoot<T extends SecurityKeyRootLinks>(
    trustedRoots: Record<string, T>,
    rootFingerprint: string | null,
    peerUserId: string,
): void {
    if (!rootFingerprint) return;
    const root = trustedRoots[rootFingerprint];
    if (!root) return;
    root.userIds = root.userIds.filter(userId => userId !== peerUserId);
    if (root.userIds.length === 0) delete trustedRoots[rootFingerprint];
}
