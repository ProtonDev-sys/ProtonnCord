import assert from 'node:assert/strict'
import test from 'node:test'
import { withMessageContent } from '../plugins/secure-messaging/js/message'

test('rendered messages retain Discord prototype methods', () => {
	class DiscordMessage {
		content = 'encrypted'
		isGroupDm() {
			return true
		}
	}

	const rendered = withMessageContent(new DiscordMessage(), 'decrypted')

	assert.equal(rendered.content, 'decrypted')
	assert.equal(rendered.isGroupDm(), true)
})
