/* SPDX-License-Identifier: GPL-3.0-or-later */
// Deno 2.7 resolves workspace imports itself but Rolldown's Node resolver needs
// the corresponding node_modules links. No upstream source is modified.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(process.argv[2])
for (const directory of ['lib', 'plugins']) {
	if (!existsSync(join(root, directory))) continue
	for (const entry of readdirSync(join(root, directory), {
		withFileTypes: true,
	})) {
		if (!entry.isDirectory()) continue
		const source = join(root, directory, entry.name)
		const file = join(source, 'package.json')
		if (!existsSync(file)) continue
		const { name } = JSON.parse(readFileSync(file, 'utf8'))
		if (!/^@revenge-mod\/[a-z0-9-]+$/.test(name))
			throw new Error('Unexpected runtime workspace name')
		const target = join(root, 'node_modules', name)
		mkdirSync(dirname(target), { recursive: true })
		if (!existsSync(target))
			symlinkSync(
				source,
				target,
				process.platform === 'win32' ? 'junction' : 'dir',
			)
	}
}
