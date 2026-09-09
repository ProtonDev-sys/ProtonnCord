/* SPDX-License-Identifier: GPL-3.0-or-later */
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!/^0\.2\.\d+\.\d+-nightly$/.test(version ?? ''))
	throw new Error('Expected a nightly build version')
const manifestPath = 'plugins/secure-messaging/manifest.json'
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.version = version
writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n')
const config = JSON.parse(readFileSync('repo.config.json', 'utf8'))
config.channels[manifest.id] = {
	latest: version,
	beta: version,
	nightly: version,
}
writeFileSync('repo.config.json', JSON.stringify(config, null, '\t') + '\n')
