/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addAudioProcessor, removeAudioProcessor } from "@api/AudioPlayer";
import { addProfileBadge, removeProfileBadge } from "@api/Badges";
import { addChatBarButton, addChatBarButtonWrapper, removeChatBarButton, removeChatBarButtonWrapper } from "@api/ChatButtons";
import { commands as registeredCommands, registerCommand, unregisterCommand } from "@api/Commands";
import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { addGifPickerContextMenuPatch, removeGifPickerContextMenuPatch } from "@api/GifPickerContextMenu";
import { addChannelToolbarButton, addHeaderBarButton, removeChannelToolbarButton, removeHeaderBarButton } from "@api/HeaderBar";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { addMessageClickListener, addMessagePreEditListener, addMessagePreSendListener, removeMessageClickListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { addMessagePopoverButton, removeMessagePopoverButton } from "@api/MessagePopover";
import { addNicknameIcon, removeNicknameIcon } from "@api/NicknameIcons";
import { addProfileCollection, removeProfileCollection } from "@api/ProfileCollections";
import { addProfileSection, removeProfileSection } from "@api/ProfileSections";
import { disableStyle, enableStyle } from "@api/Styles";
import { addUserAreaButton, removeUserAreaButton } from "@api/UserArea";
import { Plugin } from "@utils/types";

import { PluginResources } from "./resources";

/** Keep each registration beside its inverse and capture the values being registered. */
export function registerPluginContributions(p: Plugin, resources: PluginResources, subscribeFlux: () => void) {
    const {
        name, commands, contextMenus, managedStyle, userProfileBadges,
        onBeforeMessageEdit, onBeforeMessageSend, onMessageClick,
        chatBarButton, renderMemberListDecorator, renderMessageAccessory, renderMessageDecoration, messagePopoverButton,
        renderNicknameIcon, headerBarButton, audioProcessor, userAreaButton, renderProfileCollection, chatBarButtonWrapper,
        renderProfileSection, gifPickerContextMenu
    } = p;

    for (const command of commands ?? []) {
        const commandName = command.name;
        // Subcommand registration can fail after adding its parent. Register the
        // guarded rollback first so a collision never removes another command.
        resources.add(() => {
            if (registeredCommands[commandName] === command) unregisterCommand(commandName);
        });
        registerCommand(command, name);
    }

    subscribeFlux();

    for (const [navId, callback] of Object.entries(contextMenus ?? {})) {
        resources.register(() => addContextMenuPatch(navId, callback), () => removeContextMenuPatch(navId, callback));
    }

    if (managedStyle) resources.register(() => enableStyle(managedStyle), () => disableStyle(managedStyle));

    for (const badge of userProfileBadges ?? []) {
        resources.register(() => addProfileBadge(badge), () => removeProfileBadge(badge));
    }

    if (onBeforeMessageEdit) resources.register(() => addMessagePreEditListener(onBeforeMessageEdit), () => removeMessagePreEditListener(onBeforeMessageEdit));
    if (onBeforeMessageSend) resources.register(() => addMessagePreSendListener(onBeforeMessageSend), () => removeMessagePreSendListener(onBeforeMessageSend));
    if (onMessageClick) resources.register(() => addMessageClickListener(onMessageClick), () => removeMessageClickListener(onMessageClick));

    if (chatBarButton) resources.register(
        () => addChatBarButton(name, chatBarButton.render, chatBarButton.icon),
        () => removeChatBarButton(name)
    );
    if (renderMemberListDecorator) resources.register(
        () => addMemberListDecorator(name, renderMemberListDecorator),
        () => removeMemberListDecorator(name)
    );
    if (renderMessageDecoration) resources.register(
        () => addMessageDecoration(name, renderMessageDecoration),
        () => removeMessageDecoration(name)
    );
    if (renderMessageAccessory) resources.register(
        () => addMessageAccessory(name, renderMessageAccessory),
        () => removeMessageAccessory(name)
    );
    if (messagePopoverButton) resources.register(
        () => addMessagePopoverButton(name, messagePopoverButton.render, messagePopoverButton.icon),
        () => removeMessagePopoverButton(name)
    );

    if (renderNicknameIcon) resources.register(() => addNicknameIcon(name, renderNicknameIcon), () => removeNicknameIcon(name));
    if (headerBarButton) {
        const { location, render, priority } = headerBarButton;
        if (location === "channeltoolbar") {
            resources.register(() => addChannelToolbarButton(name, render, priority), () => removeChannelToolbarButton(name));
        } else {
            resources.register(() => addHeaderBarButton(name, render, priority), () => removeHeaderBarButton(name));
        }
    }
    if (audioProcessor) resources.register(() => addAudioProcessor(name, audioProcessor), () => removeAudioProcessor(name));
    if (userAreaButton) resources.register(
        () => addUserAreaButton(name, userAreaButton.render, userAreaButton.priority),
        () => removeUserAreaButton(name)
    );
    if (renderProfileCollection) resources.register(
        () => addProfileCollection(name, renderProfileCollection.render, renderProfileCollection.priority),
        () => removeProfileCollection(name)
    );
    if (chatBarButtonWrapper) resources.register(
        () => addChatBarButtonWrapper(name, chatBarButtonWrapper.wrapper, chatBarButtonWrapper.priority),
        () => removeChatBarButtonWrapper(name)
    );
    if (renderProfileSection) resources.register(
        () => addProfileSection(name, renderProfileSection.render, renderProfileSection.priority),
        () => removeProfileSection(name)
    );
    if (gifPickerContextMenu) resources.register(
        () => addGifPickerContextMenuPatch(name, gifPickerContextMenu),
        () => removeGifPickerContextMenuPatch(name)
    );
}
