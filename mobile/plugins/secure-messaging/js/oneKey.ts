/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { encode64, requireSnowflake, utf8Bytes } from './protocol'
import type { PrivateIdentity } from './protocol'

const PKCS8_PREFIX = Uint8Array.from([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
	0x22, 0x04, 0x20,
])
const SPKI_PREFIX = Uint8Array.from([
	0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

export function oneKeyProfileInput(): Uint8Array {
	return sha256(
		utf8Bytes('ProtonnCord/SecureMessaging/OneKey/CKV/profile-input/v1'),
	)
}

export function deriveOneKeyRoot(secret: Uint8Array): {
	key: Uint8Array
	fingerprint: string
	bindingPublicKey: string
} {
	if (secret.length !== 32 || secret.every(byte => byte === 0))
		throw new Error('OneKey returned an invalid secret')
	const bindingSeed = hkdf(
		sha256,
		secret,
		oneKeyProfileInput(),
		utf8Bytes('ProtonnCord/SecureMessaging/onekey-profile-binding/v1'),
		32,
	)
	try {
		const binding = concatBytes(SPKI_PREFIX, ed25519.getPublicKey(bindingSeed))
		const root = sha256(
			concatBytes(
				utf8Bytes(
					'ProtonnCord/SecureMessaging/security-key-vault-root/v1\0localhost\0-8\0',
				),
				binding,
			),
		)
		return {
			key: hkdf(
				sha256,
				secret,
				root,
				utf8Bytes(
					'ProtonnCord/SecureMessaging/security-key-vault-onekey-key/v1',
				),
				32,
			),
			fingerprint: encode64(root),
			bindingPublicKey: encode64(binding),
		}
	} finally {
		bindingSeed.fill(0)
	}
}

export function deriveOneKeyIdentity(
	root: Uint8Array,
	userId: string,
	createdAt = Date.now(),
): PrivateIdentity {
	if (root.length !== 32) throw new Error('OneKey root must be 32 bytes')
	requireSnowflake(userId, 'Discord account')
	if (
		!Number.isSafeInteger(createdAt) ||
		createdAt < 1_700_000_000_000 ||
		createdAt > 9_999_999_999_999
	)
		throw new Error('Identity creation time is invalid')
	const salt = utf8Bytes('ProtonnCord/SecureMessaging/OneKey/identity-root/v1')
	const signing = hkdf(
		sha256,
		root,
		salt,
		utf8Bytes(
			`ProtonnCord/SecureMessaging/OneKey/discord-user/ed25519/v1\0${userId}`,
		),
		32,
	)
	const hpke = hkdf(
		sha256,
		root,
		salt,
		utf8Bytes(
			`ProtonnCord/SecureMessaging/OneKey/discord-user/x25519/v1\0${userId}`,
		),
		32,
	)
	const signingDer = concatBytes(PKCS8_PREFIX, signing)
	try {
		return {
			createdAt,
			signingPrivateKey: encode64(signingDer),
			signingPublicKey: encode64(ed25519.getPublicKey(signing)),
			hpkePrivateKey: encode64(hpke),
			hpkePublicKey: encode64(x25519.getPublicKey(hpke)),
		}
	} finally {
		signing.fill(0)
		hpke.fill(0)
		signingDer.fill(0)
	}
}
