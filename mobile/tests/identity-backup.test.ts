import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { gcm } from '@noble/ciphers/aes.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
	generateIdentity,
	publicIdentity,
	setRandomSource,
} from '../plugins/secure-messaging/js/crypto'
import { openIdentityBackup } from '../plugins/secure-messaging/js/identityBackup'
import {
	decodeUtf8,
	encode64,
	utf8Bytes,
} from '../plugins/secure-messaging/js/protocol'

const USER_ID = '100000000000000001'
const PASSWORD = 'correct horse battery staple'
const SALT = Uint8Array.from({ length: 16 }, (_, index) => index)
const NONCE = Uint8Array.from({ length: 12 }, (_, index) => index + 16)
const PEER_ID = '100000000000000002'
const CHANNEL_ID = '100000000000000003'

setRandomSource(size => Uint8Array.from(randomBytes(size)))

test('Hermes-safe UTF-8 codec is strict and round-trips Unicode', () => {
	const value = 'mobile identity 🔐'
	assert.equal(decodeUtf8(utf8Bytes(value)), value)
	assert.throws(() => decodeUtf8(Uint8Array.of(0xc0, 0x80)))
	assert.throws(() => decodeUtf8(Uint8Array.of(0xed, 0xa0, 0x80)))
	assert.throws(() => utf8Bytes('\ud800'))
})

function seal(value: unknown, version: 1 | 2 = 1): string {
	const key = pbkdf2(sha256, utf8Bytes(PASSWORD), SALT, {
		c: 210_000,
		dkLen: 32,
	})
	try {
		const aad = utf8Bytes(
			`ProtonnCord/SecureMessaging/identity-backup/v${version}`,
		)
		return `PCIB${version}:${encode64(SALT)}.${encode64(NONCE)}.${encode64(
			gcm(key, NONCE, aad).encrypt(utf8Bytes(JSON.stringify(value))),
		)}`
	} finally {
		key.fill(0)
	}
}

test('password-protected desktop identity backup imports on mobile', () => {
	const identity = generateIdentity(1_800_000_000_000)
	const token = seal({ version: 1, userId: USER_ID, identity })
	assert.deepEqual(openIdentityBackup(token, PASSWORD), {
		version: 1,
		userId: USER_ID,
		identity,
		trusted: {},
		conversations: {},
	})
	assert.throws(() => openIdentityBackup(token, 'wrong password'))
})

test('desktop state backup imports trusted peers and protected conversations', () => {
	const identity = generateIdentity(1_800_000_000_000)
	const peer = publicIdentity(generateIdentity(1_800_000_000_001), PEER_ID)
	const token = seal(
		{
			version: 2,
			userId: USER_ID,
			identity,
			trusted: { [PEER_ID]: peer },
			conversations: {
				[CHANNEL_ID]: { members: [PEER_ID], recipients: [PEER_ID] },
			},
		},
		2,
	)
	assert.deepEqual(openIdentityBackup(token, PASSWORD), {
		version: 2,
		userId: USER_ID,
		identity,
		trusted: { [PEER_ID]: peer },
		conversations: {
			[CHANNEL_ID]: { members: [PEER_ID], recipients: [PEER_ID] },
		},
	})
})

test('identity backup rejects mismatched private and public keys', () => {
	const identity = generateIdentity(1_800_000_000_000)
	const other = generateIdentity(1_800_000_000_001)
	const token = seal({
		version: 1,
		userId: USER_ID,
		identity: { ...identity, hpkePublicKey: other.hpkePublicKey },
	})
	assert.throws(() => openIdentityBackup(token, PASSWORD))
})
