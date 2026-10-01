import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture() {
    const effects: Array<() => (() => void) | undefined> = [];
    const listeners = new Map<string, { callback: () => void; once: boolean; }>();
    const media = {
        tagName: "AUDIO", className: "audioElement", paused: true, playbackRate: 1,
        addEventListener: (event: string, callback: () => void, options: { once?: boolean; }) => listeners.set(event, { callback, once: !!options.once }),
        removeEventListener: (event: string, callback: () => void) => {
            if (listeners.get(event)?.callback === callback) listeners.delete(event);
        }
    };
    const mediaRef = { current: media };
    const store = { defaultVoiceMessageSpeed: 1.5, defaultVideoSpeed: 2, defaultAudioSpeed: 0.75 };
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    let selectionRef: { current: unknown; } | undefined;
    let menu: any;
    const modules: Record<string, any> = {
        "./styles.css": {}, "./components/SpeedIcon": {},
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} }, "@utils/css": { classNameFactory: () => () => "speed" },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {}, makeRange: () => [0.25, 1, 1.5, 2, 3.5] },
        "@webpack/common": {
            React, Tooltip: "Tooltip", Menu: { Menu: "Menu", MenuGroup: "Group", MenuItem: "Item" },
            ContextMenuApi: { openContextMenu: (_event: unknown, factory: () => unknown) => { menu = factory(); } },
            FluxDispatcher: { dispatch() {} }, useEffect: (effect: typeof effects[number]) => effects.push(effect),
            useRef: (current: unknown) => selectionRef ??= { current }
        }
    };
    const filename = "src/equicordplugins/mediaPlaybackSpeed/index.tsx";
    const code = transpileModule(readFileSync(filename, "utf8"), {
        fileName: filename, compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const plugin = runInNewContext(code + "\nexports.default;", { exports: {}, require: (name: string) => {
        assert.ok(name in modules, name);
        return modules[name];
    } });
    return {
        media, mediaRef, store, listeners,
        mount() {
            const view = plugin.renderPlaybackSpeedComponent({ mediaRef });
            const cleanup = effects.shift()!();
            return { cleanup, select(speed: number) {
                view.props.children[0]({}).props.onClick({});
                const items = menu.props.children[0].props.children[0];
                items.find((item: any) => item.props.id === `speed-${speed}`).props.action();
            } };
        },
        play(target = media) {
            target.paused = false;
            target.playbackRate = 1;
            const handler = listeners.get("play");
            if (handler?.once) listeners.delete("play");
            handler?.callback();
        }
    };
}

test("MediaPlaybackSpeed preserves a speed selected before the first voice playback", () => {
    const api = fixture();
    const component = api.mount();
    component.select(2);
    assert.equal(api.media.playbackRate, 2);
    api.play();
    assert.equal(api.media.playbackRate, 2);
    assert.equal(api.listeners.size, 0);
});

test("MediaPlaybackSpeed defaults and pending events target the captured element, not a replacement ref", () => {
    const api = fixture();
    api.mount();
    const replacement = { ...api.media, playbackRate: 1 };
    api.mediaRef.current = replacement;
    api.play();
    assert.equal(api.media.playbackRate, 1.5);
    assert.equal(replacement.playbackRate, 1);
});

test("MediaPlaybackSpeed releases pending playback listeners on unmount", () => {
    const api = fixture();
    const component = api.mount();
    assert.equal(api.listeners.size, 1);
    component.cleanup!();
    assert.equal(api.listeners.size, 0);
    api.play();
    assert.equal(api.media.playbackRate, 1);
});

test("MediaPlaybackSpeed does not carry a selected speed to a replacement media element", () => {
    const api = fixture();
    const component = api.mount();
    component.select(2);
    component.cleanup!();
    const replacement = { ...api.media, playbackRate: 1 };
    api.mediaRef.current = replacement;
    api.mount();
    api.play(replacement);
    assert.equal(replacement.playbackRate, 1.5);
    assert.equal(api.media.playbackRate, 2);
});

test("MediaPlaybackSpeed applies bounded defaults to audio, video and already playing voice messages", () => {
    for (const [tagName, className, paused, expected] of [
        ["AUDIO", "attachment", true, 0.75], ["VIDEO", "video", true, 2], ["AUDIO", "audioElement", false, 1.5]
    ] as const) {
        const api = fixture();
        Object.assign(api.media, { tagName, className, paused });
        api.mount();
        assert.equal(api.media.playbackRate, expected);
    }
    for (const [value, expected] of [[NaN, 1], [Infinity, 1], [-10, 0.25], [10, 3.5]]) {
        const api = fixture();
        api.store.defaultVoiceMessageSpeed = value;
        api.mount();
        api.play();
        assert.equal(api.media.playbackRate, expected);
    }
});
