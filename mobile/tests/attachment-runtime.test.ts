/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const { ModuleKind, ScriptTarget, transpileModule } = createRequire(
	new URL('../../package.json', import.meta.url),
)('typescript')

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred<T = unknown>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}
function fixture(
	options: {
		read?: (uri: string) => Promise<string>
		decode?: (value: string) => any
		write?: () => Promise<string>
		remove?: () => Promise<unknown>
		cleanup?: boolean
	} = {},
) {
	const metadata: any[] = []
	const removed: string[] = []
	const warnings: unknown[] = []
	const source = `${readFileSync(
		new URL(
			'../plugins/secure-messaging/js/attachmentRuntime.ts',
			import.meta.url,
		),
		'utf8',
	)}\nexport { readAttachmentResponse, files, cacheReady };`
	const code = transpileModule(source, {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
		},
	}).outputText
	const modules: Record<string, unknown> = {
		'@revenge-mod/discord/native': {
			FileModule: {
				writeFile: (_: string, path: string) =>
					options.write?.() ?? Promise.resolve(`/cache/${path}`),
				removeFile: async (_: string, path: string) => {
					removed.push(path)
					return await options.remove?.()
				},
			},
		},
		'@revenge-mod/modules/native': {
			callNativeMethod: async (method: string, args: string[]) => {
				if (method.endsWith('.cleanup')) return options.cleanup ?? true
				if (method.endsWith('.read'))
					return options.read ? options.read(args[0]) : 'file'
				throw new Error(`Unexpected native call: ${method}`)
			},
		},
		'@scure/base': {
			base64: {
				encode: () => 'ciphertext',
				decode: (value: string) =>
					options.decode?.(value) ?? new Uint8Array([1, 2, 3]),
			},
		},
		'./attachments': {
			MAX_ATTACHMENT_COUNT: 10,
			generateAttachmentBundleMaterial: (count: number) => ({
				descriptor: { id: 'test', count },
				keyBytes: new Uint8Array(32),
			}),
			encryptedAttachmentFilename: (_: string, index: number) =>
				`pc-test-${index}.pcaf`,
			encryptAttachmentBytes: (input: any) => {
				metadata.push({ ...input.metadata })
				return new Uint8Array(30)
			},
			attachmentBundleRoot: () => 'root',
			serializeSecurePlaintext: () => 'encrypted descriptor',
		},
		'./protocol': { requireSnowflake: (value: string) => value },
	}
	const api = runInNewContext(`${code}\nexports;`, {
		exports: {},
		URL,
		Promise,
		AbortController,
		Uint8Array,
		console: { warn: (value: unknown) => warnings.push(value) },
		require: (name: string) => {
			assert.ok(Object.hasOwn(modules, name), name)
			return modules[name]
		},
	})
	return { api, metadata, removed, warnings }
}
function upload(size = 3) {
	return {
		status: 'NOT_STARTED',
		filename: 'private.png',
		mimeType: 'image/png',
		description: 'Private description',
		spoiler: true,
		preCompressionSize: size,
		currentSize: size,
		item: {
			uri: 'content://picker/file',
			filename: 'private.png',
			width: 1,
			height: 1,
		},
		setFilename(name: string) {
			assert.equal(this.spoiler, false)
			this.filename = name
		},
	}
}

test('prepared uploads retain encrypted metadata and clear its outer plaintext copies only when applied', async () => {
	const f = fixture()
	const value = upload()
	const prepared = await f.api.prepareEncryptedUploads(
		[value],
		'',
		'channel',
		'user',
	)
	assert.equal(f.metadata[0].description, 'Private description')
	assert.equal(f.metadata[0].spoiler, true)
	assert.equal(value.description, 'Private description')
	prepared.apply()
	assert.equal(value.description, undefined)
	assert.equal(value.spoiler, false)
	assert.equal(value.filename, 'pc-test-0.pcaf')
})

test('upload accumulation refuses a third 64MiB source before reading it and wipes earlier decoded buffers', async () => {
	let reads = 0
	let wiped = 0
	const size = 64 * 1024 * 1024
	const f = fixture({
		read: async () => {
			reads++
			return 'virtual file'
		},
		decode: () => ({
			length: size,
			fill: () => {
				wiped++
			},
		}),
	})
	await assert.rejects(
		f.api.prepareEncryptedUploads(
			[upload(size), upload(size), upload(size)],
			'',
			'channel',
			'user',
		),
		/safety limit/,
	)
	assert.equal(reads, 2)
	assert.equal(wiped, 2)
	assert.equal(f.metadata.length, 0)
})

test('failed source reads wipe buffers that were already decoded', async () => {
	let reads = 0
	const bytes = new Uint8Array([7, 8, 9])
	const f = fixture({
		read: async () => {
			if (++reads === 2) throw new Error('reader failed')
			return 'file'
		},
		decode: () => bytes,
	})
	await assert.rejects(
		f.api.prepareEncryptedUploads([upload(), upload()], '', 'channel', 'user'),
		/reader failed/,
	)
	assert.deepEqual([...bytes], [0, 0, 0])
})

test('locking during ciphertext cache writes prevents applying the prepared upload and cleans the owned path', async () => {
	const write = deferred<string>()
	const f = fixture({ write: () => write.promise })
	const value = upload()
	const pending = f.api.prepareEncryptedUploads([value], '', 'channel', 'user')
	await tick()
	f.api.clearAttachmentCache()
	write.resolve('/cache/protonn-cord/uploads/pc-test-0.pcaf')
	await assert.rejects(pending, /locked/)
	assert.equal(value.filename, 'private.png')
	assert.deepEqual(f.removed, ['protonn-cord/uploads/pc-test-0.pcaf'])
})

test('streaming downloads cancel once bytes exceed their authenticated expected size', async () => {
	const f = fixture()
	let cancelled = 0
	let released = 0
	let reads = 0
	const chunk = new Uint8Array(31)
	await assert.rejects(
		f.api.readAttachmentResponse(
			{
				headers: { get: () => null },
				body: {
					getReader: () => ({
						read: async () => {
							reads++
							return { done: false, value: chunk }
						},
						cancel: async () => {
							cancelled++
						},
						releaseLock: () => {
							released++
						},
					}),
				},
			},
			30,
		),
		/exceeds its expected size/,
	)
	assert.equal(reads, 1)
	assert.equal(cancelled, 1)
	assert.equal(released, 1)
})

test('non-streaming runtimes require matching transport lengths and reject unverifiable allocation', async () => {
	const f = fixture()
	let allocations = 0
	for (const length of [null, '1000000000', 'invalid', '29']) {
		await assert.rejects(
			f.api.readAttachmentResponse(
				{
					headers: { get: () => length },
					arrayBuffer: async () => {
						allocations++
						return new ArrayBuffer(30)
					},
				},
				30,
			),
		)
	}
	assert.equal(allocations, 0)
	const bytes = await f.api.readAttachmentResponse(
		{
			headers: { get: () => '30' },
			arrayBuffer: async () => {
				allocations++
				return new ArrayBuffer(30)
			},
		},
		30,
	)
	assert.equal(bytes.length, 30)
	assert.equal(allocations, 1)
})

test('failed owned-cache cleanup is contained and retried on the next clear', async () => {
	let attempts = 0
	const f = fixture({
		remove: async () => {
			if (++attempts === 1) throw new Error('busy')
		},
	})
	f.api.files.add('share-media/protonn-cord/100000000000000001-0-private.png')
	f.api.clearAttachmentCache()
	await tick()
	assert.equal(f.api.files.size, 1)
	assert.equal(f.warnings.length, 1)
	f.api.clearAttachmentCache()
	await tick()
	assert.equal(f.api.files.size, 0)
	assert.equal(attempts, 2)
})

test('startup cache cleanup must finish successfully before attachment rendering is enabled', async () => {
	const f = fixture({ cleanup: false })
	assert.equal(f.api.cacheReady, false)
	await assert.rejects(
		f.api.cleanupStoredAttachments(),
		/cache could not be cleaned/,
	)
	assert.equal(f.api.cacheReady, false)
	const ready = fixture()
	await ready.api.cleanupStoredAttachments()
	assert.equal(ready.api.cacheReady, true)
})
