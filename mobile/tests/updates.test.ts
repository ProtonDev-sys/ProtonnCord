/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const { ModuleKind, ScriptTarget, transpileModule } = createRequire(
	new URL('../../package.json', import.meta.url),
)('typescript')
const code = transpileModule(
	readFileSync(
		new URL('../plugins/secure-messaging/js/updates.ts', import.meta.url),
		'utf8',
	),
	{
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	},
).outputText
const ID = 'uk.co.protonn.secure-messaging'
const REPO =
	'https://github.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-nightly'
const CONFIGURE = `${ID}.loader.configure`
const RUNTIME = `${ID}.loader.runtimeUrl`
interface Repo {
	url: string
	enabled: boolean
	internal: boolean
	name?: string
}

function fixture(
	options: {
		pin?: string
		fetch?: () => Promise<{ ok: boolean }>
		repos?: Repo[]
		configured?: Repo[]
		actions?: Array<{ id: string; repo: string }>
		failMethod?: string
		pending?: string[]
	} = {},
) {
	const calls: Array<{ method: string; args: any[] }> = []
	const requests: Array<{ url: string; method: string; signal: AbortSignal }> =
		[]
	const timers = new Map<number, { callback: () => void; ms: number }>()
	const repos = options.repos ?? [{ url: REPO, enabled: true, internal: false }]
	let timerId = 0,
		lists = 0
	const modules = {
		'@revenge-mod/modules/native': {
			callNativeMethod: async (method: string, args: any[]) => {
				calls.push({ method, args: structuredClone(args) })
				if (method === options.failMethod) throw new Error(`Failed ${method}`)
				switch (method) {
					case RUNTIME:
						return `https://github.com/ProtonDev-sys/ProtonnCord/releases/download/${options.pin ?? 'mobile-runtime-fixture'}/revenge.bundle`
					case 'revenge.plugins.repos.list':
						return lists++ === 0 ? repos : (options.configured ?? repos)
					case 'revenge.plugins.repos.set':
					case 'revenge.plugins.repos.refresh':
						return null
					case 'revenge.plugins.planInstall':
						return {
							actions: options.actions ?? [{ id: ID, repo: REPO }],
							warnings: [],
						}
					case 'revenge.plugins.install':
						return {
							installed: [],
							pending: options.pending ?? [ID],
							skipped: [],
						}
					case CONFIGURE:
						return true
					default:
						throw new Error(`Unexpected native method ${method}`)
				}
			},
		},
	}
	const update = runInNewContext(`${code}\nexports.installNightlyUpdates`, {
		exports: {},
		require: (name: keyof typeof modules) => {
			assert.ok(Object.hasOwn(modules, name), name)
			return modules[name]
		},
		AbortController,
		fetch: (url: string, request: { method: string; signal: AbortSignal }) => {
			requests.push({ url, ...request })
			return options.fetch?.() ?? Promise.resolve({ ok: true })
		},
		setTimeout: (callback: () => void, ms: number) => {
			timers.set(++timerId, { callback, ms })
			return timerId
		},
		clearTimeout: (id: number) => timers.delete(id),
	}) as () => Promise<boolean>
	return { update, calls, requests, timers }
}

test('nightly update checks the compiled native runtime pin before configuring it', async () => {
	const current = fixture({ pin: 'mobile-runtime-another-pin' })
	assert.equal(await current.update(), true)
	assert.equal(current.requests.length, 1)
	assert.equal(current.requests[0].method, 'HEAD')
	assert.equal(
		current.requests[0].url,
		'https://github.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-runtime-another-pin/revenge.bundle',
	)
	assert.equal(current.requests[0].signal.aborted, false)
	assert.equal(current.timers.size, 0)
	assert.deepEqual(
		current.calls.find(call => call.method === 'revenge.plugins.planInstall')
			?.args,
		[ID, null, 'nightly', [REPO]],
	)
	const install = current.calls.findIndex(
		call => call.method === 'revenge.plugins.install',
	)
	const configure = current.calls.findIndex(call => call.method === CONFIGURE)
	assert.ok(install >= 0 && configure > install)
	assert.deepEqual(current.calls[configure].args, [current.requests[0].url])
})

test('unavailable or failed runtime checks leave plugin and loader untouched', async () => {
	for (const fetch of [
		async () => ({ ok: false }),
		async () => {
			throw new Error('Network offline')
		},
	]) {
		const current = fixture({ fetch })
		await assert.rejects(current.update(), /unavailable|Network offline/)
		assert.deepEqual(current.calls, [{ method: RUNTIME, args: [] }])
		assert.equal(current.timers.size, 0)
	}
})

test('a runtime request that ignores abort still times out before any native changes', async () => {
	let finish!: (value: { ok: boolean }) => void
	const current = fixture({
		fetch: () =>
			new Promise(resolve => {
				finish = resolve
			}),
	})
	const update = current.update()
	const rejected = assert.rejects(update, /timed out/)
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(current.timers.size, 1)
	const timer = [...current.timers.values()][0]
	assert.equal(timer.ms, 10_000)
	timer.callback()
	await rejected
	assert.equal(current.requests[0].signal.aborted, true)
	assert.equal(current.timers.size, 0)
	finish({ ok: true })
	await Promise.resolve()
	assert.deepEqual(current.calls, [{ method: RUNTIME, args: [] }])
})

test('unexpected plugins or repositories cannot be installed', async () => {
	for (const action of [
		{ id: 'another.plugin', repo: REPO },
		{ id: ID, repo: 'https://example.com/plugins' },
	]) {
		const current = fixture({ actions: [action] })
		await assert.rejects(current.update(), /unexpected plugin or repository/)
		assert.ok(
			!current.calls.some(
				call =>
					call.method === 'revenge.plugins.install' ||
					call.method === CONFIGURE,
			),
		)
	}
})

test('plugin install and native configuration failures are surfaced without further changes', async () => {
	for (const failMethod of ['revenge.plugins.install', CONFIGURE]) {
		const current = fixture({ failMethod })
		await assert.rejects(current.update(), /Failed/)
		assert.equal(current.calls.at(-1)?.method, failMethod)
	}
})

test('repository migration preserves unrelated and disabled external repositories', async () => {
	const internal = { url: 'builtin', enabled: true, internal: true }
	const custom = {
		url: 'https://example.com/plugins',
		enabled: false,
		internal: false,
	}
	const local = {
		url: 'http://localhost:8080',
		enabled: true,
		internal: false,
		name: 'My plugins',
	}
	const temporary = {
		url: 'http://127.0.0.1:8080/',
		enabled: true,
		internal: false,
		name: 'Protonn Cord Mobile',
	}
	const nightly = { url: REPO, enabled: true, internal: false }
	const current = fixture({
		repos: [internal, custom, local, temporary],
		configured: [internal, nightly, custom, local, temporary],
		pending: [],
	})
	assert.equal(await current.update(), false)
	const sets = current.calls.filter(
		call => call.method === 'revenge.plugins.repos.set',
	)
	const external = (repo: Repo) => ({ url: repo.url, enabled: repo.enabled })
	assert.deepEqual(
		sets.map(call => call.args),
		[
			[[nightly, custom, local, temporary].map(external)],
			[[nightly, custom, local].map(external)],
		],
	)
})
