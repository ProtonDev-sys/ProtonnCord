import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { emojiAvailabilitySource, emojiCategorySource, questBadgesSource, questFiltersCanarySource, questFiltersSource, questSortSource } from "./fixtures/discordQuestEmoji";
import { applyPatch, declaration, evaluate, host, jsx, pluginPatches, sourceNode } from "./utils/discordClientFixture";

const questFile = "src/equicordplugins/questify/index.tsx";

test("Questify adds its sort option to Quest constants without matching the unrelated emoji category enum", () => {
    const patch = pluginPatches(questFile).find((patch: any) => patch.replacement?.replace === '.QUESTIFY="questify",$1');
    assert.ok(questSortSource.includes(patch.find));
    assert.ok(!emojiCategorySource.includes(patch.find), "the first matching module must be Quest constants");
    const original = runInNewContext(`var d;let ${questSortSource};q;`);
    const options = runInNewContext(`var d;let ${applyPatch(questSortSource, patch)};q;`);
    assert.deepEqual(Object.keys(options), ["QUESTIFY", ...Object.keys(original)]);
    assert.equal(options.QUESTIFY, "questify");
    for (const [key, value] of Object.entries(original)) assert.equal(options[key], value);
});

test("Quest badge hiding happens before native overflow and preview layout without mutating badge data", () => {
    const patch = pluginPatches(questFile).find((patch: any) => patch.find === ".MODAL]:26");
    const source = applyPatch(questBadgesSource, patch);
    let badges: ReadonlyArray<{ id: string; }> = Object.freeze(["quest_completed", "orb_profile_badge", "staff", "partner", "supporter"].map(id => Object.freeze({ id })));
    const ref = { current: null };
    const onClose = () => {};
    const profile = { userId: "user" };
    const render = runInNewContext(`(${source})`, {
        o: { d: () => true }, s: { bG: (_stores: unknown, read: Function) => read(), yK: (_stores: unknown, read: Function) => read() },
        _: { default: { getUser: () => ({ bot: false }) } }, E: { A: () => badges }, u: { A: () => ({}) },
        l: { Ay: { hasCatalogFor: () => false } }, c: { Rr: (values: unknown[]) => values },
        r: { useMemo: (read: Function) => read() }, d: { k9: 3 }, i: { jsx, Fragment: "fragment" }, e9: "badges"
    });
    const props = Object.freeze({ displayProfile: profile, containerRef: ref, onClose });
    const row = render(props).props.children[0];
    assert.deepEqual(Array.from(row.props.badges, (badge: any) => badge.id), ["staff", "partner", "supporter"]);
    assert.equal(row.props.overflowCount, 0, "hidden badges must not remain in the overflow count");
    assert.equal(row.props.displayProfile, profile);
    assert.equal(row.props.containerRef, ref);
    assert.equal(row.props.onClose, onClose);
    assert.equal(badges.length, 5);
    badges = Object.freeze([{ id: "quest_completed" }, { id: "orb_profile_badge" }]);
    assert.equal(render(props), null);
    const pending = render({ ...props, showPendingBadgeEdits: true, pendingBadges: [{ id: "pending-native" }] });
    assert.deepEqual(Array.from(pending.props.children[0].props.badges, (badge: any) => badge.id), ["pending-native"]);
});

test("Quest page sort and filter controls subscribe with current ref props and preserve native query actions", async () => {
    const patch = pluginPatches(questFile).find((patch: any) => patch.find === "QUEST_HOME)},[])," && patch.group);
    for (const fixture of [questFiltersSource, questFiltersCanarySource]) {
        let subscriptions = 0;
        let rerenders = 0;
        const choices: unknown[][] = [];
        const routes: any[] = [];
        const queries: any[] = [];
        const filters = [{ group: "task", filter: "task_video" }];
        const plugin = {
            useQuestRerender() { subscriptions++; return 1; }, getLastSortChoice: () => "questify", getLastFilterChoices: () => filters,
            setLastSortChoice: (value: unknown) => choices.push(["sort", value]), setLastFilterChoices: (value: unknown) => choices.push(["filters", value]),
            rerenderQuests() { rerenders++; }
        };
        const ref = { current: null } as { current: any; };
        const render = runInNewContext(`(${applyPatch(fixture, patch)})`, {
            plugin, URLSearchParams, requestAnimationFrame: (fn: Function) => fn(),
            i: { useRef: (current: unknown) => ({ current }), useCallback: (fn: Function) => fn, useMemo: (read: Function) => read(),
                useEffect: (effect: Function) => effect(), useImperativeHandle: (ref: any, read: Function) => { ref.current = read(); } },
            r: { jsx, jsxs: jsx, Fragment: "fragment" }, sH: { o: () => new URLSearchParams() },
            u: { W6: () => ({ replace: (value: unknown) => routes.push(value) }), zy: () => ({ hash: "" }) },
            B: { uJ: (value: string | null) => value == null || value === "" },
            tj: { kL: { SUGGESTED: "suggested", QUESTIFY: "questify", MOST_RECENT: "most_recent" } }, eM: { Vq: Boolean },
            $: { NC: { ALL: "all" }, Qh: (_tab: unknown, options: unknown) => { queries.push(options); return { quests: [{ id: "quest" }], excludedQuests: [], hasFetched: true }; }, $P() {} },
            sD: "sort", sF: "filter", sU: [], sy: {}, eE: { D: "heading" }, ew: { intl: { string: () => "Quests" }, t: {} },
            sp: "sort", sS: "filters", sC: "filters", sQ: "tiles"
        });
        const tree = render(Object.freeze({ ref }));
        assert.equal(subscriptions, 1);
        assert.equal(queries[0].sortMethod, "questify");
        assert.equal(queries[0].filters, filters);
        assert.equal(queries[0].removeExpiredQuests, true);
        const controls = tree.props.children[0].props.children[1].props.children;
        assert.equal(controls[0].props.selectedSortMethod, "questify");
        controls[0].props.onChange("most_recent");
        await Promise.resolve();
        controls[1].props.onChange([]);
        assert.ok(choices.some(([kind, value]) => kind === "sort" && value === "most_recent"));
        assert.ok(choices.some(([kind, value]) => kind === "filters" && Array.isArray(value) && value.length === 0));
        assert.equal(rerenders, 1);
        assert.equal(routes[0].search, "sort=most_recent");
        assert.equal(routes[1].search, "");
        assert.equal(typeof ref.current.scrollToQuest, "function");
    }
});

test("emoji compatibility retains native entitlement overrides and keeps fake emoji selection scoped to allowed intents", () => {
    const file = "src/plugins/fakeNitro/index.tsx";
    const intentions = evaluate(`${sourceNode(file, node => ts.isEnumDeclaration(node) && node.name.text === "EmojiIntentions")};EmojiIntentions;`, {});
    const allowedIntentions = declaration(file, "IS_BYPASSEABLE_INTENTION", { EmojiIntentions: intentions });
    const patch = pluginPatches(file, { IS_BYPASSEABLE_INTENTION: allowedIntentions }).find((patch: any) => patch.find === ".GUILD_SUBSCRIPTION_UNAVAILABLE;");
    const source = applyPatch(emojiAvailabilitySource, patch);
    const reasons = Object.fromEntries(["PREMIUM_LOCKED", "ROLE_SUBSCRIPTION_LOCKED", "GUILD_SUBSCRIPTION_UNAVAILABLE", "ROLE_SUBSCRIPTION_UNAVAILABLE", "DISALLOW_CUSTOM", "DISALLOW_EXTERNAL", "ONLY_GUILD_EMOJIS_ALLOWED"].map(reason => [reason, reason]));
    const modules = {
        770335: { i: { GUILD: "guild" } }, 836039: { tE: () => false }, 492494: { JN: () => false, kT: () => false },
        95701: { ke: () => false, ay: () => false }, 576705: { A: { can: () => true } }, 287809: { default: { getCurrentUser: () => ({}) } },
        350593: { A: {} }, 158045: { Ay: { canUseEmojisEverywhere: () => false, canUseAnimatedEmojis: () => false } },
        652215: { xBc: { USE_EXTERNAL_EMOJIS: "external" } },
        307731: { EmojiDisabledReasons: reasons, EmojiIntention: { ...intentions, GUILD_PROFILE: 100, NO_CUSTOM_EMOJI: 101 }, isExternalEmojiAllowedForIntention: () => true }
    };
    const original = host(emojiAvailabilitySource, modules).Ay.getEmojiUnavailableReason;
    const getReason = host(source, modules).Ay.getEmojiUnavailableReason;
    const emoji = Object.freeze({ id: "emoji", guildId: "other", type: "guild", available: true, animated: true, managed: false });
    const input = { emoji, guildId: "guild", intention: intentions.CHAT };
    assert.equal(original(input), reasons.PREMIUM_LOCKED);
    for (const intention of [intentions.CHAT, intentions.GUILD_STICKER_RELATED_EMOJI]) assert.equal(getReason({ ...input, intention }), null);
    for (const intention of [intentions.REACTION, intentions.STATUS]) {
        assert.equal(getReason({ ...input, intention }), reasons.PREMIUM_LOCKED);
        assert.equal(getReason({ ...input, intention, bypassPremiumEmojiEntitlement: true }), null);
    }
    assert.equal(getReason({ ...input, intention: 100 }), reasons.DISALLOW_CUSTOM);
    assert.equal(getReason({ ...input, intention: intentions.COMMUNITY_CONTENT }), reasons.DISALLOW_EXTERNAL);
    assert.equal(getReason({ ...input, emoji: { ...emoji, available: false }, intention: intentions.REACTION }), reasons.GUILD_SUBSCRIPTION_UNAVAILABLE);
    assert.equal(getReason({ ...input, emoji: { ...emoji, available: false } }), null);
});
