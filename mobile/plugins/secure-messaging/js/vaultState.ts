/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { gcm } from '@noble/ciphers/aes.js'
import {
	generateIdentity,
	mobileCounterStart,
	publicIdentity,
	secureRandomBytes,
} from './crypto'
import { deriveOneKeyIdentity, deriveOneKeyRoot } from './oneKey'
import {
	decode64,
	decodeUtf8,
	encode64,
	requireSnowflake,
	utf8Bytes,
} from './protocol'
import type { PrivateIdentity, PublicIdentity } from './protocol'
import type { ReplayRecord } from './replay'

export interface Conversation {
	members: string[]
	recipients: string[]
	needsReview?: boolean
}

export interface Account {
	identity: PrivateIdentity
	retiredIdentities?: PrivateIdentity[]
	counter: number
	trusted: Record<string, PublicIdentity>
	pending: Record<string, PublicIdentity>
	conversations: Record<string, Conversation>
	replay?: ReplayRecord[]
}

interface Vault {
	version: 1
	accounts: Record<string, Account>
}
interface OneKeyEnvelope {
	version: 2
	protection: 'onekey'
	fingerprint: string
	protectedChannels: Record<string, string[]>
	nonce: string
	ciphertext: string
}

export interface VaultStorage {
	read(): Promise<string | null>
	write(value: string): Promise<void>
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readVault(raw: string): Vault {
	const parsed: unknown = JSON.parse(raw)
	if (!record(parsed) || parsed.version !== 1 || !record(parsed.accounts))
		throw new Error('Secure Messaging vault is invalid')
	for (const [userId, account] of Object.entries(parsed.accounts)) {
		requireSnowflake(userId, 'vault account')
		if (
			!record(account) ||
			!record(account.identity) ||
			!record(account.trusted) ||
			!record(account.pending) ||
			!record(account.conversations) ||
			!Number.isSafeInteger(account.counter) ||
			Number(account.counter) < 0
		)
			throw new Error('Secure Messaging account is invalid')
	}
	return parsed as unknown as Vault
}

function readEnvelope(parsed: Record<string, unknown>): OneKeyEnvelope {
	if (
		parsed.version !== 2 ||
		parsed.protection !== 'onekey' ||
		!record(parsed.protectedChannels)
	)
		throw new Error('Unsupported protected mobile vault')
	decode64(parsed.fingerprint, 32)
	decode64(parsed.nonce, 12)
	if (decode64(parsed.ciphertext).length < 17)
		throw new Error('Protected mobile vault is invalid')
	for (const [userId, channels] of Object.entries(parsed.protectedChannels)) {
		requireSnowflake(userId, 'protected account')
		if (!Array.isArray(channels))
			throw new Error('Protected conversation index is invalid')
		for (const channel of channels)
			requireSnowflake(channel, 'protected conversation')
	}
	return parsed as unknown as OneKeyEnvelope
}

function aad(
	envelope: Pick<OneKeyEnvelope, 'fingerprint' | 'protectedChannels'>,
): Uint8Array {
	return utf8Bytes(
		JSON.stringify([
			'ProtonnCord-Mobile/SecureMessaging/onekey-vault/v1',
			envelope.fingerprint,
			envelope.protectedChannels,
		]),
	)
}

export class MobileVault {
	private value: Vault | null = null
	private envelope: OneKeyEnvelope | null = null
	private root: Uint8Array | null = null
	private rootFingerprint: string | null = null
	private queue: Promise<void> = Promise.resolve()
	private readonly listeners = new Set<() => void>()
	constructor(private readonly storage: VaultStorage) {}
	get locked(): boolean {
		return this.envelope !== null && this.root === null
	}
	get configured(): boolean {
		return this.envelope !== null || this.root !== null
	}
	get ready(): boolean {
		return this.value !== null
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	async load(): Promise<void> {
		this.root?.fill(0)
		this.root = null
		this.rootFingerprint = null
		this.envelope = null
		this.value = null
		await this.queue.catch(() => {})
		const raw = await this.storage.read()
		if (raw === null) this.value = { version: 1, accounts: {} }
		else {
			const parsed: unknown = JSON.parse(raw)
			if (record(parsed) && parsed.version === 2) {
				this.envelope = readEnvelope(parsed)
				this.value = null
			} else this.value = readVault(raw)
		}
		this.notify()
	}

	account(userId: string): Account {
		requireSnowflake(userId, 'Discord account')
		if (!this.value)
			throw new Error(
				this.locked
					? 'Unlock Secure Messaging with your OneKey first'
					: 'Secure Messaging vault is unavailable',
			)
		let account = this.value.accounts[userId]
		if (!account) {
			account = {
				identity: this.root
					? deriveOneKeyIdentity(this.root, userId)
					: generateIdentity(),
				counter: mobileCounterStart(),
				trusted: {},
				pending: {},
				conversations: {},
			}
			this.value.accounts[userId] = account
		}
		return account
	}

	protectedChannel(userId: string, channelId: string): boolean {
		if (this.value)
			return !!this.value.accounts[userId]?.conversations[channelId]
		if (this.envelope)
			return !!this.envelope.protectedChannels[userId]?.includes(channelId)
		throw new Error('Secure Messaging vault is unavailable')
	}

	async save(): Promise<void> {
		if (!this.value) throw new Error('Unlock Secure Messaging before saving')
		let snapshot = JSON.stringify(this.value)
		if (this.root && this.rootFingerprint) {
			const protectedChannels = Object.fromEntries(
				Object.entries(this.value.accounts).map(([id, value]) => [
					id,
					Object.keys(value.conversations).sort(),
				]),
			)
			const nonce = secureRandomBytes(12)
			const envelope: OneKeyEnvelope = {
				version: 2,
				protection: 'onekey',
				fingerprint: this.rootFingerprint,
				protectedChannels,
				nonce: encode64(nonce),
				ciphertext: '',
			}
			const bytes = utf8Bytes(snapshot)
			try {
				envelope.ciphertext = encode64(
					gcm(this.root, nonce, aad(envelope)).encrypt(bytes),
				)
			} finally {
				bytes.fill(0)
			}
			this.envelope = envelope
			snapshot = JSON.stringify(envelope)
		}
		const write = this.queue
			.catch(() => {})
			.then(() => this.storage.write(snapshot))
		this.queue = write
		await write
		this.notify()
	}

	async useOneKey(secret: Uint8Array, userId: string): Promise<void> {
		const derived = deriveOneKeyRoot(secret)
		let installed = false
		try {
			if (this.envelope) {
				if (derived.fingerprint !== this.envelope.fingerprint)
					throw new Error(
						'This is a different OneKey from the one protecting this mobile vault',
					)
				const bytes = gcm(
					derived.key,
					decode64(this.envelope.nonce, 12),
					aad(this.envelope),
				).decrypt(decode64(this.envelope.ciphertext))
				try {
					this.value = readVault(decodeUtf8(bytes))
				} finally {
					bytes.fill(0)
				}
			} else {
				if (!this.value)
					throw new Error('The mobile vault must be loaded before OneKey setup')
				const migrated = readVault(JSON.stringify(this.value))
				if (!migrated.accounts[userId])
					migrated.accounts[userId] = {
						identity: deriveOneKeyIdentity(derived.key, userId),
						counter: mobileCounterStart(),
						trusted: {},
						pending: {},
						conversations: {},
					}
				for (const [id, account] of Object.entries(migrated.accounts)) {
					const identity = deriveOneKeyIdentity(
						derived.key,
						id,
						account.identity.createdAt,
					)
					if (
						publicIdentity(identity, id).fingerprint !==
						publicIdentity(account.identity, id).fingerprint
					) {
						account.retiredIdentities = [
							...(account.retiredIdentities ?? []),
							account.identity,
						]
						for (const conversation of Object.values(account.conversations))
							conversation.needsReview = true
					}
					account.identity = identity
					account.counter = Math.max(account.counter, mobileCounterStart())
				}
				this.value = migrated
			}
			this.root?.fill(0)
			this.root = derived.key
			this.rootFingerprint = derived.fingerprint
			installed = true
			await this.save()
		} catch (error) {
			if (installed) this.lock()
			throw error
		} finally {
			if (!installed) derived.key.fill(0)
		}
	}

	lock(): void {
		if (!this.configured) return
		this.root?.fill(0)
		this.root = null
		this.rootFingerprint = null
		this.value = null
		this.notify()
	}

	async replace(
		userId: string,
		state: Pick<Account, 'identity' | 'trusted' | 'conversations'>,
	): Promise<void> {
		const value = this.account(userId)
		if (
			this.root &&
			publicIdentity(state.identity, userId).fingerprint !==
				publicIdentity(deriveOneKeyIdentity(this.root, userId), userId)
					.fingerprint
		)
			throw new Error(
				'The backup identity does not match this OneKey. Use a backup from your current PC OneKey identity',
			)
		if (
			publicIdentity(value.identity, userId).fingerprint !==
			publicIdentity(state.identity, userId).fingerprint
		)
			value.retiredIdentities = [
				...(value.retiredIdentities ?? []),
				value.identity,
			]
		value.identity = state.identity
		value.counter = Math.max(value.counter, mobileCounterStart())
		value.trusted = state.trusted
		value.pending = {}
		value.conversations = state.conversations
		await this.save()
	}
}
