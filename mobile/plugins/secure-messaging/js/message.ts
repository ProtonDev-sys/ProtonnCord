export function withMessageContent<T extends object>(
	message: T,
	content: string,
	attachments?: unknown[],
): T & { content: string } {
	return Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
		content,
		...(attachments === undefined ? {} : { attachments }),
	})
}
