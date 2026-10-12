/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

test('the release bundle starts without an account, handles local commands and removes its host hooks', async () => {
	const bundle = readFileSync(
		new URL('../plugins/secure-messaging/build/js/index.js', import.meta.url),
		'utf8',
	)
	const listeners = new Set(),
		cleanups = [],
		sent = []
	let currentUser,
		saved = null,
		cancellations = 0
	const userStore = {
		getCurrentUser: () => currentUser,
		addChangeListener: listener => listeners.add(listener),
		removeChangeListener: listener => listeners.delete(listener),
	}
	const send = (...args) => sent.push(args)
	const actions = { sendMessage: send, editMessage: () => {} }
	const renderer = { default: props => props }
	const jsx = (type, props) => ({ type, props })
	const forbidden = () => {
		throw new Error(
			'Unexpected network or attachment operation during bundle smoke test',
		)
	}
	function patch(target, name, callback, before = false) {
		const original = target[name]
		target[name] = function (...args) {
			return before
				? original.apply(this, callback(args) ?? args)
				: callback.call(this, args, original)
		}
		return () => {
			target[name] = original
		}
	}
	const revenge = {
		components: { Page: 'Page' },
		discord: {
			design: {
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
			flux: {
				Stores: {
					UserStore: userStore,
					ChannelStore: { getChannel: () => ({ type: 1, recipients: [] }) },
				},
				getStore: (name, callback) => {
					assert.equal(name, 'UserStore')
					callback(userStore)
					return () => {}
				},
			},
			native: {
				FileModule: { removeFile: async () => true, writeFile: forbidden },
			},
		},
		modules: {
			finders: {
				filters: { withName: () => 'renderer', withProps: () => 'actions' },
				getModules: (kind, callback) => {
					callback(kind === 'renderer' ? renderer : actions)
					return () => {}
				},
			},
			native: {
				callNativeMethod: async (method, args) => {
					switch (method) {
						case 'uk.co.protonn.secure-messaging.attachment.cleanup':
							return true
						case 'uk.co.protonn.secure-messaging.vault.load':
							return saved
						case 'uk.co.protonn.secure-messaging.vault.save':
							saved = args[0]
							return true
						default:
							throw new Error(`Unexpected bridge method: ${method}`)
					}
				},
				callNativeMethodSync: (method, args) => {
					if (method === 'uk.co.protonn.secure-messaging.random') {
						assert.ok(args[0] > 0 && args[0] <= 4096)
						return randomBytes(args[0]).toString('base64url')
					}
					assert.equal(method, 'uk.co.protonn.secure-messaging.onekey.cancel')
					cancellations++
					return true
				},
			},
		},
		patcher: {
			before: (target, name, callback) => patch(target, name, callback, true),
			instead: patch,
		},
		react: {
			React: { useEffect: () => {}, useState: value => [value, () => {}] },
			ReactJSXRuntime: { jsx, jsxs: jsx },
			ReactNative: { Alert: { alert: () => {} }, ScrollView: 'ScrollView' },
		},
	}
	const { default: plugin } = runInNewContext(bundle, {
		revenge,
		plugin: value => value,
		console,
		URL,
		Uint8Array,
		AbortController,
		fetch: forbidden,
		setTimeout,
		clearTimeout,
	})
	await plugin.start({ cleanup: (...items) => cleanups.push(...items) })
	assert.equal(saved, null, 'signed-out startup must not create an identity')
	assert.equal(listeners.size, 1)
	assert.notEqual(actions.sendMessage, send)
	assert.equal(plugin.SettingsComponent().type, 'Page')

	currentUser = { id: '100000000000000001' }
	for (const listener of listeners) listener()
	await actions.sendMessage('100000000000000003', { content: '/pc help' })
	assert.equal(sent.length, 0)
	await actions.sendMessage('100000000000000003', { content: '/pc announce' })
	assert.equal(sent.length, 1)
	assert.ok(sent[0][1].content.startsWith('PCEK1:'))
	const identity = JSON.parse(saved).accounts[currentUser.id].identity
	assert.ok(!sent[0][1].content.includes(identity.signingPrivateKey))
	assert.ok(!sent[0][1].content.includes(identity.hpkePrivateKey))

	const staleSend = actions.sendMessage
	for (const cleanup of cleanups) await cleanup()
	assert.equal(listeners.size, 0)
	assert.equal(actions.sendMessage, send)
	assert.equal(cancellations, 2)
	await staleSend('100000000000000003', { content: 'stale draft' })
	assert.equal(sent.length, 1, 'a stopped hook must not send its pending draft')
})
