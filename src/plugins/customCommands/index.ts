/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import "./styles.css";

import { ApplicationCommandInputType, ApplicationCommandOptionType, BUILT_IN, commands, findOption, registerCommand, sendBotMessage, unregisterCommand, VencordCommand } from "@api/Commands";
import { migratePluginSettings, SettingsStore } from "@api/Settings";
import { Devs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { FluxDispatcher, MessageActions, PendingReplyStore } from "@webpack/common";

import { openCreateTagModal } from "./CreateTagModal";
import { getTag, getTags, removeTag, settings, Tag } from "./settings";

const CustomCommandsMarker = Symbol("CustomCommands");
const ArgumentRegex = /{{(.+?)}}/g;
const logger = new Logger("CustomCommands");
let active = false;

type TagCommand = VencordCommand & { [CustomCommandsMarker]?: string; };

function parseArgument(value: string) {
    const separator = value.indexOf("=");
    return {
        name: (separator === -1 ? value : value.slice(0, separator)).trim().toLowerCase(),
        defaultValue: separator === -1 ? null : value.slice(separator + 1).trim()
    };
}

export function parseTagArguments(message: string) {
    const args: ReturnType<typeof parseArgument>[] = [];
    for (const [, value] of message.matchAll(ArgumentRegex)) {
        const arg = parseArgument(value);
        if (!arg.name) continue;
        const previous = args.find(previous => previous.name === arg.name);
        if (!previous) args.push(arg);
        else if (arg.defaultValue === null) previous.defaultValue = null;
    }
    return args;
}

export function validateTag(tag: Tag) {
    if (!tag.name.trim() || tag.name !== tag.name.trim()) return "Enter a name without leading or trailing spaces.";
    if (!tag.message.trim()) return "Enter a response.";
    if (tag.name === "tags" || tag.name.startsWith("tags ") || Object.hasOwn(Object.prototype, tag.name))
        return "This command name is reserved.";
    if (parseTagArguments(tag.message).some(arg => arg.name === "ephemeral"))
        return 'The argument name "ephemeral" is reserved and cannot be used.';
    const existing: TagCommand | undefined = commands[tag.name];
    if ((existing && existing[CustomCommandsMarker] === undefined) || BUILT_IN?.some(command => command.name === tag.name && command !== existing))
        return `A command with the name "${tag.name}" already exists.`;
}

function syncTagCommands(_data?: unknown, path = "") {
    if (!active || (path && path !== "plugins" && path !== "plugins.CustomCommands" && path !== "plugins.CustomCommands.tagsList" && !path.startsWith("plugins.CustomCommands.tagsList."))) return;
    for (const command of Object.values(commands) as TagCommand[]) {
        if (command[CustomCommandsMarker] === undefined) continue;
        const tag = getTag(command.name);
        if (!tag || tag.message !== command[CustomCommandsMarker]) unregisterCommand(command.name);
    }
    for (const tag of getTags()) {
        const command: TagCommand | undefined = commands[tag.name];
        if (command?.[CustomCommandsMarker] === tag.message) continue;
        try { registerTagCommand(tag); } catch (error) { logger.error("Could not register custom command", tag.name, error); }
    }
}

export function registerTagCommand(tag: Tag) {
    const error = validateTag(tag);
    if (error) throw new Error(error);
    if (!active) return;
    if (!BUILT_IN) throw new Error("Commands are not ready yet. Try again after restarting Discord.");
    const tagArguments = parseTagArguments(tag.message);
    const { message } = tag;
    const command: TagCommand = {
        name: tag.name,
        description: tag.name,
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [
            ...tagArguments.sort((a, b) => Number(b.defaultValue === null) - Number(a.defaultValue === null)).map(arg => ({
                name: arg.name,
                description: arg.name,
                type: ApplicationCommandOptionType.STRING,
                required: arg.defaultValue === null
            })),
            {
                name: "ephemeral",
                description: "Whether the response should only be visible to you",
                type: ApplicationCommandOptionType.BOOLEAN,
                required: false
            }
        ],

        execute: async (args, { channel }) => {
            if (!active || commands[command.name] !== command) return;
            const ephemeral = findOption(args, "ephemeral", false);

            const response = message
                .replace(ArgumentRegex, (fullMatch, value: string) => {
                    const { name, defaultValue } = parseArgument(value);
                    return name ? findOption(args, name, null) ?? defaultValue ?? fullMatch : fullMatch;
                })
                .replaceAll("\\n", "\n");

            if (ephemeral) {
                sendBotMessage(channel.id, { content: response });
                return;
            }
            const reply = PendingReplyStore.getPendingReply(channel.id);
            await sendMessage(channel.id, { content: response }, false, MessageActions.getSendMessageOptionsForReply(reply));
            if (active && commands[command.name] === command && reply && PendingReplyStore.getPendingReply(channel.id) === reply)
                FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId: channel.id });
        },
        [CustomCommandsMarker]: message,
    };
    const previous = commands[tag.name];
    if (previous) unregisterCommand(tag.name);
    try {
        registerCommand(command, "CustomCommands");
    } catch (error) {
        if (previous) registerCommand(previous, "CustomCommands");
        throw error;
    }
}

migratePluginSettings("CustomCommands", "MessageTags");
export default definePlugin({
    name: "CustomCommands",
    description: "Allows you to create custom slash commands / tags",
    dependencies: ["CommandsAPI"],
    searchTerms: ["MessageTags"],
    authors: [Devs.Ven, Devs.Luna,],
    tags: ["Commands", "Customisation", "Utility"],
    settings,

    start() {
        active = true;
        SettingsStore.addGlobalChangeListener(syncTagCommands);
        syncTagCommands();
    },

    stop() {
        active = false;
        SettingsStore.removeGlobalChangeListener(syncTagCommands);
        for (const command of Object.values(commands) as TagCommand[]) {
            if (command[CustomCommandsMarker] !== undefined) unregisterCommand(command.name);
        }
    },

    commands: [
        {
            name: "tags",
            description: "Manage all custom commands",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "create",
                    description: "Create a new tag",
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                },
                {
                    name: "list",
                    description: "List all your tags",
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    options: []
                },
                {
                    name: "delete",
                    description: "Remove a tag by name",
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    options: [
                        {
                            name: "tag-name",
                            description: "The name of the tag",
                            type: ApplicationCommandOptionType.STRING,
                            required: true
                        }
                    ]
                },
            ],

            async execute(args, ctx) {
                switch (args[0].name) {
                    case "create": {
                        openCreateTagModal();
                        break;
                    }

                    case "delete": {
                        const name: string = findOption(args[0].options, "tag-name", "");

                        if (!getTag(name))
                            return sendBotMessage(ctx.channel.id, {
                                content: `A Tag with the name **${name}** does not exist!`
                            });

                        removeTag(name);

                        sendBotMessage(ctx.channel.id, {
                            content: `Successfully deleted the tag **${name}**!`
                        });

                        break;
                    }

                    case "list": {
                        const content = getTags()
                            .map(tag => `\`${tag.name}\`: ${tag.message.slice(0, 72).replaceAll("\\n", " ")}${tag.message.length > 72 ? "..." : ""}`)
                            .join("\n");

                        sendBotMessage(ctx.channel.id, {
                            content: content || "Woops! There are no tags yet, use `/tags create` to create one!",
                        });

                        break;
                    }
                }
            }
        }
    ]
});
