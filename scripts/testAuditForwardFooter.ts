/*
 * Protonn Cord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { discordForwardFooters } from "./fixtures/discordForwardFooter";
import { applyPatch, evaluate, jsx, pluginPatches, React, sourceNode } from "./utils/discordClientFixture";

const file = "src/equicordplugins/betterForwards/index.tsx";
const patch = pluginPatches(file).find((patch: any) => patch.replacement?.replace?.includes("renderForwardFooter"));

for (const [channelName, source] of Object.entries(discordForwardFooters)) {
    test(`${channelName}: BetterForwards selects the current footer call without changing adjacent native footer functions`, () => {
        const factory = Object.values(source).join(";");
        assert.ok(factory.includes(patch.find), "the finder must occur in the current native factory");
        const transformed = applyPatch(factory, patch);
        for (const unchanged of [source.breadcrumb, source.footer, source.otherFooter]) assert.ok(transformed.includes(unchanged));
        assert.ok(!transformed.includes(source.parent));
    });

    test(`${channelName}: native forward snapshot visibility, content and accessory props survive the custom footer`, () => {
        const footer = evaluate(`({${sourceNode(file, node => ts.isMethodDeclaration(node) && node.name.getText() === "renderForwardFooter")}}).renderForwardFooter;`, {
            React, ErrorBoundary: "boundary", cl: (name: string) => name, GuildName: "guild", ChannelName: "channel", Timestamp: "timestamp"
        });
        const channel = Object.freeze({ id: "target-channel" });
        const messageReference = Object.freeze({ guild_id: "origin-guild", channel_id: "origin-channel", message_id: "origin-message" });
        const snapshot = Object.freeze({ id: "snapshot", timestamp: new Date(0) });
        const onMediaItemContextMenu = () => {};
        for (const visibleChannel of [true, false]) for (const hidden of [true, false]) for (const disabled of [true, false]) {
            const calls: any[] = [];
            const accessories: any[] = [];
            const plugin = { renderForwardFooter(props: any) { calls.push(props); return footer(props); } };
            const nativeJsx = (type: unknown, props: any, key?: unknown) => type === plugin.renderForwardFooter
                ? plugin.renderForwardFooter(props) : { type, props, key };
            const [snapshotName, settingsName, developerName, hiddenName, allowListName, contentName, processorName, stylesName, headerName, messageName] = channelName === "stable"
                ? ["ih", "it", "ii", "n9", "n4", "n7", "ie", "ig", "ip", "n8"]
                : ["ig", "ii", "il", "n8", "n9", "ie", "it", "ip", "iA", "n7"];
            const render = runInNewContext(`(${applyPatch(source.parent, patch)})`, {
                plugin, s: { jsx: nativeJsx, jsxs: nativeJsx }, r: { useMemo: (read: Function) => read() },
                [snapshotName]: { A: () => snapshot }, [settingsName]: Object.fromEntries(["hD", "rs", "hH"].map(key => [key, { useSetting: () => false }])),
                u: { bG: (_stores: unknown, read: Function) => read() }, [developerName]: { A: { isDeveloper: false } },
                [hiddenName]: { U: () => hidden }, [allowListName]: { S: () => true }, [contentName]: { A: () => ({ content: "native content", hasSpoilerEmbeds: true, hasBailedAst: false }) },
                [processorName]: { A: "processor" }, D: { A: { getChannel: () => visibleChannel ? channel : undefined } },
                [stylesName]: { kL: "snapshot", hD: "border", Qs: "content" }, [headerName]: "header", [messageName]: { Ay: "message" }
            });
            const message = Object.freeze({ channel_id: channel.id, messageReference });
            const tree = render(Object.freeze({ message, snapshot, index: 2, disableComponentInteractivity: disabled, onMediaItemContextMenu,
                renderAccessories: (props: any) => { accessories.push(props); return jsx("accessories", props); } }));
            if (!visibleChannel) {
                assert.equal(tree, null);
                assert.equal(calls.length, 0);
                assert.equal(accessories.length, 0);
                continue;
            }
            assert.equal(tree.key, 2);
            const children = tree.props.children[1].props.children;
            assert.equal(children[0].type, "header");
            assert.equal(children[1].props.message, snapshot);
            assert.equal(children[1].props.content, "native content");
            assert.equal(accessories[0].channelMessageProps.channel, channel);
            assert.equal(accessories[0].channelMessageProps.message, snapshot);
            assert.equal(accessories[0].disableComponentInteractivity, disabled);
            assert.equal(accessories[0].handleContextMenu, onMediaItemContextMenu);
            assert.equal(accessories[0].hasSpoilerEmbeds, true);
            assert.equal(accessories[0].renderThreadAccessory, false);
            assert.equal(calls.length, hidden ? 0 : 1);
            if (hidden) assert.equal(children[3], false);
            else {
                assert.equal(calls[0].message, message);
                assert.equal(calls[0].snapshot, snapshot);
                assert.equal(calls[0].index, 2);
                assert.equal(children[3].type, "boundary");
                const elements = children[3].props.children[0].props.children;
                assert.deepEqual(Array.from(elements, (element: any) => element.type), ["guild", "channel", "timestamp"]);
                assert.equal(elements[1].props.channelId, messageReference.channel_id);
                assert.equal(elements[2].props.snowflake, messageReference.message_id);
            }
        }
        assert.equal(footer({ message: { messageReference: null } }), null);
    });
}
