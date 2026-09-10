/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { brushCanvas } from "@equicordplugins/remix/editor/components/Canvas";

export function fillCircle(x: number, y: number, radius: number, canvas = brushCanvas) {
    canvas.beginPath();
    canvas.arc(x, y, radius, 0, Math.PI * 2);
    canvas.fill();
}

export function line(x1: number, y1: number, x2: number, y2: number, canvas = brushCanvas) {
    canvas.beginPath();
    canvas.moveTo(x1, y1);
    canvas.lineTo(x2, y2);
    canvas.stroke();
}

export function dist(x1: number, y1: number, x2: number, y2: number) {
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

export function widthFromBounds(bounds: { left: number, right: number, top: number, bottom: number; }) {
    return bounds.right - bounds.left;
}

export function heightFromBounds(bounds: { left: number, right: number, top: number, bottom: number; }) {
    return bounds.bottom - bounds.top;
}

export function urlToImage(url: string, signal?: AbortSignal) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        function cleanup() {
            img.onload = null;
            img.onerror = null;
            signal?.removeEventListener("abort", abort);
        }
        function abort() {
            cleanup();
            img.src = "";
            reject(new Error("Image loading was cancelled."));
        }
        img.crossOrigin = "anonymous";
        img.onload = () => {
            cleanup();
            resolve(img);
        };
        img.onerror = () => {
            cleanup();
            reject(new Error("Could not load the image."));
        };
        if (signal?.aborted) {
            abort();
            return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        img.src = url;
    });
}

export function imageToBlob(image: HTMLImageElement) {
    return new Promise<File>((resolve, reject) => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            reject(new Error("Image conversion is unavailable."));
            return;
        }
        canvas.width = image.width;
        canvas.height = image.height;
        ctx.drawImage(image, 0, 0);
        canvas.toBlob(blob => {
            if (blob) resolve(new File([blob], "image.png", { type: "image/png" }));
            else reject(new Error("Could not convert the image."));
        });
    });
}
