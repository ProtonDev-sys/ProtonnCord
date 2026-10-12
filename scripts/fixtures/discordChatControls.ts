/*
 * Compatibility fixture wrapper, copyright (c) 2026 Protonn Cord contributors.
 * The wrapper is licensed under GPL-3.0-or-later. Captured strings are Discord-owned
 * client code retained as test data, not relicensed by the wrapper.
 */

// Current typing row (119031) and message reaction controls (727535), identical
// on Stable and Canary in Test run 38209994939, captured 2026-10-12 for
// PR head 56fc4bda8431ddb24a6ebdf63a635a53959f4c60.
export const typingIndicator = "function X(e){let{activityInviteEducationActivity:t,isFocused:i,typingUsers:l,className:r,channel:d,isThreadCreation:o,renderDots:u,renderSlowmode:m,isInTextChannel:h=!1,shouldShowLegacyGameInviteCreationBanner:p=!1}=e,A=(0,F.v)(\"TypingUsers\"),{rateLimitPerUser:g}=d,x=s.useRef(null),v=s.useRef(null),[f,C]=s.useState(!1),E=s.useCallback(()=>{if(null==x.current||null==v.current)return;let e=x.current.getBoundingClientRect();v.current.scrollWidth+56>e.width?C(!0):C(!1)},[]);(0,I.g)(x,E,[],{enabled:h}),(0,I.g)(v,E,[],{enabled:h});let[S,j,b]=l,y=\"\";1===l.length?y=W.intl.format(W.t.lJ9sZX,{a:S}):2===l.length?y=W.intl.format(W.t.rB0CUa,{a:S,b:j}):3===l.length?y=W.intl.format(W.t.StKThj,{a:S,b:j,c:b}):l.length>3&&(y=W.intl.format(W.t.Q8lUnE,{}));let N=f&&l.length>0&&l.length<=3?W.intl.format(W.t[\"qD/0qZ\"],{}):y,O=l.length>0||g>0||p,G=!O&&null!=t,k=null;return O?k=(0,n.jsxs)(\"div\",{className:a()(H.IW,{\"stop-animation\":!i,[H.Il]:h},r),\"data-mtctest-ignore\":\"true\",children:[0===l.length&&p?(0,n.jsx)(T.A,{}):(0,n.jsxs)(\"div\",{className:H.y5,ref:x,children:[l.length>0&&!1!==u&&(A?(0,n.jsx)(z,{}):(0,n.jsx)(c.n,{className:H.gO,dotRadius:3.5,themed:!0})),(0,n.jsx)(\"span\",{className:H.Qq,\"aria-hidden\":!0,children:N}),(0,n.jsx)(\"span\",{className:H.Qq,style:{position:\"absolute\",visibility:\"hidden\"},\"aria-hidden\":!0,ref:v,children:y})]}),!1!==m&&(0,n.jsx)(_,{channel:d,isThreadCreation:o})]}):G&&null!=t&&(k=(0,n.jsx)(Z,{activity:t,isFocused:i})),(0,n.jsxs)(n.Fragment,{children:[k,(0,n.jsx)(\"span\",{className:H.y4,\"aria-live\":\"polite\",\"aria-atomic\":!0,children:y})]})}";

export const messageReactions = "h?(0,a.jsxs)(a.Fragment,{children:[E?null:(0,a.jsxs)(a.Fragment,{children:[(0,a.jsx)(nh,{channel:t,message:n}),(0,a.jsx)(nt.$$,{})]}),(0,a.jsx)(ns,{togglePopout:D,renderEmojiPicker:nA,shouldShow:I,isFocused:T,channel:t,message:n})]}):null";
