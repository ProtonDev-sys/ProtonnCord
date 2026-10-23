import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { questAccountPanel, questActionButton, questDiscoverySidebars, questProgressRing } from "./fixtures/discordQuestPanel";
import { applyPatch, jsx, pluginPatches } from "./utils/discordClientFixture";

const patches = pluginPatches("src/equicordplugins/questify/index.tsx");

for (const [channel, source] of Object.entries(questDiscoverySidebars)) {
    test(`Quest discovery hiding preserves ${channel} experiments and native navigation`, () => {
        const settings = { disableQuestsEverything: false, disableRelocationNotices: false };
        const patch = pluginPatches("src/equicordplugins/questify/index.tsx", { getQuestifySettings: () => settings })
            .find((patch: any) => patch.find === "GLOBAL_DISCOVERY_SIDEBAR},");
        const tabs = Object.freeze(["servers", "quests", "apps", "future"]);
        let nativeEnabled = false;
        let hookCalls = 0;
        const config = { useConfig({ location }: any) {
            assert.equal(location, "GlobalDiscoverySidebar");
            hookCalls++;
            return { enabled: nativeEnabled };
        } };
        const discovery = { GLOBAL_DISCOVERY_TABS: tabs, GlobalDiscoveryTab: { QUESTS: "quests" } };
        const react = { jsx, jsxs: jsx };
        const styles = { kL: "sidebar", wx: "header", C$: "navigation" };
        const bindings = channel === "stable"
            ? { s0: config, s2: discovery, M: react, s6: styles, sY: { F: "heading" }, sK: { D: "text" }, s7: "tab" }
            : { sK: config, sz: discovery, P: react, sZ: styles, sx: { F: "heading" }, sk: { D: "text" }, sJ: "tab" };
        const globals = { ...bindings, tL: { intl: { string: () => "Discovery" }, t: {} } };
        const native = runInNewContext(`(${source})`, globals);
        const patched = runInNewContext(`(${applyPatch(source, patch)})`, globals);
        for (nativeEnabled of [false, true]) {
            for (settings.disableQuestsEverything of [false, true]) {
                for (settings.disableRelocationNotices of [false, true]) {
                    hookCalls = 0;
                    const node = (patch.predicate() ? patched : native)();
                    const header = node.props.children[0].props.children;
                    const nav = node.props.children[1];
                    assert.equal(header.props.forceLevel, 1);
                    assert.equal(header.props.children.props.children, "Discovery");
                    assert.equal(nav.type, "nav");
                    assert.equal(nav.props.className, "navigation");
                    assert.equal(nav.props.role, "tablist");
                    assert.equal(nav.props["aria-orientation"], "vertical");
                    const expected = nativeEnabled || settings.disableQuestsEverything || settings.disableRelocationNotices
                        ? ["servers", "apps", "future"] : [...tabs];
                    assert.deepEqual(Array.from(nav.props.children, (child: any) => child.props.tab), expected);
                    assert.ok(nav.props.children.every((child: any) => child.type === "tab"));
                    assert.equal(hookCalls, 1);
                }
            }
        }
        assert.deepEqual(tabs, ["servers", "quests", "apps", "future"]);
    });
}

test("Quest discovery hiding remains compatible with the legacy direct-map path", () => {
    const patch = patches.find((patch: any) => patch.find === "GLOBAL_DISCOVERY_SIDEBAR},");
    const tabs = Object.freeze(["servers", "quests", "apps"]);
    const render = runInNewContext(`(${applyPatch("function(){return host.GLOBAL_DISCOVERY_TABS.map(tab=>tab)}", patch)})`, {
        host: { GLOBAL_DISCOVERY_TABS: tabs }
    });
    assert.deepEqual(Array.from(render()), ["servers", "apps"]);
    assert.deepEqual(tabs, ["servers", "quests", "apps"]);
});

test("Quest account-panel overrides keep native no-fill hooks and ad wrappers in order", () => {
    const patch = patches.find((patch: any) => patch.find === 'collapsed-with-rewards":"collapsed-without-rewards' && !Array.isArray(patch.replacement) && !String(patch.replacement.match).includes("SELECT"));
    const calls: string[] = [];
    const native = Object.freeze({ type: "quest", quest: Object.freeze({ id: "quest" }) });
    const noFill = { decisionId: "no-fill" };
    let override: any = native;
    const render = runInNewContext(`(${applyPatch(questAccountPanel, patch)})`, {
        plugin: { useQuestRerender: () => calls.push("subscribe"), getQuestPanelOverride(value: unknown) {
            calls.push("override"); assert.equal(value, native); return override;
        } },
        R: { wo: () => { calls.push("native"); return native; } },
        h: { A: (location: string, source: string) => { calls.push("no-fill"); assert.equal(location, "account"); assert.equal(source, "useNoFillAd"); return noFill; } },
        f: { p9: { DESKTOP_ACCOUNT_PANEL_AREA: "account" } }, a: { p: { QUEST: "quest", NO_FILL: "no-fill", BOUNTY: "bounty" } },
        s: { jsx }, S: { y5: "ad-wrapper" }, P: { rE: { QUESTS_BAR: "quest-bar" } }, tJ: "quest-panel", t0: "no-fill-panel"
    });
    const node = render();
    assert.deepEqual(calls, ["subscribe", "native", "override", "no-fill"]);
    assert.equal(node.type, "ad-wrapper");
    assert.equal(node.props.adCreativeId, "quest");
    assert.equal(node.props.source, "quest-bar");
    assert.equal(node.props.children.props.quest, native.quest);
    override = { type: "no-fill" };
    assert.equal(render().props.noFillDecision, noFill);
    override = { type: "bounty" };
    assert.equal(render(), null);
    assert.equal(native.type, "quest");
});

test("Quest progress overrides preserve current ref props, native accessibility and frozen inputs", () => {
    const patch = patches.find((patch: any) => patch.find === ",{progressTextAnimation:");
    const quest = { id: "quest" };
    const child = jsx("quest", { quest });
    const ref = { current: null };
    const props = Object.freeze({ percentComplete: 0.25, children: child, ref, overlayText: "25%" });
    let override: any = { percentComplete: 0.75, overlayText: "75%" };
    const render = runInNewContext(`(${applyPatch(questProgressRing, patch)})`, {
        plugin: { getQuestPanelPercentComplete(value: any) { assert.equal(value.quest, quest); assert.equal(value.ref, ref); return override; } },
        t: { useMemo: (read: Function) => read() }, r: { jsx, jsxs: jsx },
        c: { z: () => ({ progressTextAnimation: 1 }) }, h: {}, n: { animated: { div: "animated" } }, d: { a: (value: unknown) => value },
        l: () => () => "class", o: { E: "text" }, u: {}, m: { intl: { formatToPlainString: (_key: unknown, values: any) => `${values.percent}% complete` }, t: {} }
    });
    const node = render(props);
    assert.equal(node.props.ref, ref);
    assert.equal(node.props.role, "progressbar");
    assert.equal(node.props["aria-valuenow"], 75);
    assert.equal(node.props["aria-label"], "75% complete");
    assert.equal(node.props["aria-valuemin"], 0);
    assert.equal(node.props["aria-valuemax"], 100);
    assert.equal(node.props.children[0].props.children[0], child);
    assert.equal(node.props.children[0].props.children[1].props.children[1].props.children, "75%");
    assert.equal(props.percentComplete, 0.25);
    assert.equal(props.overlayText, "25%");
    override = undefined;
    assert.equal(render(props).props["aria-valuenow"], 25);
});

test("Quest action overrides keep direct task enums, native fallback, access wrappers and other statuses", () => {
    const patch = patches.find((patch: any) => patch.find === "config.taskConfigV2.tasks).length)return");
    let override: unknown;
    let suspended = false;
    const calls: any[] = [];
    const statuses = Object.fromEntries(["UNENROLLED", "ENROLLED", "INCOMPLETE", "COMPLETED", "CLAIMED", "EXPIRED", "EXPIRED_CLAIMED", "EXPIRED_CLAIMABLE"].map(value => [value, value]));
    const render = runInNewContext(`(${applyPatch(questActionButton, { replacement: patch.replacement[1] })})`, {
        plugin: { enrolledIncompleteButton(value: any) { calls.push(value); return override; } },
        c: { Pd: (quest: any) => quest.status, cc: () => "play", UA: statuses }, r: { Hv: () => suspended },
        s: { jsx }, i: { $: "button" }, f: { intl: { string: () => "Unavailable" }, t: {} }, o: { A: "access-wrapper" },
        ty: "unenrolled", tT: "enrolled", t_: "incomplete", m: "completed", N: "claimed", tf: "expired", tO: "expired-claimed"
    });
    for (const status of ["ENROLLED", "INCOMPLETE"]) {
        const quest = Object.freeze({ status, config: { taskConfigV2: { tasks: { play: {} } } } });
        const props = Object.freeze({ quest, size: "lg", surface: "tile", analyticsCtxQuestContent: "analytics" });
        override = undefined;
        const fallback = render(props);
        assert.equal(fallback.props.quest, quest);
        assert.equal(fallback.props.taskType, "play");
        assert.equal(fallback.props.surface, "tile");
        assert.equal(fallback.props.analyticsCtxQuestContent, "analytics");
        assert.equal(calls.at(-1).quest, quest);
        assert.equal(calls.at(-1).size, "lg");
        override = jsx("questify-button", {});
        assert.equal(render(props), override);
        suspended = true;
        const guarded = render(props);
        assert.equal(guarded.type, "access-wrapper");
        assert.equal(guarded.props.children, override);
        suspended = false;
    }
    const before = calls.length;
    for (const status of ["UNENROLLED", "CLAIMED", "COMPLETED", "EXPIRED"]) {
        assert.equal(render({ quest: { status, config: { taskConfigV2: { tasks: { play: {} } } } } }).type, status.toLowerCase());
    }
    assert.equal(render({ quest: { config: { taskConfigV2: { tasks: {} } } } }).type, "button");
    assert.equal(calls.length, before);
});
