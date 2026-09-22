/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import messageEventsPlugin from "../../src/plugins/_api/messageEvents";
import { canonicalizeMatch } from "../../src/utils/patches";

// Current Discord composer shape, including the post-hook upload assignment.
// x.A.sendMessage is the harness boundary for executing the host's upload handoff.
export const discordMessageSendSource = `class ChatInput {handleSendMessage=async e=>{return(0,nb.i)({openWarningPopout:e=>this.setState({contentWarningProps:e}),type:this.props.chatInputType,content:t,hasStickers:null!=l&&l.length>0,hasAttachments:null!=n&&n.length>0,channel:h}).then(e=>{let{valid:s,failureReason:f}=e;let _=tU.Ay.parse(h,t);_.tts=_.tts||A,null!=o&&(_.content="",_.components=o);let I={...x.A.getSendMessageOptions({content:t,channelId:h.id,uploads:n,stickers:l,command:i,isGif:a,pendingReply:m,alsoForwardToChannelId:p?h.parent_id??void 0:void 0,scheduledTimestamp:this.props.scheduledMessageDraft?.scheduledTimestamp}),location:nB.Hx.CHAT_INPUT};null!=c&&(I.announcementSendOptions=c),null!=r&&(I.gifMetadata=r),null!=o&&(I.flags=(0,u.UI)(I.flags??0,eM.pr7.IS_COMPONENTS_V2));if(null!=n&&n.length>0)I.attachmentsToUpload=n;x.A.sendMessage(h.id,_,I);return{shouldClear:true}})}};const chatInput=new ChatInput(),view={handleSendMessage:chatInput.handleSendMessage,onResize:null};`;

export function patchDiscordMessageSend(source = discordMessageSendSource): string {
    const patch = messageEventsPlugin.patches?.find(candidate => candidate.find === ".handleSendMessage,onResize:");
    if (!patch) throw new Error("Missing MessageEvents composer patch");
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    return replacements.reduce((current, replacement) => {
        const match = canonicalizeMatch(replacement.match);
        return typeof replacement.replace === "string"
            ? current.replace(match, replacement.replace)
            : current.replace(match, replacement.replace);
    }, source);
}
