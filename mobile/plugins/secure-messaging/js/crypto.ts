/* Protonn Cord compatible primitives. SPDX-License-Identifier: GPL-3.0-or-later */

import { gcm } from '@noble/ciphers/aes.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import {
	canonicalAnnouncement,
	canonicalEnvelope,
	decode64,
	decodeUtf8,
	encode64,
	header,
	KEY_PREFIX,
	parseAnnouncement,
	parseEnvelope,
	requireSnowflake,
	serializeEnvelope,
	utf8Bytes,
} from './protocol'
import type {
	Envelope,
	PrivateIdentity,
	PublicIdentity,
	UnsignedEnvelope,
} from './protocol'

const HPKE_INFO = utf8Bytes('ProtonnCord/SecureMessaging/v1/HPKE-wrap\0')
const FINGERPRINT = utf8Bytes('ProtonnCord/SecureMessaging/v1/fingerprint\0')
const PKCS8_PREFIX = Uint8Array.from([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
	0x22, 0x04, 0x20,
])
const EMPTY = new Uint8Array()
const KEM_ID = Uint8Array.from([0x00, 0x20])
const SUITE_ID = concatBytes(
	utf8Bytes('HPKE'),
	KEM_ID,
	Uint8Array.from([0, 1, 0, 1]),
)
const KEM_SUITE_ID = concatBytes(utf8Bytes('KEM'), KEM_ID)
let randomSource: (size: number) => Uint8Array = () => {
	throw new Error('Secure random source is not initialized')
}

export function setRandomSource(source: (size: number) => Uint8Array): void {
	randomSource = source
}

export function secureRandomBytes(size: number): Uint8Array {
	return randomSource(size)
}

export function mobileCounterStart(): number {
	const bytes = randomSource(4)
	try {
		return (
			2 ** 52 +
			(bytes[0]! * 0x1000000 +
				bytes[1]! * 0x10000 +
				bytes[2]! * 0x100 +
				bytes[3]!)
		)
	} finally {
		bytes.fill(0)
	}
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false
	let difference = 0
	for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!
	return difference === 0
}

function i2osp(value: number, length: number): Uint8Array {
	const out = new Uint8Array(length)
	for (let i = length - 1; i >= 0; i--) {
		out[i] = value & 0xff
		value >>>= 8
	}
	return out
}

function labeledExtract(
	suite: Uint8Array,
	salt: Uint8Array,
	label: string,
	ikm: Uint8Array,
): Uint8Array {
	return extract(
		sha256,
		concatBytes(utf8Bytes('HPKE-v1'), suite, utf8Bytes(label), ikm),
		salt,
	)
}

function labeledExpand(
	suite: Uint8Array,
	prk: Uint8Array,
	label: string,
	info: Uint8Array,
	length: number,
): Uint8Array {
	return expand(
		sha256,
		prk,
		concatBytes(
			i2osp(length, 2),
			utf8Bytes('HPKE-v1'),
			suite,
			utf8Bytes(label),
			info,
		),
		length,
	)
}

function hpkeKeySchedule(sharedSecret: Uint8Array, info: Uint8Array) {
	const pskIdHash = labeledExtract(SUITE_ID, EMPTY, 'psk_id_hash', EMPTY)
	const infoHash = labeledExtract(SUITE_ID, EMPTY, 'info_hash', info)
	const context = concatBytes(Uint8Array.of(0), pskIdHash, infoHash)
	const secret = labeledExtract(SUITE_ID, sharedSecret, 'secret', EMPTY)
	return {
		key: labeledExpand(SUITE_ID, secret, 'key', context, 16),
		nonce: labeledExpand(SUITE_ID, secret, 'base_nonce', context, 12),
	}
}

function hpkeSharedSecret(
	privateKey: Uint8Array,
	publicKey: Uint8Array,
	enc: Uint8Array,
	recipientPublicKey: Uint8Array,
): Uint8Array {
	const dh = x25519.getSharedSecret(privateKey, publicKey)
	const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dh)
	return labeledExpand(
		KEM_SUITE_ID,
		eaePrk,
		'shared_secret',
		concatBytes(enc, recipientPublicKey),
		32,
	)
}

function hpkeSeal(
	recipientPublicKey: Uint8Array,
	plaintext: Uint8Array,
	info: Uint8Array,
	aad: Uint8Array,
): { enc: Uint8Array; ciphertext: Uint8Array } {
	const ephemeral = randomSource(32)
	const enc = x25519.getPublicKey(ephemeral)
	const shared = hpkeSharedSecret(
		ephemeral,
		recipientPublicKey,
		enc,
		recipientPublicKey,
	)
	const { key, nonce } = hpkeKeySchedule(shared, info)
	try {
		return { enc, ciphertext: gcm(key, nonce, aad).encrypt(plaintext) }
	} finally {
		ephemeral.fill(0)
		shared.fill(0)
		key.fill(0)
	}
}

function hpkeOpen(
	recipientPrivateKey: Uint8Array,
	recipientPublicKey: Uint8Array,
	enc: Uint8Array,
	ciphertext: Uint8Array,
	info: Uint8Array,
	aad: Uint8Array,
): Uint8Array {
	const shared = hpkeSharedSecret(
		recipientPrivateKey,
		enc,
		enc,
		recipientPublicKey,
	)
	const { key, nonce } = hpkeKeySchedule(shared, info)
	try {
		return gcm(key, nonce, aad).decrypt(ciphertext)
	} finally {
		shared.fill(0)
		key.fill(0)
	}
}

function signingSeed(identity: PrivateIdentity): Uint8Array {
	const encoded = decode64(identity.signingPrivateKey, 48)
	if (!equal(encoded.subarray(0, 16), PKCS8_PREFIX))
		throw new Error('Unsupported Ed25519 private-key encoding')
	return encoded.slice(16)
}

function sign(identity: PrivateIdentity, message: Uint8Array): Uint8Array {
	const seed = signingSeed(identity)
	try {
		return ed25519.sign(message, seed)
	} finally {
		seed.fill(0)
	}
}

export function generateIdentity(now = Date.now()): PrivateIdentity {
	const signingSecret = randomSource(32)
	const hpkeSecret = randomSource(32)
	try {
		return {
			createdAt: now,
			signingPrivateKey: encode64(concatBytes(PKCS8_PREFIX, signingSecret)),
			signingPublicKey: encode64(ed25519.getPublicKey(signingSecret)),
			hpkePrivateKey: encode64(hpkeSecret),
			hpkePublicKey: encode64(x25519.getPublicKey(hpkeSecret)),
		}
	} finally {
		signingSecret.fill(0)
		hpkeSecret.fill(0)
	}
}

export function validateIdentity(identity: PrivateIdentity): void {
	if (
		!Number.isSafeInteger(identity.createdAt) ||
		identity.createdAt < 1_700_000_000_000 ||
		identity.createdAt > 9_999_999_999_999
	)
		throw new Error('Identity creation time is invalid')
	const signingPrivate = signingSeed(identity)
	const hpkePrivate = decode64(identity.hpkePrivateKey, 32)
	try {
		if (
			!equal(
				ed25519.getPublicKey(signingPrivate),
				decode64(identity.signingPublicKey, 32),
			) ||
			!equal(
				x25519.getPublicKey(hpkePrivate),
				decode64(identity.hpkePublicKey, 32),
			)
		)
			throw new Error('Identity key pair does not match')
	} finally {
		signingPrivate.fill(0)
		hpkePrivate.fill(0)
	}
}

export function fingerprint(
	identity: Pick<
		PublicIdentity,
		'userId' | 'signingPublicKey' | 'hpkePublicKey'
	>,
): string {
	requireSnowflake(identity.userId, 'userId')
	return encode64(
		sha256(
			concatBytes(
				FINGERPRINT,
				utf8Bytes(`${identity.userId}\0`),
				decode64(identity.signingPublicKey, 32),
				decode64(identity.hpkePublicKey, 32),
			),
		),
	)
}

export function publicIdentity(
	identity: PrivateIdentity,
	userId: string,
): PublicIdentity {
	const value = {
		userId: requireSnowflake(userId, 'userId'),
		signingPublicKey: identity.signingPublicKey,
		hpkePublicKey: identity.hpkePublicKey,
		fingerprint: '',
	}
	value.fingerprint = fingerprint(value)
	return value
}

export function formatFingerprint(value: string): string {
	return Array.from(decode64(value, 32), byte =>
		byte.toString(16).padStart(2, '0').toUpperCase(),
	)
		.join('')
		.match(/.{1,4}/g)!
		.join(' ')
}

export function createAnnouncement(
	identity: PrivateIdentity,
	userId: string,
): string {
	const unsigned = {
		v: 1 as const,
		t: 'k' as const,
		u: requireSnowflake(userId, 'userId'),
		d: identity.createdAt,
		s: identity.signingPublicKey,
		e: identity.hpkePublicKey,
	}
	const z = encode64(sign(identity, canonicalAnnouncement(unsigned)))
	return `${KEY_PREFIX}${JSON.stringify({ ...unsigned, z })}`
}

export function verifyAnnouncement(
	content: string,
	authorId: string,
): PublicIdentity {
	const value = parseAnnouncement(content)
	if (value.u !== requireSnowflake(authorId, 'authorId'))
		throw new Error('Key announcement author mismatch')
	const { z, ...unsigned } = value
	if (
		!ed25519.verify(
			decode64(z, 64),
			canonicalAnnouncement(unsigned),
			decode64(value.s, 32),
		)
	)
		throw new Error('Invalid key announcement signature')
	const identity = {
		userId: value.u,
		signingPublicKey: value.s,
		hpkePublicKey: value.e,
		fingerprint: '',
	}
	identity.fingerprint = fingerprint(identity)
	return identity
}

function hpkeContext(messageHeader: Uint8Array, userId: string): Uint8Array {
	return concatBytes(HPKE_INFO, messageHeader, utf8Bytes(`\0${userId}`))
}

export function encryptMessage(input: {
	channelId: string
	identity: PrivateIdentity
	plaintext: string
	recipients: PublicIdentity[]
	senderUserId: string
	counter: number
	now?: number
	id?: Uint8Array
}): string {
	const sender = publicIdentity(input.identity, input.senderUserId)
	const recipientMap = new Map<string, PublicIdentity>([
		[sender.userId, sender],
	])
	for (const recipient of input.recipients) {
		if (fingerprint(recipient) !== recipient.fingerprint)
			throw new Error(`Invalid verified key for ${recipient.userId}`)
		recipientMap.set(recipient.userId, recipient)
	}
	const recipients = [...recipientMap.values()].sort((a, b) =>
		a.userId.localeCompare(b.userId),
	)
	const base = {
		v: 3 as const,
		t: 'm' as const,
		i: encode64(input.id ?? randomSource(16)),
		c: requireSnowflake(input.channelId, 'channelId'),
		s: sender.userId,
		d: input.now ?? Date.now(),
		q: input.counter,
		k: sender.fingerprint,
		r: recipients.map(recipient => ({ u: recipient.userId, e: '', x: '' })),
		m: [],
	}
	const messageHeader = header(base)
	const contentKey = randomSource(32)
	const nonce = randomSource(12)
	try {
		const wrapped = recipients.map(recipient => {
			const context = hpkeContext(messageHeader, recipient.userId)
			const sealed = hpkeSeal(
				decode64(recipient.hpkePublicKey, 32),
				contentKey,
				context,
				context,
			)
			return {
				u: recipient.userId,
				e: encode64(sealed.enc),
				x: encode64(sealed.ciphertext),
			}
		})
		const unsigned: UnsignedEnvelope = {
			...base,
			r: wrapped,
			n: encode64(nonce),
			x: encode64(
				gcm(contentKey, nonce, messageHeader).encrypt(
					utf8Bytes(input.plaintext),
				),
			),
		}
		const z = encode64(sign(input.identity, canonicalEnvelope(unsigned)))
		return serializeEnvelope({ ...unsigned, z })
	} finally {
		contentKey.fill(0)
	}
}

export function decryptMessage(input: {
	channelId: string
	content: string
	authorId: string
	identity: PrivateIdentity
	localUserId: string
	sender: PublicIdentity
}): { envelope: Envelope; plaintext: string } {
	const envelope = parseEnvelope(input.content, input.channelId, input.authorId)
	if (
		envelope.k !== input.sender.fingerprint ||
		input.sender.userId !== input.authorId
	)
		throw new Error('Encrypted message uses an unverified sender key')
	const { z, ...unsigned } = envelope
	if (
		!ed25519.verify(
			decode64(z, 64),
			canonicalEnvelope(unsigned),
			decode64(input.sender.signingPublicKey, 32),
		)
	)
		throw new Error('Invalid encrypted-message signature')
	const wrapped = envelope.r.find(item => item.u === input.localUserId)
	if (!wrapped) throw new Error('This device is not a recipient')
	const messageHeader = header(envelope)
	const context = hpkeContext(messageHeader, input.localUserId)
	const contentKey = hpkeOpen(
		decode64(input.identity.hpkePrivateKey, 32),
		decode64(input.identity.hpkePublicKey, 32),
		decode64(wrapped.e, 32),
		decode64(wrapped.x, 48),
		context,
		context,
	)
	try {
		const plaintext = gcm(
			contentKey,
			decode64(envelope.n, 12),
			messageHeader,
		).decrypt(decode64(envelope.x))
		try {
			return { envelope, plaintext: decodeUtf8(plaintext) }
		} finally {
			plaintext.fill(0)
		}
	} finally {
		contentKey.fill(0)
	}
}
