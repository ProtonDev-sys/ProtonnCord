import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { guildActivitySource } from "./fixtures/discordGuildActivity";
import { applyPatch, evaluate, pluginPatches, sourceNode } from "./utils/discordClientFixture";

const file = "src/equicordplugins/equicordHelper/index.tsx";

test("guild activity filtering preserves native voice and stream filters and hides muted stage and embedded activity users", () => {
    const patch = pluginPatches(file).find((patch: any) => patch.find === "DirectMessage: getSpringConfigs()");
    const source = applyPatch(guildActivitySource, { replacement: patch.replacement.filter((replacement: any) => !String(replacement.match).includes("data-drop-hovering")) });
    const muted = new Set(["voice-muted", "stream-muted", "stage-muted", "stage-current", "activity-muted", "activity-current"]);
    const pluginCalls: unknown[][] = [], nativeCalls: unknown[][] = [], participantQueries: string[] = [];
    let currentChannel = "stage-current";
    const isMuted = (guild: string, channel: string) => { assert.equal(guild, "guild"); return muted.has(channel); };
    const plugin = {
        isChannelMuted: evaluate(`const plugin={${sourceNode(file, node => ts.isMethodDeclaration(node) && node.name.getText() === "isChannelMuted")}};plugin.isChannelMuted;`, {
            VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: currentChannel }) }, UserStore: { getCurrentUser: () => ({ id: "self" }) },
            UserGuildSettingsStore: { isChannelMuted: (...args: [string, string]) => { pluginCalls.push(args); return isMuted(...args); } }
        })
    };
    const stageChannels = ["stage-open", "stage-muted", "stage-current", "afk"];
    const activities = ["activity-open", "activity-muted", "activity-current", "space"].map(channel => Object.freeze({
        location: Object.freeze({ channelId: channel }), userIds: new Set([channel, "blocked"])
    }));
    const globals = {
        plugin, R: { id: "guild", afkChannelId: "afk" },
        A: { yK: (_stores: unknown, read: Function) => read(), bG: (_stores: unknown, read: Function) => read() },
        iz: { Ay: { getChannels: () => ({ voice: ["voice-open", "voice-muted"].map(id => ({ channel: { id, type: "voice" } })) }) }, vM: "voice" },
        i$: { A: { getThreadsForGuild: () => ({}) } }, en: { Ay: { isChannelMuted: (...args: [string, string]) => { nativeCalls.push(args); return isMuted(...args); } } },
        eS: { rbe: { GUILD_VOICE: "voice", GUILD_SPACE: "space" } }, iK: { Ay: () => stageChannels.map(id => ({ id })) },
        s: { useMemo: (read: Function) => read() }, em: { Ay: { getVoiceStates: () => Object.fromEntries(["voice-open", "voice-muted"].map(id => [id, [{ user: { id } }]])) } },
        to: { A: { getBlockedOrIgnoredIDs: () => ["blocked"] } }, c: () => ({ flatMap: (values: unknown[], map: any) => values.flatMap(map) }),
        ta: { aw: (users: any[], blocked: string[] = []) => users.filter(user => user && !blocked.includes(user.id)), F7: (ids: string[], blocked: string[]) => ids.filter(id => !blocked.includes(id)) },
        eI: { A: { getMutableParticipants(channel: string) {
            participantQueries.push(channel);
            return [{ type: "voice", user: { id: channel } }, { type: "voice", user: { id: "blocked" } }, { type: "other", user: { id: "non-voice" } }];
        }, getParticipantCount: () => 2 } }, ep: { ip: { SPEAKER: "speaker", AUDIENCE: "audience" }, wY: { VOICE: "voice" } },
        j: { A: { getAllApplicationStreams: () => ["stream-open", "stream-muted"].map(channelId => ({ guildId: "guild", channelId, ownerId: channelId })) } },
        G: { Ay: { getEmbeddedActivitiesForGuild: () => activities } }, W: { A: { getBasicChannel: (id: string) => ({ id, type: id === "space" ? "space" : "voice" }) } },
        x: { H: (location: any) => location.channelId }, eT: { default: { getUser: (id: string) => ({ id }) } },
        ts: { A: { getUserAffinitiesMap: () => ({}) } }, tl: { L: (users: unknown[]) => users }
    };
    const render = (expression: string) => runInNewContext(`(()=>{let t,n,i,r,l,d,u,_,E,h,f,I,p,T,m,g,S,N,C,O;return ${expression};})()`, globals);
    const original = render(guildActivitySource);
    const originalNativeCalls = nativeCalls.splice(0);
    participantQueries.length = 0;
    const current = render(source);
    const ids = (values: any[]) => Array.from(values, user => user.id);
    assert.deepEqual(ids(current.voiceUsersToShow), ids(original.voiceUsersToShow));
    assert.deepEqual(ids(current.streamUsersToShow), ids(original.streamUsersToShow));
    assert.deepEqual(nativeCalls, originalNativeCalls, "native mute filtering remains responsible for ordinary voice and streams");
    assert.deepEqual(ids(current.stageSpeakers), ["stage-open", "stage-current"]);
    assert.deepEqual(participantQueries, ["stage-open", "stage-current"], "muted and AFK stages are rejected before querying participants");
    assert.deepEqual(ids(current.embeddedActivitiesUsers), ["activity-open"]);
    assert.equal(current.numStageListeners, original.numStageListeners);
    assert.equal(current.hasActivity, true);
    assert.ok(pluginCalls.every(([guild]) => guild === "guild"));
    currentChannel = "activity-current";
    assert.deepEqual(ids(render(source).embeddedActivitiesUsers), ["activity-open", "activity-current"]);
    assert.equal(activities.length, 4);
    assert.deepEqual(Array.from(activities[0].userIds), ["activity-open", "blocked"]);
});
