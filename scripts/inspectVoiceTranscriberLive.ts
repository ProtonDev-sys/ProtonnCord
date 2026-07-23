import puppeteer, { Page } from "puppeteer-core";

const channelId = process.argv[2];
const translationTarget = process.argv.find(argument => argument.startsWith("--translate="))?.slice("--translate=".length);
const shouldTestPlayback = process.argv.includes("--playback");
const shouldTranscribe = process.argv.includes("--transcribe") || Boolean(translationTarget);

if (!/^\d{17,20}$/.test(channelId ?? ""))
    throw new Error("Usage: tsx scripts/inspectVoiceTranscriberLive.ts <channel-id> [--playback] [--transcribe] [--translate=French]");

async function getPlayerState(page: Page): Promise<string> {
    return page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll("button[aria-label], [role='button'][aria-label]"))
            .filter(element => /voice message/i.test(element.getAttribute("aria-label") ?? "") && /play|pause/i.test(element.getAttribute("aria-label") ?? ""));
        return controls.at(-1)?.getAttribute("aria-label") ?? "";
    });
}

async function testPlayback(page: Page): Promise<void> {
    const before = await getPlayerState(page);
    if (!/play/i.test(before)) throw new Error(`Expected Play voice message, found ${before || "no playback control"}`);

    await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll("button[aria-label], [role='button'][aria-label]"));
        const play = controls.filter(element => /play voice message/i.test(element.getAttribute("aria-label") ?? "")).at(-1) as HTMLElement | undefined;
        play?.click();
    });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const during = await getPlayerState(page);

    await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll("button[aria-label], [role='button'][aria-label]"));
        const pause = controls.filter(element => /pause voice message/i.test(element.getAttribute("aria-label") ?? "")).at(-1) as HTMLElement | undefined;
        pause?.click();
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    const after = await getPlayerState(page);

    const passed = /play/i.test(before) && /pause/i.test(during) && /play/i.test(after);
    console.log(JSON.stringify({ playback: { after, before, during, passed } }));
    if (!passed) throw new Error("Voice-message playback did not transition Play -> Pause -> Play");
}

async function transcribe(page: Page): Promise<void> {
    await page.evaluate(() => {
        const accessory = Array.from(document.querySelectorAll(".vc-transcription-accessory")).at(-1);
        const button = Array.from(accessory?.querySelectorAll("button") ?? [])
            .find(candidate => candidate.textContent?.trim() === "Transcribe") as HTMLButtonElement | undefined;
        button?.click();
    });

    const deadline = Date.now() + 5 * 60_000;
    let previousStatus = "";
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const state = await page.evaluate(() => {
            const accessory = Array.from(document.querySelectorAll(".vc-transcription-accessory")).at(-1);
            return {
                error: accessory?.querySelector(".vc-transcription-error")?.textContent?.trim() ?? "",
                hasTranscript: Array.from(accessory?.querySelectorAll("h5") ?? []).some(heading => heading.textContent?.trim() === "Transcript"),
                resultLength: accessory?.querySelector(".vc-transcription-result")?.textContent?.trim().length ?? 0,
                status: accessory?.querySelector(".vc-transcription-status")?.textContent?.trim() ?? ""
            };
        });

        if (state.status && state.status !== previousStatus) {
            previousStatus = state.status;
            console.log(JSON.stringify({ status: state.status }));
        }
        if (state.error) throw new Error(state.error);
        if (state.hasTranscript && !state.status) {
            console.log(JSON.stringify({ transcriptCharacters: state.resultLength, transcribed: true }));
            if (state.resultLength === 0) throw new Error("Transcription completed without text");
            return;
        }
    }

    throw new Error("Timed out waiting for voice-message transcription");
}

async function translate(page: Page, target: string): Promise<void> {
    await page.evaluate(() => {
        const accessory = Array.from(document.querySelectorAll(".vc-transcription-accessory")).at(-1);
        const button = Array.from(accessory?.querySelectorAll("button") ?? [])
            .find(candidate => candidate.textContent?.trim().startsWith("Translate")) as HTMLButtonElement | undefined;
        button?.click();
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    const input = await page.$("[role='dialog'] input, [class*='modal'] input");
    if (!input) throw new Error("Could not find the target-language search input");
    await input.evaluate(element => {
        const input = element as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await input.type(target);
    await new Promise(resolve => setTimeout(resolve, 500));

    const selected = await page.evaluate(target => {
        const matches = Array.from(document.querySelectorAll("body *"))
            .filter(candidate => candidate.textContent?.trim() === target && candidate.getClientRects().length > 0) as HTMLElement[];
        matches.sort((first, second) => first.querySelectorAll("*").length - second.querySelectorAll("*").length);
        const exact = matches[0];
        const option = exact?.closest("[role='option'], [role='button'], [tabindex], [class*='option']") as HTMLElement | null ?? exact;
        option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        option?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        option?.click();
        return Boolean(option);
    }, target);
    if (!selected) throw new Error(`Could not select translation language ${target}`);

    await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll("button"))
            .find(candidate => candidate.textContent?.trim() === "Transcribe & Translate") as HTMLButtonElement | undefined;
        button?.click();
    });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const state = await page.evaluate(target => {
            const accessory = Array.from(document.querySelectorAll(".vc-transcription-accessory")).at(-1);
            const results = Array.from(accessory?.querySelectorAll(".vc-transcription-result") ?? []);
            return {
                error: accessory?.querySelector(".vc-transcription-error")?.textContent?.trim() ?? "",
                hasTarget: Array.from(accessory?.querySelectorAll("h5") ?? []).some(heading => heading.textContent?.trim() === target),
                resultLength: results[1]?.textContent?.trim().length ?? 0
            };
        }, target);
        if (state.error) throw new Error(state.error);
        if (state.hasTarget && state.resultLength > 0) {
            console.log(JSON.stringify({ translated: true, translationCharacters: state.resultLength, translationLanguage: target }));
            return;
        }
    }

    throw new Error(`Timed out waiting for ${target} translation`);
}

async function main(): Promise<void> {
    const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
    try {
        const pages = await browser.pages();
        const page = pages.find(candidate => candidate.url().includes("discord.com/channels")) ?? pages[0];
        await page.goto(`https://discord.com/channels/@me/${channelId}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await new Promise(resolve => setTimeout(resolve, 7_000));

        const state = await page.evaluate(channelId => {
            const global = globalThis as any;
            const vencord = global.Vencord;
            const collection = vencord?.Webpack?.Common?.MessageStore?.getMessages?.(channelId);
            const messages = collection?.toArray?.() ?? collection?._array ?? [];
            const fallback = Array.from(document.querySelectorAll(".vc-transcription-playback-fallback")).at(-1);
            const audio = fallback?.querySelector("audio") as HTMLAudioElement | null;
            const canvas = fallback?.querySelector("canvas") as HTMLCanvasElement | null;
            let waveform: { activeColumns: number, uniqueColumnHeights: number; } | null = null;
            if (canvas) {
                const context = canvas.getContext("2d");
                if (context) {
                    const { data, height, width } = context.getImageData(0, 0, canvas.width, canvas.height);
                    const heights: number[] = [];
                    for (let x = 0; x < width; x++) {
                        let active = 0;
                        for (let y = 0; y < height; y++)
                            if (data[(y * width + x) * 4 + 3] > 0) active++;
                        if (active > 0) heights.push(active);
                    }
                    waveform = { activeColumns: heights.length, uniqueColumnHeights: new Set(heights).size };
                }
            }

            return {
                accessoryCount: document.querySelectorAll(".vc-transcription-accessory").length,
                displayedDuration: fallback?.querySelector("[class*='duration']")?.textContent?.trim() ?? null,
                mediaDuration: audio?.duration ?? null,
                pluginEnabled: vencord?.Settings?.plugins?.VoiceMessageTranscriber?.enabled,
                pluginPresent: Boolean(vencord?.Plugins?.plugins?.VoiceMessageTranscriber),
                transcribeButtonCount: Array.from(document.querySelectorAll("button")).filter(button => button.textContent?.trim() === "Transcribe").length,
                voiceMessageCount: messages.filter((message: any) => Boolean((message.flags ?? 0) & (1 << 13))).length,
                waveform
            };
        }, channelId);

        console.log(JSON.stringify(state, null, 2));
        if (!state.pluginPresent || !state.pluginEnabled) throw new Error("VoiceMessageTranscriber is not enabled and loaded");
        if (state.accessoryCount < 1 || state.transcribeButtonCount < 1) throw new Error("No transcription accessory was rendered");
        if (state.waveform && (state.waveform.activeColumns === 0 || state.waveform.uniqueColumnHeights < 2))
            throw new Error("The generated Discord waveform is empty or flat");

        if (shouldTestPlayback) await testPlayback(page);
        if (shouldTranscribe) await transcribe(page);
        if (translationTarget) await translate(page, translationTarget);
    } finally {
        await browser.disconnect();
    }
}

void main();
