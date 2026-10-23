import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch } from "../src/utils/patches";
import { discordAttachmentExpirySource, discordCanaryGlobalPasteSource, discordGifSelectionSource, discordGlobalPasteSource, discordImageParserSource, discordStickerSelectionSource } from "./fixtures/discordMessageComposition";
import { applyPatch, host, pluginPatches } from "./utils/discordClientFixture";
import { loadTestModule } from "./utils/loadTestModule";

test("GifPaste handles the current two-argument picker callback and leaves other GIF pickers intact", () => {
    const inserted: string[] = [];
    let closes = 0;
    const plugin = loadTestModule("src/plugins/gifPaste/index.ts", {
        "@utils/constants": { Devs: {} }, "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@utils/discord": { insertTextIntoChatInputBox: (text: string) => inserted.push(text) },
        "@webpack/common": { ExpressionPickerStore: { closeExpressionPicker() { closes++; } } }
    }, {}).default;
    const patched = applyPatch(discordGifSelectionSource, plugin.patches[0]);
    const Picker = runInNewContext(`(class { constructor(props) { this.props=props; } ${patched} })`, { plugin });
    const gif = { url: "https://media.example/fixture.gif" };
    const context = { keyboard: true };
    const selected: unknown[][] = [];
    const onSelectGIF = (...args: unknown[]) => selected.push(args);
    new Picker({ onSelectGIF }).handleSelectGIF(gif, context);
    assert.deepEqual(inserted, [gif.url + " "]);
    assert.equal(closes, 1);
    assert.equal(selected.length, 0, "the chat picker must not send immediately");
    new Picker({ className: "profile-gif-picker", onSelectGIF }).handleSelectGIF(gif, context);
    assert.deepEqual(selected, [[gif, context]], "other picker callbacks retain both native arguments");
    new Picker({ onSelectGIF }).handleSelectGIF(undefined, context);
    assert.equal(closes, 1);
});

test("global paste blocking follows the current listener and preserves ordinary and focused-input events", () => {
    const patch = pluginPatches("src/equicordplugins/middleClickTweaks/index.ts")[0];
    for (const source of [discordGlobalPasteSource, discordCanaryGlobalPasteSource]) {
        let blocked = false;
        let focusedInput = false;
        const dispatched: unknown[] = [];
        const hostFocus = { Cw: () => focusedInput, BF: () => ({ activeElement: {} }) };
        const dispatch = { _: { dispatchToLastSubscribed: (_event: unknown, data: unknown) => dispatched.push(data) } };
        const constants = { jej: { GLOBAL_CLIPBOARD_PASTE: "paste" } };
        const callback = runInNewContext(`(${applyPatch(source, patch)})`, {
            plugin: { isPastingDisabled: () => blocked },
            uP: hostFocus, uv: hostFocus, nR: dispatch, nN: dispatch, K: constants, j: constants
        });
        let prevented = 0;
        let stopped = 0;
        const event = { target: { tagName: "DIV" }, preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
        callback(event);
        assert.equal(dispatched.length, 1);
        blocked = true;
        callback(event);
        assert.equal(dispatched.length, 1);
        assert.equal(prevented, 1);
        assert.equal(stopped, 1);
        blocked = false;
        event.target.tagName = "BUTTON";
        callback(event);
        assert.equal(prevented, 2);
        assert.equal(dispatched.length, 1);
        event.target.tagName = "INPUT";
        focusedInput = true;
        callback(event);
        assert.equal(prevented, 2, "the separate input listener keeps ownership of input paste events");
        assert.equal(dispatched.length, 1);
    }
});

test("StickerPaste selects the real sticker draft decision and stages a sticker even when the draft is empty", () => {
    const patch = pluginPatches("src/plugins/stickerPaste/index.ts")[0];
    assert.ok(discordStickerSelectionSource.includes(patch.find), "the find string must identify the selection helper, not sticker URL utilities");
    const context = {
        eU: { A: { getUploadCount: () => 0 } }, eM: { A: { getStickerPreview: () => [] } },
        ex: { D6: { STICKER_PICKER: "picker", AUTOCOMPLETE: "autocomplete", BUILT_IN_INTEGRATION: "integration" } },
        ew: /$/u, eG: /$/u
    };
    const original = runInNewContext(`(${discordStickerSelectionSource})`, context);
    assert.equal(original("picker", "", "channel", "draft"), false, "Discord normally sends an isolated selection");
    const stage = runInNewContext(`(${applyPatch(discordStickerSelectionSource, patch)})`, context);
    assert.equal(stage("picker", "", "channel", "draft"), true);
    assert.equal(stage("picker", "Existing draft", "channel", "draft"), true);
    assert.equal(stage("autocomplete", "sticker", "channel", "draft"), true);
});

test("MessageLoggerEnhanced targets the moved expiry implementation instead of attachment path constants", () => {
    const patch = pluginPatches("src/equicordplugins/messageLoggerEnhanced/index.tsx").at(-1);
    const find = canonicalizeMatch(patch.find);
    assert.equal(typeof find, "string");
    assert.ok(discordAttachmentExpirySource.includes(find), "the refresh request and expiry logic share the intended factory");
    assert.ok(!'let paths=new Set(["/attachments/","/ephemeral-attachments/"])'.includes(find));
});

test("deleted messages skip both attachment and embedded-media expiry checks while live messages retain them", () => {
    const patch = pluginPatches("src/equicordplugins/messageLoggerEnhanced/index.tsx").at(-1);
    const patched = applyPatch(discordAttachmentExpirySource, patch);
    const exports = host(patched, {
        332714: { K: (value: unknown) => value },
        927813: { A: { Millis: { HOUR: 3_600_000, SECOND: 1000 } } },
        998218: { A: { toURLSafe: (value: string) => { try { return new URL(value); } catch { return null; } } } },
        256964: { p: new Set(["/attachments/", "/ephemeral-attachments/"]) }
    }, { window: { GLOBAL_ENV: { CDN_HOST: "cdn.discordapp.com" } }, Date: { now: () => 0 } });
    const expired = { url: "https://cdn.discordapp.com/attachments/1/2/file.png?ex=1" };
    const fresh = { url: "https://cdn.discordapp.com/attachments/1/2/file.png?ex=ffffffff" };
    const check = exports.$r;
    assert.equal(check({ attachments: [expired], embeds: [] }), true);
    assert.equal(check({ attachments: [], embeds: [{ image: expired }] }), true);
    assert.equal(check({ attachments: [fresh], embeds: [{ image: fresh }] }), false);
    assert.equal(check({ deleted: true, attachments: [], embeds: [{ image: expired }] }), false);
    assert.equal(check({ deleted: true, get attachments() { return assert.fail("Deleted attachments must not be examined"); }, get embeds() { return assert.fail("Deleted embeds must not be examined"); } }), false);
});

test("ImageLink keeps image URLs in the actual parser without removing other link filtering or postprocessing", () => {
    const patch = pluginPatches("src/plugins/imageLink/index.ts")[0];
    const image = "https://media.example/fixture.png";
    const blocked = "https://game.example/private";
    const parse = (_content: unknown, _allow: unknown, _options: unknown, transform: Function) => transform([
        { type: "link", target: image, content: image }, { type: "link", target: blocked, content: blocked }
    ], true, false);
    const modules = {
        46054: { A: { parse } },
        448767: { k5: () => true, iz: () => true, dn: () => ({ onlyLinks: true }), c_: (target: string) => target === blocked },
        652215: { lAJ: { MEDIA_MENTION_MESSAGE: 99 } }, 307731: { MAX_EMOJI_TO_BE_JUMBO: 30 }
    };
    const message = { id: "message", channel_id: "channel", content: image, embeds: [{ type: "image", url: image }] };
    assert.equal(host(discordImageParserSource, modules).Ay(message).content.length, 0);
    const parser = host(applyPatch(discordImageParserSource, patch), modules).Ay;
    let processed = 0;
    const result = parser(message, { postProcessor: (ast: any[]) => { processed++; return ast; } });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].target, image);
    assert.equal(processed, 1);
    assert.equal(result.hasSpoilerEmbeds, false);
});
