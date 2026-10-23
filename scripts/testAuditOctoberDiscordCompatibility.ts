import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { accountProps, avatarProps, canaryProxyTicketFactory, markdownRule, proxyTicketFactory, voiceMemo } from "./fixtures/discordClientOctober";
import { applyPatch, declaration, elements, host, jsx, pluginPatches } from "./utils/discordClientFixture";

test("SilentTyping handles the current avatar fields without changing frozen caller props or voice state", () => {
    const patch = pluginPatches("src/plugins/silentTyping/index.tsx").find((patch: any) => patch.find === ",{avatarCutoutX");
    let hidden = false;
    const render = runInNewContext(`(${applyPatch(avatarProps, patch)})`, {
        plugin: { shouldHideMembersListTypingIndicators: () => hidden }
    });
    const ref = {}, avatarContentRef = {};
    for (const isTyping of [undefined, false, true]) {
        const props = Object.freeze({ isTyping, ref, avatarContentRef, voiceStatus: "speaking" });
        hidden = false;
        assert.equal(render(props).isTyping, isTyping ?? false);
        hidden = true;
        const result = render(props);
        assert.equal(result.isTyping, false);
        assert.equal(result.voiceStatus, "speaking");
        assert.equal(result.ref, ref);
        assert.equal(result.avatarContentRef, avatarContentRef);
        assert.equal(props.isTyping, isTyping);
    }
});

test("Declutter removes the current account nameplate while preserving frozen props and soundboard state", () => {
    const patches = pluginPatches("src/equicordplugins/declutter/index.tsx");
    const patch = patches.find((patch: any) => patch.find === "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}");
    const replacement = patch.replacement.find((entry: any) => String(entry.match).includes("voiceDb"));
    const render = runInNewContext(`(${applyPatch(accountProps, { replacement })})`);
    const props = Object.freeze({ nameplate: { id: "plate" }, currentUser: {}, ref: {}, playingSoundboard: true, voiceDb: -12 });
    const result = render(props);
    assert.equal(result.nameplate, null);
    assert.equal(result.currentUser, props.currentUser);
    assert.equal(result.ref, props.ref);
    assert.equal(result.voiceDb, -12);
    assert.equal(result.playingSoundboard, true);
    assert.equal(props.nameplate.id, "plate");
});

test("code-block patches select renderers and preserve copy controls, keys and unmodified input", () => {
    const shiki = pluginPatches("src/plugins/shikiCodeblocks.desktop/index.tsx")[0];
    const auto = pluginPatches("src/equicordplugins/autoCodeblockLanguage.desktop/index.ts")[0];
    for (const patch of [shiki, auto]) {
        assert.equal(patch.find.test(markdownRule), true);
        assert.equal(patch.find.test("({codeBlock:{react:host.RULES.text.react}})"), false);
    }
    const props = Object.freeze({ content: "const value = 1;", lang: "" });
    const state = { key: "code-key" };
    const custom = { highlighted: true };
    const render = runInNewContext(applyPatch(markdownRule, shiki), {
        plugin: { renderHighlighter(node: unknown, _output: unknown, context: unknown) {
            assert.equal(node, props); assert.equal(context, state); return custom;
        } }
    }).codeBlock.react;
    assert.equal(render(props, null, state), custom);
    const native = runInNewContext(applyPatch(markdownRule, auto), {
        plugin: { resolveLanguage: (language: string, content: string) => {
            assert.equal(language, ""); assert.equal(content, props.content); return "javascript";
        } },
        i: { jsx: (type: unknown, value: any, key: string) => ({ ...jsx(type, value), key }), jsxs: jsx },
        er: { Hy: "block", lB: "copy" }, L: { p5: true }, ed: "copy-button", O: { E: "native-code" },
        s: () => (...names: string[]) => names.join(" "), ea: { kw: "code" }, ei: { H: "highlighted" }
    }).codeBlock.react(props, null, state);
    assert.equal(native.key, state.key);
    assert.equal(elements(native).find(node => node.type === "copy-button").props.text, props.content);
    assert.equal(elements(native).find(node => node.type === "native-code").props.lang, "javascript");
    assert.equal(props.lang, "");
    const legacy = "({codeBlock:{react(node,output,state){return node.lang}}})";
    const legacyRender = runInNewContext(applyPatch(legacy, auto), { plugin: { resolveLanguage: () => "javascript" } }).codeBlock.react;
    assert.equal(legacyRender({ ...props }), "javascript");
});

test("voice recording and detached playback capture the same current native player", () => {
    const voice = pluginPatches("src/plugins/voiceMessages/index.tsx")[0];
    const persistent = pluginPatches("src/equicordplugins/persistentAudioPlayback/index.tsx")[0];
    assert.equal(voice.find, "playbackCacheKey:");
    assert.equal(persistent.find, voice.find);
    const recording: any = {}, playback: any = {};
    const source = applyPatch(applyPatch(voiceMemo, voice, "recording"), persistent, "playback");
    const player = runInNewContext(`(${source})`, { recording, playback, a: { memo: (render: Function) => render } })();
    assert.equal(typeof player, "function");
    assert.equal(recording.VoiceMessage, player);
    assert.equal(playback.NativeVoiceMessage, player);
});

for (const [channel, factory] of Object.entries({ stable: proxyTicketFactory, canary: canaryProxyTicketFactory })) {
    test(`Questify resolves ${channel} cached proxy tickets and retains request and account isolation`, async () => {
        let user = "first-user";
        const requests: any[] = [];
        const api = host(factory, {
            636537: { Bo: { post: async (request: unknown) => { requests.push(request); return { body: { ticket: "fresh" } }; } } },
            280450: { default: { getId: () => user } },
            956518: { Ay: () => null },
            652215: { Rsh: { APPLICATION_PROXY_TICKET: (id: string) => `/applications/${id}/proxy-tickets` } }
        });
        const getTicket = declaration("src/equicordplugins/questify/utils/completion.ts", "getApplicationProxyTicket", {
            findByCodeLazy: (...needles: RegExp[]) => {
                const matches = Object.values(api).filter(fn => typeof fn === "function" && needles.every(needle => needle.test(String(fn))));
                assert.equal(matches.length, 1);
                return matches[0];
            }
        });
        api.WL("cached", "app", "channel");
        assert.equal(await getTicket("app", "channel"), "cached");
        assert.equal(requests.length, 0);
        assert.equal(await getTicket("app", "channel"), "fresh");
        assert.equal(requests[0].url, "/applications/app/proxy-tickets");
        assert.equal(requests[0].body.channel_id, "channel");
        assert.equal(requests[0].body.use_stateless_ticket, true);
        assert.equal(requests[0].rejectWithError, true);
        api.WL("private-cache", "app", "channel");
        user = "second-user";
        assert.equal(await getTicket("app", "channel"), "fresh");
        assert.equal(requests.length, 2);
    });
}

test("Quest visibility overrides retain loading and enrollment guards for both prop shapes", () => {
    const patch = pluginPatches("src/equicordplugins/questify/index.tsx").find((entry: any) => String(entry.find).includes("useContext"));
    const source = "function(e){let{isLoading:k}=(0,p.zT)(),w=r.useContext(D.Z),M=w||U&&Q&&!k&&!F;return M}";
    const quest = {};
    let seen: unknown;
    for (const props of [{ quest }, { creative: { quest } }]) {
        for (const loading of [false, true]) for (const blocked of [false, true]) {
            const render = runInNewContext(`(${applyPatch(source, patch)})`, {
                plugin: { shouldForceQuestPanelVisible(value: unknown) { seen = value; return true; } },
                p: { zT: () => ({ isLoading: loading }) }, r: { useContext: () => false }, D: { Z: {} }, U: true, Q: false, F: blocked
            });
            assert.equal(render(props), !loading && !blocked);
            assert.equal(seen, quest);
        }
    }
});
