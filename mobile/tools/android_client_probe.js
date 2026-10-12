/* SPDX-License-Identifier: GPL-3.0-or-later */
/* global plugin, revenge, nativeLoggingHook */
function _androidClientProbe() {
	return {
		default: plugin({
			async start({ cleanup }) {
				const id = 'uk.co.protonn.secure-messaging'
				const { callNativeMethod: call, callNativeMethodSync: sync } =
					revenge.modules.native
				const assert = (condition, message) => {
					if (!condition) throw new Error(message)
				}
				try {
					const store = await new Promise((resolve, reject) => {
						const timer = setTimeout(
							() => reject(new Error('UserStore did not initialize')),
							20_000,
						)
						cleanup(() => clearTimeout(timer))
						cleanup(
							revenge.discord.flux.getStore('UserStore', value => {
								clearTimeout(timer)
								resolve(value)
							}),
						)
					})
					assert(!store.getCurrentUser(), 'The emulator must remain signed out')
					const loader = sync('revenge.info', [])
					assert(
						loader?.name === 'RevengeXposed' && loader?.version === '1.6.2',
						'Wrong native loader',
					)
					const installed = sync('revenge.plugins.list', []).find(
						item => item.manifest.id === id,
					)
					assert(
						installed && !installed.failed && !installed.errors?.length,
						'Native plugin failed to load',
					)
					const random = sync(`${id}.random`, [32])
					assert(
						/^[A-Za-z0-9_-]{43}$/.test(random),
						'Native random bytes are unavailable',
					)
					assert(
						(await call(`${id}.vault.load`, [])) === null,
						'Signed-out startup created a vault',
					)
					const runtimeUrl = sync(`${id}.loader.runtimeUrl`, [])
					assert(
						runtimeUrl === __PROTONNCORD_RUNTIME_URL__,
						'Wrong native runtime pin',
					)
					assert(
						(await call(`${id}.loader.configure`, [runtimeUrl])) === true,
						'Native loader configuration failed',
					)
					nativeLoggingHook(
						`PROTONNCORD_ANDROID_PASS ${JSON.stringify({ loader, signedOut: true, nativePlugin: id, vault: 'absent', runtimeUrl })}`,
						1,
					)
				} catch (error) {
					nativeLoggingHook(
						`PROTONNCORD_ANDROID_FAIL ${JSON.stringify({ message: String(error), stack: error?.stack })}`,
						2,
					)
					throw error
				}
			},
		}),
	}
}
