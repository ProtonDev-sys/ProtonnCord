import assert from "node:assert/strict";

import puppeteer, { Browser, Page, Protocol } from "puppeteer-core";

interface NavigationSample {
    contentMs: number | null;
    routeMs: number | null;
    selectedMs: number | null;
    settledMs: number | null;
    timedOut: boolean;
    titleMs: number | null;
}

interface RuntimeMetrics {
    documents: number;
    domNodes: number;
    jsEventListeners: number;
    jsHeapTotalBytes: number;
    jsHeapUsedBytes: number;
    layoutObjects: number;
}

function readIterations(): number {
    const argument = process.argv.find(value => value.startsWith("--iterations="));
    const iterations = Number(argument?.split("=")[1] ?? 30);
    assert(Number.isInteger(iterations) && iterations >= 2, "--iterations must be an integer of at least 2");
    return iterations;
}

async function getDiscordPage(browser: Browser): Promise<Page> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
        const page = (await browser.pages()).find(candidate => candidate.url().includes("discord.com/channels"));
        if (page) return page;
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error("Discord channel page was not available within 30 seconds");
}

async function collectRuntimeMetrics(page: Page, collectGarbage: boolean): Promise<RuntimeMetrics> {
    const session = await page.createCDPSession();
    await session.send("Performance.enable");
    if (collectGarbage) await session.send("HeapProfiler.collectGarbage");

    const [performance, dom] = await Promise.all([
        session.send("Performance.getMetrics"),
        session.send("Memory.getDOMCounters"),
    ]);
    await session.detach();

    const metric = (name: string) => performance.metrics.find(entry => entry.name === name)?.value ?? 0;

    return {
        documents: dom.documents,
        domNodes: dom.nodes,
        jsEventListeners: dom.jsEventListeners,
        jsHeapTotalBytes: metric("JSHeapTotalSize"),
        jsHeapUsedBytes: metric("JSHeapUsedSize"),
        layoutObjects: metric("LayoutCount"),
    };
}

async function collectProcessCpu(browser: Browser): Promise<{ processCount: number; totalCpuSeconds: number; }> {
    const session = await browser.target().createCDPSession();
    const processInfo = await session.send("SystemInfo.getProcessInfo");
    await session.detach();

    return {
        processCount: processInfo.processInfo.length,
        totalCpuSeconds: processInfo.processInfo.reduce((total, process) => total + process.cpuTime, 0),
    };
}

async function getChannelPaths(page: Page): Promise<string[]> {
    return page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href^='/channels/']"))
        .filter(anchor => anchor.getClientRects().length > 0)
        .map(anchor => anchor.getAttribute("href"))
        .filter((href): href is string => typeof href === "string" && /^\/channels\/\d+\/\d+$/.test(href))
        .filter((href, index, paths) => paths.indexOf(href) === index));
}

async function ensureGuildChannelPaths(page: Page): Promise<string[]> {
    let channelPaths = await getChannelPaths(page);
    if (channelPaths.length >= 2) return channelPaths;

    const openedGuild = await page.evaluate(() => {
        const guildLink = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href^='/channels/']"))
            .find(anchor => anchor.getClientRects().length > 0 && /^\/channels\/\d+$/.test(anchor.getAttribute("href") ?? ""));
        if (guildLink) {
            guildLink.click();
            return true;
        }

        const common = Vencord.Webpack.Common as any;
        for (const guildId of Object.keys(common.GuildStore.getGuilds())) {
            const channel = common.GuildChannelStore.getSelectableChannels(guildId)
                .map((entry: any) => entry.channel)
                .find((candidate: any) => candidate?.type === 0 || candidate?.type === 5);
            if (!channel) continue;
            common.NavigationRouter.transitionTo(`/channels/${guildId}/${channel.id}`);
            return true;
        }
        return false;
    });
    assert.equal(openedGuild, true, "A visible guild is required when the benchmark starts from a DM");

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        channelPaths = await getChannelPaths(page);
        if (channelPaths.length >= 2) return channelPaths;
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return channelPaths;
}

async function measureNavigation(page: Page, targetPath: string): Promise<NavigationSample> {
    return page.evaluate(async path => {
        const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href^='/channels/']"))
            .find(candidate => candidate.getAttribute("href") === path);
        if (!anchor) throw new Error("Target channel is no longer visible");

        const targetName = anchor.querySelector<HTMLElement>("[class*='name']")?.innerText.trim();
        const startingTitle = document.title;
        const startedAt = performance.now();
        const deadline = startedAt + 10_000;
        let contentAt: number | null = null;
        let routeAt: number | null = null;
        let selectedAt: number | null = null;
        let titleAt: number | null = null;

        anchor.click();

        while (performance.now() < deadline) {
            const now = performance.now();
            const selectedAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href^='/channels/']"))
                .find(candidate => candidate.getAttribute("href") === path);

            if (routeAt == null && location.pathname === path) routeAt = now;
            if (selectedAt == null && selectedAnchor?.getAttribute("aria-current") === "page") selectedAt = now;
            if (titleAt == null && document.title !== startingTitle) titleAt = now;
            if (contentAt == null && targetName && Array.from(document.querySelectorAll("h1, h2"))
                .some(heading => heading.textContent?.includes(targetName))) {
                contentAt = now;
            }

            if (routeAt != null && selectedAt != null && titleAt != null && contentAt != null) {
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                const settledAt = performance.now();
                return {
                    contentMs: contentAt - startedAt,
                    routeMs: routeAt - startedAt,
                    selectedMs: selectedAt - startedAt,
                    settledMs: settledAt - startedAt,
                    timedOut: false,
                    titleMs: titleAt - startedAt,
                };
            }

            await new Promise(resolve => setTimeout(resolve, 1));
        }

        const elapsed = performance.now() - startedAt;
        return {
            contentMs: contentAt == null ? null : contentAt - startedAt,
            routeMs: routeAt == null ? null : routeAt - startedAt,
            selectedMs: selectedAt == null ? null : selectedAt - startedAt,
            settledMs: elapsed,
            timedOut: true,
            titleMs: titleAt == null ? null : titleAt - startedAt,
        };
    }, targetPath);
}

function summarize(values: number[]) {
    const sorted = [...values].sort((left, right) => left - right);
    const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
    const round = (value: number) => Math.round(value * 100) / 100;

    return {
        max: round(sorted.at(-1) ?? 0),
        mean: round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
        median: round(percentile(0.5)),
        min: round(sorted[0] ?? 0),
        p95: round(percentile(0.95)),
    };
}

function summarizeProfile(profile: Protocol.Profiler.Profile) {
    const selfTimeByNode = new Map<number, number>();

    profile.samples?.forEach((nodeId, index) => {
        const milliseconds = (profile.timeDeltas?.[index] ?? 0) / 1000;
        selfTimeByNode.set(nodeId, (selfTimeByNode.get(nodeId) ?? 0) + milliseconds);
    });

    return profile.nodes
        .map(node => ({
            functionName: node.callFrame.functionName || "(anonymous)",
            selfTimeMs: Math.round((selfTimeByNode.get(node.id) ?? 0) * 100) / 100,
            source: node.callFrame.url.split("/").at(-1)?.slice(0, 120) || "(injected)",
        }))
        .filter(node => node.selfTimeMs > 0 && !["(idle)", "(program)"].includes(node.functionName))
        .sort((left, right) => right.selfTimeMs - left.selfTimeMs)
        .slice(0, 20);
}

async function main(): Promise<void> {
    const iterations = readIterations();
    const shouldProfile = process.argv.includes("--profile");
    const browserUrl = process.env.DISCORD_DEBUG_URL ?? "http://127.0.0.1:9222";
    const browser = await puppeteer.connect({ browserURL: browserUrl });

    try {
        const page = await getDiscordPage(browser);
        await page.bringToFront();
        const channelPaths = await ensureGuildChannelPaths(page);
        assert(channelPaths.length >= 2, "At least two visible guild text channels are required");

        const targets = channelPaths.filter(path => path !== new URL(page.url()).pathname).slice(0, 2);
        if (targets.length < 2) targets.push(channelPaths.find(path => !targets.includes(path))!);

        const runtime = await page.evaluate(() => ({
            enabledPlugins: Object.keys(Vencord.Settings.plugins).filter(Vencord.Plugins.isPluginEnabled).length,
            pluginCount: Object.keys(Vencord.Plugins.plugins).length,
            startedPlugins: Object.values(Vencord.Plugins.plugins).filter(plugin => plugin.started).length,
        }));
        const beforeMetrics = await collectRuntimeMetrics(page, true);
        const beforeCpu = await collectProcessCpu(browser);

        for (let index = 0; index < 4; index++) {
            await measureNavigation(page, targets[index % targets.length]);
        }

        const profileSession = shouldProfile ? await page.createCDPSession() : null;
        if (profileSession) {
            await profileSession.send("Profiler.enable");
            await profileSession.send("Profiler.start");
        }

        const samples: NavigationSample[] = [];
        for (let index = 0; index < iterations; index++) {
            samples.push(await measureNavigation(page, targets[index % targets.length]));
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const profile = profileSession ? (await profileSession.send("Profiler.stop")).profile : null;
        if (profileSession) await profileSession.detach();

        const afterMetrics = await collectRuntimeMetrics(page, true);
        const afterCpu = await collectProcessCpu(browser);
        const completed = samples.filter(sample => !sample.timedOut);
        assert(completed.length === samples.length, `${samples.length - completed.length} navigation samples timed out`);

        console.log(JSON.stringify({
            afterMetrics,
            beforeMetrics,
            iterations,
            metricDelta: Object.fromEntries(Object.entries(afterMetrics).map(([name, value]) => [
                name,
                value - beforeMetrics[name as keyof RuntimeMetrics],
            ])),
            navigationMs: {
                content: summarize(completed.map(sample => sample.contentMs!)),
                route: summarize(completed.map(sample => sample.routeMs!)),
                selected: summarize(completed.map(sample => sample.selectedMs!)),
                settled: summarize(completed.map(sample => sample.settledMs!)),
                title: summarize(completed.map(sample => sample.titleMs!)),
            },
            processCpuSeconds: {
                after: afterCpu.totalCpuSeconds,
                before: beforeCpu.totalCpuSeconds,
                delta: afterCpu.totalCpuSeconds - beforeCpu.totalCpuSeconds,
                processCount: afterCpu.processCount,
            },
            profileHotspots: profile ? summarizeProfile(profile) : undefined,
            runtime,
        }, null, 2));
    } finally {
        browser.disconnect();
    }
}

void main();
