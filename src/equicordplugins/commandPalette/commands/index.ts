import { registerCommands } from "../api/registry";
import { registerCustomCommands } from "./custom";
import { discordCommands } from "./discordActions";
import { equicordCommands } from "./equicord";
import { navigationCommands } from "./navigation";
import { pluginCommands } from "./pluginManagement";
import { sendDmCommand } from "./sendDm";

export function registerBuiltinCommands() {
    registerCommands("CommandPalette.builtin", [
        ...navigationCommands,
        ...discordCommands,
        ...pluginCommands,
        ...equicordCommands,
        sendDmCommand
    ]);

    registerCustomCommands();
}
