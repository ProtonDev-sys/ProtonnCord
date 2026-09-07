/* SPDX-License-Identifier: GPL-3.0-or-later */
import { decryptMessage, publicIdentity } from './crypto'
import { parseEnvelope } from './protocol'
import { acceptEnvelope } from './replay'
import { historicalMessageAllowed } from './history'
import type { Account } from './vaultState'
import type { Envelope } from './protocol'

interface Message {
	id: string
	content: string
	channelId: string
	authorId: string
	editedAt?: number
}
type Entry = {
	account: Account
	plaintext?: string
	error?: string
	envelope?: Envelope
}

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
			message.editedAt,
		])
		const cached = this.cache.get(key)
		if (cached?.account === state) {
			if (cached.error) throw new Error(cached.error)
			if (cached.plaintext === undefined) return undefined
			if (!this.valid(state)) throw new Error('Secure Messaging is locked')
			// An accepted edit can invalidate a previously rendered cached version.
			// Eviction from the persistent window also requires a fresh save.
			if (
				cached.envelope &&
				acceptEnvelope(
					state.replay ?? [],
					cached.envelope,
					message.content,
					message.id,
				) === state.replay
			)
				return cached.plaintext
			this.cache.delete(key)
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
			const localHistory = (state.identityHistory ?? []).filter(item =>
				historicalMessageAllowed(
					message.id,
					envelope.d,
					item.retiredAt,
					message.editedAt,
				),
			)
			const identities = [
				state.identity,
				...localHistory.map(item => item.identity),
			]
			const peerHistory = state.peerIdentityHistory?.[message.authorId] ?? []
			const trusted = state.trusted[message.authorId]
			const trustedRetirement = peerHistory.find(
				item => item.identity.fingerprint === trusted?.fingerprint,
			)
			const currentSender =
				trusted &&
				(!trustedRetirement ||
					!state.pending[message.authorId] ||
					historicalMessageAllowed(
						message.id,
						envelope.d,
						trustedRetirement.retiredAt,
						message.editedAt,
					))
					? trusted
					: undefined
			const sender =
				message.authorId === userId
					? identities
							.map(identity => publicIdentity(identity, userId))
							.find(identity => identity.fingerprint === envelope.k)
					: currentSender?.fingerprint === envelope.k
						? currentSender
						: peerHistory.find(
								item =>
									item.identity.fingerprint === envelope.k &&
									historicalMessageAllowed(
										message.id,
										envelope.d,
										item.retiredAt,
										message.editedAt,
									),
							)?.identity
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
			entry.envelope = result.envelope
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
