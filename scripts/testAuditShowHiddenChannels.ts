/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordStageComponents } from "./fixtures/discordStageComponents";
import { loadTestModule } from "./utils/loadTestModule";
import { elements as descendants } from "./utils/discordClientFixture";

type Capture = typeof discordStageComponents[number];
type Element = { type: unknown; props: any; };

const permissions = { VIEW_CHANNEL: 1024n, CONNECT: 1048576n };
const stageRoles = { SPEAKER: 0, AUDIENCE: 1, REQUESTED_TO_SPEAK_ONLY: 2 };
const jsx = (type: unknown, props: object): Element => ({ type, props });

function loadPlugin() {
    return loadTestModule("src/plugins/showHiddenChannels/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "fixture-class" },
        "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack/common": {
            ChannelStore: {}, PermissionsBits: permissions,
            PermissionStore: { can: (permission: bigint, channel: any) => permission === permissions.VIEW_CHANNEL ? channel.canView : channel.canConnect }
        },
        "./components/HiddenChannelLockScreen": {}
    }, {}).default;
}

function patchSource(source: string, plugin: any) {
    let replacements = 0;
    for (const patch of plugin.patches) {
        if (patch.predicate && !patch.predicate()) continue;
        const find = canonicalizeMatch(patch.find);
        if (typeof find === "string" ? !source.includes(find) : !find.test(source)) continue;
        for (const replacement of Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement]) {
            const next = source.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, "plugin"));
            assert.notEqual(next, source, `the captured stage module must match ${replacement.match}`);
            source = next;
            replacements++;
        }
    }
    assert.equal(replacements, 6, "all stage layout and header protections must target the actual stage module");
    return source;
}

function setup(capture: Capture, overrides: Partial<ReturnType<typeof initialState>> = {}) {
    const state = Object.assign(initialState(), overrides);
    const plugin = loadPlugin();
    plugin.HiddenChannelLockScreen = (channel: unknown) => jsx("hidden-channel-lock", { channel });
    const actionLog: unknown[][] = [];
    const css = new Proxy({}, { get: (_, key) => String(key) });
    const elements = (name: string) => ({ A: name });
    const modules: Record<number, unknown> = {
        477900: { jsx, jsxs: jsx },
        582128: { useState: (value: unknown) => [value, () => {}], useMemo: (create: () => unknown) => create(), useCallback: (callback: unknown) => callback },
        435558: { debounce: (callback: unknown) => callback },
        17928: { bG: (_stores: unknown, get: () => unknown) => get() },
        688810: { Ay: () => ({ analyticsLocations: ["stage"], newestAnalyticsLocation: "header" }), f5: "analytics-provider" },
        793574: { A: { VOICE_CONTROL_TRAY: "controls", VOICE_CHANNEL_HEADER: "header" } },
        267102: { Us: () => state.context },
        309010: { Ay: { getVoiceChannelId: () => state.inCall ? "stage" : undefined } },
        576705: { A: { can: (_permission: bigint, channel: any) => channel.canConnect } },
        113783: { E5: () => state.participants, uy: () => 3, zy: (_id: string, role: number) => role === stageRoles.AUDIENCE ? 7 : 2 },
        518769: { ip: stageRoles },
        198052: { A: { getSelectedParticipant: () => state.selectedParticipant, getChatOpen: () => state.chatOpen } },
        571909: { Ay: () => ({ isOnStartStageScreen: state.startStage }), vI() {}, ek: (value: unknown) => actionLog.push(["start-stage", value]) },
        249288: { A: { getToastsEnabled: () => state.toastsEnabled } },
        367513: { A: { updateChatOpen: (...args: unknown[]) => actionLog.push(["chat", ...args]) } },
        148494: { A: { jumpToMessage: (value: unknown) => actionLog.push(["jump", value]) } },
        533233: { A: () => state.boostUpsell },
        747376: { cy: (channel: unknown) => actionLog.push(["connect", channel]) },
        156652: { A: "stage-container", x: { TOP: 0 } },
        895903: elements("start-stage-screen"),
        623413: elements("stage-preview"),
        717965: elements("stage-controls"),
        43189: { Ay: "toast-provider" },
        20465: elements("chat-toasts"),
        44540: css,
        660183: { intl: { string: (key: unknown) => key, format: (key: unknown, values: unknown) => ({ key, values }) }, t: css },
        652215: { xBc: permissions, BRT: { POPOUT: "popout" }, NJ8: { DARK: "dark" } },
        43990: { N: "theme-provider" },
        47167: { Ay: () => "Stage name" },
        446600: { A: { getStageInstanceByChannel: () => state.stageInstance } },
        58736: { Ay: Object.assign(() => {}, { Icon: "header-icon", Title: "header-title", Divider: "header-divider" }) },
        742589: { I: () => actionLog.push(["header-double-click"]) },
        451394: { q: "stage-icon" },
        661531: { A: { colors: { TEXT_MUTED: { css: "muted" } } } },
        831544: { MicrophoneIcon: "microphone-icon" },
        834730: { E: "text" },
        177953: { n: "audience-icon" },
        903489: css,
        366265: elements("boost-upsell"),
        776781: { Ni: () => state.canModerate },
        977851: { V: "open-chat-button" },
        689874: elements("clips-indicator"),
        384059: { X: (...args: unknown[]) => actionLog.push(["analytics", ...args]), O: { OPEN_REQUEST_TO_SPEAK_SIDEBAR: "request-to-speak" } }
    };
    const globals = {
        plugin,
        a: () => () => "fixture-class",
        ...Object.fromEntries(Object.entries(capture.imports).map(([name, id]) => [name, modules[id] ?? {}])),
        ...Object.fromEntries(capture.locals.map(name => [name, `local-${name}`]))
    };
    function evaluate(source: string) {
        return runInNewContext(`${source}\n({${Object.entries(capture.components).map(([role, name]) => `${role}:${name}`).join(",")}})`, globals);
    }
    const channel = { id: "stage", guild_id: "guild", canView: true, canConnect: true, isDM: () => false, isGroupDM: () => false, isMultiUserDM: () => false };
    const props = {
        channel, toggleRequestToSpeakSidebar: () => actionLog.push(["toggle-requests"]), showRequestToSpeakSidebar: false,
        popoutOpen: false, popoutType: "none", chatOpen: state.chatOpen, idleProps: { idle: false }
    };
    return { state, plugin, channel, props, actionLog, original: evaluate(capture.source), patched: evaluate(patchSource(capture.source, plugin)) };
}

function initialState() {
    return {
        inCall: false, context: "main", startStage: false, chatOpen: false, toastsEnabled: true,
        boostUpsell: false, selectedParticipant: null as null | { id: string; }, canModerate: true,
        stageInstance: { topic: "Stage topic" } as null | { topic: string; }, participants: [{ id: "speaker" }]
    };
}

function renderHeader(component: (props: unknown) => Element, props: unknown) {
    const tree = component(props);
    const theme = descendants(tree).find(node => node.type === "theme-provider");
    assert.ok(theme);
    return theme.props.children("theme-class") as Element;
}

for (const capture of discordStageComponents) {
    test(`${capture.variant}: hidden stages retain the lock screen, header and idle behavior without participant controls`, () => {
        const fixture = setup(capture);
        fixture.channel.canView = false;
        for (const inCall of [false, true]) for (const popoutOpen of [false, true]) {
            fixture.state.inCall = inCall;
            const props = { ...fixture.props, popoutOpen };
            const original = fixture.original.stage(props);
            const patched = fixture.patched.stage(props);
            assert.equal(patched.type, original.type);
            assert.equal(patched.props.children.type, "hidden-channel-lock");
            assert.equal(patched.props.children.props.channel, fixture.channel);
            assert.equal(patched.props.style, undefined);
            assert.equal(patched.props.disableGradients, true);
            assert.equal(patched.props.idle, original.props.idle);
            assert.equal(JSON.stringify(patched.props.screenMessage), JSON.stringify(original.props.screenMessage));
            for (const name of ["renderBottomCenter", "renderBottomRight", "renderChatToasts"]) assert.equal(patched.props[name](), null, name);
            assert.equal(patched.props.renderHeader().props.channel, fixture.channel);
        }
        assert.deepEqual(fixture.actionLog, [], "rendering a hidden stage must not trigger host chat or connection actions");
    });

    test(`${capture.variant}: visible stages preserve preview, start, connected, popout, style and toast branches`, () => {
        const fixture = setup(capture);
        for (const inCall of [false, true]) for (const startStage of [false, true]) for (const popoutOpen of [false, true]) for (const boostUpsell of [false, true]) {
            Object.assign(fixture.state, { inCall, startStage, boostUpsell });
            const props = { ...fixture.props, popoutOpen };
            for (const context of ["main", "popout"]) {
                fixture.state.context = context;
                const original = fixture.original.stage(props);
                const patched = fixture.patched.stage(props);
                assert.equal(JSON.stringify(patched), JSON.stringify(original));
                for (const name of ["renderBottomCenter", "renderBottomRight", "renderHeader", "renderChatToasts"]) {
                    assert.equal(JSON.stringify(patched.props[name]()), JSON.stringify(original.props[name]()));
                }
            }
        }
        fixture.state.startStage = false;
        fixture.state.inCall = false;
        fixture.props.popoutOpen = false;
        const toasts = fixture.patched.stage(fixture.props).props.renderChatToasts();
        const message = { channel_id: "stage", id: "message" };
        toasts.props.children.props.onToastClick(message);
        assert.deepEqual(fixture.actionLog.map(action => [action[0], ...action.slice(1).map(value => JSON.stringify(value))]), [
            ["chat", '"stage"', "true"], ["jump", JSON.stringify({ channelId: "stage", messageId: "message", flash: true })]
        ]);
    });

    test(`${capture.variant}: stage headers hide only inaccessible counts and the chat button`, () => {
        const fixture = setup(capture);
        for (const canView of [false, true]) for (const canConnect of [false, true]) for (const boostUpsell of [false, true]) {
            Object.assign(fixture.channel, { canView, canConnect });
            fixture.state.boostUpsell = boostUpsell;
            const original = renderHeader(fixture.original.header, fixture.props);
            const patched = renderHeader(fixture.patched.header, fixture.props);
            const before = descendants(original);
            const after = descendants(patched);
            assert.equal(after.filter(node => node.type === "header-divider").length, canView ? 1 : 0);
            assert.equal(after.filter(node => node.type === "microphone-icon").length, canView ? 1 : 0);
            assert.equal(after.filter(node => node.type === "audience-icon").length, canView ? 1 : 0);
            assert.equal(after.find(node => node.type === "header-title")?.props.children, "Stage topic");
            assert.equal(after.filter(node => node.type === "header-icon").length, 1);
            assert.equal(patched.props.onDoubleClick, original.props.onDoubleClick);
            if (canView) assert.equal(JSON.stringify(after), JSON.stringify(before));
            const toolbar = descendants(fixture.patched.toolbar(fixture.props));
            assert.equal(toolbar.filter(node => node.type === "open-chat-button").length, canView && canConnect ? 1 : 0);
            assert.equal(toolbar.filter(node => node.type === "clips-indicator").length, 1);
        }
    });

    test(`${capture.variant}: denied CONNECT keeps the host preview and existing request-to-speak behavior`, () => {
        const fixture = setup(capture);
        fixture.channel.canConnect = false;
        const preview = fixture.patched.stage(fixture.props).props.children;
        assert.equal(preview.type, "stage-preview");
        assert.equal(preview.props.hasConnectPermission, false);
        assert.equal(preview.props.participants, fixture.state.participants);
        fixture.state.chatOpen = true;
        const toolbar = fixture.patched.toolbar(fixture.props);
        const requests = descendants(toolbar).find(node => node.props?.numRequestToSpeak === 2);
        assert.ok(requests);
        requests.props.toggleRequestToSpeakSidebar();
        assert.deepEqual(fixture.actionLog, [
            ["chat", "stage", false], ["analytics", "header", "request-to-speak"], ["toggle-requests"]
        ]);
        fixture.state.canModerate = false;
        assert.equal(descendants(fixture.patched.toolbar(fixture.props)).some(node => node.props?.numRequestToSpeak === 2), false);
    });
}
