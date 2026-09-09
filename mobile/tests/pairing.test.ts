import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { sealMobilePairing } from '../../src/equicordplugins/secureMessaging.desktop/mobilePairing'
import {
	encryptMessage,
	generateIdentity,
	publicIdentity,
	setRandomSource,
} from '../plugins/secure-messaging/js/crypto'
import { observeAnnouncement } from '../plugins/secure-messaging/js/history'
import { openMobilePairing } from '../plugins/secure-messaging/js/mobilePairing'
import {
	deriveOneKeyIdentity,
	deriveOneKeyRoot,
} from '../plugins/secure-messaging/js/oneKey'
import { MessageReceiver } from '../plugins/secure-messaging/js/receive'
import { MobileVault } from '../plugins/secure-messaging/js/vaultState'
import type { Account } from '../plugins/secure-messaging/js/vaultState'

setRandomSource(size => Uint8Array.from(randomBytes(size)))
const USER = '100000000000000001',
	PEER = '100000000000000002',
	CHANNEL = '100000000000000003'
const NOW = Date.now()
const secret = randomBytes(32),
	root = deriveOneKeyRoot(secret)
const identity = deriveOneKeyIdentity(root.key, USER),
	oldIdentity = generateIdentity(),
	peerIdentity = generateIdentity()
const payload = {
	version: 1,
	userId: USER,
	createdAt: NOW,
	currentFingerprint: publicIdentity(identity, USER).fingerprint,
	trusted: { [PEER]: publicIdentity(peerIdentity, PEER) },
	conversations: { [CHANNEL]: { members: [PEER], recipients: [PEER] } },
	identityHistory: [{ identity: oldIdentity, retiredAt: NOW - 1000 }],
	peerIdentityHistory: {},
}
const token = sealMobilePairing(root.key, root.fingerprint, USER, payload)
const messageIdAt = (time: number) =>
	((BigInt(time) - 1420070400000n) << 22n).toString()

test('desktop phone pairing opens only with the same OneKey/account and authenticates all state', () => {
	const result = openMobilePairing(token, root.key, root.fingerprint, USER)
	assert.deepEqual(result.trusted, payload.trusted)
	assert.deepEqual(result.identityHistory, payload.identityHistory)
	assert.ok(!token.includes(oldIdentity.hpkePrivateKey))
	assert.ok(!token.includes(peerIdentity.signingPublicKey))
	assert.throws(() =>
		openMobilePairing(token, randomBytes(32), root.fingerprint, USER),
	)
	assert.throws(
		() => openMobilePairing(token, root.key, root.fingerprint, PEER),
		/same OneKey/,
	)
	const parts = token.split('.')
	const bytes = Buffer.from(parts[3], 'base64url')
	bytes[0] ^= 1
	parts[3] = bytes.toString('base64url')
	assert.throws(() =>
		openMobilePairing(parts.join('.'), root.key, root.fingerprint, USER),
	)
	const invalid = sealMobilePairing(root.key, root.fingerprint, USER, {
		...payload,
		identityHistory: [
			{
				identity: {
					...oldIdentity,
					signingPublicKey: identity.signingPublicKey,
				},
				retiredAt: NOW,
			},
		],
	})
	assert.throws(() =>
		openMobilePairing(invalid, root.key, root.fingerprint, USER),
	)
})

test('phone pairing survives a locked restart, preserves the mobile counter and rejects rollback or failed saves', async () => {
	let saved: string | null = null,
		fail = false
	const backing = {
		read: async () => saved,
		write: async (value: string) => {
			if (fail) throw new Error('disk failure')
			saved = value
		},
	}
	const vault = new MobileVault(backing)
	await vault.load()
	await vault.useOneKey(secret, USER)
	const counter = vault.account(USER).counter
	await vault.importPairing(token, USER)
	assert.equal(vault.account(USER).counter, counter)
	assert.deepEqual(vault.account(USER).trusted, payload.trusted)
	assert.equal(vault.protectedChannel(USER, CHANNEL), true)
	const restarted = new MobileVault(backing)
	await restarted.load()
	assert.equal(restarted.locked, true)
	await restarted.useOneKey(secret, USER)
	assert.deepEqual(restarted.account(USER).trusted, payload.trusted)
	const older = sealMobilePairing(root.key, root.fingerprint, USER, {
		...payload,
		createdAt: NOW - 1,
	})
	await assert.rejects(() => restarted.importPairing(older, USER), /older/)
	const oldState = restarted.account(USER)
	fail = true
	await assert.rejects(
		() => restarted.importPairing(token, USER),
		/disk failure/,
	)
	assert.equal(restarted.ready, false)
	assert.throws(() => restarted.account(USER), /could not be saved/)
	assert.throws(
		() => restarted.protectedChannel(USER, CHANNEL),
		/could not be saved/,
	)
	fail = false
	await restarted.save()
	assert.equal(restarted.account(USER), oldState)
})

test('historical keys open old history but cannot authenticate new posts or later edits', async () => {
	const cutoff = NOW - 2000
	const oldSender = generateIdentity(),
		newSender = generateIdentity()
	const account: Account = {
		identity,
		counter: 0,
		conversations: {},
		pending: {},
		trusted: { [PEER]: publicIdentity(newSender, PEER) },
		peerIdentityHistory: {
			[PEER]: [
				{ identity: publicIdentity(oldSender, PEER), retiredAt: cutoff },
			],
		},
	}
	const content = encryptMessage({
		channelId: CHANNEL,
		identity: oldSender,
		plaintext: 'old history',
		recipients: [publicIdentity(identity, USER)],
		senderUserId: PEER,
		counter: 5,
		now: cutoff - 1000,
	})
	const oldMessage = {
		id: messageIdAt(cutoff - 500),
		channelId: CHANNEL,
		authorId: PEER,
		content,
	}
	const receiver = new MessageReceiver(
		async () => {},
		() => true,
	)
	assert.equal(
		receiver.render(oldMessage, account, USER, () => {}),
		undefined,
	)
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(
		receiver.render(oldMessage, account, USER, () => {}),
		'old history',
	)
	for (const item of [
		{ ...oldMessage, id: messageIdAt(NOW) },
		{ ...oldMessage, editedAt: NOW },
	]) {
		receiver.render(item, account, USER, () => {})
		await new Promise(resolve => setImmediate(resolve))
		assert.throws(
			() => receiver.render(item, account, USER, () => {}),
			/trusted/,
		)
	}
})

test('announcement order is based on Discord publication metadata and key changes latch send review', () => {
	const state: Account = {
		identity,
		counter: 0,
		trusted: { ...payload.trusted },
		pending: {},
		conversations: structuredClone(payload.conversations),
	}
	const replacement = publicIdentity(generateIdentity(), PEER)
	assert.equal(observeAnnouncement(state, replacement, messageIdAt(NOW)), true)
	assert.equal(state.conversations[CHANNEL].needsReview, true)
	assert.equal(
		observeAnnouncement(state, payload.trusted[PEER], messageIdAt(NOW - 1000)),
		false,
	)
	assert.equal(state.pending[PEER].fingerprint, replacement.fingerprint)
	assert.equal(state.peerIdentityHistory?.[PEER][0].retiredAt, NOW)
})

test('pairing keeps phone-only contacts and retired keys readable after a changed PC peer and restart', async () => {
	const phoneOnlyId = '100000000000000004'
	const phoneOnlyChannel = '100000000000000005'
	let saved: string | null = null
	const backing = {
		read: async () => saved,
		write: async (value: string) => {
			saved = value
		},
	}
	const vault = new MobileVault(backing)
	await vault.load()
	await vault.useOneKey(secret, USER)
	const previousPeer = generateIdentity()
	const previousPublic = publicIdentity(previousPeer, PEER)
	const phoneOnly = publicIdentity(generateIdentity(), phoneOnlyId)
	const before = vault.account(USER)
	before.trusted[PEER] = previousPublic
	before.trusted[phoneOnlyId] = phoneOnly
	before.conversations[CHANNEL] = { members: [PEER], recipients: [PEER] }
	before.conversations[phoneOnlyChannel] = {
		members: [phoneOnlyId],
		recipients: [phoneOnlyId],
	}
	await vault.save()
	const counter = before.counter
	const oldTime = Date.now() - 1000
	const oldMessage = {
		id: messageIdAt(oldTime),
		channelId: CHANNEL,
		authorId: PEER,
		content: encryptMessage({
			channelId: CHANNEL,
			identity: previousPeer,
			plaintext: 'phone history remains readable',
			recipients: [publicIdentity(before.identity, USER)],
			senderUserId: PEER,
			counter: 71,
			now: oldTime,
		}),
	}
	await vault.importPairing(token, USER)
	const paired = vault.account(USER)
	assert.deepEqual(paired.trusted[phoneOnlyId], phoneOnly)
	assert.deepEqual(paired.trusted[PEER], payload.trusted[PEER])
	assert.equal(paired.conversations[CHANNEL].needsReview, true)
	assert.equal(
		Boolean(paired.conversations[phoneOnlyChannel].needsReview),
		false,
	)
	assert.equal(paired.counter, counter)
	const retired = paired.peerIdentityHistory![PEER]!.find(
		item => item.identity.fingerprint === previousPublic.fingerprint,
	)
	assert.ok(retired && retired.retiredAt > oldTime)
	await vault.importPairing(token, USER)
	assert.equal(vault.account(USER).peerIdentityHistory![PEER]!.length, 1)
	assert.equal(
		vault.account(USER).peerIdentityHistory![PEER]![0]!.retiredAt,
		retired.retiredAt,
	)
	vault.lock()
	const restarted = new MobileVault(backing)
	await restarted.load()
	await restarted.useOneKey(secret, USER)
	const state = restarted.account(USER)
	assert.deepEqual(state.trusted[phoneOnlyId], phoneOnly)
	assert.equal(state.conversations[CHANNEL].needsReview, true)
	const receiver = new MessageReceiver(
		() => restarted.save(),
		account => restarted.ready && restarted.account(USER) === account,
	)
	assert.equal(
		receiver.render(oldMessage, state, USER, () => {}),
		undefined,
	)
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(
		receiver.render(oldMessage, state, USER, () => {}),
		'phone history remains readable',
	)
})
