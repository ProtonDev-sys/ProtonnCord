/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash, createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";

import { isProtocolTimestamp, type PrivateIdentity, requireSnowflake } from "./protocol";

const ONEKEY_VENDOR_ID = 0x1209;
const ONEKEY_CLASSIC_PRODUCT_IDS = new Set([0x4f4b, 0x53c1]);
const ONEKEY_BINDING_INFO = Buffer.from(
    "ProtonnCord/SecureMessaging/onekey-profile-binding/v1",
    "utf8",
);
const ONEKEY_PROFILE_INPUT_DOMAIN = Buffer.from(
    "ProtonnCord/SecureMessaging/OneKey/CKV/profile-input/v1",
    "utf8",
);
const ONEKEY_IDENTITY_SALT = Buffer.from(
    "ProtonnCord/SecureMessaging/OneKey/identity-root/v1",
    "utf8",
);
const ONEKEY_SIGNING_INFO = Buffer.from(
    "ProtonnCord/SecureMessaging/OneKey/discord-user/ed25519/v1\0",
    "utf8",
);
const ONEKEY_HPKE_INFO = Buffer.from(
    "ProtonnCord/SecureMessaging/OneKey/discord-user/x25519/v1\0",
    "utf8",
);
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const X25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export interface OneKeyUsbDeviceDescriptor {
    deviceId?: string;
    manufacturerName?: string;
    productId: number;
    vendorId: number;
}

export interface OneKeyCipherResult {
    value: string;
}

export function isOneKeyClassicDevice(device: OneKeyUsbDeviceDescriptor): boolean {
    if (device.vendorId !== ONEKEY_VENDOR_ID || !ONEKEY_CLASSIC_PRODUCT_IDS.has(device.productId)) return false;
    const manufacturer = device.manufacturerName?.trim().toLowerCase();
    return manufacturer !== "trezor" && manufacturer !== "trezor company" && manufacturer !== "satoshilabs";
}

export function deriveOneKeyBindingPublicKey(secret: Buffer, profileInput: Buffer): string {
    if (!Buffer.isBuffer(secret) || secret.byteLength !== 32 || !Buffer.isBuffer(profileInput) ||
        profileInput.byteLength !== 32)
        throw new TypeError("OneKey binding inputs must be 32 bytes");
    const seed = Buffer.from(hkdfSync("sha256", secret, profileInput, ONEKEY_BINDING_INFO, 32));
    let encodedPrivateKey: Buffer | null = null;
    try {
        encodedPrivateKey = Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]);
        const privateKey = createPrivateKey({ key: encodedPrivateKey, format: "der", type: "pkcs8" });
        // Node accepts a private KeyObject here; @types/node's overload omits that documented input.
        const publicKey = createPublicKey(privateKey as unknown as Parameters<typeof createPublicKey>[0]);
        return publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    } finally {
        seed.fill(0);
        encodedPrivateKey?.fill(0);
    }
}

export function oneKeyDeterministicProfileInput(): string {
    const digest = createHash("sha256").update(ONEKEY_PROFILE_INPUT_DOMAIN).digest();
    try {
        return digest.toString("base64url");
    } finally {
        digest.fill(0);
    }
}

function rawPublicKey(der: Buffer, prefix: Buffer): string {
    if (der.byteLength !== prefix.byteLength + 32 || !der.subarray(0, prefix.byteLength).equals(prefix))
        throw new Error("OneKey identity public key encoding is invalid");
    return der.subarray(prefix.byteLength).toString("base64url");
}

export function deriveOneKeyPrivateIdentity(
    rootKey: Buffer,
    localUserId: string,
    createdAt = Date.now(),
): PrivateIdentity {
    if (!Buffer.isBuffer(rootKey) || rootKey.byteLength !== 32)
        throw new TypeError("OneKey identity root key must be 32 bytes");
    requireSnowflake(localUserId, "localUserId");
    if (!isProtocolTimestamp(createdAt)) throw new Error("Identity creation time is invalid");

    const userId = Buffer.from(localUserId, "utf8");
    const signingInfo = Buffer.concat([ONEKEY_SIGNING_INFO, userId]);
    const hpkeInfo = Buffer.concat([ONEKEY_HPKE_INFO, userId]);
    let signingSeed: Buffer | null = null;
    let hpkeSeed: Buffer | null = null;
    let signingPrivateDer: Buffer | null = null;
    let hpkePrivateDer: Buffer | null = null;
    let signingPublicDer: Buffer | null = null;
    let hpkePublicDer: Buffer | null = null;
    try {
        signingSeed = Buffer.from(hkdfSync("sha256", rootKey, ONEKEY_IDENTITY_SALT, signingInfo, 32));
        hpkeSeed = Buffer.from(hkdfSync("sha256", rootKey, ONEKEY_IDENTITY_SALT, hpkeInfo, 32));
        signingPrivateDer = Buffer.concat([ED25519_PKCS8_SEED_PREFIX, signingSeed]);
        hpkePrivateDer = Buffer.concat([X25519_PKCS8_SEED_PREFIX, hpkeSeed]);
        const signingPrivateKey = createPrivateKey({ key: signingPrivateDer, format: "der", type: "pkcs8" });
        const hpkePrivateKey = createPrivateKey({ key: hpkePrivateDer, format: "der", type: "pkcs8" });
        signingPublicDer = createPublicKey(
            signingPrivateKey as unknown as Parameters<typeof createPublicKey>[0],
        ).export({ format: "der", type: "spki" });
        hpkePublicDer = createPublicKey(
            hpkePrivateKey as unknown as Parameters<typeof createPublicKey>[0],
        ).export({ format: "der", type: "spki" });
        return {
            createdAt,
            hpkePrivateKey: hpkeSeed.toString("base64url"),
            hpkePublicKey: rawPublicKey(hpkePublicDer, X25519_SPKI_PREFIX),
            signingPrivateKey: signingPrivateDer.toString("base64url"),
            signingPublicKey: rawPublicKey(signingPublicDer, ED25519_SPKI_PREFIX),
        };
    } finally {
        userId.fill(0);
        signingInfo.fill(0);
        hpkeInfo.fill(0);
        signingSeed?.fill(0);
        hpkeSeed?.fill(0);
        signingPrivateDer?.fill(0);
        hpkePrivateDer?.fill(0);
        signingPublicDer?.fill(0);
        hpkePublicDer?.fill(0);
    }
}

async function oneKeyCipherBrowserOperation(encodedValue: string): Promise<OneKeyCipherResult | { __error: string; }> {
    type UsbDevice = {
        claimInterface(interfaceNumber: number): Promise<void>;
        clearHalt(direction: "in" | "out", endpointNumber: number): Promise<void>;
        close(): Promise<void>;
        configuration?: {
            configurationValue: number;
            interfaces: Array<{
                alternate: { interfaceClass: number; endpoints: Array<{ direction: string; endpointNumber: number; }>; };
                alternates: Array<{ interfaceClass: number; endpoints: Array<{ direction: string; endpointNumber: number; }>; }>;
                interfaceNumber: number;
            }>;
        };
        open(): Promise<void>;
        opened: boolean;
        productId: number;
        releaseInterface(interfaceNumber: number): Promise<void>;
        selectConfiguration(configurationValue: number): Promise<void>;
        transferIn(endpointNumber: number, length: number): Promise<{ data?: DataView; status: string; }>;
        transferOut(endpointNumber: number, data: ArrayBuffer): Promise<{ status: string; }>;
        vendorId: number;
    };
    type UsbApi = { requestDevice(options: { filters: Array<{ productId: number; vendorId: number; }>; }): Promise<UsbDevice>; };

    const textEncoder = new TextEncoder();
    const empty = new Uint8Array(0);
    const concat = (...values: Uint8Array[]) => {
        const result = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0));
        let offset = 0;
        for (const value of values) {
            result.set(value, offset);
            offset += value.byteLength;
        }
        return result;
    };
    const fromBase64Url = (value: string) => Uint8Array.from(
        atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")),
        character => character.charCodeAt(0),
    );
    const toBase64Url = (value: Uint8Array) => {
        let binary = "";
        for (let offset = 0; offset < value.byteLength; offset += 8_192)
            binary += String.fromCharCode(...value.subarray(offset, offset + 8_192));
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    };
    const varint = (value: number) => {
        if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error("OneKeyUnsupported");
        const bytes: number[] = [];
        let remaining = value;
        do {
            const next = remaining % 128;
            remaining = Math.floor(remaining / 128);
            bytes.push(next | (remaining > 0 ? 0x80 : 0));
        } while (remaining > 0);
        return Uint8Array.from(bytes);
    };
    const unsignedField = (field: number, value: number) => concat(varint(field << 3), varint(value));
    const bytesField = (field: number, value: Uint8Array) => concat(
        varint((field << 3) | 2),
        varint(value.byteLength),
        value,
    );
    const readVarint = (value: Uint8Array, start: number) => {
        let result = 0;
        let multiplier = 1;
        let offset = start;
        for (let count = 0; count < 5 && offset < value.byteLength; count++, offset++) {
            const byte = value[offset];
            result += (byte & 0x7f) * multiplier;
            if ((byte & 0x80) === 0) return { next: offset + 1, value: result };
            multiplier *= 128;
        }
        throw new Error("OneKeyUnsupported");
    };
    type ProtobufField = { field: number; value: number | Uint8Array; wire: number; };
    const wipeProtobufFields = (fields: ProtobufField[]) => {
        for (const field of fields) if (field.value instanceof Uint8Array) field.value.fill(0);
    };
    const protobufFields = (value: Uint8Array) => {
        const fields: ProtobufField[] = [];
        try {
            let offset = 0;
            while (offset < value.byteLength) {
                const tag = readVarint(value, offset);
                offset = tag.next;
                const field = Math.floor(tag.value / 8);
                const wire = tag.value & 7;
                if (field < 1) throw new Error("OneKeyUnsupported");
                if (wire === 0) {
                    const item = readVarint(value, offset);
                    fields.push({ field, value: item.value, wire });
                    offset = item.next;
                } else if (wire === 2) {
                    const length = readVarint(value, offset);
                    offset = length.next;
                    if (length.value > 4_096 || offset + length.value > value.byteLength)
                        throw new Error("OneKeyUnsupported");
                    fields.push({ field, value: value.slice(offset, offset + length.value), wire });
                    offset += length.value;
                } else {
                    throw new Error("OneKeyUnsupported");
                }
            }
            return fields;
        } catch (error) {
            wipeProtobufFields(fields);
            throw error;
        }
    };
    const failForDeviceResponse = (payload: Uint8Array): never => {
        const fields = protobufFields(payload);
        try {
            const code = fields.find(field => field.field === 1 && field.wire === 0)?.value;
            throw new Error(code === 4 || code === 6 ? "OneKeyCancelled" : "OneKeyFailure");
        } finally {
            wipeProtobufFields(fields);
        }
    };

    let device: UsbDevice | null = null;
    let claimed = false;
    let unsupportedStage = "webusb";
    try {
        const { usb } = navigator as Navigator & { usb?: UsbApi; };
        if (!usb) throw new Error("OneKeyUnsupported");
        unsupportedStage = "profile_input";
        const profileInput = fromBase64Url(encodedValue);
        if (profileInput.byteLength !== 32) throw new Error("OneKeyUnsupported");
        unsupportedStage = "device_enumeration";
        device = await usb.requestDevice({
            filters: [
                { productId: 0x4f4b, vendorId: 0x1209 },
                { productId: 0x53c1, vendorId: 0x1209 },
            ],
        });
        if (device.vendorId !== 0x1209 || ![0x4f4b, 0x53c1].includes(device.productId))
            throw new Error("OneKeyUnsupported");
        unsupportedStage = "device_open";
        if (!device.opened) await device.open();
        unsupportedStage = "configuration";
        if (!device.configuration || device.configuration.configurationValue !== 1)
            await device.selectConfiguration(1);
        unsupportedStage = "interface_validation";
        const usbInterface = device.configuration?.interfaces.find(item =>
            item.interfaceNumber === 0 && item.alternates.some(alternate =>
                alternate.interfaceClass === 0xff &&
                alternate.endpoints.some(endpoint => endpoint.direction === "in" && endpoint.endpointNumber === 1) &&
                alternate.endpoints.some(endpoint => endpoint.direction === "out" && endpoint.endpointNumber === 1),
            ));
        if (!usbInterface) throw new Error("OneKeyUnsupported");
        unsupportedStage = "interface_claim";
        await device.claimInterface(0);
        claimed = true;
        await device.clearHalt("in", 1).catch(() => undefined);
        await device.clearHalt("out", 1).catch(() => undefined);

        const send = async (messageType: number, payload: Uint8Array) => {
            if (!device || payload.byteLength > 4_096) throw new Error("OneKeyUnsupported");
            let offset = 0;
            let first = true;
            do {
                const packet = new Uint8Array(64);
                packet[0] = 0x3f;
                const payloadOffset = first ? 9 : 1;
                if (first) {
                    packet[1] = 0x23;
                    packet[2] = 0x23;
                    packet[3] = messageType >>> 8;
                    packet[4] = messageType;
                    packet[5] = payload.byteLength >>> 24;
                    packet[6] = payload.byteLength >>> 16;
                    packet[7] = payload.byteLength >>> 8;
                    packet[8] = payload.byteLength;
                }
                const count = Math.min(packet.byteLength - payloadOffset, payload.byteLength - offset);
                packet.set(payload.subarray(offset, offset + count), payloadOffset);
                offset += count;
                let transfer: { status: string; };
                try {
                    transfer = await device.transferOut(1, packet.buffer);
                } finally {
                    packet.fill(0);
                }
                if (transfer.status !== "ok") throw new Error("OneKeyBusy");
                first = false;
            } while (offset < payload.byteLength);
        };
        const receive = async () => {
            if (!device) throw new Error("OneKeyUnsupported");
            const transfer = await device.transferIn(1, 64);
            if (!transfer.data) throw new Error("OneKeyBusy");
            const first = new Uint8Array(
                transfer.data.buffer,
                transfer.data.byteOffset,
                transfer.data.byteLength,
            );
            let messageType: number;
            let payload: Uint8Array;
            let offset: number;
            try {
                if (transfer.status !== "ok" || first.byteLength !== 64) throw new Error("OneKeyBusy");
                if (first[0] !== 0x3f || first[1] !== 0x23 || first[2] !== 0x23)
                    throw new Error("OneKeyUnsupported");
                messageType = (first[3] << 8) | first[4];
                const length = (first[5] * 0x1000000) + (first[6] << 16) + (first[7] << 8) + first[8];
                if (length > 4_096) throw new Error("OneKeyUnsupported");
                payload = new Uint8Array(length);
                offset = Math.min(length, 55);
                payload.set(first.subarray(9, 9 + offset));
            } finally {
                first.fill(0);
            }
            try {
                while (offset < payload.byteLength) {
                    const continuationTransfer = await device.transferIn(1, 64);
                    if (!continuationTransfer.data) throw new Error("OneKeyBusy");
                    const continuation = new Uint8Array(
                        continuationTransfer.data.buffer,
                        continuationTransfer.data.byteOffset,
                        continuationTransfer.data.byteLength,
                    );
                    try {
                        if (continuationTransfer.status !== "ok" || continuation.byteLength !== 64)
                            throw new Error("OneKeyBusy");
                        if (continuation[0] !== 0x3f) throw new Error("OneKeyUnsupported");
                        const count = Math.min(63, payload.byteLength - offset);
                        payload.set(continuation.subarray(1, 1 + count), offset);
                        offset += count;
                    } finally {
                        continuation.fill(0);
                    }
                }
                return { messageType, payload };
            } catch (error) {
                payload.fill(0);
                throw error;
            }
        };

        unsupportedStage = "initialize_write";
        await send(0, empty);
        unsupportedStage = "initialize_read";
        const features = await receive();
        unsupportedStage = "features_validation";
        let featureFields: ReturnType<typeof protobufFields> = [];
        try {
            if (features.messageType === 3) failForDeviceResponse(features.payload);
            if (features.messageType !== 17) throw new Error("OneKeyUnsupported");
            featureFields = protobufFields(features.payload);
            const featureNumber = (field: number) => featureFields
                .find(item => item.field === field && item.wire === 0)?.value;
            const capabilities = featureFields.flatMap(field => {
                if (field.field !== 30) return [];
                if (field.wire === 0 && typeof field.value === "number") return [field.value];
                if (field.wire !== 2 || !(field.value instanceof Uint8Array)) return [];
                const packed: number[] = [];
                let offset = 0;
                while (offset < field.value.byteLength) {
                    const item = readVarint(field.value, offset);
                    packed.push(item.value);
                    offset = item.next;
                }
                return packed;
            });
            if (featureNumber(5) === 1 || featureNumber(7) !== 1 || featureNumber(12) !== 1 ||
                featureNumber(600) !== 1 || !capabilities.includes(5))
                throw new Error("OneKeyUnsupported");
        } finally {
            wipeProtobufFields(featureFields);
            features.payload.fill(0);
        }

        const request = concat(
            unsignedField(1, 0x80002720),
            unsignedField(1, 0),
            bytesField(2, textEncoder.encode("ProtonnCord Secure Messaging")),
            bytesField(3, profileInput),
            unsignedField(4, 1),
            unsignedField(5, 1),
            unsignedField(6, 1),
        );
        unsupportedStage = "cipher_write";
        try {
            await send(23, request);
        } finally {
            request.fill(0);
        }
        for (let interaction = 0; interaction < 12; interaction++) {
            unsupportedStage = "response_read";
            const response = await receive();
            unsupportedStage = "response_validation";
            try {
                if (response.messageType === 3) failForDeviceResponse(response.payload);
                if (response.messageType === 18) {
                    await send(10_000, empty);
                    continue;
                }
                if (response.messageType === 26) {
                    await send(27, empty);
                    continue;
                }
                if (response.messageType === 41) {
                    await send(42, Uint8Array.of(0x18, 0x01));
                    continue;
                }
                if (response.messageType !== 48) throw new Error("OneKeyUnsupported");
                const fields = protobufFields(response.payload);
                try {
                    const values = fields.filter(field =>
                        field.field === 1 && field.wire === 2 && field.value instanceof Uint8Array,
                    );
                    if (values.length !== 1) throw new Error("OneKeyFailure");
                    const value = values[0].value as Uint8Array;
                    if (value.byteLength !== 32 || value.every(byte => byte === 0))
                        throw new Error("OneKeyFailure");
                    return { value: toBase64Url(value) };
                } finally {
                    wipeProtobufFields(fields);
                }
            } finally {
                response.payload.fill(0);
            }
        }
        throw new Error("OneKeyFailure");
    } catch (error) {
        const name = error instanceof Error ? error.name : "";
        const message = error instanceof Error ? error.message : "";
        if (name === "NotFoundError" || message === "OneKeyUnavailable") return { __error: "OneKeyUnavailable" };
        if (name === "AbortError" || message === "OneKeyCancelled") return { __error: "OneKeyCancelled" };
        if (name === "NetworkError" || name === "InvalidStateError" || message === "OneKeyBusy")
            return { __error: "OneKeyBusy" };
        if (message === "OneKeyFailure") return { __error: "OneKeyFailure" };
        return { __error: `OneKeyUnsupported:${unsupportedStage}` };
    } finally {
        if (device && claimed) await device.releaseInterface(0).catch(() => undefined);
        if (device?.opened) await device.close().catch(() => undefined);
    }
}

export function createOneKeyCipherScript(encodedValue: string): string {
    return `(()=>{const __name=value=>value;return (${oneKeyCipherBrowserOperation.toString()})(${JSON.stringify(encodedValue)});})()`;
}
