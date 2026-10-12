/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
	generateIdentity,
	publicIdentity,
	setRandomSource,
} from '../plugins/secure-messaging/js/crypto'
import { captureSendPolicy } from '../plugins/secure-messaging/js/sendPolicy'
import { MobileVault } from '../plugins/secure-messaging/js/vaultState'
import type { Account } from '../plugins/secure-messaging/js/vaultState'

setRandomSource(size => Uint8Array.from(randomBytes(size)))
const USER = '100000000000000001'
const PEER = '100000000000000002'
const CHANNEL = '100000000000000003'
const OTHER = '100000000000000004'

function storage() {
	let saved: string | null = null
	let fail = false
	return {
		read: async () => saved,
		write: async (value: string) => {
			if (fail) throw new Error('storage unavailable')
			saved = value
		},
		get raw() {
			return saved
		},
		set fail(value: boolean) {
			fail = value
		},
		set raw(value: string | null) {
			saved = value
		},
	}
}

test('locking clears an unprotected vault and invalidates a pending load', async () => {
	const backing = storage()
	const vault = new MobileVault(backing)
	await vault.load()
	vault.account(USER).conversations[CHANNEL] = {
		members: [PEER],
		recipients: [PEER],
	}
	await vault.save()
	vault.lock()
	assert.equal(vault.ready, false)
	assert.throws(() => vault.account(USER), /unavailable/)

	let finish!: (value: string | null) => void
	backing.read = () =>
		new Promise(resolve => {
			finish = resolve
		})
	const loading = vault.load()
	await new Promise(resolve => setImmediate(resolve))
	vault.lock()
	finish(backing.raw)
	await assert.rejects(loading, /locked or reloaded/)
	assert.equal(vault.ready, false)
	assert.throws(() => vault.account(USER), /unavailable/)
})

test('a delayed older load cannot replace the current vault', async () => {
	const reads: Array<(value: string | null) => void> = []
	const vault = new MobileVault({
		read: () =>
			new Promise(resolve => {
				reads.push(resolve)
			}),
		write: async () => {},
	})
	const first = vault.load()
	await new Promise(resolve => setImmediate(resolve))
	const second = vault.load()
	await new Promise(resolve => setImmediate(resolve))
	reads[1](null)
	await second
	const current = vault.account(USER)
	reads[0](null)
	await assert.rejects(first, /locked or reloaded/)
	assert.equal(vault.account(USER), current)
})

test('legacy and incomplete identity backups preserve protected chats through restart and failed saves', async () => {
	const backing = storage()
	const vault = new MobileVault(backing)
	await vault.load()
	const initial = vault.account(USER)
	const peer = publicIdentity(generateIdentity(), PEER)
	initial.trusted[PEER] = peer
	initial.conversations[CHANNEL] = { members: [PEER], recipients: [PEER] }
	await vault.save()
	await vault.replace(USER, {
		identity: initial.identity,
		trusted: initial.trusted,
		conversations: {},
	})
	assert.equal(vault.protectedChannel(USER, CHANNEL), true)
	assert.throws(
		() => captureSendPolicy(vault.account(USER), CHANNEL, [PEER]),
		/Review/,
	)
	const restarted = new MobileVault(backing)
	await restarted.load()
	assert.equal(restarted.protectedChannel(USER, CHANNEL), true)
	const replacement = publicIdentity(generateIdentity(), PEER)
	await restarted.replace(USER, {
		identity: restarted.account(USER).identity,
		trusted: { [PEER]: replacement },
		conversations: {},
	})
	assert.equal(
		restarted.account(USER).peerIdentityHistory?.[PEER][0].identity.fingerprint,
		peer.fingerprint,
	)
	assert.equal(restarted.account(USER).conversations[CHANNEL].needsReview, true)
	backing.fail = true
	await assert.rejects(
		restarted.replace(USER, {
			identity: restarted.account(USER).identity,
			trusted: {},
			conversations: {},
		}),
		/storage/,
	)
	assert.equal(restarted.ready, false)
	assert.throws(
		() => restarted.protectedChannel(USER, CHANNEL),
		/could not be saved/,
	)
})

test('historical identities and publication metadata are validated before a loaded vault is ready', async () => {
	const identity = generateIdentity()
	const valid: Account = {
		identity,
		counter: 1,
		trusted: {},
		pending: {},
		conversations: {},
		identityHistory: [{ identity, retiredAt: Date.now() }],
		peerIdentityHistory: {
			[PEER]: [
				{
					identity: publicIdentity(generateIdentity(), PEER),
					retiredAt: Date.now(),
				},
			],
		},
		announcementTimes: { [PEER]: Date.now() },
		trustedAnnouncementTimes: { [PEER]: Date.now() },
		pairingImportedAt: Date.now(),
	}
	for (const patch of [
		{ identityHistory: 'invalid' },
		{ identityHistory: [{ identity, retiredAt: 'invalid' }] },
		{ identityHistory: Array(5).fill({ identity, retiredAt: Date.now() }) },
		{ peerIdentityHistory: [] },
		{
			peerIdentityHistory: {
				[PEER]: [
					{ identity: publicIdentity(identity, USER), retiredAt: Date.now() },
				],
			},
		},
		{ announcementTimes: { [PEER]: 'future' } },
		{ trustedAnnouncementTimes: { [USER]: Date.now() } },
		{ pairingImportedAt: -1 },
	]) {
		const backing = storage()
		backing.raw = JSON.stringify({
			version: 1,
			accounts: { [USER]: { ...valid, ...patch } },
		})
		const vault = new MobileVault(backing)
		await assert.rejects(vault.load())
		assert.equal(vault.ready, false)
	}
	const backing = storage()
	backing.raw = JSON.stringify({ version: 1, accounts: { [USER]: valid } })
	const vault = new MobileVault(backing)
	await vault.load()
	assert.deepEqual(vault.account(USER), valid)
	await vault.unlockWithOneKey(randomBytes(32), USER)
	const restarted = new MobileVault(backing)
	await restarted.load()
	assert.equal(restarted.locked, true)
})

test('OneKey vault survives restart locked, retains history, and hides identity material from storage', async () => {
	const backing = storage()
	const vault = new MobileVault(backing)
	await vault.load()
	const previous = vault.account(USER).identity
	vault.account(USER).trusted[PEER] = publicIdentity(generateIdentity(), PEER)
	vault.account(USER).conversations[CHANNEL] = {
		members: [PEER],
		recipients: [PEER],
	}
	const secret = randomBytes(32)
	await vault.unlockWithOneKey(secret, USER)
	const identity = vault.account(USER).identity
	assert.notEqual(identity.signingPublicKey, previous.signingPublicKey)
	assert.deepEqual(vault.account(USER).retiredIdentities, [previous])
	assert.equal(vault.account(USER).conversations[CHANNEL].needsReview, true)
	assert.ok(backing.raw)
	assert.ok(!backing.raw.includes(identity.signingPrivateKey))
	assert.ok(!backing.raw.includes(previous.hpkePrivateKey))
	assert.ok(!backing.raw.includes('trusted'))
	const restarted = new MobileVault(backing)
	await restarted.load()
	assert.equal(restarted.locked, true)
	assert.equal(restarted.protectedChannel(USER, CHANNEL), true)
	assert.equal(restarted.protectedChannel(USER, OTHER), false)
	assert.throws(() => restarted.account(USER), /Unlock/)
	await assert.rejects(() => restarted.save(), /Unlock/)
	await assert.rejects(
		() => restarted.unlockWithOneKey(randomBytes(32), USER),
		/different OneKey/,
	)
	assert.equal(restarted.locked, true)
	await restarted.unlockWithOneKey(secret, USER)
	assert.deepEqual(restarted.account(USER).identity, identity)
	assert.deepEqual(restarted.account(USER).retiredIdentities, [previous])
	assert.equal(restarted.account(USER).trusted[PEER].userId, PEER)
	restarted.lock()
	assert.throws(() => restarted.account(USER), /Unlock/)
})

test('wrong backups cannot replace the OneKey identity and failed saves can be retried', async () => {
	const backing = storage()
	const vault = new MobileVault(backing)
	await vault.load()
	await vault.unlockWithOneKey(randomBytes(32), USER)
	const identity = vault.account(USER).identity
	await assert.rejects(
		() =>
			vault.replace(USER, {
				identity: generateIdentity(),
				trusted: {},
				conversations: {},
			}),
		/does not match/,
	)
	assert.deepEqual(vault.account(USER).identity, identity)
	backing.fail = true
	await assert.rejects(() => vault.save(), /storage unavailable/)
	backing.fail = false
	await assert.doesNotReject(() => vault.save())
})

test('tampered protected conversation indexes cannot be unlocked', async () => {
	const backing = storage()
	const vault = new MobileVault(backing)
	await vault.load()
	const secret = randomBytes(32)
	await vault.unlockWithOneKey(secret, USER)
	const stored = JSON.parse(backing.raw!)
	stored.protectedChannels[USER] = [CHANNEL]
	backing.raw = JSON.stringify(stored)
	const restarted = new MobileVault(backing)
	await restarted.load()
	await assert.rejects(() => restarted.unlockWithOneKey(secret, USER))
	assert.equal(restarted.locked, true)
	assert.throws(() => restarted.account(USER))
})

test('unreadable vault never pretends protected conversations are ordinary', async () => {
	const backing = storage()
	backing.raw = '{"version":99}'
	const vault = new MobileVault(backing)
	await assert.rejects(() => vault.load())
	assert.throws(() => vault.protectedChannel(USER, CHANNEL), /unavailable/)
	assert.throws(() => vault.account(USER), /unavailable/)
})

test('malformed protected conversations cannot load as ordinary unprotected channels', async () => {
	const identity = generateIdentity()
	const raw = JSON.stringify({
		version: 1,
		accounts: {
			[USER]: {
				identity,
				counter: 1,
				trusted: {},
				pending: {},
				conversations: { [CHANNEL]: null },
			},
		},
	})
	const vault = new MobileVault({
		read: async () => raw,
		write: async () => {},
	})
	await assert.rejects(() => vault.load(), /Protected conversation/)
	assert.throws(() => vault.protectedChannel(USER, CHANNEL), /unavailable/)
})
