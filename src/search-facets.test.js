// Tests for miss-triggered search facets.
// Run: node --test src/search-facets.test.js   (Node >= 18, zero deps)
//
// The load-bearing claims this suite proves:
//   1. A HIT is never enriched and never triggers a second bridge call.
//   2. A MISS gets real values with counts attached.
//   3. A facet-lookup failure degrades to the ORIGINAL result — never a throw,
//      never a working search turned into an error.
//   4. Error envelopes keep their `error` key so isErrorResult() still flags them.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FACET_ROWS,
  unwrapPayload,
  isComponentMiss,
  isAssetTypeMiss,
  componentFacetsFromSceneStats,
  assetFacetsFromResults,
  enrichComponentSearch,
  enrichAssetSearch,
} from "./search-facets.js";
import { isErrorResult } from "./response-format.js";

// ─── fixtures (shapes copied from MCPSearchCommands.cs) ───

const SCENE_STATS = {
  sceneName: "SampleScene",
  totalGameObjects: 120,
  topComponents: [
    { type: "Transform", count: 120 },
    { type: "MeshRenderer", count: 44 },
    { type: "BoxCollider", count: 12 },
  ],
};

const HIT = {
  componentType: "Rigidbody",
  totalFound: 3,
  returned: 3,
  limit: 500,
  results: [{ name: "Player", path: "/Player", instanceId: 1, active: true, scene: "SampleScene" }],
};

const TYPE_NOT_FOUND = { error: "Component type 'Rigidbdy' not found" };
const ZERO_INSTANCES = { componentType: "Light", totalFound: 0, returned: 0, limit: 500, results: [] };

const ASSET_MISS = { totalFound: 0, returned: 0, results: [] };
const ASSET_RETRY = {
  totalFound: 5,
  returned: 5,
  results: [
    { path: "Assets/A.mat", guid: "g1", type: "Material", name: "A" },
    { path: "Assets/B.mat", guid: "g2", type: "Material", name: "B" },
    { path: "Assets/C.prefab", guid: "g3", type: "GameObject", name: "C" },
    { path: "Assets/D.png", guid: "g4", type: "Texture2D", name: "D" },
    { path: "Assets/E.mat", guid: "g5", type: "Material", name: "E" },
  ],
};

/** Counting stub: records how many times the bridge was called. */
function stub(value) {
  const fn = async (...args) => {
    fn.calls.push(args);
    if (value instanceof Error) throw value;
    return value;
  };
  fn.calls = [];
  return fn;
}

// ─── unwrapPayload ───

test("unwrapPayload: passes a bare payload straight through", () => {
  const { payload, rewrap } = unwrapPayload(HIT);
  assert.equal(payload, HIT);
  assert.deepEqual(rewrap({ a: 1 }), { a: 1 });
});

test("unwrapPayload: unwraps the queue envelope and rebuilds it", () => {
  const wrapped = { success: true, data: ZERO_INSTANCES };
  const { payload, rewrap } = unwrapPayload(wrapped);
  assert.equal(payload, ZERO_INSTANCES);
  assert.deepEqual(rewrap({ x: 1 }), { success: true, data: { x: 1 } });
});

test("unwrapPayload: tolerates null / arrays / primitives", () => {
  for (const v of [null, undefined, [1, 2], "str", 7]) {
    assert.equal(unwrapPayload(v).payload, v);
  }
});

// ─── miss detection ───

test("isComponentMiss: true for type-not-found and zero instances, false for a hit", () => {
  assert.equal(isComponentMiss(TYPE_NOT_FOUND), true);
  assert.equal(isComponentMiss(ZERO_INSTANCES), true);
  assert.equal(isComponentMiss(HIT), false);
});

test("isComponentMiss: false for junk input", () => {
  for (const v of [null, undefined, [], "nope", 0]) {
    assert.equal(isComponentMiss(v), false);
  }
});

test("isAssetTypeMiss: only fires when a type filter was actually used", () => {
  assert.equal(isAssetTypeMiss(ASSET_MISS, { query: "rock", type: "Materal" }), true);
  assert.equal(isAssetTypeMiss(ASSET_MISS, { query: "rock" }), false, "no type filter -> stay quiet");
  assert.equal(isAssetTypeMiss(ASSET_RETRY, { query: "rock", type: "Material" }), false, "hit");
});

// ─── facet extraction ───

test("componentFacetsFromSceneStats: maps topComponents into facet rows, sorted desc", () => {
  assert.deepEqual(componentFacetsFromSceneStats(SCENE_STATS), [
    { type: "Transform", count: 120 },
    { type: "MeshRenderer", count: 44 },
    { type: "BoxCollider", count: 12 },
  ]);
});

test("componentFacetsFromSceneStats: reads through a queue envelope", () => {
  assert.equal(componentFacetsFromSceneStats({ success: true, data: SCENE_STATS }).length, 3);
});

test("componentFacetsFromSceneStats: empty for malformed stats", () => {
  for (const v of [null, {}, { topComponents: "nope" }, { topComponents: [] }]) {
    assert.deepEqual(componentFacetsFromSceneStats(v), []);
  }
});

test("componentFacetsFromSceneStats: caps at MAX_FACET_ROWS", () => {
  const many = { topComponents: Array.from({ length: 60 }, (_, i) => ({ type: `T${i}`, count: 60 - i })) };
  assert.equal(componentFacetsFromSceneStats(many).length, MAX_FACET_ROWS);
});

test("assetFacetsFromResults: counts types across rows, most common first", () => {
  assert.deepEqual(assetFacetsFromResults(ASSET_RETRY), [
    { type: "Material", count: 3 },
    { type: "GameObject", count: 1 },
    { type: "Texture2D", count: 1 },
  ]);
});

test("assetFacetsFromResults: skips rows with no usable type", () => {
  const messy = { results: [{ type: "Material" }, { type: "" }, {}, null, { type: 5 }] };
  assert.deepEqual(assetFacetsFromResults(messy), [{ type: "Material", count: 1 }]);
});

// ─── enrichComponentSearch ───

test("enrichComponentSearch: a HIT is untouched and costs no extra call", async () => {
  const stats = stub(SCENE_STATS);
  const out = await enrichComponentSearch(HIT, stats);
  assert.equal(out, HIT, "same object reference — nothing rebuilt");
  assert.equal(stats.calls.length, 0, "no second bridge round-trip on a hit");
});

test("enrichComponentSearch: type-not-found gains real types + a hint", async () => {
  const out = await enrichComponentSearch(TYPE_NOT_FOUND, stub(SCENE_STATS));
  assert.deepEqual(out.availableComponentTypes, [
    { type: "Transform", count: 120 },
    { type: "MeshRenderer", count: 44 },
    { type: "BoxCollider", count: 12 },
  ]);
  assert.match(out.hint, /retry with one of these/);
  assert.match(out.hint, /not the full set/, "the top-10 cap must be stated, not implied");
});

test("enrichComponentSearch: the error key survives, so isErrorResult still flags it", async () => {
  const out = await enrichComponentSearch(TYPE_NOT_FOUND, stub(SCENE_STATS));
  assert.equal(out.error, "Component type 'Rigidbdy' not found");
  assert.equal(isErrorResult(out), true, "enrichment must not mask a logical failure");
});

test("enrichComponentSearch: zero-instance miss keeps its original fields", async () => {
  const out = await enrichComponentSearch(ZERO_INSTANCES, stub(SCENE_STATS));
  assert.equal(out.componentType, "Light");
  assert.equal(out.totalFound, 0);
  assert.equal(out.availableComponentTypes.length, 3);
});

test("enrichComponentSearch: a queue-wrapped miss stays queue-wrapped", async () => {
  const out = await enrichComponentSearch({ success: true, data: ZERO_INSTANCES }, stub(SCENE_STATS));
  assert.equal(out.success, true);
  assert.equal(out.data.availableComponentTypes.length, 3);
});

test("enrichComponentSearch: scene-stats throwing degrades to the original result", async () => {
  const out = await enrichComponentSearch(ZERO_INSTANCES, stub(new Error("bridge down")));
  assert.equal(out, ZERO_INSTANCES, "no throw, no downgrade");
});

test("enrichComponentSearch: empty facets add nothing rather than an empty list", async () => {
  const out = await enrichComponentSearch(ZERO_INSTANCES, stub({ topComponents: [] }));
  assert.equal(out, ZERO_INSTANCES);
});

// ─── enrichAssetSearch ───

test("enrichAssetSearch: a HIT is untouched and costs no extra call", async () => {
  const retry = stub(ASSET_RETRY);
  const out = await enrichAssetSearch(ASSET_RETRY, { query: "rock", type: "Material" }, retry);
  assert.equal(out, ASSET_RETRY);
  assert.equal(retry.calls.length, 0);
});

test("enrichAssetSearch: no type filter means no retry", async () => {
  const retry = stub(ASSET_RETRY);
  const out = await enrichAssetSearch(ASSET_MISS, { query: "rock" }, retry);
  assert.equal(out, ASSET_MISS);
  assert.equal(retry.calls.length, 0, "an empty name search must not spend a second call");
});

test("enrichAssetSearch: a bad type gains the types that DO match", async () => {
  const retry = stub(ASSET_RETRY);
  const out = await enrichAssetSearch(ASSET_MISS, { query: "rock", type: "Materal" }, retry);
  assert.deepEqual(out.availableAssetTypes, [
    { type: "Material", count: 3 },
    { type: "GameObject", count: 1 },
    { type: "Texture2D", count: 1 },
  ]);
  assert.equal(out.matchesWithoutTypeFilter, 5);
  assert.match(out.hint, /Materal/, "the hint names the type that failed");
});

test("enrichAssetSearch: an untruncated retry says the counts are complete", async () => {
  const out = await enrichAssetSearch(ASSET_MISS, { query: "rock", type: "Materal" }, stub(ASSET_RETRY));
  assert.equal(out.assetTypesAreSampled, false);
  assert.equal(out.assetTypesCountedFrom, 5);
  assert.match(out.hint, /counts cover every match/);
});

test("enrichAssetSearch: a TRUNCATED retry declares the counts a sample", async () => {
  // Live shape observed 2026-07-29: 10,774 matches, only 200 rows returned.
  const truncated = { totalFound: 10774, returned: 3, results: ASSET_RETRY.results.slice(0, 3) };
  const out = await enrichAssetSearch(ASSET_MISS, { query: "", type: "Materal" }, stub(truncated));
  assert.equal(out.assetTypesAreSampled, true);
  assert.equal(out.matchesWithoutTypeFilter, 10774);
  assert.equal(out.assetTypesCountedFrom, 3);
  assert.match(out.hint, /first 3 of 10774 matches/);
  assert.match(out.hint, /treat them as a sample/, "a silent cap reads as exhaustive");
});

test("enrichAssetSearch: the retry drops type but keeps the other filters", async () => {
  const retry = stub(ASSET_RETRY);
  await enrichAssetSearch(ASSET_MISS, { query: "rock", type: "Materal", folder: "Assets/Props" }, retry);
  const sent = retry.calls[0][0];
  assert.equal(sent.type, undefined, "type filter must be dropped");
  assert.equal(sent.query, "rock");
  assert.equal(sent.folder, "Assets/Props", "folder scope must survive");
});

test("enrichAssetSearch: retry throwing degrades to the original result", async () => {
  const out = await enrichAssetSearch(ASSET_MISS, { query: "rock", type: "Materal" }, stub(new Error("down")));
  assert.equal(out, ASSET_MISS);
});

test("enrichAssetSearch: a retry that also finds nothing adds nothing", async () => {
  const out = await enrichAssetSearch(ASSET_MISS, { query: "zzz", type: "Materal" }, stub(ASSET_MISS));
  assert.equal(out, ASSET_MISS);
});
