/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

export const DEFAULT_IMAGE_CACHE_DIR = "savedImages";
export const SUPPORTED_ATTACHMENT_FILE_EXTENSIONS = [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "mp4",
    "webm",
    "mp3",
    "ogg",
    "wav"
] as const;
export const DEFAULT_ATTACHMENT_FILE_EXTENSIONS = SUPPORTED_ATTACHMENT_FILE_EXTENSIONS.join(",");
export const DEFAULT_ATTACHMENT_SIZE_LIMIT_MEGABYTES = 12;
export const MAX_ATTACHMENT_SIZE_LIMIT_MEGABYTES = 50;
export const MAX_ATTACHMENT_CACHE_BYTES = 512 * 1024 * 1024;
export const MAX_ATTACHMENT_CACHE_ENTRIES = 10_000;
export const DB_NAME = "MessageLoggerIDB";
export const DB_VERSION = 1;
export const LOGS_DATA_FILENAME = "message-logger-logs.json";
