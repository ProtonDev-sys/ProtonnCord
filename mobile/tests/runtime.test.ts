/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as attachments from '../plugins/secure-messaging/js/attachments'
import * as crypto from '../plugins/secure-messaging/js/crypto'
import * as history from '../plugins/secure-messaging/js/history'
import * as identityBackup from '../plugins/secure-messaging/js/identityBackup'
import * as message from '../plugins/secure-messaging/js/message'
import * as protocol from '../plugins/secure-messaging/js/protocol'
import * as receive from '../plugins/secure-messaging/js/receive'
import * as sendPolicy from '../plugins/secure-messaging/js/sendPolicy'
import { MobileVault } from '../plugins/secure-messaging/js/vaultState'

const { JsxEmit, ModuleKind, ScriptTarget, transpileModule } = createRequire(
	new URL('../../package.json', import.meta.url),
)('typescript')
const code = transpileModule(
	readFileSync(
		new URL('../plugins/secure-messaging/js/index.tsx', import.meta.url),
		'utf8',
	),
	{
		compilerOptions: {
			jsx: JsxEmit.ReactJSX,
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
		},
	},
).outputText
const USER = '100000000000000001'
const PEER = '100000000000000002'
const CHANNEL = '100000000000000003'
const tick = () => new Promise(resolve => setImmediate(resolve))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture(
	options: {
		cleanup?: () => Promise<void>
		read?: () => Promise<string | null>
		write?: () => Promise<void>
		prepare?: (...args: any[]) => Promise<unknown>
		send?: (...args: any[]) => unknown
	} = {},
) {
	let userId: string | undefined = USER
	let cancellations = 0,
		clears = 0,
		reads = 0,
		writes = 0
	const cleanups: Array<() => unknown> = []
	const listeners = new Set<() => void>()
	const sent: any[][] = [],
		notices: string[][] = []
	const unlock = deferred<{ status: 'unlocked'; secret: string }>()
	const hookState: any[] = []
	let hookIndex = 0
	const vault = new MobileVault({
		read: async () => {
			reads++
			return options.read?.() ?? null
		},
		write: async () => {
			writes++
			await options.write?.()
		},
	})
	const account = (id: string) => vault.account(id)
	const store = {
		getCurrentUser: () => (userId ? { id: userId } : undefined),
		addChangeListener: (listener: () => void) => listeners.add(listener),
		removeChangeListener: (listener: () => void) => listeners.delete(listener),
	}
	const actions = {
		sendMessage(...args: any[]) {
			sent.push(args)
			return options.send?.(...args)
		},
		editMessage(...args: any[]) {
			sent.push(args)
		},
	}
	const modules: Record<string, unknown> = {
		'@revenge-mod/components/Page': { default: 'Page', __esModule: true },
		'@revenge-mod/discord/design': {
			Design: Object.fromEntries(
				[
					'Button',
					'Stack',
					'TableRow',
					'TableRowGroup',
					'Text',
					'TextInput',
				].map(name => [name, name]),
			),
		},
		'@revenge-mod/discord/flux': {
			Stores: {
				UserStore: store,
				ChannelStore: { getChannel: () => ({ type: 1, recipients: [PEER] }) },
			},
			getStore: (_: string, callback: (value: typeof store) => void) => {
				callback(store)
				return () => {}
			},
		},
		'@revenge-mod/modules/finders': {
			getModules: (kind: string, callback: (value: typeof actions) => void) => {
				if (kind === 'send') callback(actions)
				return () => {}
			},
		},
		'@revenge-mod/modules/finders/filters': {
			withName: () => 'render',
			withProps: () => 'send',
		},
		'@revenge-mod/modules/native': {
			callNativeMethod: () => unlock.promise,
			callNativeMethodSync: (method: string, args: number[]) => {
				if (method.endsWith('.random'))
					return randomBytes(args[0]).toString('base64url')
				assert.ok(method.endsWith('.onekey.cancel'))
				cancellations++
				return true
			},
		},
		'@revenge-mod/patcher': {
			instead: (
				target: any,
				key: string,
				callback: (
					args: any[],
					original: (...args: any[]) => unknown,
				) => unknown,
			) => {
				const original = target[key]
				target[key] = function (...args: any[]) {
					return callback.call(this, args, original)
				}
				return () => {
					target[key] = original
				}
			},
		},
		react: {
			useEffect: () => {},
			useState: (value: unknown) => {
				const index = hookIndex++
				if (!(index in hookState)) hookState[index] = value
				return [
					hookState[index],
					(next: any) => {
						hookState[index] =
							typeof next === 'function' ? next(hookState[index]) : next
					},
				]
			},
		},
		'react/jsx-runtime': {
			jsx: (type: string, props: unknown) => ({ type, props }),
			jsxs: (type: string, props: unknown) => ({ type, props }),
		},
		'react-native': {
			Alert: { alert: (...args: string[]) => notices.push(args) },
			ScrollView: 'ScrollView',
		},
		'./attachmentRuntime': {
			cleanupStoredAttachments: options.cleanup ?? (async () => {}),
			clearAttachmentCache: () => {
				clears++
			},
			setAttachmentPatcher: () => {},
			prepareEncryptedUploads: options.prepare,
		},
		'./attachments': attachments,
		'./crypto': crypto,
		'./history': history,
		'./identityBackup': identityBackup,
		'./message': message,
		'./protocol': protocol,
		'./receive': receive,
		'./sendPolicy': sendPolicy,
		'./updates': {},
		'./vault': {
			mobileVault: vault,
			account,
			loadVault: () => vault.load(),
			saveVault: () => vault.save(),
			ownPublicIdentity: (id: string) =>
				crypto.publicIdentity(account(id).identity, id),
			subscribe: () => () => {},
		},
	}
	const plugin = runInNewContext(`${code}\nexports.default`, {
		exports: {},
		plugin: (value: unknown) => value,
		require: (name: string) => {
			assert.ok(Object.hasOwn(modules, name), name)
			return modules[name]
		},
	})
	function settings() {
		hookIndex = 0
		return plugin.SettingsComponent()
	}
	function button(text: string, node = settings()): any {
		if (node?.type === 'Button' && node.props.text === text) return node.props
		for (const child of [node?.props?.children].flat()) {
			if (!child) continue
			const found = button(text, child)
			if (found) return found
		}
	}
	return {
		vault,
		actions,
		sent,
		notices,
		unlock,
		button,
		listeners,
		start: () =>
			plugin.start({
				cleanup: (...items: Array<() => unknown>) => cleanups.push(...items),
			}),
		stop: () => {
			for (const cleanup of cleanups.splice(0)) cleanup()
		},
		changeUser: (id?: string) => {
			userId = id
			for (const listener of listeners) listener()
		},
		get counters() {
			return { cancellations, clears, reads, writes }
		},
	}
}

test('stopping during startup prevents a late vault load and removes the account listener', async () => {
	const cleanup = deferred<void>()
	const runtime = fixture({ cleanup: () => cleanup.promise })
	const starting = runtime.start()
	assert.equal(runtime.listeners.size, 1)
	runtime.stop()
	cleanup.resolve()
	await starting
	assert.equal(runtime.listeners.size, 0)
	assert.deepEqual(runtime.counters, {
		cancellations: 1,
		clears: 1,
		reads: 0,
		writes: 0,
	})
	assert.equal(runtime.vault.ready, false)
	assert.deepEqual(runtime.notices, [])
})

test('stopping while storage is loading keeps the vault unavailable without stale notices', async () => {
	const read = deferred<string | null>()
	const runtime = fixture({ read: () => read.promise })
	const starting = runtime.start()
	await tick()
	runtime.stop()
	read.resolve(null)
	await starting
	assert.equal(runtime.vault.ready, false)
	assert.equal(runtime.counters.writes, 0)
	assert.deepEqual(runtime.notices, [])
})

test('account transitions clear private content, lock OneKey, and reject an old unlock even after switching back', async () => {
	const runtime = fixture()
	await runtime.start()
	await runtime.vault.unlockWithOneKey(randomBytes(32), USER)
	const opening = runtime.button('Unlock with OneKey').onPress()
	runtime.changeUser()
	assert.equal(runtime.vault.locked, true)
	runtime.changeUser(USER)
	runtime.unlock.resolve({
		status: 'unlocked',
		secret: randomBytes(32).toString('base64url'),
	})
	await opening
	assert.equal(runtime.counters.clears, 2)
	assert.equal(runtime.counters.cancellations, 2)
	assert.equal(runtime.vault.locked, true)
	assert.match(runtime.notices.at(-1)![1], /account changed/)
	runtime.stop()
})

test('an unlock from a stopped instance cannot configure a restarted plugin', async () => {
	const runtime = fixture()
	await runtime.start()
	const opening = runtime.button('Set up OneKey').onPress()
	runtime.stop()
	await runtime.start()
	runtime.unlock.resolve({
		status: 'unlocked',
		secret: randomBytes(32).toString('base64url'),
	})
	await opening
	assert.equal(runtime.vault.configured, false)
	assert.equal(runtime.counters.writes, 2)
	runtime.stop()
})

for (const control of ['Lock Secure Messaging', 'Cancel']) {
	test(`${control} rejects a pending OneKey approval`, async () => {
		const runtime = fixture()
		await runtime.start()
		const secret = randomBytes(32)
		await runtime.vault.unlockWithOneKey(secret, USER)
		const opening = runtime.button('Unlock with OneKey').onPress()
		runtime.button(control).onPress()
		assert.equal(runtime.vault.locked, true)
		runtime.unlock.resolve({
			status: 'unlocked',
			secret: secret.toString('base64url'),
		})
		await opening
		assert.equal(runtime.vault.locked, true)
		assert.equal(runtime.counters.cancellations, 1)
		assert.match(runtime.notices.at(-1)![1], /cancelled/)
		runtime.stop()
	})
}

test('cancelling initial OneKey setup leaves the software identity available', async () => {
	const runtime = fixture()
	await runtime.start()
	const identity = runtime.vault.account(USER).identity
	const opening = runtime.button('Set up OneKey').onPress()
	runtime.button('Cancel').onPress()
	runtime.unlock.resolve({
		status: 'unlocked',
		secret: randomBytes(32).toString('base64url'),
	})
	await opening
	assert.equal(runtime.vault.configured, false)
	assert.equal(runtime.vault.account(USER).identity, identity)
	assert.equal(runtime.counters.writes, 1)
	runtime.stop()
})

test('cancelling after native approval keeps the vault locked while its save finishes', async () => {
	const write = deferred<void>()
	let pending = false
	const runtime = fixture({
		write: () => (pending ? write.promise : Promise.resolve()),
	})
	await runtime.start()
	const opening = runtime.button('Set up OneKey').onPress()
	pending = true
	runtime.unlock.resolve({
		status: 'unlocked',
		secret: randomBytes(32).toString('base64url'),
	})
	await tick()
	assert.equal(runtime.vault.configured, true)
	assert.equal(runtime.vault.ready, true)
	runtime.button('Cancel').onPress()
	assert.equal(runtime.vault.locked, true)
	write.resolve()
	await opening
	assert.equal(runtime.vault.locked, true)
	assert.equal(runtime.vault.ready, false)
	assert.match(runtime.notices.at(-1)![1], /cancelled/)
	runtime.stop()
})

test('the host send hook encrypts protected text and keeps commands local', async () => {
	const runtime = fixture()
	await runtime.start()
	const peer = crypto.generateIdentity()
	const account = runtime.vault.account(USER)
	account.trusted[PEER] = crypto.publicIdentity(peer, PEER)
	account.conversations[CHANNEL] = { members: [PEER], recipients: [PEER] }
	await runtime.vault.save()
	await runtime.actions.sendMessage(CHANNEL, { content: '/pc help' })
	assert.equal(runtime.sent.length, 0)
	await runtime.actions.sendMessage(CHANNEL, { content: 'private mobile text' })
	assert.equal(runtime.sent.length, 1)
	const content = runtime.sent[0][1].content
	assert.ok(content.startsWith(protocol.MESSAGE_PREFIX))
	assert.equal(
		crypto.decryptMessage({
			content,
			channelId: CHANNEL,
			authorId: USER,
			identity: peer,
			localUserId: PEER,
			sender: crypto.publicIdentity(account.identity, USER),
		}).plaintext,
		'private mobile text',
	)
	runtime.stop()
})

test('an account round trip during attachment preparation blocks the original host send', async () => {
	const prepared = deferred<{ plaintext: string; apply(): void }>()
	const runtime = fixture({ prepare: () => prepared.promise })
	await runtime.start()
	const account = runtime.vault.account(USER)
	account.trusted[PEER] = crypto.publicIdentity(crypto.generateIdentity(), PEER)
	account.conversations[CHANNEL] = { members: [PEER], recipients: [PEER] }
	await runtime.vault.save()
	const sending = runtime.actions.sendMessage(
		CHANNEL,
		{ content: 'private' },
		{},
		{ attachmentsToUpload: [{}] },
	)
	await tick()
	runtime.changeUser()
	runtime.changeUser(USER)
	let applied = false
	prepared.resolve({
		plaintext: 'private attachment',
		apply: () => {
			applied = true
		},
	})
	await sending
	assert.equal(applied, false)
	assert.equal(runtime.sent.length, 0)
	assert.match(runtime.notices.at(-1)![1], /account changed/)
	runtime.stop()
})

test('protected sends freeze the upload list and retire retry state only after host success', async () => {
	const preparing = deferred<{
		plaintext: string
		apply(): void
		complete(): void
	}>()
	const sending = deferred<string>()
	const value = { id: 'encrypted source' }
	let completed = 0
	const runtime = fixture({
		prepare: () => preparing.promise,
		send: () => sending.promise,
	})
	await runtime.start()
	const state = runtime.vault.account(USER)
	state.trusted[PEER] = crypto.publicIdentity(crypto.generateIdentity(), PEER)
	state.conversations[CHANNEL] = { members: [PEER], recipients: [PEER] }
	await runtime.vault.save()
	const options = { attachmentsToUpload: [value] }
	const pending = runtime.actions.sendMessage(
		CHANNEL,
		{ content: 'private' },
		{},
		options,
	)
	await tick()
	options.attachmentsToUpload.push({ id: 'later plaintext source' })
	preparing.resolve({
		plaintext: 'encrypted descriptor',
		apply() {},
		complete() {
			completed++
		},
	})
	await tick()
	assert.equal(runtime.sent.length, 1)
	assert.deepEqual(Array.from(runtime.sent[0][3].attachmentsToUpload), [value])
	assert.notEqual(runtime.sent[0][3], options)
	assert.equal(completed, 0)
	sending.resolve('sent')
	assert.equal(await pending, 'sent')
	assert.equal(completed, 1)
	runtime.stop()
})

test('a rejected host send preserves retry state and its original rejection', async () => {
	let failed = true
	let completed = 0
	const runtime = fixture({
		prepare: async () => ({
			plaintext: 'encrypted descriptor',
			apply() {},
			complete() {
				completed++
			},
		}),
		send: () =>
			failed
				? Promise.reject(new Error('network unavailable'))
				: Promise.resolve('sent'),
	})
	await runtime.start()
	const state = runtime.vault.account(USER)
	state.trusted[PEER] = crypto.publicIdentity(crypto.generateIdentity(), PEER)
	state.conversations[CHANNEL] = { members: [PEER], recipients: [PEER] }
	await runtime.vault.save()
	const options = { attachmentsToUpload: [{}] }
	await assert.rejects(
		runtime.actions.sendMessage(CHANNEL, { content: 'private' }, {}, options),
		/network unavailable/,
	)
	assert.equal(completed, 0)
	failed = false
	assert.equal(
		await runtime.actions.sendMessage(
			CHANNEL,
			{ content: 'private' },
			{},
			options,
		),
		'sent',
	)
	assert.equal(completed, 1)
	runtime.stop()
})
