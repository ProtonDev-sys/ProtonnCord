export type NavidromeAlbumArtMode = "none" | "lastfm";

export function normalizeNavidromeAlbumArtMode(value: unknown): NavidromeAlbumArtMode {
    return value === "lastfm" ? "lastfm" : "none";
}
