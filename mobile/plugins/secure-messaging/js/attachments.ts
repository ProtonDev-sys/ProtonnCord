/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { secureRandomBytes } from './crypto'
import {
	decode64,
	decodeUtf8,
	encode64,
	requireSnowflake,
	utf8Bytes,
} from './protocol'

export const ATTACHMENT_PAYLOAD_PREFIX = 'PCEA2:'
export const RICH_CONTENT_PAYLOAD_PREFIX = 'PCER2:'
export const DETACHED_TEXT_PAYLOAD_PREFIX = 'PCET1:'
export const LEGACY_ATTACHMENT_PAYLOAD_PREFIX = 'PCEA1:'
export const LEGACY_RICH_CONTENT_PAYLOAD_PREFIX = 'PCER1:'
export const MANIFEST_ATTACHMENT_PAYLOAD_PREFIX = 'PCEA3:'
export const MANIFEST_RICH_CONTENT_PAYLOAD_PREFIX = 'PCER3:'
export const MANIFEST_DETACHED_TEXT_PAYLOAD_PREFIX = 'PCET2:'
export const MAX_ATTACHMENT_MANIFEST_BYTES = 768
export const DETACHED_TEXT_FILENAME = 'message.txt'
export const DETACHED_TEXT_MIME_TYPE =
	'application/vnd.protonn-cord.secure-message'
export const MAX_ATTACHMENT_COUNT = 10
export const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024 - 20

export function generateAttachmentBundleMaterial(count: number): {
	descriptor: Omit<AttachmentBundleDescriptor, 'root'>
	keyBytes: Uint8Array
} {
	if (!Number.isInteger(count) || count < 1 || count > MAX_ATTACHMENT_COUNT)
		throw new Error('Attachment count is invalid')
	const idBytes = secureRandomBytes(16)
	const keyBytes = secureRandomBytes(32)
	return {
		descriptor: {
			count,
			id: encode64(idBytes),
			key: encode64(keyBytes),
		},
		keyBytes,
	}
}

export function encryptedAttachmentFilename(
	bundleId: string,
	index: number,
): string {
	decode64(bundleId, 16)
	if (!Number.isInteger(index) || index < 0 || index >= MAX_ATTACHMENT_COUNT)
		throw new Error('Attachment index is invalid')
	return `pc-${bundleId}-${index}.pcaf`
}

const KDF_PREFIX = utf8Bytes('ProtonnCord/SecureMessaging/v1/attachment-kdf\0')
const ROOT_PREFIX = utf8Bytes(
	'ProtonnCord/SecureMessaging/v1/attachment-root\0',
)

export interface AttachmentBundleDescriptor {
	count: number
	id: string
	key: string
	root: string
	manifest?: AttachmentManifestEntry[]
}

export interface AttachmentManifestEntry {
	digest: string
	preview: boolean
	spoiler: boolean
	size: number
	name: string | null
}

export interface AttachmentMetadata {
	description: string | null
	duration: number | null
	height: number | null
	mimeType: string
	name: string
	size: number
	spoiler: boolean
	waveform: string | null
	width: number | null
}

export interface SecureStickerItem {
	formatType: number
	id: string
	name: string
}

export interface SecurePlaintext {
	attachments: AttachmentBundleDescriptor | null
	detachedTextIndex: number | null
	stickers: SecureStickerItem[]
	text: string
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, any>, expected: string[]): boolean {
	return Object.keys(value).sort().join() === expected.sort().join()
}

function optionalDimension(value: unknown): value is number | null {
	return (
		value === null ||
		(Number.isInteger(value) &&
			(value as number) >= 1 &&
			(value as number) <= 32768)
	)
}

function optionalDuration(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === 'number' &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= 604800)
	)
}

function validWaveform(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= 4 &&
		value.length <= 344 &&
		value.length % 4 === 0 &&
		/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)
	)
}

export function validateAttachmentMetadata(metadata: AttachmentMetadata): void {
	if (
		typeof metadata.name !== 'string' ||
		metadata.name.length < 1 ||
		metadata.name.length > 255 ||
		Array.from(metadata.name).some(
			character =>
				character.charCodeAt(0) < 32 || character === '\\' || character === '/',
		) ||
		typeof metadata.mimeType !== 'string' ||
		metadata.mimeType.length > 255 ||
		/[^\x20-\x7e]/.test(metadata.mimeType) ||
		!Number.isSafeInteger(metadata.size) ||
		metadata.size < 1 ||
		metadata.size > MAX_ATTACHMENT_BYTES ||
		typeof metadata.spoiler !== 'boolean' ||
		(metadata.description !== null &&
			(typeof metadata.description !== 'string' ||
				metadata.description.length > 1024 ||
				metadata.description.includes('\0'))) ||
		!optionalDimension(metadata.width) ||
		!optionalDimension(metadata.height) ||
		(metadata.width === null) !== (metadata.height === null) ||
		!optionalDuration(metadata.duration) ||
		(metadata.waveform !== null &&
			(!validWaveform(metadata.waveform) ||
				!metadata.mimeType.toLowerCase().startsWith('audio/') ||
				metadata.duration === null))
	)
		throw new Error('Attachment metadata is invalid')
}

function validateBundle(bundle: AttachmentBundleDescriptor): void {
	decode64(bundle.id, 16)
	decode64(bundle.key, 32)
	decode64(bundle.root, 32)
	if (
		!Number.isInteger(bundle.count) ||
		bundle.count < 1 ||
		bundle.count > MAX_ATTACHMENT_COUNT
	)
		throw new Error('Attachment bundle is invalid')
	if (bundle.manifest !== undefined) {
		if (
			!Array.isArray(bundle.manifest) ||
			bundle.manifest.length !== bundle.count
		)
			throw new Error('Attachment manifest count is invalid')
		let total = 0
		for (const entry of bundle.manifest) {
			if (
				!entry ||
				typeof entry.preview !== 'boolean' ||
				typeof entry.spoiler !== 'boolean' ||
				!Number.isSafeInteger(entry.size) ||
				entry.size < 1 ||
				entry.size > MAX_ATTACHMENT_BYTES ||
				(entry.name !== null &&
					(typeof entry.name !== 'string' ||
						!entry.name.length ||
						entry.name.length > 255 ||
						// biome-ignore lint/suspicious/noControlCharactersInRegex: Untrusted attachment names must reject ASCII control characters.
						/[\0-\x1f\\/]/u.test(entry.name)))
			)
				throw new Error('Attachment manifest entry is invalid')
			decode64(entry.digest, 32)
			total += entry.size
		}
		if (
			total > 500 * 1024 * 1024 ||
			utf8Bytes(JSON.stringify(compactManifest(bundle.manifest))).length >
				MAX_ATTACHMENT_MANIFEST_BYTES
		)
			throw new Error('Attachment manifest is too large')
	}
}

function compactManifest(manifest: AttachmentManifestEntry[]): unknown[] {
	return manifest.map(entry => [
		entry.digest,
		(entry.preview ? 1 : 0) | (entry.spoiler ? 2 : 0),
		entry.size,
		...(entry.name === null ? [] : [entry.name]),
	])
}

function compactBundle(bundle: AttachmentBundleDescriptor): unknown[] {
	return [
		bundle.id,
		bundle.key,
		bundle.count,
		bundle.root,
		...(bundle.manifest ? [compactManifest(bundle.manifest)] : []),
	]
}

function validateSticker(sticker: SecureStickerItem): void {
	requireSnowflake(sticker.id, 'sticker')
	if (
		!sticker.name ||
		sticker.name.length > 100 ||
		sticker.name.includes('\0') ||
		!Number.isInteger(sticker.formatType) ||
		sticker.formatType < 1 ||
		sticker.formatType > 4
	)
		throw new Error('Secure sticker is invalid')
}

function uint32(value: number): Uint8Array {
	const result = new Uint8Array(4)
	new DataView(result.buffer).setUint32(0, value)
	return result
}

function attachmentAad(
	channelId: string,
	senderUserId: string,
	bundleId: string,
	index: number,
	count: number,
): Uint8Array {
	requireSnowflake(channelId, 'attachment channel')
	requireSnowflake(senderUserId, 'attachment sender')
	decode64(bundleId, 16)
	if (!Number.isInteger(index) || index < 0 || index >= count)
		throw new Error('Attachment position is invalid')
	return utf8Bytes(
		JSON.stringify({
			v: 1,
			c: channelId,
			s: senderUserId,
			b: bundleId,
			i: index,
			n: count,
		}),
	)
}

function attachmentKeyAndNonce(
	masterKey: Uint8Array,
	bundleId: string,
	aad: Uint8Array,
): { key: Uint8Array; nonce: Uint8Array } {
	const material = hkdf(
		sha256,
		masterKey,
		decode64(bundleId, 16),
		concatBytes(KDF_PREFIX, aad),
		44,
	)
	return { key: material.slice(0, 32), nonce: material.slice(32) }
}

function canonicalMetadata(metadata: AttachmentMetadata, waveform = true) {
	validateAttachmentMetadata(metadata)
	return {
		v: 1,
		n: metadata.name,
		m: metadata.mimeType,
		s: metadata.size,
		p: metadata.spoiler,
		d: metadata.description,
		w: metadata.width,
		h: metadata.height,
		t: metadata.duration,
		...(waveform ? { q: metadata.waveform } : {}),
	}
}

export function encryptAttachmentBytes(input: {
	bundleId: string
	channelId: string
	count: number
	data: Uint8Array
	index: number
	masterKey: Uint8Array
	metadata: AttachmentMetadata
	senderUserId: string
}): Uint8Array {
	if (input.data.length !== input.metadata.size)
		throw new Error('Attachment byte length does not match metadata')
	const metadata = utf8Bytes(JSON.stringify(canonicalMetadata(input.metadata)))
	if (metadata.length > 8192)
		throw new Error('Attachment metadata is too large')
	const plaintext = concatBytes(uint32(metadata.length), metadata, input.data)
	const aad = attachmentAad(
		input.channelId,
		input.senderUserId,
		input.bundleId,
		input.index,
		input.count,
	)
	const { key, nonce } = attachmentKeyAndNonce(
		input.masterKey,
		input.bundleId,
		aad,
	)
	try {
		return gcm(key, nonce, aad).encrypt(plaintext)
	} finally {
		key.fill(0)
		plaintext.fill(0)
	}
}

export function decryptAttachmentBytes(input: {
	bundleId: string
	channelId: string
	ciphertext: Uint8Array
	count: number
	index: number
	masterKey: Uint8Array
	senderUserId: string
}): { data: Uint8Array; metadata: AttachmentMetadata } {
	if (
		input.ciphertext.length < 21 ||
		input.ciphertext.length > 500 * 1024 * 1024
	)
		throw new Error('Encrypted attachment size is invalid')
	const aad = attachmentAad(
		input.channelId,
		input.senderUserId,
		input.bundleId,
		input.index,
		input.count,
	)
	const { key, nonce } = attachmentKeyAndNonce(
		input.masterKey,
		input.bundleId,
		aad,
	)
	let plaintext: Uint8Array
	try {
		plaintext = gcm(key, nonce, aad).decrypt(input.ciphertext)
	} catch {
		throw new Error('Encrypted attachment authentication failed')
	} finally {
		key.fill(0)
	}
	try {
		if (plaintext.length < 5)
			throw new Error('Encrypted attachment is malformed')
		const metadataLength = new DataView(
			plaintext.buffer,
			plaintext.byteOffset,
			4,
		).getUint32(0)
		if (
			metadataLength < 1 ||
			metadataLength > 8192 ||
			4 + metadataLength >= plaintext.length
		)
			throw new Error('Encrypted attachment metadata is invalid')
		const metadataJson = decodeUtf8(plaintext.subarray(4, 4 + metadataLength))
		const value = JSON.parse(metadataJson)
		const legacy =
			isRecord(value) &&
			exactKeys(value, ['v', 'n', 'm', 's', 'p', 'd', 'w', 'h', 't'])
		const current =
			isRecord(value) &&
			exactKeys(value, ['v', 'n', 'm', 's', 'p', 'd', 'w', 'h', 't', 'q'])
		if ((!legacy && !current) || value.v !== 1)
			throw new Error('Encrypted attachment metadata is invalid')
		const metadata: AttachmentMetadata = {
			name: value.n,
			mimeType: value.m,
			size: value.s,
			spoiler: value.p,
			description: value.d,
			width: value.w,
			height: value.h,
			duration: value.t,
			waveform: current ? value.q : null,
		}
		validateAttachmentMetadata(metadata)
		if (JSON.stringify(canonicalMetadata(metadata, current)) !== metadataJson)
			throw new Error('Encrypted attachment metadata is not canonical')
		const data = plaintext.slice(4 + metadataLength)
		if (data.length !== metadata.size)
			throw new Error('Encrypted attachment content length is invalid')
		return { data, metadata }
	} finally {
		plaintext.fill(0)
	}
}

export function attachmentBundleRoot(
	bundleId: string,
	ciphertexts: Uint8Array[],
): string {
	return attachmentBundleRootFromDigests(
		bundleId,
		ciphertexts.map(attachmentCiphertextDigest),
	)
}

export function attachmentCiphertextDigest(ciphertext: Uint8Array): string {
	return encode64(sha256(ciphertext))
}

export function attachmentBundleRootFromDigests(
	bundleId: string,
	digests: readonly string[],
): string {
	decode64(bundleId, 16)
	if (digests.length < 1 || digests.length > MAX_ATTACHMENT_COUNT)
		throw new Error('Attachment count is invalid')
	return encode64(
		sha256(
			concatBytes(
				ROOT_PREFIX,
				decode64(bundleId, 16),
				uint32(digests.length),
				...digests.map(digest => decode64(digest, 32)),
			),
		),
	)
}

export function authenticateAttachmentBundle(
	bundle: AttachmentBundleDescriptor,
	ciphertexts: Uint8Array[],
): void {
	validateBundle(bundle)
	if (
		ciphertexts.length !== bundle.count ||
		attachmentBundleRoot(bundle.id, ciphertexts) !== bundle.root
	)
		throw new Error('Encrypted attachment bundle authentication failed')
	if (
		bundle.manifest &&
		bundle.manifest.some(
			(entry, index) =>
				entry.digest !== attachmentCiphertextDigest(ciphertexts[index]),
		)
	)
		throw new Error('Encrypted attachment manifest authentication failed')
}

const PREVIEW_MIMES = new Set([
	'audio/aac',
	'audio/flac',
	'audio/mp4',
	'audio/mpeg',
	'audio/ogg',
	'audio/opus',
	'audio/wav',
	'audio/webm',
	'image/avif',
	'image/gif',
	'image/jpeg',
	'image/png',
	'image/webp',
	'video/mp4',
	'video/ogg',
	'video/quicktime',
	'video/webm',
])

export function createAttachmentManifest(
	ciphertexts: Uint8Array[],
	metadata: AttachmentMetadata[],
): AttachmentManifestEntry[] {
	if (
		ciphertexts.length !== metadata.length ||
		!ciphertexts.length ||
		ciphertexts.length > MAX_ATTACHMENT_COUNT
	)
		throw new Error('Attachment manifest count is invalid')
	const manifest = ciphertexts.map((ciphertext, index) => {
		const item = metadata[index]
		validateAttachmentMetadata(item)
		return {
			digest: attachmentCiphertextDigest(ciphertext),
			preview: PREVIEW_MIMES.has(
				item.mimeType.split(';', 1)[0].trim().toLowerCase(),
			),
			spoiler: item.spoiler,
			size: item.size,
			name: item.name as string | null,
		}
	})
	for (
		let index = manifest.length - 1;
		utf8Bytes(JSON.stringify(compactManifest(manifest))).length >
		MAX_ATTACHMENT_MANIFEST_BYTES;
		index--
	) {
		if (index < 0) throw new Error('Attachment manifest is too large')
		manifest[index].name = null
	}
	return manifest
}

function parseBundle(
	value: unknown,
	manifest: boolean,
): AttachmentBundleDescriptor {
	if (
		!Array.isArray(value) ||
		value.length !== (manifest ? 5 : 4) ||
		typeof value[0] !== 'string' ||
		typeof value[1] !== 'string' ||
		typeof value[2] !== 'number' ||
		typeof value[3] !== 'string'
	)
		throw new Error('Secure attachment bundle is invalid')
	const bundle: AttachmentBundleDescriptor = {
		id: value[0],
		key: value[1],
		count: value[2],
		root: value[3],
	}
	if (manifest) {
		if (
			!Array.isArray(value[4]) ||
			value[4].length !== bundle.count ||
			value[4].length > MAX_ATTACHMENT_COUNT
		)
			throw new Error('Attachment manifest count is invalid')
		bundle.manifest = value[4].map(
			(entry: unknown): AttachmentManifestEntry => {
				if (
					!Array.isArray(entry) ||
					(entry.length !== 3 && entry.length !== 4) ||
					typeof entry[0] !== 'string' ||
					!Number.isInteger(entry[1]) ||
					entry[1] < 0 ||
					entry[1] > 3 ||
					typeof entry[2] !== 'number' ||
					(entry.length === 4 && typeof entry[3] !== 'string')
				)
					throw new Error('Attachment manifest entry is invalid')
				return {
					digest: entry[0],
					preview: (entry[1] & 1) !== 0,
					spoiler: (entry[1] & 2) !== 0,
					size: entry[2],
					name: entry.length === 4 ? entry[3] : null,
				}
			},
		)
	}
	validateBundle(bundle)
	return bundle
}

function validateStickers(stickers: SecureStickerItem[]): void {
	if (!Array.isArray(stickers) || stickers.length > 3)
		throw new Error('Secure sticker list is invalid')
	for (const sticker of stickers) validateSticker(sticker)
	if (new Set(stickers.map(sticker => sticker.id)).size !== stickers.length)
		throw new Error('Secure sticker list contains duplicates')
}

export function serializeSecurePlaintext(
	text: string,
	attachments: AttachmentBundleDescriptor | null = null,
	stickers: SecureStickerItem[] = [],
	detachedTextIndex: number | null = null,
): string {
	if (typeof text !== 'string' || text.length > 2_000)
		throw new Error('Secure message text is invalid')
	validateStickers(stickers)
	if (detachedTextIndex !== null) {
		if (
			text.length > 0 ||
			!attachments ||
			!Number.isInteger(detachedTextIndex) ||
			detachedTextIndex < 0 ||
			detachedTextIndex >= attachments.count
		)
			throw new Error('Detached secure message text is invalid')
		validateBundle(attachments)
		return `${attachments.manifest ? MANIFEST_DETACHED_TEXT_PAYLOAD_PREFIX : DETACHED_TEXT_PAYLOAD_PREFIX}${JSON.stringify(
			[
				compactBundle(attachments),
				detachedTextIndex,
				...(stickers.length > 0
					? [
							stickers.map(sticker => [
								sticker.id,
								sticker.name,
								sticker.formatType,
							]),
						]
					: []),
			],
		)}`
	}
	if (
		attachments === null &&
		stickers.length === 0 &&
		!text.startsWith(ATTACHMENT_PAYLOAD_PREFIX) &&
		!text.startsWith(RICH_CONTENT_PAYLOAD_PREFIX) &&
		!text.startsWith(DETACHED_TEXT_PAYLOAD_PREFIX) &&
		!text.startsWith(MANIFEST_ATTACHMENT_PAYLOAD_PREFIX) &&
		!text.startsWith(MANIFEST_RICH_CONTENT_PAYLOAD_PREFIX) &&
		!text.startsWith(MANIFEST_DETACHED_TEXT_PAYLOAD_PREFIX) &&
		!text.startsWith(LEGACY_ATTACHMENT_PAYLOAD_PREFIX) &&
		!text.startsWith(LEGACY_RICH_CONTENT_PAYLOAD_PREFIX)
	)
		return text
	if (attachments) validateBundle(attachments)
	const compactAttachment = attachments ? compactBundle(attachments) : null
	if (stickers.length > 0) {
		return `${attachments?.manifest ? MANIFEST_RICH_CONTENT_PAYLOAD_PREFIX : RICH_CONTENT_PAYLOAD_PREFIX}${JSON.stringify(
			[
				text,
				compactAttachment,
				stickers.map(sticker => [sticker.id, sticker.name, sticker.formatType]),
			],
		)}`
	}
	return `${attachments?.manifest ? MANIFEST_ATTACHMENT_PAYLOAD_PREFIX : ATTACHMENT_PAYLOAD_PREFIX}${JSON.stringify([text, compactAttachment])}`
}

export function parseSecurePlaintext(value: string): SecurePlaintext {
	if (typeof value !== 'string') throw new Error('Secure plaintext is invalid')
	const manifestDetached = value.startsWith(
		MANIFEST_DETACHED_TEXT_PAYLOAD_PREFIX,
	)
	if (manifestDetached || value.startsWith(DETACHED_TEXT_PAYLOAD_PREFIX)) {
		const prefix = manifestDetached
			? MANIFEST_DETACHED_TEXT_PAYLOAD_PREFIX
			: DETACHED_TEXT_PAYLOAD_PREFIX
		let parsed: unknown
		try {
			parsed = JSON.parse(value.slice(prefix.length))
		} catch {
			throw new Error('Detached secure content payload is malformed')
		}
		if (
			!Array.isArray(parsed) ||
			(parsed.length !== 2 && parsed.length !== 3) ||
			!Number.isInteger(parsed[1])
		)
			throw new Error('Detached secure content payload is invalid')
		const attachments = parseBundle(parsed[0], manifestDetached)
		const detachedTextIndex = parsed[1] as number
		if (detachedTextIndex < 0 || detachedTextIndex >= attachments.count)
			throw new Error('Detached secure message index is invalid')
		const stickers: SecureStickerItem[] = []
		if (parsed.length === 3) {
			if (!Array.isArray(parsed[2]) || parsed[2].length === 0)
				throw new Error('Secure sticker list is invalid')
			for (const sticker of parsed[2]) {
				if (
					!Array.isArray(sticker) ||
					sticker.length !== 3 ||
					typeof sticker[0] !== 'string' ||
					typeof sticker[1] !== 'string' ||
					typeof sticker[2] !== 'number'
				)
					throw new Error('Secure sticker item is invalid')
				stickers.push({
					id: sticker[0],
					name: sticker[1],
					formatType: sticker[2],
				})
			}
			validateStickers(stickers)
		}
		const canonical = [
			compactBundle(attachments),
			detachedTextIndex,
			...(stickers.length > 0
				? [
						stickers.map(sticker => [
							sticker.id,
							sticker.name,
							sticker.formatType,
						]),
					]
				: []),
		]
		if (JSON.stringify(canonical) !== value.slice(prefix.length))
			throw new Error('Detached secure content payload is not canonical')
		return { text: '', attachments, detachedTextIndex, stickers }
	}
	const manifestRich = value.startsWith(MANIFEST_RICH_CONTENT_PAYLOAD_PREFIX)
	const manifestAttachment = value.startsWith(
		MANIFEST_ATTACHMENT_PAYLOAD_PREFIX,
	)
	const compactRich =
		manifestRich || value.startsWith(RICH_CONTENT_PAYLOAD_PREFIX)
	const compactAttachment =
		manifestAttachment || value.startsWith(ATTACHMENT_PAYLOAD_PREFIX)
	if (compactRich || compactAttachment) {
		const prefix = manifestRich
			? MANIFEST_RICH_CONTENT_PAYLOAD_PREFIX
			: manifestAttachment
				? MANIFEST_ATTACHMENT_PAYLOAD_PREFIX
				: compactRich
					? RICH_CONTENT_PAYLOAD_PREFIX
					: ATTACHMENT_PAYLOAD_PREFIX
		let parsed: unknown
		try {
			parsed = JSON.parse(value.slice(prefix.length))
		} catch {
			throw new Error('Secure content payload is malformed')
		}
		if (
			!Array.isArray(parsed) ||
			parsed.length !== (compactRich ? 3 : 2) ||
			typeof parsed[0] !== 'string'
		)
			throw new Error('Secure content payload is invalid')
		let attachments: AttachmentBundleDescriptor | null = null
		if (parsed[1] !== null)
			attachments = parseBundle(parsed[1], manifestRich || manifestAttachment)
		else if (manifestRich || manifestAttachment)
			throw new Error('Secure attachment manifest is missing')
		const stickers: SecureStickerItem[] = []
		if (compactRich) {
			if (!Array.isArray(parsed[2]))
				throw new Error('Secure sticker list is invalid')
			for (const sticker of parsed[2]) {
				if (
					!Array.isArray(sticker) ||
					sticker.length !== 3 ||
					typeof sticker[0] !== 'string' ||
					typeof sticker[1] !== 'string' ||
					typeof sticker[2] !== 'number'
				)
					throw new Error('Secure sticker item is invalid')
				stickers.push({
					id: sticker[0],
					name: sticker[1],
					formatType: sticker[2],
				})
			}
			validateStickers(stickers)
			if (stickers.length === 0)
				throw new Error('Secure rich content requires a sticker')
		}
		const canonical = [
			parsed[0],
			attachments ? compactBundle(attachments) : null,
			...(compactRich
				? [
						stickers.map(sticker => [
							sticker.id,
							sticker.name,
							sticker.formatType,
						]),
					]
				: []),
		]
		if (JSON.stringify(canonical) !== value.slice(prefix.length))
			throw new Error('Secure content payload is not canonical')
		return { text: parsed[0], attachments, detachedTextIndex: null, stickers }
	}

	const rich = value.startsWith(LEGACY_RICH_CONTENT_PAYLOAD_PREFIX)
	if (!rich && !value.startsWith(LEGACY_ATTACHMENT_PAYLOAD_PREFIX))
		return {
			text: value,
			attachments: null,
			detachedTextIndex: null,
			stickers: [],
		}
	const prefix = rich
		? LEGACY_RICH_CONTENT_PAYLOAD_PREFIX
		: LEGACY_ATTACHMENT_PAYLOAD_PREFIX
	let parsed: unknown
	try {
		parsed = JSON.parse(value.slice(prefix.length))
	} catch {
		throw new Error('Secure content payload is malformed')
	}
	if (
		!isRecord(parsed) ||
		!exactKeys(parsed, rich ? ['v', 'm', 'a', 's'] : ['v', 'm', 'a']) ||
		parsed.v !== 1 ||
		typeof parsed.m !== 'string'
	)
		throw new Error('Secure content payload is invalid')
	let attachments: AttachmentBundleDescriptor | null = null
	if (parsed.a !== null) {
		if (
			!isRecord(parsed.a) ||
			!exactKeys(parsed.a, ['i', 'k', 'c', 'r']) ||
			typeof parsed.a.i !== 'string' ||
			typeof parsed.a.k !== 'string' ||
			typeof parsed.a.c !== 'number' ||
			typeof parsed.a.r !== 'string'
		)
			throw new Error('Secure attachment bundle is invalid')
		attachments = {
			id: parsed.a.i,
			key: parsed.a.k,
			count: parsed.a.c,
			root: parsed.a.r,
		}
		validateBundle(attachments)
	}
	const stickers: SecureStickerItem[] = []
	if (rich) {
		if (!Array.isArray(parsed.s))
			throw new Error('Secure sticker list is invalid')
		for (const sticker of parsed.s) {
			if (
				!isRecord(sticker) ||
				!exactKeys(sticker, ['i', 'n', 'f']) ||
				typeof sticker.i !== 'string' ||
				typeof sticker.n !== 'string' ||
				typeof sticker.f !== 'number'
			)
				throw new Error('Secure sticker item is invalid')
			stickers.push({ id: sticker.i, name: sticker.n, formatType: sticker.f })
		}
		validateStickers(stickers)
		if (stickers.length === 0)
			throw new Error('Secure rich content requires a sticker')
	}
	const canonical = {
		v: 1,
		m: parsed.m,
		a: attachments
			? {
					i: attachments.id,
					k: attachments.key,
					c: attachments.count,
					r: attachments.root,
				}
			: null,
		...(rich
			? {
					s: stickers.map(sticker => ({
						i: sticker.id,
						n: sticker.name,
						f: sticker.formatType,
					})),
				}
			: {}),
	}
	if (JSON.stringify(canonical) !== value.slice(prefix.length))
		throw new Error('Secure content payload is not canonical')
	return { text: parsed.m, attachments, detachedTextIndex: null, stickers }
}
