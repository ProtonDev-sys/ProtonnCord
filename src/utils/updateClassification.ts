/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
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

export interface UpdateChange {
    hash: string;
}

export interface UpdateClassification {
    isNewer: boolean;
    isOutdated: boolean;
}

const MIN_ABBREVIATED_HASH_LENGTH = 7;

export function hashesReferToSameCommit(first: string, second: string): boolean {
    if (first === second) return true;
    if (Math.min(first.length, second.length) < MIN_ABBREVIATED_HASH_LENGTH) return false;

    return first.startsWith(second) || second.startsWith(first);
}

export function classifyUpdateChanges(changes: UpdateChange[], currentHash: string): UpdateClassification {
    const isNewer = changes.some(change => hashesReferToSameCommit(change.hash, currentHash));

    return {
        isNewer,
        isOutdated: !isNewer && changes.length > 0
    };
}
