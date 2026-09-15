import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
	createKeyAnnouncement as desktopCreateAnnouncement,
	decryptMessage as desktopDecryptMessage,
	encryptMessage as desktopEncryptMessage,
	publicIdentity as desktopPublicIdentity,
	verifyKeyAnnouncement as desktopVerifyAnnouncement,
} from '../../src/equicordplugins/secureMessaging.desktop/crypto'
import {
	createAnnouncement,
	decryptMessage,
	encryptMessage,
	generateIdentity,
	publicIdentity,
	setRandomSource,
	verifyAnnouncement,
} from '../plugins/secure-messaging/js/crypto'

setRandomSource(size => Uint8Array.from(randomBytes(size)))

const ALICE = '100000000000000001'
const BOB = '100000000000000002'
const CHANNEL = '100000000000000003'
const NOW = 1_800_000_000_000

test('mobile and desktop key announcements are mutually compatible', async () => {
	const identity = generateIdentity(NOW)
	const mobile = createAnnouncement(identity, ALICE)
	assert.deepEqual(
		await desktopVerifyAnnouncement(mobile, ALICE),
		publicIdentity(identity, ALICE),
	)

	const desktop = await desktopCreateAnnouncement(identity, ALICE)
	assert.deepEqual(
		verifyAnnouncement(desktop, ALICE),
		await desktopPublicIdentity(identity, ALICE),
	)
})

test('mobile ciphertext decrypts on desktop and desktop ciphertext decrypts on mobile', async () => {
	const aliceIdentity = generateIdentity(NOW)
	const bobIdentity = generateIdentity(NOW + 1)
	const alice = publicIdentity(aliceIdentity, ALICE)
	const bob = publicIdentity(bobIdentity, BOB)

	const fromMobile = encryptMessage({
		channelId: CHANNEL,
		identity: aliceIdentity,
		plaintext: 'hello from Android 🔐',
		recipients: [bob],
		senderUserId: ALICE,
		counter: 1,
		now: NOW + 2,
		id: Uint8Array.from({ length: 16 }, (_, index) => index),
	})
	assert.equal(
		(
			await desktopDecryptMessage({
				channelId: CHANNEL,
				content: fromMobile,
				discordAuthorId: ALICE,
				identity: bobIdentity,
				localUserId: BOB,
				senderIdentity: alice,
			})
		).plaintext,
		'hello from Android 🔐',
	)

	const fromDesktop = await desktopEncryptMessage({
		channelId: CHANNEL,
		identity: aliceIdentity,
		plaintext: 'hello from desktop',
		recipients: [bob],
		senderUserId: ALICE,
		counter: 2,
		now: NOW + 3,
	})
	assert.equal(
		decryptMessage({
			channelId: CHANNEL,
			content: fromDesktop,
			authorId: ALICE,
			identity: bobIdentity,
			localUserId: BOB,
			sender: alice,
		}).plaintext,
		'hello from desktop',
	)
})

test('authenticated mobile decryption rejects modified ciphertext', () => {
	const aliceIdentity = generateIdentity(NOW)
	const bobIdentity = generateIdentity(NOW + 1)
	const alice = publicIdentity(aliceIdentity, ALICE)
	const bob = publicIdentity(bobIdentity, BOB)
	const encrypted = encryptMessage({
		channelId: CHANNEL,
		identity: aliceIdentity,
		plaintext: 'do not alter',
		recipients: [bob],
		senderUserId: ALICE,
		counter: 1,
		now: NOW + 2,
	})
	const changed = `${encrypted.slice(0, -2)}${encrypted.at(-2) === 'A' ? 'B' : 'A'}${encrypted.at(-1)}`
	assert.throws(() =>
		decryptMessage({
			channelId: CHANNEL,
			content: changed,
			authorId: ALICE,
			identity: bobIdentity,
			localUserId: BOB,
			sender: alice,
		}),
	)
})
