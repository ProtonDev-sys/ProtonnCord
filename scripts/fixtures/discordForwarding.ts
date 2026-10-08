/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Captured 2026-10-08 from Discord module 914718, chunk 84755:
// https://discord.com/assets/b06fc554f142ed45.js
// Keep the private actions and native reference construction verbatim. The React
// modal is reduced to its observed allSettled success/failure decision below.
export const discordForwardingSource = `t.d(n,{ForwardModal:()=>ek});
let H={async sendForward(e,n,t){let l=R.A.getChannel(n),a=R.A.getChannel(e.channel_id),i=t?.isICYMIGameContentForwarding?T.VL:a?.guild_id;if(null==a&&null==i)throw Error("Unable to find original channel for message");if(null==l)throw Error("Unable to find destination channel for message");let s=O.Ay.parse(l,""),r={guild_id:i,channel_id:e.channel_id,message_id:e.id,type:P.S.FORWARD,forward_only:t?.onlyAttachmentIds!=null||t?.onlyEmbedIndices!=null?{attachment_ids:t.onlyAttachmentIds,embed_indices:t.onlyEmbedIndices}:void 0},o=0,u=t?.withMessage;if(null!=u){let[e,n]=(0,L.Ay)(u);e&&(u=n,o=(0,N.UI)(o,G.pr7.SUPPRESS_NOTIFICATIONS))}await D.A.sendMessage(l.id,s,!1,{messageReference:r,location:W.Hx.FORWARDING,eagerDispatch:!1,flags:o}),null==u||""===u||(0,U.lP)(l,V.A)||await D.A.sendMessage(l.id,O.Ay.parse(l,u),!1,{location:W.Hx.FORWARDING,flags:o})},sendForwards:(e,n,t)=>M()(n.map(n=>H.sendForward(e,n,t)))};
async function ek(r,o,F,a){let u=await H.sendForwards(r,o,{...F,withMessage:a});if(u.every(e=>{let{status:n}=e;return"fulfilled"===n}))return{results:u,hasError:!1,failedDestinations:[]};let f=o.filter((e,n)=>"rejected"===u[n].status);return{results:u,hasError:!0,failedDestinations:f}}`;
