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
	editedAt?: number,
): boolean {
	const createdAt = discordMessageTime(messageId)
	const publishedAt = editedAt ?? createdAt
	if (
		!Number.isSafeInteger(publishedAt) ||
		publishedAt < createdAt ||
		publishedAt > Date.now() + 5 * 60_000
	)
		throw new Error('Announcement publication timestamp is invalid')
	const peerId = candidate.userId
	const times = (state.announcementTimes ??= {})
	const trusted = state.trusted[peerId]
	if (trusted?.fingerprint === candidate.fingerprint) return false
	if (publishedAt <= (state.trustedAnnouncementTimes?.[peerId] ?? 0))
		return false
	if (state.pending[peerId] && publishedAt <= (times[peerId] ?? 0)) return false
	times[peerId] = publishedAt
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

export function approveAnnouncement(state: Account, peerId: string): void {
	const candidate = state.pending[peerId]
	if (!candidate) throw new Error('No pending announcement for this user')
	const previous = state.trusted[peerId]
	state.trusted[peerId] = candidate
	const publishedAt = state.announcementTimes?.[peerId]
	if (publishedAt !== undefined)
		(state.trustedAnnouncementTimes ??= {})[peerId] = publishedAt
	delete state.pending[peerId]
	if (previous && previous.fingerprint !== candidate.fingerprint)
		for (const conversation of Object.values(state.conversations))
			if (conversation.recipients.includes(peerId))
				conversation.needsReview = true
}
