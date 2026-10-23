import { parseExternalHttpsUrl } from "@shared/externalUrls";

/** Open an untrusted browser-build link without granting it opener access. */
export function openExternalInBrowser(value: unknown): boolean {
    const href = parseExternalHttpsUrl(value);
    if (href == null) return false;

    try {
        const openedWindow = window.open(href, "_blank", "noopener,noreferrer");
        if (openedWindow != null) openedWindow.opener = null;
        return true;
    } catch {
        return false;
    }
}
