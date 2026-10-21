/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** This is capability negotiation, not authentication or encryption. */
export const CONTROL_MESSAGE_PREFIX = "PCMCAP1:";

export const CAPABILITY_TTL_MS = 10 * 60 * 1000;
export const PROBE_COOLDOWN_MS = 10 * 60 * 1000;
export const CHALLENGE_TTL_MS = 60 * 1000;
export const RESPONSE_COOLDOWN_MS = 30 * 1000;
const MAX_PEERS = 256;
const MAX_CONTROL_LENGTH = 2000;
const ID_PATTERN = /^\d{1,20}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;

export interface PeerContext {
    channelId: string;
    localId: string;
    /** The actual message author for received controls, verified by the caller. */
    peerId: string;
}

interface ControlBase {
    v: 1;
    channel: string;
    from: string;
    to: string;
    nonce: string;
}

type ControlFrame = ControlBase & (
    { type: "hello"; } |
    { type: "ack"; replyTo: string; } |
    { type: "confirm"; }
);

interface Challenge {
    nonce: string;
    expiresAt: number;
}

interface PeerState {
    readyUntil: number;
    lastProbeAt: number;
    lastHelloResponseAt: number;
    touchedAt: number;
    outgoing?: Challenge;
    incoming?: Challenge;
}

export interface ControlResult {
    reply?: string;
    ready: boolean;
    label: string;
}

function validContext(peer: PeerContext): boolean {
    return ID_PATTERN.test(peer.channelId)
        && ID_PATTERN.test(peer.localId)
        && ID_PATTERN.test(peer.peerId)
        && peer.localId !== peer.peerId;
}

function randomNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function frameFor(peer: PeerContext, type: "hello" | "confirm", nonce: string): ControlFrame;
function frameFor(peer: PeerContext, type: "ack", nonce: string, replyTo: string): ControlFrame;
function frameFor(peer: PeerContext, type: "hello" | "ack" | "confirm", nonce: string, replyTo?: string): ControlFrame {
    const base: ControlBase = { v: 1, channel: peer.channelId, from: peer.localId, to: peer.peerId, nonce };
    return type === "ack" ? { ...base, type, replyTo: replyTo! } : { ...base, type };
}

function serialize(frame: ControlFrame): string {
    const explanation = frame.type === "hello"
        ? "ProtonnCord is checking whether both people support experimental message compression. If your app does not support it, no action is needed and ordinary messages will continue."
        : frame.type === "ack"
            ? "ProtonnCord supports experimental message compression and is confirming this conversation. No action is needed."
            : "ProtonnCord has confirmed experimental message compression for this conversation. No action is needed.";
    return CONTROL_MESSAGE_PREFIX + JSON.stringify(frame) + "\n" + explanation;
}

function parse(content: string, peer: PeerContext): ControlFrame | null {
    if (typeof content !== "string" || content.length > MAX_CONTROL_LENGTH || !content.startsWith(CONTROL_MESSAGE_PREFIX)) return null;
    const end = content.indexOf("\n");
    const payload = content.slice(CONTROL_MESSAGE_PREFIX.length, end === -1 ? undefined : end);
    try {
        const frame = JSON.parse(payload);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
        if (frame.v !== 1 || frame.channel !== peer.channelId || frame.from !== peer.peerId || frame.to !== peer.localId) return null;
        if (typeof frame.nonce !== "string" || !NONCE_PATTERN.test(frame.nonce)) return null;
        if (frame.type !== "hello" && frame.type !== "ack" && frame.type !== "confirm") return null;
        if (frame.type === "ack" && (typeof frame.replyTo !== "string" || !NONCE_PATTERN.test(frame.replyTo))) return null;
        const expectedKeys = frame.type === "ack" ? 7 : 6;
        if (Object.keys(frame).length !== expectedKeys) return null;
        return frame as ControlFrame;
    } catch {
        return null;
    }
}

/**
 * Pure, in-memory negotiation for one-to-one DMs. The caller must supply real
 * channel/author identities and pass only live controls from the peer, never
 * message history, edits, forwarded snapshots, bots, or the local user's echo.
 *
 * Only prepareProbe initiates a negotiation; call it after an intentional user
 * send in the same DM. Returned frames are ordinary visible messages. A failed
 * send never grants readiness: it merely leaves a temporary challenge/cooldown.
 */
export class CompressionSession {
    private peers = new Map<string, PeerState>();
    private accountId: string | undefined;

    /** Reset on plugin stop, account change, or reconnect if session state is uncertain. */
    clear(): void {
        this.peers.clear();
        this.accountId = undefined;
    }

    prepareProbe(peer: PeerContext, now = Date.now()): string | null {
        if (!this.acceptContext(peer, now)) return null;
        const state = this.stateFor(peer, now, true)!;
        if (state.readyUntil > now || now - state.lastProbeAt < PROBE_COOLDOWN_MS) return null;
        const nonce = randomNonce();
        state.outgoing = { nonce, expiresAt: now + CHALLENGE_TTL_MS };
        state.lastProbeAt = now;
        return serialize(frameFor(peer, "hello", nonce));
    }

    isReady(peer: PeerContext, now = Date.now()): boolean {
        if (!this.acceptContext(peer, now)) return false;
        return (this.stateFor(peer, now, false)?.readyUntil ?? 0) > now;
    }

    handleControl(content: string, peer: PeerContext, now = Date.now()): ControlResult | null {
        if (!this.acceptContext(peer, now)) return null;
        const frame = parse(content, peer);
        if (!frame) return null;
        const state = this.stateFor(peer, now, frame.type === "hello");
        const result: ControlResult = {
            ready: (state?.readyUntil ?? 0) > now,
            label: "ProtonnCord message compression capability check"
        };
        if (!state) return result;

        if (frame.type === "hello") {
            if (now - state.lastHelloResponseAt < RESPONSE_COOLDOWN_MS) return result;
            const nonce = randomNonce();
            state.incoming = { nonce, expiresAt: now + CHALLENGE_TTL_MS };
            state.lastHelloResponseAt = now;
            result.reply = serialize(frameFor(peer, "ack", nonce, frame.nonce));
        } else if (frame.type === "ack") {
            if (!state.outgoing || state.outgoing.nonce !== frame.replyTo) return result;
            state.outgoing = undefined;
            state.readyUntil = now + CAPABILITY_TTL_MS;
            result.ready = true;
            result.reply = serialize(frameFor(peer, "confirm", frame.nonce));
        } else {
            if (!state.incoming || state.incoming.nonce !== frame.nonce) return result;
            state.incoming = undefined;
            state.readyUntil = now + CAPABILITY_TTL_MS;
            result.ready = true;
        }
        return result;
    }

    private acceptContext(peer: PeerContext, now: number): boolean {
        if (!Number.isFinite(now) || !validContext(peer)) return false;
        if (this.accountId !== peer.localId) {
            this.clear();
            this.accountId = peer.localId;
        }
        return true;
    }

    private stateFor(peer: PeerContext, now: number, create: boolean): PeerState | undefined {
        for (const [key, state] of this.peers) {
            if (state.outgoing && state.outgoing.expiresAt <= now) state.outgoing = undefined;
            if (state.incoming && state.incoming.expiresAt <= now) state.incoming = undefined;
            if (state.touchedAt + CAPABILITY_TTL_MS * 2 <= now && state.readyUntil <= now && !state.outgoing && !state.incoming) {
                this.peers.delete(key);
            }
        }
        const key = `${peer.localId}:${peer.channelId}:${peer.peerId}`;
        let state = this.peers.get(key);
        if (!state && create) {
            while (this.peers.size >= MAX_PEERS) this.peers.delete(this.peers.keys().next().value!);
            state = { readyUntil: 0, lastProbeAt: -Infinity, lastHelloResponseAt: -Infinity, touchedAt: now };
        }
        if (state) {
            state.touchedAt = now;
            this.peers.delete(key);
            this.peers.set(key, state);
        }
        return state;
    }
}
