from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/apply-secure-messaging-cache-audit.yml"
SCRIPT = Path(__file__)


def replace_once(path: str, old: str, new: str) -> None:
    file = ROOT / path
    source = file.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old.splitlines()[0]!r}")
    file.write_text(source.replace(old, new, 1))


def replace_section(path: str, start_marker: str, end_marker: str, replacement: str) -> None:
    file = ROOT / path
    source = file.read_text()
    if source.count(start_marker) != 1 or source.count(end_marker) != 1:
        raise SystemExit(f"Section markers were not unique in {path}: {start_marker!r}, {end_marker!r}")
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    file.write_text(source[:start] + replacement + source[end:])


CRYPTO = "src/equicordplugins/secureMessaging.desktop/crypto.ts"
ATTACHMENTS = "src/equicordplugins/secureMessaging.desktop/attachments.ts"
DECRYPT_CACHE = "src/equicordplugins/secureMessaging.desktop/decryptCache.ts"
ATTACHMENT_CACHE = "src/equicordplugins/secureMessaging.desktop/attachmentCache.ts"
EMBED_CACHE = "src/equicordplugins/secureMessaging.desktop/embedCache.ts"

replace_once(
    CRYPTO,
    '} from "@hpke/core";\n\nimport {',
    '} from "@hpke/core";\n\nimport { exactArrayBuffer } from "./exactArrayBuffer";\nimport {',
)
replace_once(
    CRYPTO,
    "function cryptoBytes(value: Uint8Array): ArrayBuffer {\n    return Uint8Array.from(value).buffer;\n}\n",
    "function cryptoBytes(value: Uint8Array): ArrayBuffer {\n    return exactArrayBuffer(value);\n}\n",
)

replace_once(
    ATTACHMENTS,
    'import { decodeBase64Url, encodeBase64Url, isSnowflake } from "./protocol";\n',
    'import { exactArrayBuffer } from "./exactArrayBuffer";\nimport { decodeBase64Url, encodeBase64Url, isSnowflake } from "./protocol";\n',
)
replace_once(
    ATTACHMENTS,
    "function cryptoBytes(value: Uint8Array): ArrayBuffer {\n    return Uint8Array.from(value).buffer;\n}\n",
    "function cryptoBytes(value: Uint8Array): ArrayBuffer {\n    return exactArrayBuffer(value);\n}\n",
)

replace_once(
    DECRYPT_CACHE,
    'import type { DecryptIncomingAttachmentsResult, DecryptIncomingResult } from "./native";\n',
    'import type { DecryptIncomingAttachmentsResult, DecryptIncomingResult } from "./native";\nimport { createTaskQueue } from "./taskQueue";\n',
)
replace_once(
    DECRYPT_CACHE,
    "const cache = new Map<string, DecryptCacheEntry>();\nlet cacheGeneration = 0;\nlet inFlightDecrypts = 0;\n",
    "const cache = new Map<string, DecryptCacheEntry>();\nconst runDecryptTask = createTaskQueue(4);\nlet cacheGeneration = 0;\n",
)
replace_once(
    DECRYPT_CACHE,
    '''    if (inFlightDecrypts >= MAX_CACHE_ENTRIES) {
        entry.result = { status: "failed", error: "cryptographic_operation_failed" };
        entry.promise = Promise.resolve(entry.result);
        return [key, entry];
    }
    cache.set(key, entry);
    const generation = cacheGeneration;
    inFlightDecrypts++;
    entry.promise = decryptWithRetry(localUserId, message, generation, () => cache.get(key) === entry).then(result => {
            if (cache.get(key) === entry) {
                entry.lastAccess = Date.now();
                entry.result = result;
                pruneCache(key);
            }
            return result;
        }).finally(() => { inFlightDecrypts--; });
''',
    '''    cache.set(key, entry);
    const generation = cacheGeneration;
    entry.promise = runDecryptTask(() =>
        decryptWithRetry(localUserId, message, generation, () => cache.get(key) === entry)
    ).then(result => {
        if (cache.get(key) === entry) {
            entry.lastAccess = Date.now();
            entry.result = result;
            pruneCache(key);
        }
        return result;
    });
''',
)

replace_once(
    ATTACHMENT_CACHE,
    'import { preserveEncryptedMessageScroll } from "./layoutStability";\n',
    'import { exactArrayBuffer } from "./exactArrayBuffer";\nimport { preserveEncryptedMessageScroll } from "./layoutStability";\n',
)
replace_once(
    ATTACHMENT_CACHE,
    'import { isEncryptedMessage } from "./protocol";\n',
    'import { isEncryptedMessage } from "./protocol";\nimport { createTaskQueue } from "./taskQueue";\n',
)
replace_once(ATTACHMENT_CACHE, "const MAX_IN_FLIGHT_LOADS = 12;\n", "")
replace_once(
    ATTACHMENT_CACHE,
    "const VIDEO_POSTER_TIMEOUT_MS = 5_000;\n",
    "const VIDEO_POSTER_TIMEOUT_MS = 5_000;\nconst runAttachmentLoad = createTaskQueue(4);\n",
)
replace_once(ATTACHMENT_CACHE, "let inFlightLoads = 0;\n", "")
replace_once(
    ATTACHMENT_CACHE,
    "            const blob = new Blob([Uint8Array.from(attachment.data).buffer], {\n",
    "            const blob = new Blob([exactArrayBuffer(attachment.data)], {\n",
)
replace_section(
    ATTACHMENT_CACHE,
    "function startEntryLoad(message: Message, key: string, entry: AttachmentCacheEntry, localUserId: string): void {",
    "function objectUrl(value: string): string {",
    '''function startEntryLoad(message: Message, key: string, entry: AttachmentCacheEntry, localUserId: string): void {
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    void runAttachmentLoad(async () => {
        if (entry.disposed || cache.get(key) !== entry) return;
        if (UserStore.getCurrentUser()?.id !== localUserId) {
            removeEntry(key, entry);
            return;
        }
        const requiredBytes = message.attachments.reduce((total, attachment) => total + attachment.size, 0);
        pruneCache(key, requiredBytes);
        if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 1 || requiredBytes > MAX_CACHE_BYTES ||
            cachedBytes + inFlightBytes + requiredBytes > MAX_CACHE_BYTES) {
            entry.status = { status: "failed", reason: "The encrypted attachment cache is busy. Retry in a moment." };
            prepareTransientRetry(entry);
            notifyStatus(entry);
            scheduleRetry(message, key, entry, localUserId);
            return;
        }
        entry.reservedBytes = requiredBytes;
        inFlightBytes += requiredBytes;
        try {
            await loadEntry(message, key, entry, localUserId);
        } finally {
            releaseReservation(entry);
        }
    }).catch(() => {
        if (entry.disposed || cache.get(key) !== entry) return;
        entry.status = { status: "failed", reason: "The encrypted attachments could not be loaded." };
        prepareTransientRetry(entry);
        notifyStatus(entry);
        scheduleRetry(message, key, entry, localUserId);
    });
}

''',
)

replace_once(
    EMBED_CACHE,
    'import { preserveEncryptedMessageScroll } from "./layoutStability";\n',
    'import { preserveEncryptedMessageScroll } from "./layoutStability";\nimport { createTaskQueue } from "./taskQueue";\n',
)
replace_once(
    EMBED_CACHE,
    '''interface UnfurlCacheEntry {
    expiresAt: number;
    lastAccess: number;
    promise: Promise<Record<string, unknown>[]>;
}

const cache = new Map<string, EmbedCacheEntry>();
const unfurlCache = new Map<string, UnfurlCacheEntry>();
''',
    '''interface UnfurlCacheEntry {
    expiresAt: number;
    lastAccess: number;
    promise: Promise<Record<string, unknown>[]>;
    settled: boolean;
}

const cache = new Map<string, EmbedCacheEntry>();
const unfurlCache = new Map<string, UnfurlCacheEntry>();
const runUnfurlTask = createTaskQueue(4);
''',
)
replace_section(
    EMBED_CACHE,
    "function pruneCache(protectedKey: string): void {",
    "async function requestUnfurl(url: string): Promise<Record<string, unknown>[]> {",
    '''function pruneCache(protectedKey: string, maximumEntries = MAX_CACHE_ENTRIES): void {
    while (cache.size > maximumEntries) {
        let oldest: [string, EmbedCacheEntry] | null = null;
        let oldestReady: [string, EmbedCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey) continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
            if (value[1].status === "ready" && (!oldestReady || value[1].lastAccess < oldestReady[1].lastAccess))
                oldestReady = value;
        }
        const candidate = oldestReady ?? oldest;
        if (!candidate) break;
        cache.delete(candidate[0]);
    }
}

function pruneUnfurlCache(protectedKey: string, now: number, maximumEntries = MAX_UNFURL_CACHE_ENTRIES): void {
    for (const [key, entry] of unfurlCache) {
        if (key !== protectedKey && entry.settled && entry.expiresAt <= now) unfurlCache.delete(key);
    }
    while (unfurlCache.size > maximumEntries) {
        let oldest: [string, UnfurlCacheEntry] | null = null;
        for (const value of unfurlCache) {
            if (value[0] === protectedKey || !value[1].settled) continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
        }
        if (!oldest) break;
        unfurlCache.delete(oldest[0]);
    }
}

''',
)
replace_once(EMBED_CACHE, "                retries: 1,\n", "                retries: 0,\n")
replace_section(
    EMBED_CACHE,
    "function unfurlUrl(url: string): Promise<Record<string, unknown>[]> {",
    "async function unfurlEmbeds(urls: string[]): Promise<Record<string, unknown>[]> {",
    '''function unfurlUrl(url: string): Promise<Record<string, unknown>[]> {
    const now = Date.now();
    const existing = unfurlCache.get(url);
    if (existing && (!existing.settled || existing.expiresAt > now)) {
        existing.lastAccess = now;
        return existing.promise;
    }
    if (existing) unfurlCache.delete(url);
    pruneUnfurlCache("", now, MAX_UNFURL_CACHE_ENTRIES - 1);
    if (unfurlCache.size >= MAX_UNFURL_CACHE_ENTRIES) return Promise.resolve([]);

    const entry: UnfurlCacheEntry = {
        expiresAt: Number.POSITIVE_INFINITY,
        lastAccess: now,
        promise: Promise.resolve([]),
        settled: false,
    };
    unfurlCache.set(url, entry);
    entry.promise = runUnfurlTask(() =>
        unfurlCache.get(url) === entry ? requestUnfurl(url) : Promise.resolve([])
    ).then(embeds => {
        if (unfurlCache.get(url) === entry) {
            const settledAt = Date.now();
            entry.expiresAt = settledAt + (embeds.length > 0 ? SUCCESSFUL_UNFURL_TTL : EMPTY_UNFURL_TTL);
            entry.lastAccess = settledAt;
            entry.settled = true;
            pruneUnfurlCache(url, settledAt);
        }
        return embeds;
    });
    return entry.promise;
}

''',
)
replace_once(
    EMBED_CACHE,
    '''    if (decrypted.status !== "decrypted") {
        finishEntry(message, key, entry);
        return;
    }
    entry.stickers = decrypted.stickers ?? [];
''',
    '''    if (decrypted.status !== "decrypted") {
        finishEntry(message, key, entry);
        return;
    }
    if (cache.get(key) !== entry) return;
    entry.stickers = decrypted.stickers ?? [];
''',
)
replace_once(
    EMBED_CACHE,
    "    const rawEmbeds = await unfurlEmbeds(urls);\n    const converted: Embed[] = [];\n",
    "    const rawEmbeds = await unfurlEmbeds(urls);\n    if (cache.get(key) !== entry) return;\n    const converted: Embed[] = [];\n",
)
replace_once(
    EMBED_CACHE,
    '''    if (existing) cache.delete(key);
    const entry: EmbedCacheEntry = {
''',
    '''    if (existing) cache.delete(key);
    pruneCache("", MAX_CACHE_ENTRIES - 1);
    const entry: EmbedCacheEntry = {
''',
)

WORKFLOW.unlink()
SCRIPT.unlink()
