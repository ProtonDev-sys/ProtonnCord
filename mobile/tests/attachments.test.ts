import assert from 'node:assert/strict'
import test from 'node:test'
import {
	attachmentBundleRoot as desktopBundleRoot,
	createAttachmentManifest as desktopCreateManifest,
	decryptAttachmentBytes as desktopDecryptAttachment,
	encryptAttachmentBytes as desktopEncryptAttachment,
	parseSecurePlaintext as desktopParsePlaintext,
	serializeSecurePlaintext as desktopSerializePlaintext,
} from '../../src/equicordplugins/secureMessaging.desktop/attachments'
import {
	attachmentBundleRoot,
	authenticateAttachmentBundle,
	createAttachmentManifest,
	decryptAttachmentBytes,
	encryptAttachmentBytes,
	encryptedAttachmentFilename,
	generateAttachmentBundleMaterial,
	parseSecurePlaintext,
	serializeSecurePlaintext,
} from '../plugins/secure-messaging/js/attachments'
import { setRandomSource } from '../plugins/secure-messaging/js/crypto'
import { encode64 } from '../plugins/secure-messaging/js/protocol'
import type { AttachmentMetadata } from '../plugins/secure-messaging/js/attachments'

const CHANNEL = '100000000000000001'
const SENDER = '100000000000000002'
const BUNDLE_ID = encode64(Uint8Array.from({ length: 16 }, (_, index) => index))
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 16)
const DATA = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const METADATA: AttachmentMetadata = {
	name: 'proof.png',
	mimeType: 'image/png',
	size: DATA.length,
	spoiler: false,
	description: 'encrypted proof',
	width: 1,
	height: 1,
	duration: null,
	waveform: null,
}

setRandomSource(size => Uint8Array.from({ length: size }, (_, index) => index))

test('nightly manifest attachments, stickers and detached text are readable on mobile', async () => {
	const ciphertext = await desktopEncryptAttachment({
		bundleId: BUNDLE_ID,
		channelId: CHANNEL,
		count: 1,
		data: DATA,
		index: 0,
		masterKey: KEY,
		metadata: METADATA,
		senderUserId: SENDER,
	})
	const manifest = await desktopCreateManifest([ciphertext], [METADATA])
	assert.deepEqual(createAttachmentManifest([ciphertext], [METADATA]), manifest)
	const bundle = {
		id: BUNDLE_ID,
		key: encode64(KEY),
		count: 1,
		root: await desktopBundleRoot(BUNDLE_ID, [ciphertext]),
		manifest,
	}
	const stickers = [{ id: '100000000000000004', name: 'wave', formatType: 1 }]
	for (const [text, items, detached] of [
		['hello', [], null],
		['hello', stickers, null],
		['', [], 0],
		['', stickers, 0],
	] as const) {
		const desktop = desktopSerializePlaintext(
			text,
			bundle,
			[...items],
			detached,
		)
		assert.deepEqual(
			parseSecurePlaintext(desktop),
			desktopParsePlaintext(desktop),
		)
		assert.equal(
			serializeSecurePlaintext(text, bundle, [...items], detached),
			desktop,
		)
	}
	assert.doesNotThrow(() => authenticateAttachmentBundle(bundle, [ciphertext]))
	const changed = ciphertext.slice()
	changed[0] ^= 1
	assert.throws(
		() => authenticateAttachmentBundle(bundle, [changed]),
		/authentication/,
	)
	assert.throws(
		() =>
			authenticateAttachmentBundle(
				{
					...bundle,
					manifest: [{ ...manifest[0], digest: encode64(new Uint8Array(32)) }],
				},
				[ciphertext],
			),
		/manifest authentication/,
	)
})

test('literal protocol prefixes remain ordinary text and malformed manifests are rejected', () => {
	for (const prefix of [
		'PCEA1:',
		'PCEA2:',
		'PCEA3:',
		'PCER1:',
		'PCER2:',
		'PCER3:',
		'PCET1:',
		'PCET2:',
	]) {
		const text = `${prefix}literal`
		const wire = serializeSecurePlaintext(text, null)
		assert.equal(desktopParsePlaintext(wire).text, text)
		assert.equal(parseSecurePlaintext(wire).text, text)
	}
	assert.throws(() => parseSecurePlaintext('PCEA3:["text",null]'))
	assert.throws(() =>
		parseSecurePlaintext(
			`PCEA3:["text",["${BUNDLE_ID}","${encode64(KEY)}",1,"${encode64(KEY)}",[["${encode64(KEY)}",4,8]]]]`,
		),
	)
})

test('mobile and desktop attachment encryption are mutually compatible', async () => {
	const input = {
		bundleId: BUNDLE_ID,
		channelId: CHANNEL,
		count: 1,
		data: DATA,
		index: 0,
		masterKey: KEY,
		metadata: METADATA,
		senderUserId: SENDER,
	}
	const fromDesktop = await desktopEncryptAttachment(input)
	assert.deepEqual(
		decryptAttachmentBytes({ ...input, ciphertext: fromDesktop }),
		{
			data: DATA,
			metadata: METADATA,
		},
	)

	const fromMobile = encryptAttachmentBytes(input)
	assert.deepEqual(
		await desktopDecryptAttachment({ ...input, ciphertext: fromMobile }),
		{
			data: DATA,
			metadata: METADATA,
		},
	)
	assert.equal(
		attachmentBundleRoot(BUNDLE_ID, [fromMobile]),
		await desktopBundleRoot(BUNDLE_ID, [fromMobile]),
	)
})

test('mobile and desktop secure attachment plaintext are mutually compatible', () => {
	const bundle = {
		id: BUNDLE_ID,
		key: encode64(KEY),
		count: 1,
		root: encode64(Uint8Array.from({ length: 32 }, (_, index) => 255 - index)),
	}
	assert.deepEqual(
		parseSecurePlaintext(desktopSerializePlaintext('attached', bundle)),
		{
			text: 'attached',
			attachments: bundle,
			detachedTextIndex: null,
			stickers: [],
		},
	)
	assert.deepEqual(
		desktopParsePlaintext(serializeSecurePlaintext('attached', bundle)),
		{
			text: 'attached',
			attachments: bundle,
			detachedTextIndex: null,
			stickers: [],
		},
	)
})

test('mobile attachment bundle material matches its upload filenames', () => {
	const { descriptor, keyBytes } = generateAttachmentBundleMaterial(2)
	assert.equal(descriptor.key, encode64(keyBytes))
	assert.equal(
		encryptedAttachmentFilename(descriptor.id, 1),
		`pc-${descriptor.id}-1.pcaf`,
	)
	keyBytes.fill(0)
})
