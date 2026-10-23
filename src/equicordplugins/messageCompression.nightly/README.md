# MessageCompression (nightly experiment)

MessageCompression is a standalone ProtonnCord plugin for automatically sending smaller, lossless text messages in one-to-one DMs. Enable **MessageCompression** in Settings → Protonn Cord → Plugins, restart if prompted, and use the normal message composer. The first eligible message can compress immediately; no handshake or recipient response is required.

The plugin has its own settings, wire format, preview and decoder. It does not depend on SecureMessaging or change that plugin.

It is packaged only in nightly and development builds. The repository may promote its source to staging or main, but those production builds exclude the `.nightly` plugin target. Changing release channels preserves saved plugin settings; reading compressed history still requires a build that includes the decoder.

## What happens in a conversation

1. The encoder searches a bounded set of exact representations for each eligible outgoing message, including the first message in a DM.
2. It compares complete wire sizes and sends a compressed message only when it is smaller in both UTF-8 bytes and JavaScript string length, including the header and text-safe encoding. It sends no compatibility or control messages.
3. A client with the plugin reconstructs the original text locally. Decoding happens at the message model boundary, so chat history, copy, the edit composer and reply previews use the same text.

Open the plugin's settings to use **Try compression**. Paste your own text and inspect the before/after byte counts, selected representation, percentage saved and exact transmitted text without sending anything. **Show savings** is on by default and reports the same message-body counts when sending or editing.

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
- Decode work and caches are bounded; stopping the plugin clears its decode cache and removes its send/edit listeners.

The ordinary Discord character limit is documented in [Sending Messages](https://support.discord.com/hc/en-us/articles/360034632292-Sending-Messages). The compressed wire limit stays at 2,000 even when the sender has a higher ordinary-text allowance.

## Compatibility and storage

Every client used to read compressed messages needs MessageCompression, including other devices signed in to the same Discord account. This experiment deliberately does not check for support before sending. It is included in desktop and browser nightly builds; the Android companion does not implement it.

A client without MessageCompression sees encoded message bodies. Installing and enabling the plugin later makes supported compressed history readable. No shared session, previous messages, account pairing or recipient availability is required.

Discord stores and indexes the encoded body. Server-side text search, push-notification previews, exports and other clients therefore see the encoded representation. Loaded messages are expanded in client memory; this does not rewrite old conversations or change Discord's underlying storage implementation.

The **Show savings** setting reports the original and encoded **message-body** byte counts. HTTP/WebSocket framing, installed decoder code and Discord's own transport/storage compression are separate costs. A smaller body is not a measurement of total network traffic or server disk usage.

This format provides lossless compression and corruption detection. It provides no confidentiality or sender authentication.

## Ordinary-text measurements

The benchmark contains literal, hand-written messages, with no generated repetition. These results use the installed fflate dependency and include the complete `PCMC1:` packet:

| Sample | Original bytes | Transmitted bytes | Saved |
|---|---:|---:|---:|
| Short chat | 80 | 80 (unchanged) | 0% |
| Ordinary paragraph | 398 | 346 | 13.1% |
| Three-paragraph conversation | 1,029 | 798 | 22.4% |
| Technical update | 967 | 690 | 28.6% |
| Long ordinary message | 2,462 | 1,674 | 32.0% |

All compressed samples select DEFLATE and reconstruct the exact input. Algorithmic recipes remain useful for structured text; they do not guarantee better results for arbitrary prose. The long ordinary message fits in one 2,000-character message after encoding. Run `pnpm benchmarkMessageCompression` to reproduce the results.

## Development checks

```sh
pnpm testMessageCompression
pnpm benchmarkMessageCompression
pnpm build
pnpm test
```

The focused suite exercises the codec, handshake-free send/edit/decode integration and nightly/stable catalog generation without sending live Discord messages. Full release validation remains in the repository's existing workflows.

Production builds derive their channel from the checked-out Git branch, or the GitHub branch/PR target in CI. For a local production preview from a feature branch, explicitly set `PROTONN_CORD_BUILD_CHANNEL=nightly` in the build environment. The override accepts `main`, `staging` or `nightly`; unknown channels, tags and detached checkouts exclude nightly plugins. Development and reporter builds include them for testing.
