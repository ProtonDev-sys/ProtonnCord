export const CORS_PROXY = "https://cors.keiran0.workers.dev";

export function normalizeCorsProxyUrl(url?: string): string {
    return (url?.trim() || CORS_PROXY).replace(/\/+$/, "");
}

export function toProxiedUrl(url: string, corsProxyUrl = CORS_PROXY): string {
    if (corsProxyUrl === "none") {
        return url;
    }
    return `${normalizeCorsProxyUrl(corsProxyUrl)}?url=${encodeURIComponent(url)}`;
}
