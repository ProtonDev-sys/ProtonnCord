/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { initInput } from "@equicordplugins/remix/editor/input";
import { bounds } from "@equicordplugins/remix/editor/tools/crop";
import { heightFromBounds, widthFromBounds } from "@equicordplugins/remix/editor/utils/canvas";
import { useEffect, useRef } from "@webpack/common";

export let canvas: HTMLCanvasElement | null = null;
export let ctx: CanvasRenderingContext2D | null = null;

export const brushCanvas = document.createElement("canvas")!.getContext("2d")!;
export const shapeCanvas = document.createElement("canvas")!.getContext("2d")!;
export const cropCanvas = document.createElement("canvas")!.getContext("2d")!;

export let image: HTMLImageElement;
let canvasGeneration = 0;

export function exportImg(): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
        if (!canvas || !ctx) {
            reject(new Error("Load an image before sending it."));
            return;
        }
        const selection = {
            ...bounds,
            right: bounds.right === -1 ? canvas.width : bounds.right,
            bottom: bounds.bottom === -1 ? canvas.height : bounds.bottom
        };
        const width = widthFromBounds(selection);
        const height = heightFromBounds(selection);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            reject(new Error("Select a non-empty crop before sending it."));
            return;
        }
        const renderCanvas = document.createElement("canvas");
        renderCanvas.width = width;
        renderCanvas.height = height;
        const renderCtx = renderCanvas.getContext("2d");
        if (!renderCtx) {
            reject(new Error("Image export is unavailable."));
            return;
        }
        renderCtx.drawImage(image, -selection.left, -selection.top);
        renderCtx.drawImage(brushCanvas.canvas, -selection.left, -selection.top);
        renderCanvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error("Could not export the image."));
        });
    });
}

interface CanvasProps {
    file: File;
    onReady?(ready: boolean): void;
    onError?(message: string): void;
}

export const Canvas = ({ file, onReady, onError }: CanvasProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const targetCanvas = canvasRef.current;
        if (!targetCanvas) return;

        const generation = ++canvasGeneration;
        canvas = null;
        ctx = null;
        onReady?.(false);
        const nextImage = new Image();
        const imageUrl = URL.createObjectURL(file);
        let cleanupInput: (() => void) | undefined;
        let active = true;
        let released = false;
        const isCurrent = () => active && generation === canvasGeneration;
        function releaseImage() {
            active = false;
            nextImage.onload = null;
            nextImage.onerror = null;
            if (!released) {
                released = true;
                URL.revokeObjectURL(imageUrl);
            }
        }
        function fail() {
            if (!isCurrent()) return;
            releaseImage();
            onError?.("Could not load the image. Choose another file.");
        }
        nextImage.onerror = fail;
        nextImage.onload = () => {
            if (!isCurrent()) return;
            const nextContext = targetCanvas.getContext("2d");
            if (!nextContext || nextImage.width <= 0 || nextImage.height <= 0) {
                fail();
                return;
            }
            releaseImage();
            image = nextImage;
            canvas = targetCanvas;
            ctx = nextContext;
            canvas.width = image.width;
            canvas.height = image.height;
            brushCanvas.canvas.width = image.width;
            brushCanvas.canvas.height = image.height;
            shapeCanvas.canvas.width = image.width;
            shapeCanvas.canvas.height = image.height;
            cropCanvas.canvas.width = image.width;
            cropCanvas.canvas.height = image.height;
            bounds.left = bounds.top = 0;
            bounds.right = image.width;
            bounds.bottom = image.height;
            ctx.drawImage(image, 0, 0);
            cleanupInput = initInput();
            onReady?.(true);
        };

        nextImage.src = imageUrl;

        return () => {
            cleanupInput?.();
            releaseImage();
            nextImage.src = "";
            if (generation === canvasGeneration && canvas === targetCanvas) {
                canvas = null;
                ctx = null;
            }
        };
    }, [file, onReady, onError]);

    return (<canvas ref={canvasRef} className="vc-remix-canvas"></canvas>);
};

export function render() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    ctx.drawImage(brushCanvas.canvas, 0, 0);
    ctx.drawImage(shapeCanvas.canvas, 0, 0);
    ctx.drawImage(cropCanvas.canvas, 0, 0);
}
