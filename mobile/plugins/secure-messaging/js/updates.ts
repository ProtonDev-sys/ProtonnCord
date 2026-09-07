/* SPDX-License-Identifier: GPL-3.0-or-later */
import {
	exists,
	getConstants,
	readFile,
	writeFile,
} from '@revenge-mod/modules/native/fs'
import { callNativeMethod } from '@revenge-mod/modules/native'

interface Repo {
	url: string
	enabled: boolean
	internal: boolean
}
interface InstallPlan {
	actions: Array<{ id: string; repo: string }>
	warnings: string[]
}
declare module '@revenge-mod/modules/native' {
	export interface NativeMethods {
		'revenge.plugins.repos.list': [[], Repo[]]
		'revenge.plugins.repos.set': [
			[config: Array<{ url: string; enabled: boolean }>],
			null,
		]
		'revenge.plugins.repos.refresh': [[url: string], Repo]
		'revenge.plugins.planInstall': [
			[
				id: string,
				version: string | null,
				channel: string | null,
				repos: string[] | null,
			],
			InstallPlan,
		]
		'revenge.plugins.install': [
			[plan: InstallPlan],
			{ installed: string[]; pending: string[]; skipped: string[] },
		]
	}
}

export const NIGHTLY_REPOSITORY =
	'https://github.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-nightly'
const RUNTIME_URL =
	'https://github.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-runtime-6f22fe1/revenge.bundle'
const ID = 'uk.co.protonn.secure-messaging'

export async function installNightlyUpdates(): Promise<boolean> {
	const repos = await callNativeMethod('revenge.plugins.repos.list', [])
	if (!repos.some(repo => repo.url === NIGHTLY_REPOSITORY && repo.enabled)) {
		await callNativeMethod('revenge.plugins.repos.set', [
			[
				{ url: NIGHTLY_REPOSITORY, enabled: true },
				...repos
					.filter(repo => !repo.internal && repo.url !== NIGHTLY_REPOSITORY)
					.map(repo => ({ url: repo.url, enabled: repo.enabled })),
			],
		])
	}
	await callNativeMethod('revenge.plugins.repos.refresh', [NIGHTLY_REPOSITORY])
	const plan = await callNativeMethod('revenge.plugins.planInstall', [
		ID,
		null,
		'nightly',
		[NIGHTLY_REPOSITORY],
	])
	if (
		plan.actions.some(
			action => action.id !== ID || action.repo !== NIGHTLY_REPOSITORY,
		)
	)
		throw new Error(
			'The nightly update requested an unexpected plugin or repository',
		)
	const result = await callNativeMethod('revenge.plugins.install', [plan])
	// Change the temporary loader only after both HTTPS endpoints are reachable.
	const response = await fetch(RUNTIME_URL, { method: 'HEAD' })
	if (!response.ok)
		throw new Error(
			'The mobile runtime download is unavailable; the existing loader was kept',
		)
	const path = `${getConstants().files}/pyoncord/loader.json`
	const config = (await exists(path)) ? JSON.parse(await readFile(path)) : {}
	if (!config || typeof config !== 'object' || Array.isArray(config))
		throw new Error('The Revenge loader configuration is invalid')
	await writeFile(`${path}.protonn-backup`, JSON.stringify(config))
	await writeFile(
		path,
		JSON.stringify({
			...config,
			customLoadUrl: { enabled: true, url: RUNTIME_URL },
		}),
	)
	return result.pending.length > 0
}
