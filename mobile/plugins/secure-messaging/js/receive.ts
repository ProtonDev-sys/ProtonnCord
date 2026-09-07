/* SPDX-License-Identifier: GPL-3.0-or-later */
import { decryptMessage, publicIdentity } from './crypto'
import { parseEnvelope } from './protocol'
import { acceptEnvelope } from './replay'
import type { Account } from './vaultState'

interface Message {
	id: string
	content: string
	channelId: string
	authorId: string
}
type Entry = { account: Account; plaintext?: string; error?: string }

export class MessageReceiver {
	private readonly cache = new Map<string, Entry>()
	private generation = 0
	constructor(
		private readonly save: () => Promise<void>,
		private readonly valid: (account: Account) => boolean,
	) {}
	clear(): void {
		this.generation++
		this.cache.clear()
	}
	render(
		message: Message,
		state: Account,
		userId: string,
		refresh: () => void,
	): string | undefined {
		const key = JSON.stringify([
			userId,
			message.channelId,
			message.id,
			message.content,
		])
		const cached = this.cache.get(key)
		if (cached?.account === state) {
			if (cached.error) throw new Error(cached.error)
			return cached.plaintext
		}
		if (this.cache.size >= 256)
			this.cache.delete(this.cache.keys().next().value!)
		const entry: Entry = { account: state }
		this.cache.set(key, entry)
		const generation = this.generation
		void (async () => {
			const envelope = parseEnvelope(
				message.content,
				message.channelId,
				message.authorId,
			)
			const identities = [state.identity, ...(state.retiredIdentities ?? [])]
			const sender =
				message.authorId === userId
					? identities
							.map(identity => publicIdentity(identity, userId))
							.find(identity => identity.fingerprint === envelope.k)
					: state.trusted[message.authorId]
			if (!sender) throw new Error('Sender key is not trusted')
			let result: ReturnType<typeof decryptMessage> | undefined
			let failure: unknown
			for (const identity of identities) {
				try {
					result = decryptMessage({
						...message,
						identity,
						localUserId: userId,
						sender,
					})
					break
				} catch (error) {
					failure = error
				}
			}
			if (!result) throw failure
			state.replay = acceptEnvelope(
				state.replay ?? [],
				result.envelope,
				message.content,
				message.id,
			)
			await this.save()
			if (generation !== this.generation || !this.valid(state)) return
			entry.plaintext = result.plaintext
			refresh()
		})().catch(error => {
			if (generation !== this.generation) return
			entry.error =
				error instanceof Error ? error.message : 'Message authentication failed'
			refresh()
		})
		return undefined
	}
}
