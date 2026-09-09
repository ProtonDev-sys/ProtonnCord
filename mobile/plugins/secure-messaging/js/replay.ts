/* SPDX-License-Identifier: GPL-3.0-or-later */
import { sha256 } from '@noble/hashes/sha2.js'
import { encode64, requireSnowflake, utf8Bytes } from './protocol'
import type { Envelope } from './protocol'

export interface ReplayRecord {
	messageId: string
	channelId: string
	authorId: string
	fingerprint: string
	envelopeId: string
	counter: number
	digest: string
}

// Called only after signature and AEAD authentication. Persist the returned
// record set before making plaintext visible; receiving history need not be ordered.
export function acceptEnvelope(
	records: ReplayRecord[],
	envelope: Envelope,
	content: string,
	messageId: string,
): ReplayRecord[] {
	requireSnowflake(messageId, 'message ID')
	const next: ReplayRecord = {
		messageId,
		channelId: envelope.c,
		authorId: envelope.s,
		fingerprint: envelope.k,
		envelopeId: envelope.i,
		counter: envelope.q,
		digest: encode64(sha256(utf8Bytes(content))),
	}
	if (
		records.some(
			previous =>
				previous.channelId === next.channelId &&
				previous.messageId === next.messageId &&
				previous.counter > next.counter,
		)
	)
		throw new Error('Encrypted message edit is stale')
	for (const previous of records) {
		const sameMessage =
			previous.channelId === next.channelId &&
			previous.messageId === next.messageId
		if (sameMessage && previous.digest === next.digest) return records
		if (
			sameMessage &&
			(previous.authorId !== next.authorId ||
				previous.fingerprint !== next.fingerprint ||
				next.counter <= previous.counter)
		)
			throw new Error('Encrypted message edit is stale or changed identity')
		if (
			previous.authorId === next.authorId &&
			previous.fingerprint === next.fingerprint &&
			(previous.envelopeId === next.envelopeId ||
				previous.counter === next.counter)
		)
			throw new Error(
				'Encrypted envelope or counter was already used by another message',
			)
	}
	return [...records, next].slice(-4096)
}
