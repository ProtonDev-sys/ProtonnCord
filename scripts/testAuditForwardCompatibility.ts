import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordForwardPreviews } from "./fixtures/discordForwardPreview";
import { loadTestModule } from "./utils/loadTestModule";
import { elements } from "./utils/discordClientFixture";

const jsx = (type: unknown, props: any, ...children: unknown[]) => ({ type, props: children.length ? { ...props, children } : props });
const React = { createElement: jsx };

function loadPlugin() {
    return loadTestModule("src/equicordplugins/betterForwards/index.tsx", {
        "@api/PluginManager": { plugins: {} },
        "@api/Settings": { definePluginSettings: () => ({ store: {} }), migratePluginSettings() {} },
        "@components/BaseText": {}, "@components/ErrorBoundary": { __esModule: true, default: "boundary" },
        "@components/Flex": {}, "@components/Icons": {}, "@components/margins": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/discord": {}, "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack": { proxyLazyWebpack: (factory: unknown) => factory }, "@webpack/common": { React },
        "../secureMessaging.desktop/forwarding": {}, "../secureMessaging.desktop/protocol": {},
        "./components": { ForwardPicker: "custom-picker" }
    }, {}).default;
}

test("forward media picker preserves native text, thumbnails and checkpoint previews on both clients", () => {
    const plugin = loadPlugin();
    const replacement = plugin.patches[1].replacement[3];
    const modules: Record<string, any> = {
        477900: { jsx, jsxs: jsx }, 582128: { useMemo: (get: () => unknown) => get() },
        17928: { bG: (_stores: unknown, get: () => unknown) => get() },
        435558: { countBy: (values: any[], get: (value: any) => string) => values.reduce((counts, value) => {
            const key = get(value); counts[key] = (counts[key] ?? 0) + 1; return counts;
        }, {} as Record<string, number>) },
        661531: { A: { colors: { TEXT_MUTED: "muted" } } },
        503698: (...values: string[]) => values.join(" "),
        448381: { NI: (attachment: any) => attachment.kind },
        918909: { _S: (message: any) => message.checkpoint, b5: (checkpoint: any) => checkpoint.title },
        521981: { Ay: (_message: unknown, props: any) => ({ content: props.contentMessage.content }) },
        659674: { fS: () => true, ax: () => false },
        885386: { hH: { useSetting: () => true } },
        619517: { Ay: "thumbnail" }, 438729: { Ay: "content" }, 739126: {},
        573435: { Ay: Object.assign(() => {}, { Masks: { FORWARD_ATTACHMENT_PILE_OVERFLOW: "mask" } }) },
        477262: { s: "images" }, 65154: { S: "video" }, 191023: { ImageIcon: "image" }, 588975: { P: "file" },
        660183: { intl: { formatToPlainString: () => "Attachment summary" }, t: {} }, 834730: { E: "text" }
    };
    for (const fixture of discordForwardPreviews) {
        const source = fixture.source.replace(canonicalizeMatch(replacement.match), canonicalizeReplace(replacement.replace, "plugin"));
        assert.notEqual(source, fixture.source, "the picker must match current native preview code");
        const globals = {
            ...Object.fromEntries(Object.entries(fixture.imports).map(([name, id]) => [name, modules[id] ?? {}])),
            ...Object.fromEntries(Object.entries(fixture.defaults).map(([name, id]) => [name, () => modules[id]])),
            [fixture.checkpointComponent]: "checkpoint",
            plugin
        };
        const render = runInNewContext(`(${source})`, globals);
        for (const kind of ["IMAGE", "VIDEO", "embed"]) {
            const original = {
                content: "Original forwarded text", messageSnapshots: [], checkpoint: { title: "Checkpoint" },
                attachments: kind === "embed" ? [] : [{ id: "media", kind, proxy_url: "native-thumbnail" }],
                embeds: kind === "embed" ? [{ thumbnail: { proxyURL: "native-thumbnail" } }] : []
            };
            const message = { ...original, content: "Wrapper text", messageSnapshots: [{ message: original }] };
            const nodes = elements(render({ message, channel: {} }));
            assert.equal(nodes.filter(node => node.type === "custom-picker").length, 1);
            assert.equal(nodes.find(node => node.type === "content").props.content, "Original forwarded text");
            assert.equal(nodes.find(node => node.type === "content").props.message, message);
            assert.equal(nodes.find(node => node.type === "thumbnail").props.src, "native-thumbnail");
            assert.equal(nodes.find(node => node.type === "checkpoint").props.checkpointData, original.checkpoint);
            assert.equal(nodes.some(node => node.props?.children === "Attachment summary"), false, "custom selection replaces only the old attachment count");
        }
    }
});
