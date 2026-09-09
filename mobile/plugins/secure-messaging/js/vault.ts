/* SPDX-License-Identifier: GPL-3.0-or-later */

import { callNativeMethod } from '@revenge-mod/modules/native'
import { publicIdentity } from './crypto'
import { MobileVault } from './vaultState'
import type { Account } from './vaultState'
import type { PrivateIdentity } from './protocol'

export type { Account, Conversation } from './vaultState'

export const mobileVault = new MobileVault({
	read: () => callNativeMethod('uk.co.protonn.secure-messaging.vault.load', []),
	write: async snapshot => {
		const result = await callNativeMethod(
			'uk.co.protonn.secure-messaging.vault.save',
			[snapshot],
		)
		if (result !== true) throw new Error('The mobile vault could not be saved')
	},
})
export const loadVault = () => mobileVault.load()
export const account = (userId: string) => mobileVault.account(userId)
export const ownPublicIdentity = (userId: string) =>
	publicIdentity(account(userId).identity, userId)
export const saveVault = () => mobileVault.save()
export const subscribe = (listener: () => void) =>
	mobileVault.subscribe(listener)
export const replaceAccount = (
	userId: string,
	state: Pick<Account, 'identity' | 'trusted' | 'conversations'>,
) => mobileVault.replace(userId, state)
export function replaceIdentity(
	userId: string,
	identity: PrivateIdentity,
): Promise<void> {
	return replaceAccount(userId, {
		identity,
		trusted: account(userId).trusted,
		conversations: {},
	})
}

declare module '@revenge-mod/modules/native' {
	export interface NativeMethods {
		'uk.co.protonn.secure-messaging.attachment.read': [[uri: string], string]
		'uk.co.protonn.secure-messaging.attachment.share': [[path: string], string]
		'uk.co.protonn.secure-messaging.random': [[size: number], string]
		'uk.co.protonn.secure-messaging.vault.load': [[], string | null]
		'uk.co.protonn.secure-messaging.vault.save': [[plaintext: string], boolean]
		'uk.co.protonn.secure-messaging.vault.reset': [[], boolean]
		'uk.co.protonn.secure-messaging.onekey.status': [[], string]
		'uk.co.protonn.secure-messaging.onekey.cancel': [[], boolean]
		'uk.co.protonn.secure-messaging.onekey.unlock': [
			[],
			(
				| { status: 'unlocked'; secret: string }
				| { status: 'error'; message: string }
			),
		]
	}
}
