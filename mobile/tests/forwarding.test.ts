/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
	attachmentBundleRoot,
	createAttachmentManifest,
	parseSecurePlaintext as desktopParsePlaintext,
	serializeSecurePlaintext as desktopSerializePlaintext,
	encryptAttachmentBytes,
} from '../../src/equicordplugins/secureMessaging.desktop/attachments'
import { encryptMessage as desktopEncryptMessage } from '../../src/equicordplugins/secureMessaging.desktop/crypto'
import {
	composeSecureForwardText,
	parseSecureForwardText,
} from '../../src/equicordplugins/secureMessaging.desktop/forwarding'
import {
	DETACHED_TEXT_FILENAME,
	DETACHED_TEXT_MIME_TYPE,
	decryptAttachmentBytes,
	parseSecurePlaintext,
	serializeSecurePlaintext,
} from '../plugins/secure-messaging/js/attachments'
import {
	decryptMessage,
	generateIdentity,
	publicIdentity,
	setRandomSource,
} from '../plugins/secure-messaging/js/crypto'
import {
	decodeUtf8,
	encode64,
	utf8Bytes,
} from '../plugins/secure-messaging/js/protocol'
import type { AttachmentMetadata } from '../plugins/secure-messaging/js/attachments'

const CHANNEL = '100000000000000001'
const SENDER = '100000000000000002'
const RECIPIENT = '100000000000000003'
const NOW = 1_800_000_000_000
const BUNDLE_ID = encode64(Uint8Array.from({ length: 16 }, (_, index) => index))
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 16)
setRandomSource(size => Uint8Array.from(randomBytes(size)))

async function encryptedBundle(data: Uint8Array, detached = false) {
	const metadata: AttachmentMetadata = {
		name: detached ? DETACHED_TEXT_FILENAME : 'forwarded.png',
		mimeType: detached ? DETACHED_TEXT_MIME_TYPE : 'image/png',
		size: data.length,
		spoiler: false,
		description: null,
		width: null,
		height: null,
		duration: null,
		waveform: null,
	}
	const input = {
		bundleId: BUNDLE_ID,
		channelId: CHANNEL,
		count: 1,
		data,
		index: 0,
		masterKey: KEY,
		metadata,
		senderUserId: SENDER,
	}
	const ciphertext = await encryptAttachmentBytes(input)
	return {
		input,
		ciphertext,
		bundle: {
			id: BUNDLE_ID,
			key: encode64(KEY),
			count: 1,
			root: await attachmentBundleRoot(BUNDLE_ID, [ciphertext]),
			manifest: await createAttachmentManifest([ciphertext], [metadata]),
		},
	}
}

test('desktop forward cards retain readable text and notes on unchanged mobile clients', () => {
	const copied = composeSecureForwardText({
		authorLabel: 'Alice *quoted*',
		content: 'The copied message',
		timestampMs: NOW,
	})
	for (const [text, note] of [
		[copied, undefined],
		[`My note\n\n${copied}`, 'My note'],
	] as const) {
		const wire = desktopSerializePlaintext(text)
		const mobile = parseSecurePlaintext(wire)
		const desktop = desktopParsePlaintext(wire)
		assert.equal(mobile.text, text)
		assert.equal(serializeSecurePlaintext(mobile.text), wire)
		assert.deepEqual(desktop.forward, {
			authorLabel: 'Alice *quoted*',
			timestampMs: NOW,
			content: 'The copied message',
			...(note === undefined ? {} : { note }),
		})
		assert.equal(desktop.text, mobile.text)
		assert.deepEqual(mobile.stickers, [])
		assert.equal(mobile.attachments, null)
	}
})

test('file-only and sticker forwards preserve their authenticated mobile media payloads', async () => {
	const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
	const { bundle, ciphertext, input } = await encryptedBundle(data)
	const header = composeSecureForwardText({ authorLabel: 'Alice', content: '' })
	const stickers = [{ id: '100000000000000004', name: 'wave', formatType: 1 }]
	for (const [attachments, items] of [
		[bundle, []],
		[null, stickers],
		[bundle, stickers],
	] as const) {
		const wire = desktopSerializePlaintext(header, attachments, [...items])
		const mobile = parseSecurePlaintext(wire)
		const desktop = desktopParsePlaintext(wire)
		assert.equal(mobile.text, header)
		assert.deepEqual(mobile.attachments, attachments)
		assert.deepEqual(mobile.stickers, items)
		assert.equal(desktop.forward?.content, '')
		assert.equal(desktop.forward?.authorLabel, 'Alice')
		assert.equal(
			serializeSecurePlaintext(
				mobile.text,
				mobile.attachments,
				mobile.stickers,
			),
			wire,
		)
	}
	assert.deepEqual(decryptAttachmentBytes({ ...input, ciphertext }).data, data)
})

test('long encrypted forwards remain readable on mobile after authenticated detached-text decryption', async () => {
	const body = 'A long copied message. '.repeat(200)
	const text = composeSecureForwardText({
		authorLabel: 'Alice',
		content: body,
		timestampMs: NOW,
	})
	const { bundle, ciphertext, input } = await encryptedBundle(
		utf8Bytes(text),
		true,
	)
	const wire = desktopSerializePlaintext('', bundle, [], 0)
	const senderIdentity = generateIdentity(NOW)
	const recipientIdentity = generateIdentity(NOW + 1)
	const encrypted = await desktopEncryptMessage({
		channelId: CHANNEL,
		identity: senderIdentity,
		plaintext: wire,
		recipients: [publicIdentity(recipientIdentity, RECIPIENT)],
		senderUserId: SENDER,
		counter: 1,
		now: NOW + 2,
	})
	const decrypted = decryptMessage({
		channelId: CHANNEL,
		content: encrypted,
		authorId: SENDER,
		identity: recipientIdentity,
		localUserId: RECIPIENT,
		sender: publicIdentity(senderIdentity, SENDER),
	})
	const mobile = parseSecurePlaintext(decrypted.plaintext)
	assert.equal(mobile.detachedTextIndex, 0)
	assert.deepEqual(mobile.attachments, bundle)
	assert.equal(serializeSecurePlaintext('', mobile.attachments, [], 0), wire)
	const detached = decryptAttachmentBytes({ ...input, ciphertext })
	assert.equal(detached.metadata.name, DETACHED_TEXT_FILENAME)
	assert.equal(detached.metadata.mimeType, DETACHED_TEXT_MIME_TYPE)
	const readable = decodeUtf8(detached.data)
	assert.equal(readable, text)
	assert.equal(parseSecureForwardText(readable)?.content, body.trim())
	const changed = ciphertext.slice()
	changed[0] ^= 1
	assert.throws(
		() => decryptAttachmentBytes({ ...input, ciphertext: changed }),
		/authentication/,
	)
})

test('malformed forwarded headers stay ordinary readable text on desktop and mobile', () => {
	for (const text of [
		'**Forwarded copy from Alice**\nBody without the required separator',
		'**Forwarded copy from Alice** • <t:0:f>\n\nBody',
		'**Forwarded copy from Alice  Smith**\n\nBody',
		'**Forwarded copy from Alice *unescaped***\n\nBody',
		'**Forwarded copy from Alice** • <t:9999999999999:f>\n\nBody',
	]) {
		const wire = desktopSerializePlaintext(text)
		assert.equal(parseSecureForwardText(text), null)
		assert.equal(desktopParsePlaintext(wire).forward, undefined)
		assert.equal(desktopParsePlaintext(wire).text, text)
		assert.equal(parseSecurePlaintext(wire).text, text)
	}
})
