/* SPDX-License-Identifier: GPL-3.0-or-later */

import { gcm } from '@noble/ciphers/aes.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fingerprint, validateIdentity } from './crypto'
import { decode64, decodeUtf8, requireSnowflake, utf8Bytes } from './protocol'
import type { PrivateIdentity, PublicIdentity } from './protocol'
import type { Conversation } from './vault'

const LEGACY_PREFIX = 'PCIB1:'
const PREFIX = 'PCIB2:'
const LEGACY_AAD = utf8Bytes('ProtonnCord/SecureMessaging/identity-backup/v1')
const AAD = utf8Bytes('ProtonnCord/SecureMessaging/identity-backup/v2')
const ITERATIONS = 210_000
const MAX_BACKUP_LENGTH = 1024 * 1024

export interface IdentityBackup {
	conversations: Record<string, Conversation>
	identity: PrivateIdentity
	trusted: Record<string, PublicIdentity>
	userId: string
	version: 1 | 2
}

export function parseIdentity(value: any): PrivateIdentity {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !==
			'createdAt,hpkePrivateKey,hpkePublicKey,signingPrivateKey,signingPublicKey' ||
		!Number.isSafeInteger(value.createdAt)
	)
		throw new Error('Identity backup is invalid')
	const identity = value as PrivateIdentity
	validateIdentity(identity)
	return identity
}

export function parsePublicIdentity(
	value: any,
	expectedUserId: string,
): PublicIdentity {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !==
			'fingerprint,hpkePublicKey,signingPublicKey,userId' ||
		value.userId !== expectedUserId
	)
		throw new Error('Identity backup is invalid')
	const identity = value as PublicIdentity
	decode64(identity.hpkePublicKey, 32)
	decode64(identity.signingPublicKey, 32)
	decode64(identity.fingerprint, 32)
	if (fingerprint(identity) !== identity.fingerprint)
		throw new Error('Identity backup is invalid')
	return identity
}

function orderedSnowflakes(
	value: unknown,
	ownUserId: string,
): value is string[] {
	if (!Array.isArray(value)) return false
	let previous = ''
	for (const item of value) {
		if (typeof item !== 'string' || item === ownUserId || item <= previous)
			return false
		try {
			requireSnowflake(item, 'backup member')
		} catch {
			return false
		}
		previous = item
	}
	return true
}

export function parseState(value: any, userId: string) {
	if (
		!value.trusted ||
		typeof value.trusted !== 'object' ||
		Array.isArray(value.trusted) ||
		!value.conversations ||
		typeof value.conversations !== 'object' ||
		Array.isArray(value.conversations) ||
		Object.keys(value.trusted).length > 2_000 ||
		Object.keys(value.conversations).length > 2_000
	)
		throw new Error('Identity backup is invalid')

	const trusted: Record<string, PublicIdentity> = {}
	for (const [peerId, rawIdentity] of Object.entries(value.trusted)) {
		requireSnowflake(peerId, 'backup peer')
		if (peerId === userId) throw new Error('Identity backup is invalid')
		trusted[peerId] = parsePublicIdentity(rawIdentity, peerId)
	}

	const conversations: Record<string, Conversation> = {}
	for (const [channelId, rawConversation] of Object.entries(
		value.conversations,
	)) {
		requireSnowflake(channelId, 'backup channel')
		if (
			!rawConversation ||
			typeof rawConversation !== 'object' ||
			Array.isArray(rawConversation) ||
			Object.keys(rawConversation).sort().join() !== 'members,recipients'
		)
			throw new Error('Identity backup is invalid')
		const conversation = rawConversation as Conversation
		if (
			!orderedSnowflakes(conversation.members, userId) ||
			conversation.members.length < 1 ||
			!orderedSnowflakes(conversation.recipients, userId) ||
			conversation.recipients.length < 1 ||
			conversation.recipients.some(
				peerId => !conversation.members.includes(peerId) || !trusted[peerId],
			)
		)
			throw new Error('Identity backup is invalid')
		conversations[channelId] = conversation
	}
	return { trusted, conversations }
}

export function openIdentityBackup(
	token: string,
	password: string,
): IdentityBackup {
	const legacy = token.startsWith(LEGACY_PREFIX)
	const prefix = legacy ? LEGACY_PREFIX : PREFIX
	if (
		(!legacy && !token.startsWith(PREFIX)) ||
		token.length > MAX_BACKUP_LENGTH ||
		password.length < 8 ||
		password.length > 256
	)
		throw new Error('Identity backup or password is invalid')
	const parts = token.slice(prefix.length).split('.')
	if (parts.length !== 3) throw new Error('Identity backup is invalid')
	const salt = decode64(parts[0], 16)
	const nonce = decode64(parts[1], 12)
	const ciphertext = decode64(parts[2])
	if (ciphertext.length < 17 || ciphertext.length > MAX_BACKUP_LENGTH)
		throw new Error('Identity backup is invalid')
	const key = pbkdf2(sha256, utf8Bytes(password), salt, {
		c: ITERATIONS,
		dkLen: 32,
	})
	let plaintext: Uint8Array | undefined
	try {
		plaintext = gcm(key, nonce, legacy ? LEGACY_AAD : AAD).decrypt(ciphertext)
		const value = JSON.parse(decodeUtf8(plaintext))
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Identity backup is invalid')
		const userId = requireSnowflake(value.userId, 'backup userId')
		if (legacy) {
			if (
				Object.keys(value).sort().join() !== 'identity,userId,version' ||
				value.version !== 1
			)
				throw new Error('Identity backup is invalid')
			return {
				version: 1,
				userId,
				identity: parseIdentity(value.identity),
				trusted: {},
				conversations: {},
			}
		}
		if (
			Object.keys(value).sort().join() !==
				'conversations,identity,trusted,userId,version' ||
			value.version !== 2
		)
			throw new Error('Identity backup is invalid')
		const state = parseState(value, userId)
		return {
			version: 2,
			userId,
			identity: parseIdentity(value.identity),
			...state,
		}
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === 'Identity backup is invalid'
		)
			throw error
		throw new Error('Identity backup or password is invalid')
	} finally {
		key.fill(0)
		plaintext?.fill(0)
	}
}
