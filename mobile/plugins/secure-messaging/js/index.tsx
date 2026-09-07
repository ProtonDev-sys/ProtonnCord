/* SPDX-License-Identifier: GPL-3.0-or-later */

import Page from '@revenge-mod/components/Page'
import { Design } from '@revenge-mod/discord/design'
import { Stores } from '@revenge-mod/discord/flux'
import { getModules } from '@revenge-mod/modules/finders'
import { withName, withProps } from '@revenge-mod/modules/finders/filters'
import {
	callNativeMethod,
	callNativeMethodSync,
} from '@revenge-mod/modules/native'
import { before, instead } from '@revenge-mod/patcher'
import { useEffect, useState } from 'react'
import { Alert, ScrollView } from 'react-native'
import {
	clearAttachmentCache,
	prepareEncryptedUploads,
	renderAttachments,
	refreshEncryptedMessage,
	trackEncryptedMessage,
	setAttachmentPatcher,
} from './attachmentRuntime'
import { parseSecurePlaintext } from './attachments'
import {
	createAnnouncement,
	encryptMessage,
	formatFingerprint,
	setRandomSource,
	verifyAnnouncement,
} from './crypto'
import { openIdentityBackup } from './identityBackup'
import { withMessageContent } from './message'
import { observeAnnouncement } from './history'
import { MessageReceiver } from './receive'
import { captureSendPolicy } from './sendPolicy'
import { installNightlyUpdates } from './updates'
import {
	decode64,
	KEY_PREFIX,
	MESSAGE_PREFIX,
	PREVIOUS_MESSAGE_PREFIX,
	LEGACY_MESSAGE_PREFIX,
} from './protocol'
import {
	account,
	loadVault,
	mobileVault,
	ownPublicIdentity,
	replaceAccount,
	replaceIdentity,
	saveVault,
	subscribe,
} from './vault'

const { Button, Stack, TableRow, TableRowGroup, Text, TextInput } = Design
const receiver = new MessageReceiver(saveVault, state => {
	const userId = currentUserId()
	return !!userId && mobileVault.ready && account(userId) === state
})

function clearDecryptedContent(): void {
	receiver.clear()
	clearAttachmentCache()
}

function encryptedContent(content: string): boolean {
	return (
		content.startsWith(MESSAGE_PREFIX) ||
		content.startsWith(PREVIOUS_MESSAGE_PREFIX) ||
		content.startsWith(LEGACY_MESSAGE_PREFIX)
	)
}

function requireDm(channelId: string): void {
	const channel = (Stores.ChannelStore as any)?.getChannel?.(channelId)
	if (channel?.type !== 1 && channel?.type !== 3)
		throw new Error('Secure Messaging is only available in DMs and group DMs')
}

function currentUserId(): string | undefined {
	return (Stores.UserStore as any)?.getCurrentUser?.()?.id
}

function memberSnapshot(channelId: string, userId: string): string[] {
	const channel = (Stores.ChannelStore as any)?.getChannel?.(channelId)
	const ids: unknown[] = Array.isArray(channel?.recipients)
		? channel.recipients
		: []
	return [
		...new Set(
			ids.filter(
				(id: unknown): id is string => typeof id === 'string' && id !== userId,
			),
		),
	].sort()
}

function notice(title: string, message: string): void {
	Alert.alert(title, message)
}

async function localCommand(
	channelId: string,
	content: string,
): Promise<string | null | undefined> {
	if (!/^\/pc(?:\s|$)/.test(content)) return undefined
	requireDm(channelId)
	const userId = currentUserId()
	if (!userId) throw new Error('Discord user is unavailable')
	const state = account(userId)
	const [command = 'help', ...args] = content.trim().split(/\s+/).slice(1)

	switch (command.toLowerCase()) {
		case 'announce':
			await saveVault()
			return createAnnouncement(state.identity, userId)
		case 'trust': {
			const [peerId, supplied = ''] = args
			const candidate = peerId && state.pending[peerId]
			if (!candidate)
				throw new Error('No verified pending announcement for that user')
			const expected = formatFingerprint(candidate.fingerprint).replace(
				/\s/g,
				'',
			)
			if (supplied.replace(/[^a-f\d]/gi, '').toUpperCase() !== expected)
				throw new Error('The full fingerprint does not match')
			const old = state.trusted[peerId]
			state.trusted[peerId] = candidate
			clearDecryptedContent()
			delete state.pending[peerId]
			if (old && old.fingerprint !== candidate.fingerprint) {
				for (const [id, conversation] of Object.entries(state.conversations)) {
					if (conversation.recipients.includes(peerId))
						delete state.conversations[id]
				}
			}
			await saveVault()
			notice(
				'Key trusted',
				`Verified ${peerId}. Re-enable affected conversations explicitly.`,
			)
			return null
		}
		case 'on': {
			const members = memberSnapshot(channelId, userId)
			const recipients = [
				...new Set(args.length ? args : memberSnapshot(channelId, userId)),
			].sort()
			if (!recipients.length)
				throw new Error('No recipients supplied or found for this DM')
			for (const id of recipients) {
				if (!members.includes(id))
					throw new Error(`User ${id} is not a member of this DM`)
				if (!state.trusted[id])
					throw new Error(`User ${id} does not have a trusted key`)
			}
			state.conversations[channelId] = {
				recipients,
				members,
			}
			await saveVault()
			notice(
				'Encryption enabled',
				`Protected text sends to ${recipients.join(', ')}.`,
			)
			return null
		}
		case 'off':
			delete state.conversations[channelId]
			await saveVault()
			notice(
				'Encryption disabled',
				'This conversation now sends ordinary Discord messages.',
			)
			return null
		case 'status': {
			const conversation = state.conversations[channelId]
			notice(
				'Protonn Cord Mobile',
				conversation
					? `Encryption is on for: ${conversation.recipients.join(', ')}`
					: 'Encryption is off in this conversation.',
			)
			return null
		}
		default:
			notice(
				'Protonn Cord Mobile commands',
				'/pc announce\n/pc trust USER_ID FULL_FINGERPRINT\n/pc on [USER_ID ...]\n/pc off\n/pc status',
			)
			return null
	}
}

function patchMessageRenderer(
	cleanup: (...fn: Array<() => unknown>) => void,
): void {
	cleanup(
		getModules(
			withName<any>('createMessageContent'),
			(module: any) => {
				const parent = module?.default ? module : null
				if (!parent) return
				cleanup(
					before(parent, 'default', args => {
						const props = args[0]
						const message = props?.message
						const content = message?.content
						const channelId = message?.channel_id ?? message?.channelId
						const authorId = message?.author?.id ?? message?.authorId
						const userId = currentUserId()
						if (
							!userId ||
							typeof content !== 'string' ||
							!channelId ||
							!authorId
						)
							return args

						let rendered: string | undefined
						let renderedAttachments: unknown[] | undefined
						try {
							if (content.startsWith(KEY_PREFIX)) {
								const candidate = verifyAnnouncement(content, authorId)
								if (authorId !== userId) {
									const state = account(userId)
									if (observeAnnouncement(state, candidate, message.id)) {
										receiver.clear()
										void saveVault().catch(() =>
											notice(
												'Key review could not be saved',
												'Protected sends remain blocked until the vault can be saved.',
											),
										)
									}
								}
								rendered = `🔑 Protonn Cord key for ${authorId}\n${formatFingerprint(candidate.fingerprint)}`
							} else if (encryptedContent(content)) {
								const state = account(userId)
								trackEncryptedMessage(message)
								const plaintext = receiver.render(
									{
										id: message.id,
										content,
										channelId,
										authorId,
										editedAt:
											message.edited_timestamp || message.editedTimestamp
												? new Date(
														message.edited_timestamp ?? message.editedTimestamp,
													).getTime()
												: undefined,
									},
									state,
									userId,
									() => refreshEncryptedMessage(message),
								)
								const secure =
									plaintext === undefined
										? {
												plaintext: 'Verifying encrypted message…',
												attachments: [],
											}
										: renderAttachments(
												message,
												parseSecurePlaintext(plaintext),
											)
								rendered = `🔒 ${secure.plaintext}`
								renderedAttachments = secure.attachments
							}
						} catch (error) {
							rendered = `🔒 Encrypted message blocked: ${error instanceof Error ? error.message : String(error)}`
							if (encryptedContent(content)) renderedAttachments = []
						}
						if (rendered !== undefined) {
							args[0] = {
								...props,
								message: withMessageContent(
									message,
									rendered,
									renderedAttachments,
								),
							}
						}
						return args
					}),
				)
			},
			{ returnNamespace: true },
		),
	)
}

function SettingsComponent() {
	const [, rerender] = useState(0)
	const [backup, setBackup] = useState('')
	const [password, setPassword] = useState('')
	const [importing, setImporting] = useState(false)
	const [unlocking, setUnlocking] = useState(false)
	const [updating, setUpdating] = useState(false)
	const [pairing, setPairing] = useState('')
	const [pairingBusy, setPairingBusy] = useState(false)
	useEffect(() => subscribe(() => rerender(value => value + 1)), [])
	const userId = currentUserId()
	const state = userId && mobileVault.ready ? account(userId) : undefined
	const own = userId && state ? ownPublicIdentity(userId) : undefined
	const unlockOneKey = async () => {
		if (!userId || unlocking) return
		setUnlocking(true)
		let secret: Uint8Array | undefined
		try {
			const result = await callNativeMethod(
				'uk.co.protonn.secure-messaging.onekey.unlock',
				[],
			)
			if (result.status !== 'unlocked') throw new Error(result.message)
			secret = decode64(result.secret, 32)
			await mobileVault.useOneKey(secret, userId)
			clearDecryptedContent()
			notice(
				'OneKey unlocked',
				`Compare this fingerprint with your PC:\n${formatFingerprint(ownPublicIdentity(userId).fingerprint)}`,
			)
		} catch (error) {
			notice(
				'OneKey unlock blocked',
				error instanceof Error ? error.message : String(error),
			)
		} finally {
			secret?.fill(0)
			setUnlocking(false)
		}
	}
	const importBackup = async () => {
		if (!userId) return
		setImporting(true)
		try {
			const imported = openIdentityBackup(backup.trim(), password)
			if (imported.userId !== userId)
				throw new Error('This backup belongs to a different Discord account')
			if (imported.version === 2) await replaceAccount(userId, imported)
			else await replaceIdentity(userId, imported.identity)
			clearDecryptedContent()
			setBackup('')
			setPassword('')
			notice(
				'PC identity imported',
				imported.version === 2
					? `Mobile now has the PC identity, ${Object.keys(imported.trusted).length} trusted peer keys, and ${Object.keys(imported.conversations).length} protected conversations.`
					: 'Mobile now uses the same identity as your PC. Protected conversations were disabled until you review and re-enable them.',
			)
		} catch (error) {
			notice(
				'Import blocked',
				error instanceof Error ? error.message : String(error),
			)
		} finally {
			setImporting(false)
		}
	}
	return (
		<Page>
			<ScrollView keyboardShouldPersistTaps="handled">
				<Stack spacing={16}>
					<TableRowGroup title="Nightly updates">
						<TableRow
							label="ProtonnCord Mobile"
							subLabel="Install the Android build tested against the latest desktop nightly. Reload Discord after updating."
						/>
						<Button
							text={updating ? 'Checking nightly…' : 'Update from nightly'}
							disabled={updating}
							onPress={async () => {
								setUpdating(true)
								try {
									await installNightlyUpdates()
									notice(
										'Nightly ready',
										'The hosted runtime and nightly plugin repository are configured. Reload Discord to apply any pending update.',
									)
								} catch (error) {
									notice(
										'Update failed',
										error instanceof Error ? error.message : String(error),
									)
								} finally {
									setUpdating(false)
								}
							}}
						/>
					</TableRowGroup>
					<TableRowGroup title="OneKey Classic 1S">
						<TableRow
							label={
								mobileVault.locked
									? 'Locked'
									: mobileVault.configured
										? 'Unlocked'
										: 'Use the same identity as your PC'
							}
							subLabel="Connect your OneKey directly to this phone with a USB data cable. Enter the PIN and approve on the OneKey."
						/>
						<Button
							disabled={!userId || unlocking}
							onPress={unlockOneKey}
							text={
								unlocking
									? 'Waiting for OneKey…'
									: mobileVault.configured
										? 'Unlock with OneKey'
										: 'Set up OneKey'
							}
							variant="primary"
						/>
						{mobileVault.configured && !mobileVault.locked && (
							<Button
								text="Lock Secure Messaging"
								onPress={() => {
									mobileVault.lock()
									clearDecryptedContent()
								}}
							/>
						)}
						{unlocking && (
							<Button
								text="Cancel"
								onPress={() =>
									callNativeMethodSync(
										'uk.co.protonn.secure-messaging.onekey.cancel',
										[],
									)
								}
							/>
						)}
					</TableRowGroup>
					<TableRowGroup title="Identity">
						<TableRow
							label={userId ?? 'No signed-in Discord account'}
							subLabel={own ? formatFingerprint(own.fingerprint) : undefined}
						/>
					</TableRowGroup>
					<TableRowGroup title="Bring your PC chats">
						<TableRow
							label="OneKey-encrypted phone pairing"
							subLabel="On your PC, unlock Secure Messaging and choose Copy phone pairing. Paste it here to import verified contacts, protected conversations and older history keys."
						/>
						<TextInput
							label="Phone pairing"
							placeholder="PCMP1:…"
							value={pairing}
							onChange={setPairing}
						/>
						<Button
							text={pairingBusy ? 'Importing…' : 'Import PC chats'}
							disabled={
								pairingBusy ||
								!mobileVault.ready ||
								!mobileVault.configured ||
								!pairing.trim()
							}
							onPress={async () => {
								if (!userId) return
								setPairingBusy(true)
								try {
									await mobileVault.importPairing(pairing.trim(), userId)
									setPairing('')
									clearDecryptedContent()
									notice(
										'PC chats imported',
										'Verified contacts and protected conversations are ready. Open the same DM on your phone. Any changed membership or pending key still requires review.',
									)
								} catch (error) {
									notice(
										'Pairing blocked',
										error instanceof Error ? error.message : String(error),
									)
								} finally {
									setPairingBusy(false)
								}
							}}
						/>
					</TableRowGroup>
					<TableRowGroup title="Use your PC identity">
						<Stack spacing={8}>
							<TextInput
								label="Encrypted identity backup"
								onChange={setBackup}
								placeholder="PCIB1:..."
								value={backup}
							/>
							<TextInput
								label="Backup password"
								onChange={setPassword}
								secureTextEntry
								value={password}
							/>
							<Button
								disabled={
									importing || !mobileVault.ready || !backup.trim() || !password
								}
								onPress={importBackup}
								text={importing ? 'Importing…' : 'Import PC identity'}
								variant="primary"
							/>
						</Stack>
					</TableRowGroup>
					<TableRowGroup title="Usage">
						<TableRow
							label="Send /pc help in a DM"
							subLabel="Commands are handled locally and are not posted."
						/>
					</TableRowGroup>
					<Text color="text-muted" variant="text-sm/normal">
						Text and attachments are encrypted. Calls, reactions, edits, and
						notifications are not encrypted in this alpha.
					</Text>
				</Stack>
			</ScrollView>
		</Page>
	)
}

export default plugin({
	SettingsComponent,
	async start({ cleanup }) {
		setRandomSource(size =>
			decode64(
				callNativeMethodSync('uk.co.protonn.secure-messaging.random', [size]),
				size,
			),
		)
		cleanup(() => clearDecryptedContent())
		cleanup(() => mobileVault.lock())
		patchMessageRenderer(cleanup)
		cleanup(
			getModules(
				withProps<any>('sendMessage', 'editMessage'),
				messageActions => {
					if (typeof messageActions.patchMessageAttachments === 'function')
						setAttachmentPatcher(
							messageActions.patchMessageAttachments.bind(messageActions),
						)
					cleanup(
						instead(
							messageActions,
							'sendMessage',
							async function (args, original) {
								const [channelId, message] = args as [string, any]
								try {
									const text =
										typeof message?.content === 'string' ? message.content : ''
									const command = await localCommand(channelId, text)
									if (command === null) return undefined
									if (typeof command === 'string') {
										return original.apply(this, [
											channelId,
											{ ...message, content: command },
											...args.slice(2),
										])
									}
									const userId = currentUserId()
									if (!userId) throw new Error('Discord user is unavailable')
									if (!mobileVault.protectedChannel(userId, channelId))
										return original.apply(this, args)
									requireDm(channelId)
									const state = account(userId)
									const policy = captureSendPolicy(
										state,
										channelId,
										memberSnapshot(channelId, userId),
									)
									const assertSendCurrent = () => {
										if (
											currentUserId() !== userId ||
											!mobileVault.ready ||
											mobileVault.locked ||
											account(userId) !== state
										)
											throw new Error(
												'Secure Messaging was locked or the account changed while preparing this send',
											)
										policy.assertCurrent(
											state,
											memberSnapshot(channelId, userId),
										)
									}
									const options = args[3] as any
									if (
										message?.stickerIds?.length ||
										message?.sticker_ids?.length ||
										options?.stickerIds?.length ||
										message?.messageSnapshots?.length ||
										message?.message_snapshots?.length ||
										message?.messageReference?.type === 1 ||
										message?.message_reference?.type === 1
									)
										throw new Error(
											'Stickers and forwards are not supported in protected mobile conversations yet',
										)
									const uploads = Array.isArray(
										(args[3] as any)?.attachmentsToUpload,
									)
										? ((args[3] as any).attachmentsToUpload as any[])
										: []
									const prepared = uploads.length
										? await prepareEncryptedUploads(
												uploads,
												text,
												channelId,
												userId,
											)
										: null
									assertSendCurrent()
									state.counter += 1
									const encrypted = encryptMessage({
										channelId,
										identity: state.identity,
										plaintext: prepared?.plaintext ?? text,
										recipients: policy.recipients,
										senderUserId: userId,
										counter: state.counter,
									})
									await saveVault()
									assertSendCurrent()
									prepared?.apply()
									return original.apply(this, [
										channelId,
										{ ...message, content: encrypted },
										...args.slice(2),
									])
								} catch (error) {
									notice(
										'Secure send blocked',
										error instanceof Error ? error.message : String(error),
									)
									return undefined
								}
							},
						),
						instead(messageActions, 'editMessage', function (args, original) {
							const userId = currentUserId()
							if (
								!mobileVault.ready ||
								(userId &&
									mobileVault.protectedChannel(userId, String(args[0])))
							) {
								notice(
									'Encrypted edit blocked',
									'Editing protected messages is not supported in this alpha.',
								)
								return undefined
							}
							return original.apply(this, args)
						}),
					)
				},
			),
		)
		try {
			await loadVault()
			const userId = currentUserId()
			if (userId && mobileVault.ready) {
				account(userId)
				await saveVault()
			}
		} catch {
			notice(
				'Secure Messaging unavailable',
				'The vault could not be loaded. Protected sends are blocked. Restart the app and check the plugin settings.',
			)
		}
	},
})
