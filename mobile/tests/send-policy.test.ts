import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
	generateIdentity,
	publicIdentity,
	setRandomSource,
} from '../plugins/secure-messaging/js/crypto'
import { captureSendPolicy } from '../plugins/secure-messaging/js/sendPolicy'
import type { Account } from '../plugins/secure-messaging/js/vaultState'

setRandomSource(size => Uint8Array.from(randomBytes(size)))
const PEER = '100000000000000002',
	CHANNEL = '100000000000000003'
function state(): Account {
	return {
		identity: generateIdentity(),
		counter: 0,
		pending: {},
		trusted: { [PEER]: publicIdentity(generateIdentity(), PEER) },
		conversations: { [CHANNEL]: { members: [PEER], recipients: [PEER] } },
	}
}

test('send preparation keeps its recipient snapshot and rejects membership or identity changes', () => {
	const account = state(),
		policy = captureSendPolicy(account, CHANNEL, [PEER])
	policy.assertCurrent(account, [PEER])
	assert.notEqual(policy.recipients[0], account.trusted[PEER])
	assert.throws(
		() => policy.assertCurrent(account, [PEER, '100000000000000004']),
		/membership changed/,
	)
	account.trusted[PEER] = publicIdentity(generateIdentity(), PEER)
	assert.throws(() => policy.assertCurrent(account, [PEER]), /key changed/)
})

test('a pending key review or disabled conversation cancels an already prepared send', () => {
	const account = state(),
		policy = captureSendPolicy(account, CHANNEL, [PEER])
	account.pending[PEER] = publicIdentity(generateIdentity(), PEER)
	assert.throws(() => policy.assertCurrent(account, [PEER]), /key changed/)
	assert.throws(() => captureSendPolicy(account, CHANNEL, [PEER]), /key review/)
	delete account.pending[PEER]
	delete account.conversations[CHANNEL]
	assert.throws(() => policy.assertCurrent(account, [PEER]), /settings changed/)
})
