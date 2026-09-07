/* SPDX-License-Identifier: GPL-3.0-or-later */

import { FileModule } from '@revenge-mod/discord/native'
import { callNativeMethod } from '@revenge-mod/modules/native'
import { base64 } from '@scure/base'
import {
	attachmentBundleRoot,
	authenticateAttachmentBundle,
	DETACHED_TEXT_FILENAME,
	DETACHED_TEXT_MIME_TYPE,
	decryptAttachmentBytes,
	encryptAttachmentBytes,
	encryptedAttachmentFilename,
	generateAttachmentBundleMaterial,
	MAX_ATTACHMENT_COUNT,
	serializeSecurePlaintext,
} from './attachments'
import { decode64, decodeUtf8, requireSnowflake } from './protocol'
import type {
	AttachmentBundleDescriptor,
	AttachmentMetadata,
	SecurePlaintext,
} from './attachments'

interface DiscordAttachment {
	content_type?: string
	description?: string | null
	duration_secs?: number
	filename: string
	height?: number
	id: string
	proxy_url: string
	size: number
	url: string
	waveform?: string
	width?: number
}

interface MessageLike {
	attachments?: DiscordAttachment[]
	author?: { id?: string }
	channel_id?: string
	channelId?: string
	content: string
	id: string
}

interface DiscordUpload {
	allowOptimization: boolean
	currentSize: number
	description?: string | null
	durationSecs?: number
	filename: string
	id: string
	isImage: boolean
	isThumbnail?: boolean
	isVideo: boolean
	item: {
		filename: string
		height?: number
		id: string
		mimeType: string
		originalUri: string
		uri: string
		width?: number
	}
	mimeType: string
	postCompressionSize?: number
	preCompressionSize: number
	reactNativeFilePrepped: boolean
	setFilename(value: string): void
	spoiler: boolean
	status: string
	waveform?: string
}

export interface PreparedEncryptedUploads {
	apply(): void
	plaintext: string
}

interface ReadyState {
	attachments: DiscordAttachment[]
	plaintext: string
	status: 'ready'
}

type CacheState =
	| { status: 'pending' }
	| { reason: string; status: 'failed' }
	| ReadyState

type PatchAttachments = (
	channelId: string,
	messageId: string,
	attachments: DiscordAttachment[],
) => unknown

// ponytail: the JS bridge holds base64 in memory; move streaming crypto native if
// Discord raises ordinary mobile upload limits beyond these bounds.
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
const cache = new Map<string, CacheState>()
const files = new Set<string>()
const renderedMessages = new Map<string, MessageLike>()
const downloads = new Set<AbortController>()
let cacheGeneration = 0
let patchAttachments: PatchAttachments | undefined

export function setAttachmentPatcher(patcher: PatchAttachments): void {
	patchAttachments = patcher
}

export function refreshEncryptedMessage(message: MessageLike): void {
	patchAttachments?.(message.channel_id ?? message.channelId!, message.id, [
		...(message.attachments ?? []),
	])
}

export function trackEncryptedMessage(message: MessageLike): void {
	if (renderedMessages.size >= 256)
		renderedMessages.delete(renderedMessages.keys().next().value!)
	renderedMessages.set(cacheKey(message), message)
}

function optionalPositiveInteger(value: unknown): number | null {
	return Number.isInteger(value) && (value as number) > 0
		? (value as number)
		: null
}

function optionalDuration(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: null
}

export async function prepareEncryptedUploads(
	uploads: DiscordUpload[],
	text: string,
	channelId: string,
	senderUserId: string,
): Promise<PreparedEncryptedUploads> {
	if (uploads.length < 1 || uploads.length > MAX_ATTACHMENT_COUNT)
		throw new Error(
			`Secure Messaging supports 1 to ${MAX_ATTACHMENT_COUNT} attachments`,
		)
	requireSnowflake(channelId, 'attachment channel')
	requireSnowflake(senderUserId, 'attachment sender')

	const sources: Array<{ data: Uint8Array; metadata: AttachmentMetadata }> = []
	for (const upload of uploads) {
		if (
			upload.status !== 'NOT_STARTED' ||
			upload.isThumbnail ||
			typeof upload.item?.uri !== 'string' ||
			!['content:', 'file:'].includes(new URL(upload.item.uri).protocol)
		)
			throw new Error(
				'Secure Messaging can only encrypt pending local attachments',
			)
		const encoded = await callNativeMethod(
			'uk.co.protonn.secure-messaging.attachment.read',
			[upload.item.uri],
		)
		if (typeof encoded !== 'string')
			throw new Error('Attachment reader returned invalid data')
		const data = base64.decode(encoded)
		if (data.length < 1 || data.length > MAX_FILE_BYTES)
			throw new Error('Attachment exceeds the mobile safety limit')
		const width = optionalPositiveInteger(upload.item.width)
		const height = optionalPositiveInteger(upload.item.height)
		sources.push({
			data,
			metadata: {
				name: upload.filename || upload.item.filename,
				mimeType:
					upload.mimeType || upload.item.mimeType || 'application/octet-stream',
				size: data.length,
				spoiler: upload.spoiler === true,
				description:
					typeof upload.description === 'string' ? upload.description : null,
				width: width !== null && height !== null ? width : null,
				height: width !== null && height !== null ? height : null,
				duration: optionalDuration(upload.durationSecs),
				waveform: typeof upload.waveform === 'string' ? upload.waveform : null,
			},
		})
	}
	if (
		sources.reduce((sum, source) => sum + source.data.length, 0) >
		MAX_TOTAL_BYTES
	)
		throw new Error('Attachments exceed the mobile safety limit')

	const { descriptor, keyBytes } = generateAttachmentBundleMaterial(
		uploads.length,
	)
	const ciphertexts: Uint8Array[] = []
	const replacements: Array<{
		filename: string
		id: string
		size: number
		upload: DiscordUpload
		uri: string
	}> = []
	try {
		for (let index = 0; index < uploads.length; index++) {
			const source = sources[index]!
			const ciphertext = encryptAttachmentBytes({
				bundleId: descriptor.id,
				channelId,
				count: uploads.length,
				data: source.data,
				index,
				masterKey: keyBytes,
				metadata: source.metadata,
				senderUserId,
			})
			ciphertexts.push(ciphertext)
			const filename = encryptedAttachmentFilename(descriptor.id, index)
			const relativePath = `protonn-cord/uploads/${filename}`
			const path = await FileModule.writeFile(
				'cache',
				relativePath,
				base64.encode(ciphertext),
				'base64',
			)
			files.add(relativePath)
			const uri = path.startsWith('file:') ? path : `file://${path}`
			replacements.push({
				filename,
				id: `${uri}${ciphertext.length}`,
				size: ciphertext.length,
				upload: uploads[index]!,
				uri,
			})
		}
		const root = attachmentBundleRoot(descriptor.id, ciphertexts)
		return {
			plaintext: serializeSecurePlaintext(text, { ...descriptor, root }),
			apply() {
				for (const replacement of replacements) {
					const { upload } = replacement
					Object.assign(upload.item, {
						id: replacement.id,
						uri: replacement.uri,
						originalUri: replacement.uri,
						filename: replacement.filename,
						mimeType: 'application/octet-stream',
						width: undefined,
						height: undefined,
					})
					upload.id = replacement.id
					upload.setFilename(replacement.filename)
					upload.mimeType = 'application/octet-stream'
					upload.allowOptimization = false
					upload.isImage = false
					upload.isVideo = false
					upload.durationSecs = undefined
					upload.waveform = undefined
					upload.currentSize = replacement.size
					upload.preCompressionSize = replacement.size
					upload.postCompressionSize = undefined
					upload.reactNativeFilePrepped = false
				}
			},
		}
	} finally {
		keyBytes.fill(0)
		for (const source of sources) source.data.fill(0)
		for (const ciphertext of ciphertexts) ciphertext.fill(0)
	}
}

function cacheKey(message: MessageLike): string {
	return `${message.channel_id ?? message.channelId}\0${message.id}\0${message.content}`
}

function stickersText(value: SecurePlaintext): string {
	return value.stickers.map(sticker => `🎟 ${sticker.name}`).join('\n')
}

function displayText(value: SecurePlaintext, suffix = ''): string {
	return [value.text, stickersText(value), suffix].filter(Boolean).join('\n')
}

function validatedAttachmentUrl(
	value: string,
	channelId: string,
	attachmentId: string,
): string {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('Discord attachment URL is invalid')
	}
	if (
		url.protocol !== 'https:' ||
		!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
		!url.pathname.startsWith(`/attachments/${channelId}/${attachmentId}/`)
	)
		throw new Error('Discord attachment URL is invalid')
	return url.toString()
}

function orderedAttachments(
	attachments: DiscordAttachment[],
	bundle: AttachmentBundleDescriptor,
): DiscordAttachment[] {
	if (attachments.length !== bundle.count)
		throw new Error('Encrypted attachment count does not match the message')
	const ordered: DiscordAttachment[] = []
	const escaped = bundle.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const pattern = new RegExp(`^pc-${escaped}-(\\d+)\\.pcaf$`)
	for (const attachment of attachments) {
		requireSnowflake(attachment.id, 'attachment')
		if (
			!Number.isSafeInteger(attachment.size) ||
			attachment.size < 21 ||
			attachment.size > MAX_FILE_BYTES
		)
			throw new Error('Encrypted attachment exceeds the mobile safety limit')
		const match = pattern.exec(attachment.filename)
		const index = match ? Number(match[1]) : -1
		if (index < 0 || index >= bundle.count || ordered[index])
			throw new Error('Encrypted attachment filename is invalid')
		ordered[index] = attachment
	}
	if (ordered.some(attachment => !attachment))
		throw new Error('Encrypted attachment order is invalid')
	if (
		ordered.reduce((sum, attachment) => sum + attachment.size, 0) >
		MAX_TOTAL_BYTES
	)
		throw new Error('Encrypted attachments exceed the mobile safety limit')
	return ordered
}

async function download(
	attachment: DiscordAttachment,
	channelId: string,
): Promise<Uint8Array> {
	let lastError: unknown
	for (const candidate of [attachment.url, attachment.proxy_url]) {
		const controller = new AbortController()
		downloads.add(controller)
		try {
			const url = validatedAttachmentUrl(candidate, channelId, attachment.id)
			const response = await fetch(url, { signal: controller.signal })
			if (!response.ok)
				throw new Error(
					`Discord attachment download failed (${response.status})`,
				)
			const bytes = new Uint8Array(await response.arrayBuffer())
			if (bytes.length !== attachment.size)
				throw new Error('Encrypted attachment download length is invalid')
			return bytes
		} catch (error) {
			if (controller.signal.aborted)
				throw new Error('Secure Messaging was locked')
			lastError = error
		} finally {
			downloads.delete(controller)
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error('Discord attachment download failed')
}

function localAttachment(
	raw: DiscordAttachment,
	metadata: AttachmentMetadata,
	uri: string,
): DiscordAttachment {
	return {
		id: raw.id,
		filename: `${metadata.spoiler ? 'SPOILER_' : ''}${metadata.name}`,
		size: metadata.size,
		url: uri,
		proxy_url: uri,
		content_type: metadata.mimeType || 'application/octet-stream',
		...(metadata.description === null
			? {}
			: { description: metadata.description }),
		...(metadata.width === null
			? {}
			: { width: metadata.width, height: metadata.height! }),
		...(metadata.duration === null ? {} : { duration_secs: metadata.duration }),
		...(metadata.waveform === null ? {} : { waveform: metadata.waveform }),
	}
}

async function decryptAttachments(
	message: MessageLike,
	secure: SecurePlaintext,
	generation: number,
): Promise<ReadyState> {
	const channelId = message.channel_id ?? message.channelId
	if (!channelId || !secure.attachments)
		throw new Error('Encrypted attachment message is invalid')
	const senderUserId = message.author?.id
	if (!senderUserId)
		throw new Error('Encrypted attachment sender is unavailable')
	requireSnowflake(senderUserId, 'attachment sender')
	const raw = orderedAttachments(message.attachments ?? [], secure.attachments)
	const key = decode64(secure.attachments.key, 32)
	const ciphertexts: Uint8Array[] = []
	const decrypted: Array<{
		data: Uint8Array
		metadata: AttachmentMetadata
		raw: DiscordAttachment
	}> = []
	try {
		for (let index = 0; index < raw.length; index++) {
			const ciphertext = await download(raw[index]!, channelId)
			if (generation !== cacheGeneration) {
				ciphertext.fill(0)
				throw new Error('Secure Messaging was locked')
			}
			ciphertexts.push(ciphertext)
			decrypted.push({
				raw: raw[index]!,
				...decryptAttachmentBytes({
					bundleId: secure.attachments.id,
					channelId,
					ciphertext,
					count: secure.attachments.count,
					index,
					masterKey: key,
					senderUserId,
				}),
			})
		}
		authenticateAttachmentBundle(secure.attachments, ciphertexts)

		let plaintext = secure.text
		if (secure.detachedTextIndex !== null) {
			const detached = decrypted[secure.detachedTextIndex]
			if (
				!detached ||
				detached.metadata.name !== DETACHED_TEXT_FILENAME ||
				detached.metadata.mimeType !== DETACHED_TEXT_MIME_TYPE ||
				detached.metadata.spoiler ||
				detached.metadata.description !== null ||
				detached.metadata.width !== null ||
				detached.metadata.height !== null ||
				detached.metadata.duration !== null
			)
				throw new Error('Detached encrypted message text is invalid')
			plaintext = decodeUtf8(detached.data)
			if (!plaintext)
				throw new Error('Detached encrypted message text is empty')
		}

		const visible: DiscordAttachment[] = []
		for (let index = 0; index < decrypted.length; index++) {
			if (index === secure.detachedTextIndex) continue
			const item = decrypted[index]!
			const relativePath = `share-media/protonn-cord/${message.id}-${index}-${item.metadata.name}`
			const path = await FileModule.writeFile(
				'cache',
				relativePath,
				base64.encode(item.data),
				'base64',
			)
			if (generation !== cacheGeneration) {
				await FileModule.removeFile('cache', relativePath)
				throw new Error('Secure Messaging was locked')
			}
			files.add(relativePath)
			const uri = await callNativeMethod(
				'uk.co.protonn.secure-messaging.attachment.share',
				[path],
			)
			if (generation !== cacheGeneration)
				throw new Error('Secure Messaging was locked')
			if (typeof uri !== 'string' || !uri.startsWith('content://'))
				throw new Error('Attachment share URI is invalid')
			visible.push(localAttachment(item.raw, item.metadata, uri))
		}
		return { status: 'ready', attachments: visible, plaintext }
	} finally {
		key.fill(0)
		for (const ciphertext of ciphertexts) ciphertext.fill(0)
		for (const item of decrypted) item.data.fill(0)
	}
}

function start(message: MessageLike, secure: SecurePlaintext): void {
	if (cache.size >= 128) clearAttachmentCache()
	const key = cacheKey(message)
	const generation = cacheGeneration
	renderedMessages.set(key, message)
	cache.set(key, { status: 'pending' })
	void decryptAttachments(message, secure, generation)
		.then(result => {
			if (generation !== cacheGeneration) return
			cache.set(key, result)
			patchAttachments?.(message.channel_id ?? message.channelId!, message.id, [
				...(message.attachments ?? []),
			])
		})
		.catch(error => {
			if (generation !== cacheGeneration) return
			cache.set(key, {
				status: 'failed',
				reason: error instanceof Error ? error.message : String(error),
			})
			patchAttachments?.(message.channel_id ?? message.channelId!, message.id, [
				...(message.attachments ?? []),
			])
		})
}

export function renderAttachments(
	message: MessageLike,
	secure: SecurePlaintext,
): { attachments: DiscordAttachment[]; plaintext: string } {
	if (!secure.attachments) {
		if (message.attachments?.length)
			throw new Error('Encrypted message has unauthenticated attachments')
		return { attachments: [], plaintext: displayText(secure) }
	}
	if (!message.id) throw new Error('Encrypted attachment message has no ID')
	const key = cacheKey(message)
	const state = cache.get(key)
	if (!state && patchAttachments) start(message, secure)
	if (state?.status === 'ready')
		return {
			attachments: state.attachments,
			plaintext: displayText({ ...secure, text: state.plaintext }),
		}
	if (state?.status === 'failed')
		return {
			attachments: [],
			plaintext: displayText(
				secure,
				`📎 Attachment decryption blocked: ${state.reason}`,
			),
		}
	return {
		attachments: [],
		plaintext: displayText(secure, '📎 Decrypting attachments…'),
	}
}

export function clearAttachmentCache(): void {
	cacheGeneration++
	for (const controller of downloads) controller.abort()
	downloads.clear()
	cache.clear()
	for (const path of files) void FileModule.removeFile('cache', path)
	files.clear()
	const messages = [...renderedMessages.values()]
	renderedMessages.clear()
	for (const message of messages)
		patchAttachments?.(message.channel_id ?? message.channelId!, message.id, [
			...(message.attachments ?? []),
		])
}
