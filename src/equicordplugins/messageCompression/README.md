# MessageCompression (nightly experiment)

MessageCompression is a standalone ProtonnCord plugin for automatically sending smaller, lossless text messages in one-to-one DMs. Both people enable **MessageCompression** in Plugins, restart if prompted, and use the normal message composer.

The plugin has its own settings, wire format, compatibility exchange and decoder. It does not depend on SecureMessaging or change that plugin.

## What happens in a conversation

1. When a text message could shrink, the plugin checks whether the other client has recently confirmed support.
2. If support is unknown, it sends a short, visible compatibility message through the normal pre-send policies. An ordinary first message still sends as plain text. An oversized first message waits briefly for the other client to answer.
3. After negotiation, the encoder searches a bounded set of exact representations and compares their complete wire sizes. It sends a compressed message only when it is smaller in both UTF-8 bytes and JavaScript string length, including the header and text-safe encoding.
4. The recipient reconstructs the original text locally. Decoding happens at the message model boundary, so chat history, copy, the edit composer and reply previews use the same text.

Short messages and messages that do not shrink retain their original content. Links, mentions, custom emoji, replies, forwards, attachments, stickers, scheduled messages and text-to-speech retain normal sending so Discord can keep processing their metadata.

An oversized message that cannot be safely represented within the wire limit is cancelled before sending, and the draft stays available. Existing text-formatting hooks run first. If SplitLargeMessages is enabled, it may split oversized input before MessageCompression runs; disable splitting when experimenting with a single compressed message.

## Representation and limits

The `PCMC1:` envelope contains a versioned, self-contained representation with an original byte length and integrity check. Decoding never evaluates JavaScript or executes a supplied program. Only the small, fixed set of supported operations is accepted.

The encoder compares five candidates:

| ID | Candidate | Stored representation |
|---|---|---|
| 0 | DEFLATE | A raw DEFLATE stream, validated before bounded inflation |
| 1 | Repetition | The shortest byte pattern that repeats to the declared length |
| 2 | Arithmetic sequence | Count, first integer, step, and surrounding text/separators |
| 3 | Quadratic sequence | The arithmetic recipe plus a constant second difference |
| 4 | Line template | Shared line prefix/suffix, line endings, and variable fields |

The binary header is one codec byte, a four-byte little-endian original byte length, and a four-byte little-endian CRC32. The complete binary packet uses canonical padded Base64 after the ASCII prefix. The encoder reconstructs the selected packet and compares it with the input before allowing a send.

The encoder compares algorithmic recipes with an existing DEFLATE implementation. This is an experiment in automatically finding useful short descriptions, not a claim of a universally optimal compression algorithm. No language model, external service or shared chat-history dictionary is needed.

- Maximum reconstructed text: **64 KiB of UTF-8**.
- Maximum compressed Discord message: **2,000 ASCII characters**, including `PCMC1:`.
- Each message is independently decodable after a restart or after earlier messages are deleted.
- Malformed, corrupt, unsupported or over-limit envelopes remain visible as received.
- Decode work and caches are bounded; stopping the plugin clears session state, caches and waiting tasks.

The ordinary Discord character limit is documented in [Sending Messages](https://support.discord.com/hc/en-us/articles/360034632292-Sending-Messages). The compressed wire limit stays at 2,000 even when the sender has a higher ordinary-text allowance.

## Compatibility and storage

Compatibility controls use the separate `PCMCAP1:` prefix and are bound to the DM and both account IDs. Support is temporary, kept in memory, and reset on reconnect, logout or plugin stop. Discovery is rate limited and starts when sending a message that could benefit.

Every client used to read compressed messages needs MessageCompression, including other devices signed in to the same Discord account. One compatible client can confirm support while another device remains unable to decode. This plugin is included in desktop and browser builds; the Android companion does not implement it.

A client without MessageCompression sees compatibility messages and encoded message bodies. Installing the plugin later makes supported compressed history readable. Switching the recipient to another device without the plugin during a confirmed session can expose encoded messages on that device until the session expires.

Discord stores and indexes the encoded body. Server-side text search, push-notification previews, exports and other clients therefore see the encoded representation. Loaded messages are expanded in client memory; this does not rewrite old conversations or change Discord's underlying storage implementation.

The optional **Show savings** setting reports the original and encoded **message-body** byte counts. Compatibility messages, HTTP/WebSocket framing, installed decoder code and Discord's own transport/storage compression are separate costs. A smaller body is not a measurement of total network traffic or server disk usage.

This format provides lossless compression and corruption detection. It provides no confidentiality or sender authentication.

## Development checks

```sh
pnpm testMessageCompression
pnpm build
pnpm test
```

The focused suite exercises the codec, peer negotiation and automatic send/decode integration without sending live Discord messages. Full release validation remains in the repository's existing workflows.
