import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const plugin = loadTestModule("src/equicordplugins/searchFix/index.tsx", {
    "@utils/constants": { EquicordDevs: {} },
    "@utils/types": { __esModule: true, default: (value: unknown) => value }
}, {}).default;

test("SearchFix preserves in-range offsets and sorting", () => {
    for (const offset of [undefined, 0, 1, 4999, 5000]) {
        const query = { offset, sort_order: "asc", author_id: "user" };
        const original = { ...query };
        plugin.main(query);
        assert.deepEqual(query, original);
    }
});

test("SearchFix reverses out-of-range sorting and preserves the documented zero-offset fallback", () => {
    for (const offset of [5001, 10000, 20000]) {
        for (const [sort_order, expected] of [["asc", "desc"], ["desc", "asc"], [undefined, "asc"]]) {
            const query = { offset, sort_order, author_id: "user" };
            plugin.main(query);
            assert.deepEqual(query, { offset: 0, sort_order: expected, author_id: "user" });
        }
    }
});
