/* SPDX-License-Identifier: GPL-3.0-or-later */
import type { Account } from './vaultState'

export function captureSendPolicy(
	state: Account,
	channelId: string,
	members: string[],
) {
	const conversation = state.conversations[channelId]
	if (!conversation || conversation.needsReview)
		throw new Error('Review this conversation and run /pc on before sending')
	const identity = state.identity
	const expectedMembers = JSON.stringify(conversation.members)
	const selected = [...conversation.recipients]
	const recipients = selected.map(id => {
		const trusted = state.trusted[id]
		if (
			!trusted ||
			(state.pending[id] &&
				state.pending[id].fingerprint !== trusted.fingerprint)
		)
			throw new Error('A recipient needs key review')
		return { ...trusted }
	})
	function assertCurrent(current: Account, currentMembers: string[]): void {
		if (
			current !== state ||
			state.identity !== identity ||
			state.conversations[channelId] !== conversation ||
			conversation.needsReview ||
			JSON.stringify(conversation.recipients) !== JSON.stringify(selected)
		)
			throw new Error('Encryption settings changed while preparing this send')
		if (JSON.stringify(currentMembers) !== expectedMembers)
			throw new Error('DM membership changed; run /pc on again after review')
		for (const recipient of recipients) {
			const trusted = state.trusted[recipient.userId]
			if (
				!trusted ||
				trusted.fingerprint !== recipient.fingerprint ||
				trusted.signingPublicKey !== recipient.signingPublicKey ||
				trusted.hpkePublicKey !== recipient.hpkePublicKey ||
				(state.pending[recipient.userId] &&
					state.pending[recipient.userId].fingerprint !== recipient.fingerprint)
			)
				throw new Error('A recipient key changed while preparing this send')
		}
	}
	assertCurrent(state, members)
	return { recipients, assertCurrent }
}
