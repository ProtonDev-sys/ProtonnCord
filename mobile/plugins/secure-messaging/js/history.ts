/* SPDX-License-Identifier: GPL-3.0-or-later */
import { requireSnowflake } from './protocol'
import type { PublicIdentity } from './protocol'
import type { Account } from './vaultState'

export function discordMessageTime(id: string): number {
	requireSnowflake(id, 'message ID')
	return Number((BigInt(id) >> 22n) + 1420070400000n)
}

export function historicalMessageAllowed(
	messageId: string,
	envelopeTime: number,
	retiredAt: number,
	editedAt?: number,
): boolean {
	return (
		Number.isSafeInteger(retiredAt) &&
		envelopeTime < retiredAt &&
		discordMessageTime(messageId) < retiredAt &&
		(editedAt === undefined ||
			(Number.isFinite(editedAt) && editedAt < retiredAt))
	)
}

export function observeAnnouncement(
	state: Account,
	candidate: PublicIdentity,
	messageId: string,
): boolean {
	const publishedAt = discordMessageTime(messageId)
	const peerId = candidate.userId
	const times = (state.announcementTimes ??= {})
	if (publishedAt <= (times[peerId] ?? 0)) return false
	times[peerId] = publishedAt
	const trusted = state.trusted[peerId]
	if (trusted?.fingerprint === candidate.fingerprint) return true
	state.pending[peerId] = candidate
	if (trusted) {
		const histories = (state.peerIdentityHistory ??= {})
		const history = (histories[peerId] ??= [])
		const existing = history.find(
			item => item.identity.fingerprint === trusted.fingerprint,
		)
		if (existing) existing.retiredAt = Math.min(existing.retiredAt, publishedAt)
		else history.push({ identity: trusted, retiredAt: publishedAt })
		histories[peerId] = history
			.sort((left, right) => right.retiredAt - left.retiredAt)
			.slice(0, 4)
		for (const conversation of Object.values(state.conversations))
			if (conversation.recipients.includes(peerId))
				conversation.needsReview = true
	}
	return true
}
