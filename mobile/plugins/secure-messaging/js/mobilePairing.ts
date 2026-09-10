/* SPDX-License-Identifier: GPL-3.0-or-later */
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
	parseIdentity,
	parsePublicIdentity,
	parseState,
} from './identityBackup'
import { decode64, decodeUtf8, requireSnowflake, utf8Bytes } from './protocol'
import type { PrivateIdentity, PublicIdentity } from './protocol'

const CONTEXT = 'ProtonnCord/SecureMessaging/mobile-pairing/v1'
export interface HistoricalIdentity<T> {
	identity: T
	retiredAt: number
}

function history<T>(
	raw: unknown,
	parse: (value: unknown) => T,
): HistoricalIdentity<T>[] {
	if (!Array.isArray(raw) || raw.length > 4)
		throw new Error('Phone pairing history is invalid')
	return raw.map(record => {
		if (
			!record ||
			typeof record !== 'object' ||
			Object.keys(record).sort().join() !== 'identity,retiredAt' ||
			!Number.isSafeInteger(record.retiredAt) ||
			record.retiredAt < 1_700_000_000_000 ||
			record.retiredAt > Date.now() + 60_000
		)
			throw new Error('Phone pairing history cutoff is invalid')
		return { identity: parse(record.identity), retiredAt: record.retiredAt }
	})
}

export function openMobilePairing(
	token: string,
	root: Uint8Array,
	rootFingerprint: string,
	userId: string,
) {
	if (!token.startsWith('PCMP1:') || token.length > 3 * 1024 * 1024)
		throw new Error('Invalid phone pairing')
	const fields = token.slice(6).split('.')
	if (
		fields.length !== 4 ||
		fields[0] !== userId ||
		fields[1] !== rootFingerprint
	)
		throw new Error(
			'Phone pairing requires the same OneKey and Discord account as the PC',
		)
	const key = hkdf(
		sha256,
		root,
		decode64(rootFingerprint, 32),
		utf8Bytes(CONTEXT),
		32,
	)
	let bytes: Uint8Array | undefined
	try {
		bytes = gcm(
			key,
			decode64(fields[2], 12),
			utf8Bytes(JSON.stringify([CONTEXT, userId, rootFingerprint])),
		).decrypt(decode64(fields[3]))
		const value = JSON.parse(decodeUtf8(bytes))
		if (
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value) ||
			value.version !== 1 ||
			value.userId !== userId ||
			Object.keys(value).sort().join() !==
				'conversations,createdAt,currentFingerprint,identityHistory,peerIdentityHistory,trusted,userId,version' ||
			!Number.isSafeInteger(value.createdAt) ||
			value.createdAt < 1_700_000_000_000 ||
			value.createdAt > Date.now() + 60_000
		)
			throw new Error('Invalid phone pairing state')
		decode64(value.currentFingerprint, 32)
		const identityHistory = history<PrivateIdentity>(
			value.identityHistory,
			parseIdentity,
		)
		if (
			!value.peerIdentityHistory ||
			typeof value.peerIdentityHistory !== 'object' ||
			Array.isArray(value.peerIdentityHistory) ||
			Object.keys(value.peerIdentityHistory).length > 2000
		)
			throw new Error('Invalid phone pairing contacts')
		const peerIdentityHistory: Record<
			string,
			HistoricalIdentity<PublicIdentity>[]
		> = {}
		for (const [id, records] of Object.entries(value.peerIdentityHistory)) {
			requireSnowflake(id, 'historical contact')
			if (id === userId) throw new Error('Invalid historical contact')
			peerIdentityHistory[id] = history(records, raw =>
				parsePublicIdentity(raw, id),
			)
		}
		return {
			...parseState(value, userId),
			identityHistory,
			peerIdentityHistory,
			createdAt: value.createdAt as number,
			currentFingerprint: value.currentFingerprint as string,
		}
	} finally {
		key.fill(0)
		bytes?.fill(0)
	}
}
