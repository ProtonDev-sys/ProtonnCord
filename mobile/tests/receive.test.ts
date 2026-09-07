import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
	encryptMessage,
	generateIdentity,
	publicIdentity,
	setRandomSource,
} from '../plugins/secure-messaging/js/crypto'
import { parseEnvelope } from '../plugins/secure-messaging/js/protocol'
import { acceptEnvelope } from '../plugins/secure-messaging/js/replay'
import { MessageReceiver } from '../plugins/secure-messaging/js/receive'
import type { Account } from '../plugins/secure-messaging/js/vaultState'

setRandomSource(size => Uint8Array.from(randomBytes(size)))
const ALICE = '100000000000000001',
	BOB = '100000000000000002',
	CHANNEL = '100000000000000003'
const identity = generateIdentity(),
	bob = generateIdentity()
function message(counter: number, id = '100000000000000004') {
	const content = encryptMessage({
		channelId: CHANNEL,
		identity,
		plaintext: 'private text',
		recipients: [publicIdentity(bob, BOB)],
		senderUserId: ALICE,
		counter,
	})
	return { content, id, channelId: CHANNEL, authorId: ALICE }
}
function state(): Account {
	return {
		identity: bob,
		counter: 0,
		trusted: { [ALICE]: publicIdentity(identity, ALICE) },
		pending: {},
		conversations: {},
	}
}

test('persistent replay state accepts history out of order and rejects copies, counter reuse and edit rollback', () => {
	const first = message(1),
		second = message(2, '100000000000000005'),
		edit = message(3)
	const accept = (
		records: Parameters<typeof acceptEnvelope>[0],
		item: ReturnType<typeof message>,
	) =>
		acceptEnvelope(
			records,
			parseEnvelope(item.content, CHANNEL, ALICE),
			item.content,
			item.id,
		)
	let records = accept([], second)
	records = accept(records, first)
	assert.equal(accept(records, first), records)
	assert.throws(
		() => accept(records, { ...first, id: '100000000000000006' }),
		/already used/,
	)
	assert.throws(
		() => accept(records, message(1, '100000000000000006')),
		/already used/,
	)
	records = accept(records, edit)
	assert.throws(() => accept(records, first), /stale/)
	assert.throws(
		() => accept(records, { ...first, id: '100000000000000006' }),
		/already used/,
	)
	const restored = JSON.parse(JSON.stringify(records))
	assert.throws(() => accept(restored, first), /stale/)
})

test('receiver exposes plaintext only after replay persistence and clears it on lock', async () => {
	let finish!: () => void
	let valid = true
	const saved = new Promise<void>(resolve => {
		finish = resolve
	})
	const receiver = new MessageReceiver(
		() => saved,
		() => valid,
	)
	const item = message(10),
		account = state()
	let refreshes = 0
	const render = () =>
		receiver.render(item, account, BOB, () => {
			refreshes++
		})
	assert.equal(render(), undefined)
	assert.equal(render(), undefined)
	finish()
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(render(), 'private text')
	assert.equal(refreshes, 1)
	receiver.clear()
	valid = false
	assert.equal(render(), undefined)
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(refreshes, 1)
})

test('storage failure prevents decrypted display', async () => {
	const receiver = new MessageReceiver(
		async () => {
			throw new Error('storage failed')
		},
		() => true,
	)
	const item = message(11),
		account = state()
	assert.equal(
		receiver.render(item, account, BOB, () => {}),
		undefined,
	)
	await new Promise(resolve => setImmediate(resolve))
	assert.throws(
		() => receiver.render(item, account, BOB, () => {}),
		/storage failed/,
	)
})
