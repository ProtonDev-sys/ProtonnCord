/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ProtonnCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Literal, hand-written examples, not repeated filler. Keep the exact text so
// reported savings include the same punctuation, spaces and paragraph breaks.
export const messageCompressionSamples = [
    {
        name: "Short chat",
        text: "Yeah, that works for me. I'll be home around seven, so we can call after dinner."
    },
    {
        name: "Ordinary paragraph",
        text: "I finally had a chance to try the new build this evening. The settings page feels much easier to navigate, and I like that the search remembers what I was looking for. One thing I noticed is that the window opens a little too wide on my laptop, so the buttons near the bottom disappear until I resize it. I'll try the same steps on my desktop tomorrow and let you know whether it happens there too."
    },
    {
        name: "Three-paragraph conversation",
        text: "I've been thinking about the weekend trip, and I reckon we should take the earlier train on Saturday. It means getting up a bit sooner, but we'd have time to drop our bags off and find somewhere for lunch before the museum gets busy. I checked the weather this morning and it looks like there might be a shower in the afternoon, so having an indoor plan seems sensible.\n\nFor Sunday, I'd rather leave things fairly open. We could walk along the river if it's dry, or find a quiet cafe and spend a couple of hours there if it isn't. I'm happy to book the tickets tonight once you know whether you're working late on Friday. There's no rush to choose a restaurant; we can ask the people at the hotel when we arrive.\n\nAlso, I found the little camera I thought I'd lost. The battery still charges, but I need to clear some space on the memory card before we go. I'll bring the charger and a spare cable so we don't have to share one between all our devices. Let me know if you want me to pick anything up from the shop on my way home."
    },
    {
        name: "Technical update",
        text: "Quick update on the notification bug:\n\n- I can reproduce it when the app is closed while a download is still running. The download completes, but the notification points to the old temporary filename.\n- Restarting the app fixes the filename for new downloads. It does not repair notifications that have already been queued.\n- The change is in the completion handler. It now waits for the final rename before creating the notification, and it keeps the original error if that rename fails.\n- I tested a normal download, a cancelled download, a filename containing spaces, and a destination folder that cannot be written to.\n\nThe part I still want another pair of eyes on is the retry path. At the moment it clears the previous progress entry before starting again. That seems reasonable to me, but it means the failed attempt disappears from the list. If we want to keep a history of attempts, I think that should be a separate change so this fix stays easy to review."
    },
    {
        name: "Long ordinary message",
        text: "Sorry for the long message, but I wanted to write everything down while it was still fresh. I went through the first version of the app this afternoon and tried to use it as someone who had never seen the project before. I made a new account, added a few items, changed the display settings, and then came back after closing the window. Most of that felt straightforward, and the saved items were exactly where I expected them to be.\n\nThe main place I got stuck was choosing a folder. The button says to select a location, but the next screen asks for a name before it lets you continue. I wasn't sure whether I was naming the folder on my computer or creating a collection inside the app. A short sentence above the field would probably answer that. It would also help if the example used an everyday name instead of the internal project name.\n\nI noticed a smaller issue with the search results. When I typed part of an item's title, the right result appeared immediately. When I pasted the full title with a space at the end, the list was empty. I would expect extra spaces at either end to be ignored. Searching within a description worked, although I couldn't tell which part of the description matched until I opened the item. Highlighting the matching words would make that much easier to understand.\n\nThe empty state could use a little more guidance too. Right now it tells me that I haven't added anything, which is true, but it doesn't explain what sorts of things belong there. A small example and a single clear button would be enough. I don't think we need a guided tour or a set of popups; people should be able to explore the screen at their own pace.\n\nFor the next build, I would focus on those small points before adding more options. We already have enough features to see whether the basic workflow feels useful. Once the labels are clearer, we can ask a couple of friends to try the same tasks and watch where they hesitate. It would be useful to hear what they expect before explaining how the app is meant to work. That should tell us more than asking whether they like the design.\n\nNone of this needs to hold up tomorrow's demo. We can show the current version, explain that we're still working on the wording, and collect feedback as we go. I'll put the screenshots in the shared folder later tonight, along with the exact steps for the search issue. If you have time in the morning, could you check whether it also happens on your laptop?"
    }
] as const;
