/*
 * Protonn Cord regression fixture wrapper, GPL-3.0-or-later.
 * Captured Discord code below remains third-party test data; this notice
 * does not assert contributor ownership or relicense the captured source.
 */

// Exact Active Now header/card components captured 2026-10-12.
// Discord Stable module157667; Canary module27794.
export const activeNow = {
    "stable": {
        "header": "function _X(e){let{party:t,onUserContextMenu:i,quest:r}=e,{priorityMembers:a,partiedMembers:s,guildContext:l}=t,o=a[0],d=function(e){let{priorityMembers:t,partiedMembers:n}=e,i=new Set(t.map(e=>{let{user:t}=e;return t.id})),r=n.filter(e=>!i.has(e.id)),a=at.Ay.getName(t[0].user),s=null!=t[1]?at.Ay.getName(t[1].user):null!=r[0]?at.Ay.getName(r[0]):null;switch(n.length){case 1:return a;case 2:return tv.intl.format(tv.t.t1DyC1,{user1:a,user2:s});default:return tv.intl.format(tv.t[\"5CSEcJ\"],{user1:a,user2:s,extras:n.length-2})}}(t),{subtitle:c,icon:u}=function(e){let{priorityMembers:t,partiedMembers:i,voiceChannels:r,currentActivities:a}=e,s=t.length,l=i.length-s,o=a[0],d=o?.activity,c=o?.startedPlayingTime,u={name:d?.name??\"\"};if((0,uz.A)(d)&&null!=d)return{subtitle:(0,w.jsx)(_A.Ay,{start:c,location:_A.Ay.Locations.ACTIVITY_FEED_NEW,messageProps:u}),icon:null};if(s+l===1&&null!=o){let{application:e}=o;if(null==d)return{subtitle:null,icon:null};let t=uQ.Ij(d);if(null!=t)return t;switch(d.type){case K.$pd.PLAYING:if((0,_K.A)(d))return{subtitle:tv.intl.string(tv.t.tO8wOx),icon:(0,w.jsx)(_H.Header.Icon,{src:_H.Header.Icon.Src.XBOX})};return{subtitle:(0,w.jsx)(_A.Ay,{start:c,location:_A.Ay.Locations.ACTIVITY_FEED_NEW,messageProps:u}),icon:null!=e?(0,w.jsx)(_H.Header.Icon,{src:null!=e.getIconURL(64)?e.getIconURL(64):n(960648)}):null};case K.$pd.STREAMING:return{subtitle:tv.intl.string(tv.t.HyGHj7),icon:null!=e&&null!=e.getIconURL(64)?(0,w.jsx)(_H.Header.Icon,{src:e.getIconURL(64)}):null};case K.$pd.LISTENING:let i;return i=(0,uX.A)(d)?(0,w.jsx)(_H.Header.Icon,{src:_H.Header.Icon.Src.SPOTIFY}):null!=e.getIconURL(64)?(0,w.jsx)(_H.Header.Icon,{src:e.getIconURL(64)}):(0,w.jsx)(_H.Header.Icon,{src:n(960648)}),{subtitle:tv.intl.formatToPlainString(tv.t.NF5xop,{name:d.name}),icon:i};case K.$pd.WATCHING:return{subtitle:tv.intl.formatToPlainString(tv.t.pW3Ip3,{name:d.name}),icon:null!=e&&null!=e.getIconURL(64)?(0,w.jsx)(_H.Header.Icon,{src:e.getIconURL(64)}):null};default:return{subtitle:tv.intl.string(tv.t.grGyaf),icon:null}}}if(0===a.length){if(r.length>0)return{subtitle:tv.intl.string(tv.t.grGyaf),icon:null};let e=a[0];if(null!=e){let{activity:t}=e;if(null!=t){let e=uQ.Ij(t);if(null!=e)return e}if(null!=t&&t.type===K.$pd.LISTENING)return{subtitle:tv.intl.string(tv.t.rmnkz4),icon:(0,w.jsx)(_H.Header.Icon,{src:_H.Header.Icon.Src.SPOTIFY})}}}else if(1===a.length){let e=a.find(e=>null!=e.activity);if(null==e)return{subtitle:null,icon:null};let{activity:t,application:n,startedPlayingTime:i}=e;ts()(null!=t,\"Activity was null somehow\");let r=(0,w.jsx)(_A.Ay,{start:i,location:_A.Ay.Locations.ACTIVITY_FEED_NEW,messageProps:u});return(0,_K.A)(t)?{subtitle:r,icon:(0,w.jsx)(_H.Header.Icon,{src:lD.A.get(K.fg2.XBOX).icon.lightPNG})}:{subtitle:r,icon:null!=n&&null!=n.getIconURL(64)?(0,w.jsx)(_H.Header.Icon,{src:n.getIconURL(64)}):null}}return{subtitle:tv.intl.string(tv.t.sau5tt),icon:(0,w.jsx)(_H.Header.Icon,{src:_H.Header.Icon.Src.MULTIPLE})}}(t),_=t.currentActivities[0]?.activity?.application_id,E=null!=r?(0,_z.I6)(r)?(0,_z.xc)(r):(0,_z._3)(r)?.[0]:void 0,A=(0,_c.A)({applicationId:null!=r?E:_,location:null!=r?s3.rE.QUEST_INSTRUCTIONS:\"FriendsActivityFeed\",source:null!=r?_d.GameProfileSources.QuestActivityPanel:_d.GameProfileSources.FriendsActivityFeed}),h=(0,_s.A)({userId:o.user.id,guildId:l?.id}),f=(0,_l.a)({displayNameStyles:h}),I=(0,ly.DP)(),p=null!=r?`${tv.intl.string(tv.t.l7clOK)} \\xb7 ${tv.intl.string(tv.t.o6FLcF)}`:null,T=(0,lT.M)(I)?\"dark\":\"light\",m=null!=r?(0,_$.tW)(r,_$.fY.GAME_TILE,T)?.url:null,g=null!=m?(0,w.jsx)(_H.Header.Icon,{src:m}):null,S=null!=r?g??u:u;return(0,w.jsx)(_H.Header,{priorityUser:o,guildId:l?.id,title:d,subtitle:p??c,icon:S,onSubtitleClick:A,onIconClick:A,onContextMenu:e=>i(e,o.user),displayNameFont:1===s.length?f:void 0})}",
        "card": "function(e){let{party:t,onUserContextMenu:n,onChannelContextMenu:i,quest:r,hasStaffQuestActivityPanelOverride:a}=e,s=em.useRef(null),[l,o]=em.useState(null),d=em.useCallback(()=>o(r?.id??null),[r?.id]),c=null!=l&&l===r?.id,u=(0,uw.sb)(r),_=!0===a||u&&null!=r&&(null==r.userStatus||!(0,uG.gO)(r.userStatus,uU.uF.ACTIVITY_PANEL)),E=c||!_?void 0:r,A=(0,w.jsx)(_X,{party:t,onUserContextMenu:n,quest:E}),h=(0,w.jsx)(_Y,{party:t,onChannelContextMenu:i,quest:E,hasStaffQuestActivityPanelOverride:a,onQuestDismiss:d}),{partiedMembers:f,applicationStreams:I,currentActivities:p,voiceChannels:T}=t,m=f.length,g=I.length,S=p.length,N=T.length>0,C=em.useCallback(()=>{let e=p.filter(e=>e.application?.name!=null&&(0,$.isGameApplicationType)(e.application?.type)).map(e=>e.application.name);$.default.track(K.HAw.NOW_PLAYING_CARD_HOVERED,{num_users:m,num_streams:g,num_activities:S,in_voice_channel:N,games_detected:e})},[m,g,S,N,p]),O=em.useMemo(()=>uM()(C,ET),[C]);return null!=E?(0,w.jsx)(\"div\",{className:Ep.MP,children:(0,w.jsx)(uF.R,{questOrQuests:E,questContent:uU.uF.ACTIVITY_PANEL,sourceQuestContent:uU.uF.ACTIVITY_PANEL,children:e=>(0,w.jsx)(uB.C,{quest:E,questContent:uU.uF.ACTIVITY_PANEL,shouldShowDisclosure:E.userStatus?.enrolledAt==null,showShareLink:!0,sourceQuestContent:uU.uF.ACTIVITY_PANEL,children:t=>{let n={...t,onMouseDown:e=>{e.stopPropagation(),Em(e)||t.onMouseDown(e)},onClick:e=>{e.stopPropagation(),Em(e)||t.onClick(e)},onKeyDown:e=>{e.stopPropagation(),t.onKeyDown(e)},onKeyPress:e=>{e.stopPropagation(),Em(e)||(\"Enter\"===e.key||\" \"===e.key)&&(e.preventDefault(),t.onClick(e))}};return(0,w.jsxs)(_H,{...n,ref:t=>{e.current=t},onMouseEnter:O,\"aria-haspopup\":\"menu\",className:Ep.dJ,children:[A,h]})}})})}):null!=A||null!=h?(0,w.jsx)(al.Y,{targetElementRef:s,position:\"left\",renderPopout:e=>{let{closePopout:n}=e;return(0,w.jsx)(Eh,{party:t,close:n})},spacing:8,children:(e,t)=>{let{isShown:n}=t;return(0,w.jsx)(_H,{...e,ref:s,onMouseEnter:O,\"aria-haspopup\":\"menu\",className:Ep.MP,active:n,children:(0,w.jsxs)(\"div\",{children:[A,h]})})}}):null}",
        "bindings": {
            "w": 477900,
            "K": 652215,
            "$": 174459,
            "em": 582128,
            "tv": 660183,
            "rE": 49999,
            "at": 427262,
            "al": 922016,
            "s3": 190107,
            "lT": 462887,
            "ly": 736653,
            "lD": 573648,
            "uU": 738822,
            "uw": 77870,
            "uG": 710969,
            "uF": 657792,
            "uB": 270045,
            "uz": 765379,
            "uX": 90644,
            "uQ": 475706,
            "_s": 609425,
            "_l": 73392,
            "_d": 409626,
            "_c": 692969,
            "_A": 529433,
            "_K": 61330,
            "_$": 291749,
            "_z": 792620,
            "Ep": 438879
        },
        "locals": {
            "Card": "_H",
            "Header": "_X",
            "Body": "_Y",
            "Popout": "Eh",
            "isInteractive": "Em",
            "throttle": "uM",
            "delay": "ET",
            "assert": "ts"
        }
    },
    "canary": {
        "header": "function _K(e){let{party:t,onUserContextMenu:i,quest:r}=e,{priorityMembers:a,partiedMembers:s,guildContext:l}=t,o=a[0],d=function(e){let{priorityMembers:t,partiedMembers:n}=e,i=new Set(t.map(e=>{let{user:t}=e;return t.id})),r=n.filter(e=>!i.has(e.id)),a=r9.Ay.getName(t[0].user),s=null!=t[1]?r9.Ay.getName(t[1].user):null!=r[0]?r9.Ay.getName(r[0]):null;switch(n.length){case 1:return a;case 2:return tL.intl.format(tL.t.t1DyC1,{user1:a,user2:s});default:return tL.intl.format(tL.t[\"5CSEcJ\"],{user1:a,user2:s,extras:n.length-2})}}(t),{subtitle:c,icon:u}=function(e){let{priorityMembers:t,partiedMembers:i,voiceChannels:r,currentActivities:a}=e,s=t.length,l=i.length-s,o=a[0],d=o?.activity,c=o?.startedPlayingTime,u={name:d?.name??\"\"};if((0,uY.A)(d)&&null!=d)return{subtitle:(0,M.jsx)(_u.Ay,{start:c,location:_u.Ay.Locations.ACTIVITY_FEED_NEW,messageProps:u}),icon:null};if(s+l===1&&null!=o){let{application:e}=o;if(null==d)return{subtitle:null,icon:null};let t=uX.Ij(d);if(null!=t)return t;switch(d.type){case j.$pd.PLAYING:if((0,_j.A)(d))return{subtitle:tL.intl.string(tL.t.tO8wOx),icon:(0,M.jsx)(_F.Header.Icon,{src:_F.Header.Icon.Src.XBOX})};return{subtitle:(0,M.jsx)(_u.Ay,{start:c,location:_u.Ay.Locations.ACTIVITY_FEED_NEW,messageProps:u}),icon:null!=e?(0,M.jsx)(_F.Header.Icon,{src:null!=e.getIconURL(64)?e.getIconURL(64):n(960648)}):null};case j.$pd.STREAMING:return{subtitle:tL.intl.string(tL.t.HyGHj7),icon:null!=e&&null!=e.getIconURL(64)?(0,M.jsx)(_F.Header.Icon,{src:e.getIconURL(64)}):null};case j.$pd.LISTENING:let i;return i=(0,uK.A)(d)?(0,M.jsx)(_F.Header.Icon,{src:_F.Header.Icon.Src.SPOTIFY}):null!=e.getIconURL(64)?(0,M.jsx)(_F.Header.Icon,{src:e.getIconURL(64)}):(0,M.jsx)(_F.Header.Icon,{src:n(960648)}),{subtitle:tL.intl.formatToPlainString(tL.t.NF5xop,{name:d.name}),icon:i};case j.$pd.WATCHING:return{subtitle:tL.intl.formatToPlainString(tL.t.pW3Ip3,{name:d.name}),icon:null!=e&&null!=e.getIconURL(64)?(0,M.jsx)(_F.Header.Icon,{src:e.getIconURL(64)}):null};default:return{subtitle:tL.intl.string(tL.t.grGyaf),icon:null}}}if(0===a.length){if(r.length>0)return{subtitle:tL.intl.string(tL.t.grGyaf),icon:null};let e=a[0];if(null!=e){let{activity:t}=e;if(null!=t){let e=uX.Ij(t);if(null!=e)return e}if(null!=t&&t.type===j.$pd.LISTENING)return{subtitle:tL.intl.string(tL.t.rmnkz4),icon:(0,M.jsx)(_F.Header.Icon,{src:_F.Header.Icon.Src.SPOTIFY})}}}else if(1===a.length){let e=a.find(e=>null!=e.activity);if(null==e)return{subtitle:null,icon:null};let{activity:t,application:n,startedPlayingTime:i}=e;ti()(null!=t,\"Activity was null somehow\");let r=(0,M.jsx)(_u.Ay,{start:i,location:_u.Ay.Locations.ACTIVITY_FEED_NEW,messageProps:u});return(0,_j.A)(t)?{subtitle:r,icon:(0,M.jsx)(_F.Header.Icon,{src:lR.A.get(j.fg2.XBOX).icon.lightPNG})}:{subtitle:r,icon:null!=n&&null!=n.getIconURL(64)?(0,M.jsx)(_F.Header.Icon,{src:n.getIconURL(64)}):null}}return{subtitle:tL.intl.string(tL.t.sau5tt),icon:(0,M.jsx)(_F.Header.Icon,{src:_F.Header.Icon.Src.MULTIPLE})}}(t),_=t.currentActivities[0]?.activity?.application_id,E=null!=r?(0,_Y.I6)(r)?(0,_Y.xc)(r):(0,_Y._3)(r)?.[0]:void 0,A=(0,_l.A)({applicationId:null!=r?E:_,location:null!=r?s0.rE.QUEST_INSTRUCTIONS:\"FriendsActivityFeed\",source:null!=r?_s.GameProfileSources.QuestActivityPanel:_s.GameProfileSources.FriendsActivityFeed}),h=(0,_i.A)({userId:o.user.id,guildId:l?.id}),f=(0,_r.a)({displayNameStyles:h}),I=(0,lO.DP)(),p=null!=r?`${tL.intl.string(tL.t.l7clOK)} \\xb7 ${tL.intl.string(tL.t.o6FLcF)}`:null,T=(0,lf.M)(I)?\"dark\":\"light\",m=null!=r?(0,_W.tW)(r,_W.fY.GAME_TILE,T)?.url:null,g=null!=m?(0,M.jsx)(_F.Header.Icon,{src:m}):null,S=null!=r?g??u:u;return(0,M.jsx)(_F.Header,{priorityUser:o,guildId:l?.id,title:d,subtitle:p??c,icon:S,onSubtitleClick:A,onIconClick:A,onContextMenu:e=>i(e,o.user),displayNameFont:1===s.length?f:void 0})}",
        "card": "function(e){let{party:t,onUserContextMenu:n,onChannelContextMenu:i,quest:r,hasStaffQuestActivityPanelOverride:a}=e,s=eI.useRef(null),[l,o]=eI.useState(null),d=eI.useCallback(()=>o(r?.id??null),[r?.id]),c=null!=l&&l===r?.id,u=(0,uM.sb)(r),_=!0===a||u&&null!=r&&(null==r.userStatus||!(0,uP.gO)(r.userStatus,ub.uF.ACTIVITY_PANEL)),E=c||!_?void 0:r,A=(0,M.jsx)(_K,{party:t,onUserContextMenu:n,quest:E}),h=(0,M.jsx)(_H,{party:t,onChannelContextMenu:i,quest:E,hasStaffQuestActivityPanelOverride:a,onQuestDismiss:d}),{partiedMembers:f,applicationStreams:I,currentActivities:p,voiceChannels:T}=t,m=f.length,g=I.length,S=p.length,N=T.length>0,C=eI.useCallback(()=>{let e=p.filter(e=>e.application?.name!=null&&(0,W.isGameApplicationType)(e.application?.type)).map(e=>e.application.name);W.default.track(j.HAw.NOW_PLAYING_CARD_HOVERED,{num_users:m,num_streams:g,num_activities:S,in_voice_channel:N,games_detected:e})},[m,g,S,N,p]),O=eI.useMemo(()=>uD()(C,Ef),[C]);return null!=E?(0,M.jsx)(\"div\",{className:Eh.MP,children:(0,M.jsx)(uG.R,{questOrQuests:E,questContent:ub.uF.ACTIVITY_PANEL,sourceQuestContent:ub.uF.ACTIVITY_PANEL,children:e=>(0,M.jsx)(ux.C,{quest:E,questContent:ub.uF.ACTIVITY_PANEL,shouldShowDisclosure:E.userStatus?.enrolledAt==null,showShareLink:!0,sourceQuestContent:ub.uF.ACTIVITY_PANEL,children:t=>{let n={...t,onMouseDown:e=>{e.stopPropagation(),EI(e)||t.onMouseDown(e)},onClick:e=>{e.stopPropagation(),EI(e)||t.onClick(e)},onKeyDown:e=>{e.stopPropagation(),t.onKeyDown(e)},onKeyPress:e=>{e.stopPropagation(),EI(e)||(\"Enter\"===e.key||\" \"===e.key)&&(e.preventDefault(),t.onClick(e))}};return(0,M.jsxs)(_F,{...n,ref:t=>{e.current=t},onMouseEnter:O,\"aria-haspopup\":\"menu\",className:Eh.dJ,children:[A,h]})}})})}):null!=A||null!=h?(0,M.jsx)(aa.Y,{targetElementRef:s,position:\"left\",renderPopout:e=>{let{closePopout:n}=e;return(0,M.jsx)(E_,{party:t,close:n})},spacing:8,children:(e,t)=>{let{isShown:n}=t;return(0,M.jsx)(_F,{...e,ref:s,onMouseEnter:O,\"aria-haspopup\":\"menu\",className:Eh.MP,active:n,children:(0,M.jsxs)(\"div\",{children:[A,h]})})}}):null}",
        "bindings": {
            "M": 477900,
            "j": 652215,
            "W": 174459,
            "eI": 582128,
            "tL": 660183,
            "r9": 427262,
            "aa": 922016,
            "s0": 190107,
            "lf": 462887,
            "lO": 736653,
            "lR": 573648,
            "ub": 738822,
            "uM": 77870,
            "uP": 710969,
            "uG": 657792,
            "ux": 270045,
            "uF": 427358,
            "uY": 765379,
            "uK": 90644,
            "uX": 475706,
            "_i": 609425,
            "_r": 73392,
            "_s": 409626,
            "_l": 692969,
            "_u": 529433,
            "_j": 61330,
            "_W": 291749,
            "_Y": 792620,
            "Eh": 438879,
            "fY": 953822
        },
        "locals": {
            "Card": "_F",
            "Header": "_K",
            "Body": "_H",
            "Popout": "E_",
            "isInteractive": "EI",
            "throttle": "uD",
            "delay": "Ef",
            "assert": "ti"
        }
    }
} as const;
