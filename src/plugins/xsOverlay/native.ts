/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createSocket, Socket } from "dgram";

let xsoSocket: Socket | null = null;

export function sendToOverlay(_, data: any) {
    const json = JSON.stringify({ ...data, messageType: data.type });
    if (!xsoSocket) {
        const socket = xsoSocket = createSocket("udp4");
        socket.on("error", error => {
            console.error("XSOverlay UDP socket error", error);
            if (xsoSocket === socket) xsoSocket = null;
            try { socket.close(); } catch { }
        });
    }
    return new Promise<void>((resolve, reject) => {
        xsoSocket!.send(json, 42069, "127.0.0.1", error => error ? reject(error) : resolve());
    });
}

export function closeSocket() {
    const socket = xsoSocket;
    xsoSocket = null;
    try { socket?.close(); } catch { }
}
