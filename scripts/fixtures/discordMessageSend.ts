/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import messageEventsPlugin from "../../src/plugins/_api/messageEvents";
import { canonicalizeMatch } from "../../src/utils/patches";
import type { PatchReplacement } from "../../src/utils/types";

// Captured 2026-09-22 from Discord module 688438 (Brotli cache entry f_000535).
// The entire observed handleSendMessage body is retained, including the size checks,
// failed-send draft restoration, draft cleanup, and four-argument sendMessage call.
export const discordMessageSendSource = "class ChatInput {handleSendMessage=async e=>{let{value:t,uploads:n,stickers:l,command:i,commandOptionValues:s,isGif:a,gifMetadata:r,components:o,announcementSendOptions:c}=e;if(0===(t=t.trim()).length&&(null==l||0===l.length)&&(null==n||0===n.length))return Promise.resolve({shouldClear:!1,shouldRefocus:!0});let{guild:d,channel:h,pendingReply:m,chatInputType:g}=this.props,p=!1;if(null!=i){if(i.inputType===k.y$.BUILT_IN_INTEGRATION)return nN._.dispatch(ew.jej.SHAKE_APP,{duration:200,intensity:2}),Promise.resolve({shouldClear:!1,shouldRefocus:!0});let e=L.A.getCommandOrigin(h.id);if(null==e||e===k.iw.CHAT){let{isAuthorized:e}=await (0,G.q)({applicationId:i.applicationId,channel:h,commandIntegrationTypes:i.integration_types});if(!e)return Promise.resolve({shouldClear:!1,shouldRefocus:!0})}else if(e===k.iw.APPLICATION_LAUNCHER||e===k.iw.IMAGE_RECS_MENU||e===k.iw.IMAGE_RECS_SUBMENU){let{location:t,sectionName:n}=(0,nL.bV)(i)??{},l=e===k.iw.APPLICATION_LAUNCHER?T.A.lastShownEntrypoint():v.s4.TEXT,{isAuthorized:s}=await (0,G.q)({applicationId:i.applicationId,channel:h,commandIntegrationTypes:i.integration_types,appLauncherContext:{location:t,sectionName:n,entrypoint:l}});if(!s)return Promise.resolve({shouldClear:!1,shouldRefocus:!0});(0,nL.My)(i)}let n=await (0,O.A)({command:i,optionValues:s??{},context:{guild:d,channel:h}});if(i.inputType!==k.y$.BUILT_IN_TEXT)return Promise.resolve({shouldClear:!0,shouldRefocus:!0});null!=n&&(t=null!=n.content&&\"\"!==n.content?n.content:t,p=!0===n.tts)}return(0,nT.i)({openWarningPopout:e=>this.setState({contentWarningProps:e}),type:this.props.chatInputType,content:t,hasStickers:null!=l&&l.length>0,hasAttachments:null!=n&&n.length>0,channel:h}).then(e=>{let{valid:s,failureReason:A}=e;if(!s)if(A===ew.X8x.SLOWMODE_COOLDOWN)return nN._.dispatch(ew.jej.SHAKE_APP,{duration:200,intensity:2}),nN._.dispatch(ew.jej.EMPHASIZE_SLOWMODE_COOLDOWN),{shouldClear:!1,shouldRefocus:!0};else return{shouldClear:!1,shouldRefocus:!1};let f=(0,t$.S)(t,{channel:h,isEdit:!1});null!=f&&(null!=f.content&&(t=f.content),null!=f.tts&&(p=f.tts));let E=tq.Ay.parse(h,t);E.tts=E.tts||p,null!=o&&(E.content=\"\",E.components=o);let I={...x.A.getSendMessageOptions({content:t,channelId:h.id,uploads:n,stickers:l,command:i,isGif:a,pendingReply:m,scheduledTimestamp:this.props.scheduledMessageDraft?.scheduledTimestamp}),location:nq.Hx.CHAT_INPUT};if(null!=c&&(I.announcementSendOptions=c),null!=r&&(I.gifMetadata=r),null!=o&&(I.flags=(0,u.UI)(I.flags??0,ew.pr7.IS_COMPONENTS_V2)),a)return x.A.sendMessage(h.id,E,void 0,I),(0,nu.Jx)(h.id),{shouldClear:!1,shouldRefocus:!0};function _(){\"\"!==t&&\"\"===eC.A.getDraft(h.id,eC.C.ChannelMessage)&&C.A.saveDraft(h.id,t,eC.C.ChannelMessage),null!=n&&n.length>0&&0===eE.A.getUploadCount(h.id,eC.C.ChannelMessage)&&S.A.setUploads({channelId:h.id,uploads:n,draftType:eC.C.ChannelMessage})}if(null!=n&&n.length>0){let e=(0,nv.LJ)(n);if((0,nv.fJ)(e,d?.id))return(0,e_.V)(h,e),{shouldClear:!1,shouldRefocus:!1};I.eagerDispatch=!1,I.attachmentsToUpload=n,I.onAttachmentUploadError=(e,t,n)=>{(0,tV.k)({file:e,guildId:h.getGuildId(),analyticsLocations:[],code:t,reason:n})&&_()},S.A.clearAll(h.id,eC.C.ChannelMessage)}return x.A.sendMessage(h.id,E,void 0,I).catch(e=>{throw(null!=I.scheduledTimestamp||!1===I.eagerDispatch)&&_(),e}),this.setState((0,w.N3)()),(0,nu.Jx)(h.id),(0,nf.x5)(h.id,g.drafts.type),{shouldClear:!0,shouldRefocus:!0}})};}const chatInput=new ChatInput(),view={handleSendMessage:chatInput.handleSendMessage,onResize:null};";

export function patchDiscordMessageSend(source = discordMessageSendSource, overrides?: PatchReplacement[]): string {
    const patch = messageEventsPlugin.patches?.find(candidate => candidate.find === ".handleSendMessage,onResize:");
    if (!patch) throw new Error("Missing MessageEvents composer patch");
    const replacements = overrides ?? (Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement]);
    return replacements.reduce((current, replacement) => {
        const match = canonicalizeMatch(replacement.match);
        const next = typeof replacement.replace === "string"
            ? current.replace(match, replacement.replace)
            : current.replace(match, replacement.replace);
        // WebpackPatcher rolls back the entire group if any replacement has no effect.
        // Tests must not run a partially patched fixture that the client would discard.
        if (next === current) throw new Error(`MessageEvents patch group has no effect: ${replacement.match}`);
        return next;
    }, source);
}
