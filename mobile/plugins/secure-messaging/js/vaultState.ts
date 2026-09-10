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
import { parseIdentity, parsePublicIdentity } from './identityBackup'
import { openMobilePairing } from './mobilePairing'
import { deriveOneKeyIdentity, deriveOneKeyRoot } from './oneKey'
import {
	decode64,
	decodeUtf8,
	encode64,
	requireSnowflake,
	utf8Bytes,
} from './protocol'
import type { HistoricalIdentity } from './mobilePairing'
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
	identityHistory?: HistoricalIdentity<PrivateIdentity>[]
	peerIdentityHistory?: Record<string, HistoricalIdentity<PublicIdentity>[]>
	pairingImportedAt?: number
	announcementTimes?: Record<string, number>
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
	if (Object.keys(parsed.accounts).length > 16)
		throw new Error('Too many mobile vault accounts')
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
		parseIdentity(account.identity)
		for (const collection of [account.trusted, account.pending]) {
			if (Object.keys(collection).length > 2000)
				throw new Error('Too many mobile contacts')
			for (const [peerId, identity] of Object.entries(collection)) {
				requireSnowflake(peerId, 'vault contact')
				if (peerId === userId)
					throw new Error('A trusted contact cannot be the local account')
				parsePublicIdentity(identity, peerId)
			}
		}
		if (Object.keys(account.conversations).length > 2000)
			throw new Error('Too many protected conversations')
		for (const [channelId, conversation] of Object.entries(
			account.conversations,
		)) {
			requireSnowflake(channelId, 'vault channel')
			if (
				!record(conversation) ||
				!Array.isArray(conversation.members) ||
				!Array.isArray(conversation.recipients) ||
				conversation.members.length < 1 ||
				conversation.members.length > 24 ||
				conversation.recipients.length < 1 ||
				conversation.recipients.length > 24 ||
				(conversation.needsReview !== undefined &&
					typeof conversation.needsReview !== 'boolean')
			)
				throw new Error('Protected conversation is invalid')
			for (const ids of [conversation.members, conversation.recipients]) {
				let previous = ''
				for (const id of ids) {
					requireSnowflake(id, 'protected participant')
					if (id === userId || id <= previous)
						throw new Error('Protected participants are invalid')
					previous = id
				}
			}
			const members = conversation.members
			if (conversation.recipients.some(id => !members.includes(id)))
				throw new Error('Protected recipients are not channel members')
		}
		if (account.retiredIdentities !== undefined) {
			if (
				!Array.isArray(account.retiredIdentities) ||
				account.retiredIdentities.length > 4
			)
				throw new Error('Invalid local identity history')
			for (const identity of account.retiredIdentities) parseIdentity(identity)
		}
		if (account.replay !== undefined) {
			if (!Array.isArray(account.replay) || account.replay.length > 4096)
				throw new Error('Invalid replay state')
			for (const entry of account.replay) {
				if (
					!record(entry) ||
					!Number.isSafeInteger(entry.counter) ||
					Number(entry.counter) < 1 ||
					typeof entry.envelopeId !== 'string'
				)
					throw new Error('Invalid replay entry')
				for (const id of [entry.messageId, entry.channelId, entry.authorId])
					requireSnowflake(id, 'replay metadata')
				decode64(entry.fingerprint, 32)
				decode64(entry.digest, 32)
			}
		}
	}
	const vault = parsed as unknown as Vault
	for (const account of Object.values(vault.accounts)) {
		if (!account.identityHistory && account.retiredIdentities?.length)
			account.identityHistory = account.retiredIdentities
				.slice(-4)
				.map(identity => ({ identity, retiredAt: Date.now() }))
	}
	return vault
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
	private saveFailed = false
	private saveFailureVersion = 0
	private savedProtectedChannels: Record<string, string[]> = {}
	private readonly listeners = new Set<() => void>()
	constructor(private readonly storage: VaultStorage) {}
	get locked(): boolean {
		return this.envelope !== null && this.root === null
	}
	get configured(): boolean {
		return this.envelope !== null || this.root !== null
	}
	get ready(): boolean {
		return this.value !== null && !this.saveFailed
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
	private protectedChannels(): Record<string, string[]> {
		return Object.fromEntries(
			Object.entries(this.value?.accounts ?? {}).map(([id, value]) => [
				id,
				Object.keys(value.conversations).sort(),
			]),
		)
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
		this.savedProtectedChannels =
			this.envelope?.protectedChannels ?? this.protectedChannels()
		this.saveFailed = false
		this.notify()
	}

	account(userId: string): Account {
		requireSnowflake(userId, 'Discord account')
		if (this.saveFailed)
			throw new Error(
				'The vault could not be saved. Reload Secure Messaging before continuing',
			)
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
		if (this.saveFailed)
			throw new Error(
				'The vault could not be saved. Reload Secure Messaging before sending',
			)
		if (this.value)
			return (
				!!this.value.accounts[userId]?.conversations[channelId] ||
				!!this.savedProtectedChannels[userId]?.includes(channelId)
			)
		if (this.envelope)
			return (
				!!this.envelope.protectedChannels[userId]?.includes(channelId) ||
				!!this.savedProtectedChannels[userId]?.includes(channelId)
			)
		throw new Error('Secure Messaging vault is unavailable')
	}

	async save(): Promise<void> {
		const failureVersion = this.saveFailureVersion
		try {
			if (!this.value) throw new Error('Unlock Secure Messaging before saving')
			const protectedChannels = this.protectedChannels()
			let snapshot = JSON.stringify(this.value)
			if (this.root && this.rootFingerprint) {
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
			this.savedProtectedChannels = protectedChannels
		} catch (error) {
			// Callers may already have changed live conversation state. Never let a
			// rejected save make a durably protected channel fall through to plaintext.
			this.saveFailed = true
			this.saveFailureVersion++
			this.notify()
			throw error
		}
		// A save queued before a failure is not an explicit retry of that failure.
		if (failureVersion === this.saveFailureVersion) this.saveFailed = false
		this.notify()
		if (this.saveFailed)
			throw new Error(
				'An earlier vault save failed. Reload Secure Messaging before continuing',
			)
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
						].slice(-4)
						account.identityHistory = [
							...(account.identityHistory ?? []),
							{ identity: account.identity, retiredAt: Date.now() },
						].slice(-4)
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

	async importPairing(token: string, userId: string): Promise<void> {
		if (!this.root || !this.rootFingerprint)
			throw new Error('Unlock with your OneKey before importing phone pairing')
		const pairing = openMobilePairing(
			token,
			this.root,
			this.rootFingerprint,
			userId,
		)
		const current = this.account(userId)
		if (
			pairing.currentFingerprint !==
			publicIdentity(current.identity, userId).fingerprint
		)
			throw new Error(
				'The PC identity does not match the active OneKey identity',
			)
		if (pairing.createdAt < (current.pairingImportedAt ?? 0))
			throw new Error(
				'This phone pairing is older than the one already imported',
			)
		const next: Account = JSON.parse(JSON.stringify(current))
		const replacedPeers = new Map<string, PublicIdentity>()
		// Import is the local replacement event; older recorded cutoffs still win.
		const importedAt = Date.now()
		for (const [id, identity] of Object.entries(pairing.trusted)) {
			const previous = next.trusted[id]
			if (previous && previous.fingerprint !== identity.fingerprint)
				replacedPeers.set(id, previous)
			next.trusted[id] = identity
		}
		if (Object.keys(next.trusted).length > 2000)
			throw new Error('Phone pairing would exceed the verified contact limit')
		for (const [id, conversation] of Object.entries(pairing.conversations)) {
			next.conversations[id] = {
				...conversation,
				...(next.conversations[id]?.needsReview ? { needsReview: true } : {}),
			}
		}
		if (Object.keys(next.conversations).length > 2000)
			throw new Error(
				'Phone pairing would exceed the protected conversation limit',
			)
		for (const [id, candidate] of Object.entries(next.pending)) {
			if (next.trusted[id]?.fingerprint === candidate.fingerprint)
				delete next.pending[id]
		}
		for (const conversation of Object.values(next.conversations)) {
			if (
				conversation.recipients.some(
					id => !next.trusted[id] || next.pending[id] || replacedPeers.has(id),
				)
			)
				conversation.needsReview = true
		}
		const history = new Map<string, HistoricalIdentity<PrivateIdentity>>()
		for (const item of [
			...(next.identityHistory ?? []),
			...pairing.identityHistory,
		]) {
			const fingerprint = publicIdentity(item.identity, userId).fingerprint
			const previous = history.get(fingerprint)
			if (!previous || item.retiredAt < previous.retiredAt)
				history.set(fingerprint, item)
		}
		next.identityHistory = [...history.values()]
			.sort((left, right) => right.retiredAt - left.retiredAt)
			.slice(0, 4)
		const peerHistories = { ...next.peerIdentityHistory }
		const historyPeers = new Set([
			...Object.keys(pairing.peerIdentityHistory),
			...replacedPeers.keys(),
		])
		for (const id of historyPeers) {
			const displaced = replacedPeers.get(id)
			const merged = new Map<string, HistoricalIdentity<PublicIdentity>>()
			for (const item of [
				...(peerHistories[id] ?? []),
				...(pairing.peerIdentityHistory[id] ?? []),
				...(displaced ? [{ identity: displaced, retiredAt: importedAt }] : []),
			]) {
				const fingerprint = item.identity.fingerprint
				const previous = merged.get(fingerprint)
				if (!previous || item.retiredAt < previous.retiredAt)
					merged.set(fingerprint, item)
			}
			peerHistories[id] = [...merged.values()]
				.sort((left, right) => right.retiredAt - left.retiredAt)
				.slice(0, 4)
		}
		if (Object.keys(peerHistories).length > 2000)
			throw new Error('Phone pairing would exceed the contact history limit')
		next.peerIdentityHistory = peerHistories
		next.pairingImportedAt = pairing.createdAt
		const previousEnvelope = this.envelope
		this.value!.accounts[userId] = next
		try {
			await this.save()
		} catch (error) {
			if (this.value) this.value.accounts[userId] = current
			this.envelope = previousEnvelope
			throw error
		}
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
		) {
			value.retiredIdentities = [
				...(value.retiredIdentities ?? []),
				value.identity,
			].slice(-4)
			value.identityHistory = [
				...(value.identityHistory ?? []),
				{ identity: value.identity, retiredAt: Date.now() },
			].slice(-4)
		}
		value.identity = state.identity
		value.counter = Math.max(value.counter, mobileCounterStart())
		value.trusted = state.trusted
		value.pending = {}
		value.conversations = state.conversations
		await this.save()
	}
}
