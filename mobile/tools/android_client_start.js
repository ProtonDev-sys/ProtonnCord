/* SPDX-License-Identifier: GPL-3.0-or-later */
/* global plugin, revenge, nativeLoggingHook */
function _observeAndroidStart() {
	// Use the pinned host's evaluator on the unchanged built script. Its start
	// loop does not await dependencies, so native load alone is insufficient.
	const exports = new Function(
		'revenge',
		'plugin',
		`return ${__PROTONNCORD_PLUGIN_SCRIPT__}`,
	)(revenge, plugin)
	const start = exports.default.start
	if (typeof start !== 'function')
		throw new Error('Secure Messaging start is missing')
	exports.default.start = async function (...args) {
		try {
			const result = await start.apply(this, args)
			nativeLoggingHook(
				'PROTONNCORD_ANDROID_JS_STARTED {"plugin":"uk.co.protonn.secure-messaging","started":true}',
				1,
			)
			return result
		} catch (error) {
			nativeLoggingHook(
				`PROTONNCORD_ANDROID_FAIL ${JSON.stringify({ phase: 'plugin-start', message: String(error), stack: error?.stack })}`,
				2,
			)
			throw error
		}
	}
	return exports
}
