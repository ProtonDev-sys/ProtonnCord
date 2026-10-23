/* SPDX-License-Identifier: GPL-3.0-or-later */
import type { ReactElement } from 'react'
import type { ScrollView } from 'react-native'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import type { WorkletFunction } from 'react-native-worklets'

// Checked by lint:types; this fixture is never part of the plugin bundle.
export function checkHostTypePeers(
	value: SharedValue<number>,
	ref: AnimatedRef<ScrollView>,
	worklet: WorkletFunction<[number], string>,
	element: ReactElement<{ visible: boolean }>,
) {
	value.value = 1
	ref.current?.scrollTo({ y: 1 })
	const result: string = worklet(1)
	const visible: boolean = element.props.visible

	// @ts-expect-error Shared values must retain their value type.
	value.value = 'invalid'
	// @ts-expect-error Native view refs must retain the ScrollView API.
	ref.current?.scrollTo({ y: 'invalid' })
	// @ts-expect-error Worklet arguments must retain their declared types.
	worklet('invalid')
	// @ts-expect-error React props must retain their declared types.
	const invalid: number = element.props.visible
	return { result, visible, invalid }
}
