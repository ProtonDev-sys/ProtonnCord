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
import { MobileVault } from '../plugins/secure-messaging/js/vaultState'

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
	await vault.useOneKey(secret, USER)
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
		() => restarted.useOneKey(randomBytes(32), USER),
		/different OneKey/,
	)
	assert.equal(restarted.locked, true)
	await restarted.useOneKey(secret, USER)
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
	await vault.useOneKey(randomBytes(32), USER)
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
	await vault.useOneKey(secret, USER)
	const stored = JSON.parse(backing.raw!)
	stored.protectedChannels[USER] = [CHANNEL]
	backing.raw = JSON.stringify(stored)
	const restarted = new MobileVault(backing)
	await restarted.load()
	await assert.rejects(() => restarted.useOneKey(secret, USER))
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
