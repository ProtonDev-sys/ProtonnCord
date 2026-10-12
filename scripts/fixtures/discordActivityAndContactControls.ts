/*
 * Protonn Cord regression fixture wrapper, GPL-3.0-or-later.
 * Captured Discord code below remains third-party test data; this notice
 * does not assert contributor ownership or relicense the captured source.
 */

// Exact Discord Stable/Canary components captured 2026-10-12.
// App launcher 554601; Friends page 157667 (Stable), 27794 (Canary).
export const activityAndContactControls = {
    "stable": {
        "appCard": "function nM(e){let{application:t,look:n,imageStyle:l,enableVideoBanner:i,disableBannerFadeIn:s,children:a,overrideImageUrl:c,showsPromoted:d}=e,{iconURL:u,name:m,description:p}=o.useMemo(()=>(0,I.X2)(t,{fakeAppIconURL:tk}),[t]),h=o.useMemo(()=>null==p?null:(0,q.SD)(p),[p]),A=(0,ej.Ay)(u,\"\"),[f,x]=o.useState(!1),N=o.useCallback(()=>{!0===i&&x(!0)},[i]),E=d||(0,I.NO)(t),g=\"large_banner\"===n||\"medium_banner\"===n,C=o.useCallback(()=>x(!1),[]),_=(0,nC.uS)(t.id),y=(0,I.fl)(t);return(0,r.jsxs)(r.Fragment,{children:[g?(0,r.jsxs)(\"div\",{onMouseEnter:N,onFocus:N,onMouseLeave:C,onBlur:C,className:v()(nS.zK,{[nS.i2]:\"medium_banner\"===n,[nS.ir]:\"large_banner\"===n}),children:[(0,r.jsx)(\"span\",{className:l,children:(0,r.jsx)(nH,{application:t,fallbackColor:A,showVideo:f,disableFadeIn:s,overrideImageUrl:c})}),_||E||y!==M.Hr.NONE?(0,r.jsxs)(\"div\",{className:nS.YN,children:[E&&(0,r.jsx)(nu.E,{type:{text:et.intl.string(et.t[\"/eVltv\"])},variant:\"expressive\"}),_&&(0,r.jsx)(nk,{}),y!==M.Hr.NONE&&(0,r.jsx)(nN.A,{labelType:y})]}):null,(0,r.jsx)(\"div\",{className:nS.Re,children:a})]}):null,(0,r.jsxs)(\"div\",{className:v()(nS.TD,{[nS.Ne]:\"row\"===n}),children:[(0,r.jsx)(j.A,{src:u,className:v()(nS.Kk,{[nS.aL]:\"row\"===n}),\"aria-hidden\":!0,rendersPlaceholder:!0}),(0,r.jsxs)(\"div\",{className:nS.eV,children:[(0,r.jsxs)(\"div\",{className:nS.mD,children:[(0,r.jsx)(O.D,{variant:\"heading-md/semibold\",color:\"text-strong\",lineClamp:1,children:m}),!g&&E?(0,r.jsx)(nu.E,{type:{text:et.intl.string(et.t[\"/eVltv\"])},variant:\"expressive\"}):null,(0,r.jsx)(nU,{application:t})]}),(0,r.jsx)(T.E,{variant:\"text-sm/normal\",color:\"text-subtle\",lineClamp:1,children:h})]}),\"row\"===n?(0,r.jsx)(\"div\",{className:nS.ek}):null]})]})}",
        "friendsTabs": "function A6(e){let{initialSection:t}=e,n=(0,tW.zy)(),i=(0,tW.W6)();em.useEffect(()=>{\"true\"===new URLSearchParams(n.search).get(\"confirm-age\")&&V.h.dispatch({type:\"AGE_GATE_MODAL_OPEN\",source:id.w_.DEEP_LINK_PROMPT}).then(()=>{i.replace(K.BVt.ME)})},[i,n]),em.useEffect(()=>{uI.I(K.BVt.FRIENDS),(0,ER.d0)(\"friends\")},[]);let r=(0,ef.bG)([ey.A],()=>ey.A.theme),a=(0,iH.kX)(),{section:s,rows:l}=(0,ef.cf)([EL.Ay],()=>EL.Ay.getState()),o=(0,ef.bG)([um.A],()=>um.A.getSuggestionCount()),d=em.useMemo(()=>l.getRelationshipCounts(),[l]);function c(e){up.A.transitionToSection(e,{explicit:!0})}em.useEffect(()=>{null!=t&&up.A.setInitialSection(t),0===d[K.eA$.FRIEND]&&0===d[K.eA$.PENDING_INCOMING]&&0===d[K.eA$.PENDING_OUTGOING]&&0===d[K.eA$.BLOCKED]&&up.A.transitionToSection(K.m3P.ADD_FRIEND)},[t,d]);let u=(0,uT.GV)(),_=(0,uT.GV)(),E=[{id:K.m3P.ONLINE,show:l.filter(K.m3P.ONLINE).length>0,content:tv.intl.string(tv.t.b9w3bO),announceName:tv.intl.string(tv.t.b9w3bO),className:A2.AS},{id:K.m3P.ALL,show:d[K.eA$.FRIEND]>0,content:tv.intl.string(tv.t.PfjFjR),announceName:tv.intl.string(tv.t.PfjFjR),className:A2.AS},{id:K.m3P.PENDING,show:d[K.eA$.PENDING_INCOMING]>0||d[K.eA$.PENDING_OUTGOING]>0,content:(0,w.jsxs)(w.Fragment,{children:[tv.intl.string(tv.t.p6IHGE),a>0&&(0,w.jsx)(uh.hV,{count:a,className:A2.qS})]}),ariaLabel:tv.intl.formatToPlainString(tv.t.OAC0Z4,{count:a.toString()}),announceName:tv.intl.string(tv.t.p6IHGE),className:A2.AS},{id:K.m3P.SUGGESTIONS,show:o>0,content:(0,w.jsxs)(w.Fragment,{children:[tv.intl.string(tv.t[\"8rSi1/\"]),(0,w.jsx)(uh.hV,{count:o,className:A2.qS})]}),ariaLabel:tv.intl.formatToPlainString(tv.t.AbMQp7,{count:o.toString()}),announceName:tv.intl.string(tv.t[\"8rSi1/\"]),className:A2.AS},{id:K.m3P.ADD_FRIEND,show:!0,content:(0,w.jsx)(\"span\",{children:tv.intl.string(tv.t.j0wbE5)}),ariaLabel:tv.intl.string(tv.t.j0wbE5),announceName:tv.intl.string(tv.t.j0wbE5),className:tf()(A2.AS,A2.GU)}],A=E.filter(e=>e.show).map(e=>e.id).join(\",\"),h=em.useRef(null);em.useEffect(()=>{let e=\"\"===A?[]:A.split(\",\"),t=new Set(e),n=h.current;if(null!=n){for(let t of e)if(!n.has(t)){let e=E.find(e=>e.id===t);null!=e&&uA.O.announce(tv.intl.formatToPlainString(tv.t[\"6x49+U\"],{tabName:e.announceName}),\"polite\")}}h.current=t},[A]);let f=null,I=(0,w.jsx)(\"div\",{className:A2.Xl,children:(0,w.jsx)(EO,{})});return f=s===K.m3P.ADD_FRIEND?(0,w.jsx)(E$,{}):(0,w.jsx)(A1,{titleId:_}),(0,w.jsxs)(\"main\",{className:A2.kL,\"aria-label\":tv.intl.string(tv.t.TdEu5X),children:[(0,w.jsx)(i6.HI,{location:tv.intl.string(tv.t.TdEu5X)}),(0,w.jsx)(tp.N,{theme:r,children:e=>(0,w.jsxs)(ug.A,{className:e,toolbar:(0,w.jsx)(A3,{}),role:\"navigation\",\"aria-labelledby\":u,scrollable:!0,keepToastsBelow:!0,children:[(0,w.jsx)(ug.A.Icon,{icon:aG.$,\"aria-hidden\":!0}),(0,w.jsx)(ug.A.Title,{id:u,children:tv.intl.string(tv.t.TdEu5X)}),(0,w.jsx)(ug.A.Divider,{}),(0,w.jsx)(uf.V,{\"aria-label\":tv.intl.string(tv.t.TdEu5X),selectedItem:s,type:\"top-pill\",onItemSelect:c,className:A2.$H,children:E.filter(e=>e.show).map(e=>(0,w.jsx)(uf.V.Item,{id:e.id,className:e.className,\"aria-label\":e.ariaLabel,children:e.content},e.id))})]})}),(0,w.jsxs)(\"div\",{className:A2.MJ,children:[(0,w.jsx)(uf.V.Panel,{id:s,className:A2.UL,\"aria-labelledby\":_,children:f}),I]})]})}",
        "friendsBindings": {
            "w": 477900,
            "V": 73153,
            "K": 652215,
            "ef": 17928,
            "em": 582128,
            "ey": 363195,
            "tp": 43990,
            "tv": 660183,
            "tW": 806163,
            "id": 204925,
            "iH": 912309,
            "i6": 726249,
            "aG": 214947,
            "uA": 765178,
            "uh": 812993,
            "uf": 761508,
            "uI": 944791,
            "up": 711950,
            "uT": 915089,
            "um": 586774,
            "ug": 742589,
            "ER": 210714,
            "EL": 595623,
            "A2": 415017,
            "w_": 17159
        },
        "friendsLocals": {
            "classNames": "tf",
            "sidebar": "EO",
            "addFriend": "E$",
            "list": "A1",
            "toolbar": "A3"
        }
    },
    "canary": {
        "appCard": "function nM(e){let{application:t,look:n,imageStyle:l,enableVideoBanner:i,disableBannerFadeIn:s,children:a,overrideImageUrl:c,showsPromoted:d}=e,{iconURL:u,name:m,description:p}=o.useMemo(()=>(0,I.X2)(t,{fakeAppIconURL:tO}),[t]),h=o.useMemo(()=>null==p?null:(0,q.SD)(p),[p]),A=(0,ej.Ay)(u,\"\"),[f,x]=o.useState(!1),N=o.useCallback(()=>{!0===i&&x(!0)},[i]),E=d||(0,I.NO)(t),g=\"large_banner\"===n||\"medium_banner\"===n,C=o.useCallback(()=>x(!1),[]),_=(0,nC.uS)(t.id),y=(0,I.fl)(t);return(0,r.jsxs)(r.Fragment,{children:[g?(0,r.jsxs)(\"div\",{onMouseEnter:N,onFocus:N,onMouseLeave:C,onBlur:C,className:v()(nS.zK,{[nS.i2]:\"medium_banner\"===n,[nS.ir]:\"large_banner\"===n}),children:[(0,r.jsx)(\"span\",{className:l,children:(0,r.jsx)(nH,{application:t,fallbackColor:A,showVideo:f,disableFadeIn:s,overrideImageUrl:c})}),_||E||y!==M.Hr.NONE?(0,r.jsxs)(\"div\",{className:nS.YN,children:[E&&(0,r.jsx)(nu.E,{type:{text:et.intl.string(et.t[\"/eVltv\"])},variant:\"expressive\"}),_&&(0,r.jsx)(nk,{}),y!==M.Hr.NONE&&(0,r.jsx)(nN.A,{labelType:y})]}):null,(0,r.jsx)(\"div\",{className:nS.Re,children:a})]}):null,(0,r.jsxs)(\"div\",{className:v()(nS.TD,{[nS.Ne]:\"row\"===n}),children:[(0,r.jsx)(j.A,{src:u,className:v()(nS.Kk,{[nS.aL]:\"row\"===n}),\"aria-hidden\":!0,rendersPlaceholder:!0}),(0,r.jsxs)(\"div\",{className:nS.eV,children:[(0,r.jsxs)(\"div\",{className:nS.mD,children:[(0,r.jsx)(O.D,{variant:\"heading-md/semibold\",color:\"text-strong\",lineClamp:1,children:m}),!g&&E?(0,r.jsx)(nu.E,{type:{text:et.intl.string(et.t[\"/eVltv\"])},variant:\"expressive\"}):null,(0,r.jsx)(nU,{application:t})]}),(0,r.jsx)(T.E,{variant:\"text-sm/normal\",color:\"text-subtle\",lineClamp:1,children:h})]}),\"row\"===n?(0,r.jsx)(\"div\",{className:nS.ek}):null]})]})}",
        "friendsTabs": "function A1(e){let{initialSection:t}=e,n=(0,tV.zy)(),i=(0,tV.W6)();eI.useEffect(()=>{\"true\"===new URLSearchParams(n.search).get(\"confirm-age\")&&k.h.dispatch({type:\"AGE_GATE_MODAL_OPEN\",source:il.w_.DEEP_LINK_PROMPT}).then(()=>{i.replace(j.BVt.ME)})},[i,n]),eI.useEffect(()=>{uA.I(j.BVt.FRIENDS),(0,EN.d0)(\"friends\")},[]);let r=(0,eE.bG)([eO.A],()=>eO.A.theme),a=(0,iB.kX)(),{section:s,rows:l}=(0,eE.cf)([EC.Ay],()=>EC.Ay.getState()),o=(0,eE.bG)([uI.A],()=>uI.A.getSuggestionCount()),d=eI.useMemo(()=>l.getRelationshipCounts(),[l]);function c(e){uh.A.transitionToSection(e,{explicit:!0})}eI.useEffect(()=>{null!=t&&uh.A.setInitialSection(t),0===d[j.eA$.FRIEND]&&0===d[j.eA$.PENDING_INCOMING]&&0===d[j.eA$.PENDING_OUTGOING]&&0===d[j.eA$.BLOCKED]&&uh.A.transitionToSection(j.m3P.ADD_FRIEND)},[t,d]);let u=(0,uf.GV)(),_=(0,uf.GV)(),E=[{id:j.m3P.ONLINE,show:l.filter(j.m3P.ONLINE).length>0,content:tL.intl.string(tL.t.b9w3bO),announceName:tL.intl.string(tL.t.b9w3bO),className:AJ.AS},{id:j.m3P.ALL,show:d[j.eA$.FRIEND]>0,content:tL.intl.string(tL.t.PfjFjR),announceName:tL.intl.string(tL.t.PfjFjR),className:AJ.AS},{id:j.m3P.PENDING,show:d[j.eA$.PENDING_INCOMING]>0||d[j.eA$.PENDING_OUTGOING]>0,content:(0,M.jsxs)(M.Fragment,{children:[tL.intl.string(tL.t.p6IHGE),a>0&&(0,M.jsx)(u_.hV,{count:a,className:AJ.qS})]}),ariaLabel:tL.intl.formatToPlainString(tL.t.OAC0Z4,{count:a.toString()}),announceName:tL.intl.string(tL.t.p6IHGE),className:AJ.AS},{id:j.m3P.SUGGESTIONS,show:o>0,content:(0,M.jsxs)(M.Fragment,{children:[tL.intl.string(tL.t[\"8rSi1/\"]),(0,M.jsx)(u_.hV,{count:o,className:AJ.qS})]}),ariaLabel:tL.intl.formatToPlainString(tL.t.AbMQp7,{count:o.toString()}),announceName:tL.intl.string(tL.t[\"8rSi1/\"]),className:AJ.AS},{id:j.m3P.ADD_FRIEND,show:!0,content:(0,M.jsx)(\"span\",{children:tL.intl.string(tL.t.j0wbE5)}),ariaLabel:tL.intl.string(tL.t.j0wbE5),announceName:tL.intl.string(tL.t.j0wbE5),className:tE()(AJ.AS,AJ.GU)}],A=E.filter(e=>e.show).map(e=>e.id).join(\",\"),h=eI.useRef(null);eI.useEffect(()=>{let e=\"\"===A?[]:A.split(\",\"),t=new Set(e),n=h.current;if(null!=n){for(let t of e)if(!n.has(t)){let e=E.find(e=>e.id===t);null!=e&&uu.O.announce(tL.intl.formatToPlainString(tL.t[\"6x49+U\"],{tabName:e.announceName}),\"polite\")}}h.current=t},[A]);let f=null,I=(0,M.jsx)(\"div\",{className:AJ.Xl,children:(0,M.jsx)(ES,{})});return f=s===j.m3P.ADD_FRIEND?(0,M.jsx)(EW,{}):(0,M.jsx)(AQ,{titleId:_}),(0,M.jsxs)(\"main\",{className:AJ.kL,\"aria-label\":tL.intl.string(tL.t.TdEu5X),children:[(0,M.jsx)(i2.HI,{location:tL.intl.string(tL.t.TdEu5X)}),(0,M.jsx)(th.N,{theme:r,children:e=>(0,M.jsxs)(up.A,{className:e,toolbar:(0,M.jsx)(A0,{}),role:\"navigation\",\"aria-labelledby\":u,scrollable:!0,keepToastsBelow:!0,children:[(0,M.jsx)(up.A.Icon,{icon:aU.$,\"aria-hidden\":!0}),(0,M.jsx)(up.A.Title,{id:u,children:tL.intl.string(tL.t.TdEu5X)}),(0,M.jsx)(up.A.Divider,{}),(0,M.jsx)(uE.V,{\"aria-label\":tL.intl.string(tL.t.TdEu5X),selectedItem:s,type:\"top-pill\",onItemSelect:c,className:AJ.$H,children:E.filter(e=>e.show).map(e=>(0,M.jsx)(uE.V.Item,{id:e.id,className:e.className,\"aria-label\":e.ariaLabel,children:e.content},e.id))})]})}),(0,M.jsxs)(\"div\",{className:AJ.MJ,children:[(0,M.jsx)(uE.V.Panel,{id:s,className:AJ.UL,\"aria-labelledby\":_,children:f}),I]})]})}",
        "friendsBindings": {
            "M": 477900,
            "k": 73153,
            "V": 736056,
            "j": 652215,
            "eE": 17928,
            "eI": 582128,
            "eO": 363195,
            "th": 43990,
            "tL": 660183,
            "tV": 806163,
            "il": 204925,
            "iB": 912309,
            "i2": 726249,
            "aU": 214947,
            "uu": 765178,
            "u_": 812993,
            "uE": 761508,
            "uA": 944791,
            "uh": 711950,
            "uf": 915089,
            "uI": 586774,
            "up": 742589,
            "EN": 210714,
            "EC": 595623,
            "AJ": 415017
        },
        "friendsLocals": {
            "classNames": "tE",
            "sidebar": "ES",
            "addFriend": "EW",
            "list": "AQ",
            "toolbar": "A0"
        }
    }
} as const;
