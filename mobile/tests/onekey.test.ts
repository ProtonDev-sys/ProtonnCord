/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from 'node:assert/strict'
import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import test from 'node:test'
import {
	deriveOneKeyBindingPublicKey,
	deriveOneKeyPrivateIdentity,
	oneKeyDeterministicProfileInput,
} from '../../src/equicordplugins/secureMessaging.desktop/oneKeyVault'
import {
	decryptMessage as desktopDecrypt,
	encryptMessage as desktopEncrypt,
	publicIdentity as desktopPublic,
} from '../../src/equicordplugins/secureMessaging.desktop/crypto'
import {
	deriveOneKeyIdentity,
	deriveOneKeyRoot,
	oneKeyProfileInput,
} from '../plugins/secure-messaging/js/oneKey'
import {
	decryptMessage,
	encryptMessage,
	publicIdentity,
	setRandomSource,
} from '../plugins/secure-messaging/js/crypto'

setRandomSource(size => Uint8Array.from(randomBytes(size)))
const USER = '100000000000000001'
const CHANNEL = '100000000000000002'
const CREATED = 1_800_000_000_000

test('Classic 1S root, binding and account identity match desktop exactly', () => {
	const secret = randomBytes(32)
	const input = oneKeyDeterministicProfileInput()
	assert.equal(Buffer.from(oneKeyProfileInput()).toString('base64url'), input)
	const binding = deriveOneKeyBindingPublicKey(
		secret,
		Buffer.from(input, 'base64url'),
	)
	const fingerprint = createHash('sha256')
		.update('ProtonnCord/SecureMessaging/security-key-vault-root/v1\0')
		.update('localhost\0-8\0')
		.update(Buffer.from(binding, 'base64url'))
		.digest()
	const desktopRoot = Buffer.from(
		hkdfSync(
			'sha256',
			secret,
			fingerprint,
			'ProtonnCord/SecureMessaging/security-key-vault-onekey-key/v1',
			32,
		),
	)
	const mobileRoot = deriveOneKeyRoot(secret)
	assert.equal(mobileRoot.bindingPublicKey, binding)
	assert.equal(mobileRoot.fingerprint, fingerprint.toString('base64url'))
	assert.deepEqual(Buffer.from(mobileRoot.key), desktopRoot)
	for (const userId of [USER, '100000000000000003'])
		assert.deepEqual(
			deriveOneKeyIdentity(mobileRoot.key, userId, CREATED),
			deriveOneKeyPrivateIdentity(desktopRoot, userId, CREATED),
		)
	secret.fill(0)
	desktopRoot.fill(0)
	mobileRoot.key.fill(0)
})

test('the same OneKey account reads and sends its PC and mobile messages', async () => {
	const root = randomBytes(32)
	const pc = deriveOneKeyPrivateIdentity(root, USER, CREATED)
	const phone = deriveOneKeyIdentity(root, USER, CREATED + 1)
	assert.equal(
		publicIdentity(phone, USER).fingerprint,
		(await desktopPublic(pc, USER)).fingerprint,
	)
	const fromPc = await desktopEncrypt({
		channelId: CHANNEL,
		identity: pc,
		plaintext: 'PC to phone',
		recipients: [],
		senderUserId: USER,
		counter: 1,
		now: CREATED + 2,
	})
	assert.equal(
		decryptMessage({
			channelId: CHANNEL,
			content: fromPc,
			authorId: USER,
			identity: phone,
			localUserId: USER,
			sender: publicIdentity(phone, USER),
		}).plaintext,
		'PC to phone',
	)
	const fromPhone = encryptMessage({
		channelId: CHANNEL,
		identity: phone,
		plaintext: 'phone to PC',
		recipients: [],
		senderUserId: USER,
		counter: 2,
		now: CREATED + 3,
	})
	assert.equal(
		(
			await desktopDecrypt({
				channelId: CHANNEL,
				content: fromPhone,
				discordAuthorId: USER,
				identity: pc,
				localUserId: USER,
				senderIdentity: await desktopPublic(pc, USER),
			})
		).plaintext,
		'phone to PC',
	)
	root.fill(0)
})

test('OneKey derivation rejects missing material and separates accounts and devices', () => {
	assert.throws(() => deriveOneKeyRoot(new Uint8Array(32)))
	assert.throws(() => deriveOneKeyRoot(new Uint8Array(31)))
	const root = randomBytes(32)
	assert.throws(() => deriveOneKeyIdentity(root, 'invalid'))
	assert.notEqual(
		deriveOneKeyIdentity(root, USER).signingPublicKey,
		deriveOneKeyIdentity(root, CHANNEL).signingPublicKey,
	)
	assert.notEqual(
		deriveOneKeyIdentity(root, USER).signingPublicKey,
		deriveOneKeyIdentity(randomBytes(32), USER).signingPublicKey,
	)
})
