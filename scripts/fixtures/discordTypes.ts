// Type-only regression cases checked by the existing project tsc command.
import type { ComponentProps } from "react";
import type { ComboboxPopout } from "../../packages/discord-types/src";
import type { WebpackRequire } from "../../packages/discord-types/webpack";
const props: ComponentProps<ComboboxPopout> = {
    value: new Set<string>(),
    placeholder: "Select an item",
    children: query => [query],
    onChange() {}
};
const invalid: ComponentProps<ComboboxPopout> = {
    ...props,
    // @ts-expect-error This component requires a query render callback.
    children: "plain text"
};
void invalid;
declare const webpackRequire: WebpackRequire;
const ownsProperty: boolean = webpackRequire.o({ key: undefined }, "key");
webpackRequire.o({}, Symbol("key"));
webpackRequire.o([], 0);
// @ts-expect-error The wrapper requires both object and property arguments.
webpackRequire.o("key");
// @ts-expect-error An object is not a property key.
webpackRequire.o({}, {});
void ownsProperty;
