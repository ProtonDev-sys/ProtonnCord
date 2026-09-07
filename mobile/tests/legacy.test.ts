import assert from 'node:assert/strict'
import {
	createCipheriv,
	createPrivateKey,
	randomBytes,
	randomUUID,
	sign,
} from 'node:crypto'
import test from 'node:test'
import {
	Aes128Gcm,
	CipherSuite,
	DhkemX25519HkdfSha256,
	HkdfSha256,
} from '@hpke/core'
import {
	canonicalEncryptedEnvelope,
	envelopeHeader,
	serializeEncryptedEnvelope,
} from '../../src/equicordplugins/secureMessaging.desktop/protocol'
import { decryptMessage as desktopDecrypt } from '../../src/equicordplugins/secureMessaging.desktop/crypto'
import {
	decryptMessage,
	encryptMessage,
	generateIdentity,
	publicIdentity,
	setRandomSource,
} from '../plugins/secure-messaging/js/crypto'
import {
	canonicalEnvelope,
	header,
	parseEnvelope,
} from '../plugins/secure-messaging/js/protocol'
import type { UnsignedEncryptedEnvelope } from '../../src/equicordplugins/secureMessaging.desktop/protocol'

setRandomSource(size => Uint8Array.from(randomBytes(size)))
const ALICE = '100000000000000001',
	BOB = '100000000000000002',
	CHANNEL = '100000000000000003'

test('legacy PCEM1 and PCEM2 ciphertext authenticate and decrypt identically on desktop and mobile', async () => {
	const aliceIdentity = generateIdentity(),
		bobIdentity = generateIdentity()
	const alice = publicIdentity(aliceIdentity, ALICE),
		bob = publicIdentity(bobIdentity, BOB)
	const suite = new CipherSuite({
		kem: new DhkemX25519HkdfSha256(),
		kdf: new HkdfSha256(),
		aead: new Aes128Gcm(),
	})
	for (const version of [1, 2] as const) {
		const envelope: UnsignedEncryptedEnvelope = {
			v: version,
			t: 'm',
			i: version === 1 ? randomUUID() : randomBytes(16).toString('base64url'),
			c: CHANNEL,
			s: ALICE,
			d: Date.now(),
			q: version,
			k: alice.fingerprint,
			r: [alice, bob].map(peer => ({ u: peer.userId, e: '', x: '' })),
			n: '',
			x: '',
		}
		const aad = Buffer.from(envelopeHeader(envelope)),
			key = randomBytes(32),
			nonce = randomBytes(12)
		for (const [index, peer] of [alice, bob].entries()) {
			const context = Buffer.concat([
				Buffer.from('ProtonnCord/SecureMessaging/v1/HPKE-wrap\0'),
				aad,
				Buffer.from(`\0${peer.userId}`),
			])
			const publicKey = await suite.kem.importKey(
				'raw',
				Uint8Array.from(Buffer.from(peer.hpkePublicKey, 'base64url')).buffer,
				true,
			)
			const sender = await suite.createSenderContext({
				recipientPublicKey: publicKey,
				info: Uint8Array.from(context).buffer,
			})
			envelope.r[index] = {
				u: peer.userId,
				e: Buffer.from(sender.enc).toString('base64url'),
				x: Buffer.from(
					await sender.seal(
						Uint8Array.from(key).buffer,
						Uint8Array.from(context).buffer,
					),
				).toString('base64url'),
			}
		}
		const cipher = createCipheriv('aes-256-gcm', key, nonce)
		cipher.setAAD(aad)
		envelope.n = nonce.toString('base64url')
		envelope.x = Buffer.concat([
			cipher.update('legacy history', 'utf8'),
			cipher.final(),
			cipher.getAuthTag(),
		]).toString('base64url')
		const signature = sign(
			null,
			canonicalEncryptedEnvelope(envelope),
			createPrivateKey({
				key: Buffer.from(aliceIdentity.signingPrivateKey, 'base64url'),
				type: 'pkcs8',
				format: 'der',
			}),
		).toString('base64url')
		const content = serializeEncryptedEnvelope({ ...envelope, z: signature })
		assert.deepEqual(Buffer.from(header(envelope)), aad)
		assert.deepEqual(
			Buffer.from(canonicalEnvelope(envelope)),
			Buffer.from(canonicalEncryptedEnvelope(envelope)),
		)
		assert.equal(
			decryptMessage({
				channelId: CHANNEL,
				authorId: ALICE,
				content,
				identity: bobIdentity,
				localUserId: BOB,
				sender: alice,
			}).plaintext,
			'legacy history',
		)
		assert.equal(
			(
				await desktopDecrypt({
					channelId: CHANNEL,
					discordAuthorId: ALICE,
					content,
					identity: bobIdentity,
					localUserId: BOB,
					senderIdentity: alice,
				})
			).plaintext,
			'legacy history',
		)
		assert.throws(() =>
			decryptMessage({
				channelId: '100000000000000004',
				authorId: ALICE,
				content,
				identity: bobIdentity,
				localUserId: BOB,
				sender: alice,
			}),
		)
		key.fill(0)
	}
})

test('mobile signs mention metadata only for encrypted participants', async () => {
	const identity = generateIdentity(),
		bob = publicIdentity(generateIdentity(), BOB)
	const content = encryptMessage({
		channelId: CHANNEL,
		identity,
		plaintext: `hello <@${BOB}> <@100000000000000004>`,
		recipients: [bob],
		senderUserId: ALICE,
		counter: 1,
	})
	assert.deepEqual(parseEnvelope(content, CHANNEL, ALICE).m, [BOB])
	assert.equal(
		(
			await desktopDecrypt({
				channelId: CHANNEL,
				discordAuthorId: ALICE,
				content,
				identity,
				localUserId: ALICE,
				senderIdentity: publicIdentity(identity, ALICE),
			})
		).plaintext,
		`hello <@${BOB}> <@100000000000000004>`,
	)
})
