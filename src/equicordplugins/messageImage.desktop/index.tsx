/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { saveFile } from "@utils/web";
import type { Message, RenderModalProps } from "@vencord/discord-types";
import { closeModal, Menu, Modal, openModal, React, showToast, Toasts, useEffect, useMemo, useRef, UserStore, useState } from "@webpack/common";

import { captureMessage, Native } from "./capture";
import { captureDimensions, CapturedMessage, composeCaptures, Mask, maskBetween, MAX_MESSAGES, MAX_PIXELS, paintPreview, png } from "./image";

const selected = new Map<string, CapturedMessage>();
let account: string | undefined;
let channel: string | undefined;
let modal: string | undefined;
let captureController: AbortController | undefined;
let enabled = false;

function reset() {
    captureController?.abort();
    captureController = undefined;
    if (modal) closeModal(modal);
    modal = undefined;
    selected.clear();
    account = channel = undefined;
}

function active(id: string) { return enabled && UserStore.getCurrentUser()?.id === id; }

async function select(message: Message, open = false) {
    const owner = UserStore.getCurrentUser()?.id;
    if (!owner || !enabled || modal) return;
    if (account && account !== owner) reset();
    if (captureController) { showToast("A message is still being captured."); return; }
    if (!open && selected.has(message.id)) { selected.delete(message.id); if (!selected.size) channel = undefined; showToast(`${selected.size} messages selected.`); return; }
    if (!open && channel && channel !== message.channel_id && selected.size) { showToast("Clear the image selection before selecting from another channel.", Toasts.Type.FAILURE); return; }
    if (!open && selected.size >= MAX_MESSAGES) { showToast(`Select up to ${MAX_MESSAGES} messages.`, Toasts.Type.FAILURE); return; }
    const controller = new AbortController();
    captureController = controller;
    account = owner;
    const cancel = () => controller.abort();
    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("keydown", cancel);
    window.addEventListener("pointerdown", cancel);
    try {
        const captured = await captureMessage(message.channel_id, message.id, controller.signal);
        if (controller.signal.aborted || !active(owner)) return;
        const pixels = captured.canvas.width * captured.canvas.height + [...selected.values()].reduce((n, item) => n + item.canvas.width * item.canvas.height, 0);
        if (!open && pixels > MAX_PIXELS) throw new Error("The selection is too large. Create this image before adding more messages.");
        if (open) openEditor([captured]);
        else {
            selected.set(message.id, captured);
            channel = message.channel_id;
            showToast(`${selected.size} ${selected.size === 1 ? "message" : "messages"} selected for an image.`);
        }
    } catch (error) {
        if (!controller.signal.aborted && active(owner)) showToast(error instanceof Error ? error.message : "Could not capture the message.", Toasts.Type.FAILURE);
    } finally {
        window.removeEventListener("wheel", cancel);
        window.removeEventListener("keydown", cancel);
        window.removeEventListener("pointerdown", cancel);
        if (captureController === controller) captureController = undefined;
    }
}

function Editor({ entries, owner, ...props }: RenderModalProps & { entries: CapturedMessage[]; owner: string; }) {
    const composition = useMemo(() => composeCaptures(entries), [entries]);
    const [masks, setMasks] = useState<Mask[]>([]);
    const [hideNames, setHideNames] = useState(false);
    const [hideAvatars, setHideAvatars] = useState(false);
    const [hideTimes, setHideTimes] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const preview = useRef<HTMLCanvasElement>(null);
    const start = useRef<{ x: number; y: number; } | undefined>(undefined);
    const mounted = useRef(true);
    const automatic = [...(hideNames ? composition.names : []), ...(hideAvatars ? composition.avatars : []), ...(hideTimes ? composition.times : [])];

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    useEffect(() => {
        if (preview.current) paintPreview(preview.current, composition.canvas, [...automatic, ...masks]);
    }, [composition, masks, hideNames, hideAvatars, hideTimes]);

    function point(event: React.PointerEvent<HTMLCanvasElement>) {
        const rect = event.currentTarget.getBoundingClientRect();
        return { x: (event.clientX - rect.left) * event.currentTarget.width / rect.width, y: (event.clientY - rect.top) * event.currentTarget.height / rect.height };
    }

    function cancelDrag() {
        if (!start.current) return;
        start.current = undefined; setDragging(false);
        if (preview.current) paintPreview(preview.current, composition.canvas, [...automatic, ...masks]);
    }

    async function exportImage(copy: boolean) {
        if (busy || dragging || !preview.current || !active(owner)) return;
        setBusy(true); setNotice("");
        try {
            // Repaint from current controls before encoding, even if an effect has not run yet.
            paintPreview(preview.current, composition.canvas, [...automatic, ...masks]);
            const blob = await png(preview.current);
            if (!mounted.current || !active(owner)) return;
            if (copy) {
                const bytes = new Uint8Array(await blob.arrayBuffer());
                if (!mounted.current || !active(owner)) return;
                await Native.copyImage(bytes);
            } else saveFile(new File([blob], "message-image.png", { type: "image/png" }));
            if (mounted.current && active(owner)) setNotice(copy ? "Image copied." : "Image download started.");
        } catch {
            if (mounted.current && active(owner)) setNotice(copy ? "Could not copy the image. Try Save PNG." : "Could not save the image.");
        } finally { if (mounted.current) setBusy(false); }
    }

    return <Modal {...props} size="lg" title="Message image">
        <div className="pc-message-image">
            <Paragraph>Drag over anything you want to censor. The rest of the image stays exactly as it appeared in Discord.</Paragraph>
            <div className="pc-message-image-options">
                <FormSwitch title="Censor author names" value={hideNames} onChange={setHideNames} disabled={busy || dragging} hideBorder />
                <FormSwitch title="Censor profile pictures" value={hideAvatars} onChange={setHideAvatars} disabled={busy || dragging} hideBorder />
                <FormSwitch title="Censor timestamps" value={hideTimes} onChange={setHideTimes} disabled={busy || dragging} hideBorder />
            </div>
            <div className="pc-message-image-actions">
                <Button variant="secondary" size="small" disabled={!masks.length || busy || dragging} onClick={() => setMasks(previous => previous.slice(0, -1))}>Undo block</Button>
                <Button variant="secondary" size="small" disabled={!masks.length || busy || dragging} onClick={() => setMasks([])}>Clear drawn blocks</Button>
            </div>
            <details>
                <summary>Censor a whole message</summary>
                <div className="pc-message-image-actions">
                    {composition.rows.map((row, index) => <Button key={entries[index].id} variant="secondary" size="small" disabled={busy || dragging} onClick={() => setMasks(previous => [...previous, row])}>Message {index + 1}</Button>)}
                </div>
            </details>
            <canvas ref={preview} className="pc-message-image-preview" aria-label="Captured Discord messages. Drag to censor; the controls above also work with a keyboard."
                onPointerDown={event => {
                    if (busy || event.button !== 0) return;
                    start.current = point(event); setDragging(true); event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={event => {
                    if (!start.current) return;
                    paintPreview(event.currentTarget, composition.canvas, [...automatic, ...masks, maskBetween(start.current, point(event), composition.canvas.width, composition.canvas.height)]);
                }}
                onPointerUp={event => {
                    if (!start.current) return;
                    const mask = maskBetween(start.current, point(event), composition.canvas.width, composition.canvas.height);
                    start.current = undefined; setDragging(false);
                    if (mask.width >= 2 && mask.height >= 2) setMasks(previous => [...previous, mask]);
                    else paintPreview(event.currentTarget, composition.canvas, [...automatic, ...masks]);
                }} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} />
            {notice && <Paragraph role="status">{notice}</Paragraph>}
            <div className="pc-message-image-actions">
                <Button disabled={busy || dragging} onClick={() => void exportImage(true)}>{busy ? "Working…" : "Copy image"}</Button>
                <Button variant="secondary" disabled={busy || dragging} onClick={() => void exportImage(false)}>Save PNG</Button>
                <Button variant="secondary" onClick={props.onClose}>Done</Button>
            </div>
        </div>
    </Modal>;
}

function openEditor(entries = [...selected.values()]) {
    if (modal || !enabled) return;
    const owner = UserStore.getCurrentUser()?.id;
    if (!owner || owner !== account) { reset(); return; }
    if (!entries.length) { showToast("Right-click messages and choose Add to image first."); return; }
    try {
        entries.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : a.id === b.id ? 0 : 1);
        // Validate before handing the render to Discord's modal root.
        captureDimensions(entries);
        modal = openModal(props => <Editor {...props} entries={entries} owner={owner} />, { onCloseCallback: () => { modal = undefined; selected.clear(); channel = undefined; } });
    } catch (error) { showToast(error instanceof Error ? error.message : "Could not open the image preview.", Toasts.Type.FAILURE); }
}

const messageMenu: NavContextMenuPatchCallback = (children, { message }: { message?: Message; }) => {
    if (!message?.author) return;
    if (account && account !== UserStore.getCurrentUser()?.id) reset();
    children.push(<Menu.MenuGroup>
        <Menu.MenuItem id="pc-message-image-single" label="Create image…" action={() => void select(message, true)} />
        <Menu.MenuItem id="pc-message-image-select" label={selected.has(message.id) ? "Remove from image" : "Add to image"} action={() => void select(message)} />
        {selected.size > 0 && <Menu.MenuItem id="pc-message-image-preview" label={`Preview selected messages (${selected.size})…`} action={() => openEditor()} />}
        {selected.size > 0 && <Menu.MenuItem id="pc-message-image-clear" label="Clear image selection" action={reset} />}
    </Menu.MenuGroup>);
};

export default definePlugin({
    name: "MessageImage",
    description: "Capture Discord messages exactly as displayed, with optional censoring before copying a PNG.",
    authors: [EquicordDevs.creations],
    tags: ["Chat", "Utility"],
    contextMenus: { message: messageMenu },
    settingsAboutComponent: () => <Paragraph>Right-click a message and choose Create image. For several messages, choose Add to image on each, then Preview selected messages. Captures use your current Discord theme and zoom.</Paragraph>,
    toolboxActions: { "Create image from selected messages": () => openEditor(), "Clear image selection": reset },
    start() { enabled = true; },
    stop() { enabled = false; reset(); },
    flux: { LOGOUT: reset, CONNECTION_OPEN() { if (account && account !== UserStore.getCurrentUser()?.id) reset(); } }
});
