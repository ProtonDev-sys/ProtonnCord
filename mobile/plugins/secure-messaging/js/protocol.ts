/* SPDX-License-Identifier: GPL-3.0-or-later */

import { base64urlnopad } from '@scure/base'

export const KEY_PREFIX = 'PCEK1:'
export const MESSAGE_PREFIX = 'PCEM3:'
export const PREVIOUS_MESSAGE_PREFIX = 'PCEM2:'
export const MAX_MESSAGE_LENGTH = 2_000
export const MAX_RECIPIENTS = 24

const SNOWFLAKE = /^\d{17,20}$/

export interface PrivateIdentity {
	createdAt: number
	hpkePrivateKey: string
	hpkePublicKey: string
	signingPrivateKey: string
	signingPublicKey: string
}

export interface PublicIdentity {
	fingerprint: string
	hpkePublicKey: string
	signingPublicKey: string
	userId: string
}

export interface KeyAnnouncement {
	v: 1
	t: 'k'
	u: string
	d: number
	s: string
	e: string
	z: string
}

export interface WrappedKey {
	u: string
	e: string
	x: string
}

export interface Envelope {
	v: 2 | 3
	t: 'm'
	i: string
	c: string
	s: string
	d: number
	q: number
	k: string
	r: WrappedKey[]
	m?: string[]
	n: string
	x: string
	z: string
}

export type UnsignedEnvelope = Omit<Envelope, 'z'>

export function requireSnowflake(value: unknown, name: string): string {
	if (typeof value !== 'string' || !SNOWFLAKE.test(value))
		throw new Error(`${name} must be a Discord snowflake`)
	return value
}

export function encode64(bytes: Uint8Array): string {
	return base64urlnopad.encode(bytes)
}

export function utf8Bytes(value: string): Uint8Array {
	const bytes: number[] = []
	for (let index = 0; index < value.length; index++) {
		let point = value.charCodeAt(index)
		if (point >= 0xd800 && point <= 0xdbff) {
			const low = value.charCodeAt(++index)
			if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdfff)
				throw new Error('Invalid UTF-16 string')
			point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00)
		} else if (point >= 0xdc00 && point <= 0xdfff) {
			throw new Error('Invalid UTF-16 string')
		}
		if (point < 0x80) bytes.push(point)
		else if (point < 0x800)
			bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
		else if (point < 0x10000)
			bytes.push(
				0xe0 | (point >> 12),
				0x80 | ((point >> 6) & 0x3f),
				0x80 | (point & 0x3f),
			)
		else
			bytes.push(
				0xf0 | (point >> 18),
				0x80 | ((point >> 12) & 0x3f),
				0x80 | ((point >> 6) & 0x3f),
				0x80 | (point & 0x3f),
			)
	}
	return Uint8Array.from(bytes)
}

export function decodeUtf8(bytes: Uint8Array): string {
	let value = ''
	for (let index = 0; index < bytes.length; ) {
		const first = bytes[index++]!
		let point: number
		let continuation: number
		let minimum: number
		if (first < 0x80) {
			point = first
			continuation = 0
			minimum = 0
		} else if (first >= 0xc2 && first <= 0xdf) {
			point = first & 0x1f
			continuation = 1
			minimum = 0x80
		} else if (first >= 0xe0 && first <= 0xef) {
			point = first & 0x0f
			continuation = 2
			minimum = 0x800
		} else if (first >= 0xf0 && first <= 0xf4) {
			point = first & 0x07
			continuation = 3
			minimum = 0x10000
		} else throw new Error('Invalid UTF-8 plaintext')

		if (index + continuation > bytes.length)
			throw new Error('Invalid UTF-8 plaintext')
		for (let count = 0; count < continuation; count++) {
			const next = bytes[index++]!
			if ((next & 0xc0) !== 0x80) throw new Error('Invalid UTF-8 plaintext')
			point = (point << 6) | (next & 0x3f)
		}
		if (
			point < minimum ||
			point > 0x10ffff ||
			(point >= 0xd800 && point <= 0xdfff)
		)
			throw new Error('Invalid UTF-8 plaintext')
		if (point <= 0xffff) value += String.fromCharCode(point)
		else {
			point -= 0x10000
			value += String.fromCharCode(
				0xd800 | (point >> 10),
				0xdc00 | (point & 0x3ff),
			)
		}
	}
	return value
}

export function decode64(value: unknown, size?: number): Uint8Array {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
		throw new Error('Invalid base64url value')
	let bytes: Uint8Array
	try {
		bytes = base64urlnopad.decode(value)
	} catch {
		throw new Error('Invalid base64url value')
	}
	if (size !== undefined && bytes.length !== size)
		throw new Error(`Expected ${size} decoded bytes`)
	if (encode64(bytes) !== value)
		throw new Error('Non-canonical base64url value')
	return bytes
}

function timestamp(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		(value as number) >= 1_700_000_000_000 &&
		(value as number) <= 9_999_999_999_999
	)
}

export function canonicalAnnouncement(
	value: Omit<KeyAnnouncement, 'z'>,
): Uint8Array {
	return utf8Bytes(
		JSON.stringify({
			v: value.v,
			t: value.t,
			u: value.u,
			d: value.d,
			s: value.s,
			e: value.e,
		}),
	)
}

export function parseAnnouncement(content: string): KeyAnnouncement {
	if (!content.startsWith(KEY_PREFIX) || content.length > MAX_MESSAGE_LENGTH)
		throw new Error('Unsupported key announcement')
	const raw = content.slice(KEY_PREFIX.length)
	let value: any
	try {
		value = JSON.parse(raw)
	} catch {
		throw new Error('Malformed key announcement')
	}
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== 'd,e,s,t,u,v,z' ||
		value.v !== 1 ||
		value.t !== 'k' ||
		!timestamp(value.d)
	)
		throw new Error('Invalid key announcement')
	requireSnowflake(value.u, 'announcement user')
	decode64(value.s, 32)
	decode64(value.e, 32)
	decode64(value.z, 64)
	if (JSON.stringify(value) !== raw)
		throw new Error('Non-canonical key announcement')
	return value as KeyAnnouncement
}

export function header(
	value: Pick<
		UnsignedEnvelope,
		'v' | 'i' | 'c' | 's' | 'd' | 'q' | 'k' | 'r' | 'm'
	>,
): Uint8Array {
	const prefix = value.v === 3 ? MESSAGE_PREFIX : PREVIOUS_MESSAGE_PREFIX
	return utf8Bytes(
		JSON.stringify([
			prefix,
			value.i,
			value.c,
			value.s,
			value.d,
			value.q,
			value.k,
			value.r.map(recipient => recipient.u),
			...(value.v === 3 ? [value.m ?? []] : []),
		]),
	)
}

export function canonicalEnvelope(value: UnsignedEnvelope): Uint8Array {
	const prefix = value.v === 3 ? MESSAGE_PREFIX : PREVIOUS_MESSAGE_PREFIX
	return utf8Bytes(
		JSON.stringify([
			prefix,
			value.i,
			value.c,
			value.s,
			value.d,
			value.q,
			value.k,
			value.r.map(recipient => [recipient.u, recipient.e, recipient.x]),
			...(value.v === 3 ? [value.m ?? []] : []),
			value.n,
			value.x,
		]),
	)
}

function compact(value: Envelope): unknown[] {
	const prefix = [
		value.i,
		value.d,
		value.q,
		value.k,
		value.r.map(recipient => [recipient.u, recipient.e, recipient.x]),
	]
	return value.v === 3
		? [
				...prefix,
				(value.m ?? []).map(userId => `<@${userId}>`),
				value.n,
				value.x,
				value.z,
			]
		: [...prefix, value.n, value.x, value.z]
}

export function serializeEnvelope(value: Envelope): string {
	const prefix = value.v === 3 ? MESSAGE_PREFIX : PREVIOUS_MESSAGE_PREFIX
	const content = `${prefix}${JSON.stringify(compact(value))}`
	if (content.length > MAX_MESSAGE_LENGTH)
		throw new Error('Encrypted message exceeds Discord’s 2,000 character limit')
	return content
}

export function parseEnvelope(
	content: string,
	channelId: string,
	authorId: string,
): Envelope {
	requireSnowflake(channelId, 'channelId')
	requireSnowflake(authorId, 'authorId')
	const current = content.startsWith(MESSAGE_PREFIX)
	const isPrevious = content.startsWith(PREVIOUS_MESSAGE_PREFIX)
	if ((!current && !isPrevious) || content.length > MAX_MESSAGE_LENGTH)
		throw new Error('Unsupported encrypted message')
	const prefix = current ? MESSAGE_PREFIX : PREVIOUS_MESSAGE_PREFIX
	let wire: any
	try {
		wire = JSON.parse(content.slice(prefix.length))
	} catch {
		throw new Error('Malformed encrypted message')
	}
	if (
		!Array.isArray(wire) ||
		wire.length !== (current ? 9 : 8) ||
		!Array.isArray(wire[4]) ||
		(current && !Array.isArray(wire[5]))
	)
		throw new Error('Malformed encrypted envelope')
	const recipients: WrappedKey[] = wire[4].map((item: unknown) => {
		if (!Array.isArray(item) || item.length !== 3)
			throw new Error('Invalid encrypted recipient')
		return { u: item[0], e: item[1], x: item[2] }
	})
	const mentions = current
		? wire[5].map((mention: unknown) => {
				if (typeof mention !== 'string')
					throw new Error('Invalid encrypted mentioned user')
				const match = /^<@(\d{17,20})>$/.exec(mention)
				if (!match) throw new Error('Invalid encrypted mentioned user')
				return match[1]!
			})
		: undefined
	const value: Envelope = {
		v: current ? 3 : 2,
		t: 'm',
		i: wire[0],
		c: channelId,
		s: authorId,
		d: wire[1],
		q: wire[2],
		k: wire[3],
		r: recipients,
		...(current ? { m: mentions } : {}),
		n: wire[current ? 6 : 5],
		x: wire[current ? 7 : 6],
		z: wire[current ? 8 : 7],
	}
	decode64(value.i, 16)
	if (!timestamp(value.d) || !Number.isSafeInteger(value.q) || value.q < 1)
		throw new Error('Invalid encrypted envelope fields')
	decode64(value.k, 32)
	decode64(value.n, 12)
	if (decode64(value.x).length < 17) throw new Error('Invalid ciphertext')
	decode64(value.z, 64)
	if (recipients.length < 1 || recipients.length > MAX_RECIPIENTS + 1)
		throw new Error('Invalid recipient count')
	let previous = ''
	for (const recipient of recipients) {
		requireSnowflake(recipient.u, 'recipient')
		decode64(recipient.e, 32)
		decode64(recipient.x, 48)
		if (recipient.u <= previous) throw new Error('Recipients are not canonical')
		previous = recipient.u
	}
	if (current) {
		if (mentions.length > MAX_RECIPIENTS)
			throw new Error('Invalid encrypted mentioned users')
		const recipientIds = new Set(recipients.map(recipient => recipient.u))
		let previousMention = ''
		for (const userId of mentions) {
			requireSnowflake(userId, 'mentioned user')
			if (userId <= previousMention || !recipientIds.has(userId))
				throw new Error('Mentioned users are not canonical')
			previousMention = userId
		}
	}
	if (JSON.stringify(compact(value)) !== content.slice(prefix.length))
		throw new Error('Non-canonical encrypted envelope')
	return value
}
