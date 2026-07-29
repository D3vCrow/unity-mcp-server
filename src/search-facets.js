// AnkleBreaker Unity MCP — miss-triggered search facets (Node seam, zero C# edits).
//
// Problem: `unity_search_by_component` and `unity_search_assets` both take a
// free-text enum the agent has to GUESS — a component type name, an asset type
// name. A wrong guess returns "Component type 'X' not found" or an empty list,
// and the agent's only recovery is to guess again. That burns a round-trip per
// wrong guess and often several in a row.
//
// Fix: when (and only when) a search misses, attach the REAL values with counts.
// The agent then picks from a list instead of guessing. Pattern lifted from the
// speedrun talent network API, which returns live facet counts on every list
// response so callers "discover valid values instead of guessing"
// (knowledge/research/2026-07-28-vet-speedrun-talent-network-developers.md).
//
// Deviation from the source, on purpose: that API computes facets in the same
// query, so always-on costs nothing. Here the values live behind a SEPARATE
// bridge round-trip, so always-on would double the cost of every successful
// search. Firing only on a miss puts the tokens exactly where the guesswork is.
//
// Guarantees:
//   - A hit is never enriched and never delayed.
//   - A facet-lookup failure returns the ORIGINAL result untouched (never throws,
//     never downgrades a working search into an error).
//   - Error envelopes keep their `error` key, so isErrorResult() still flags them.

/** Max facet rows attached to a response. Keeps a miss cheap in tokens. */
export const MAX_FACET_ROWS = 25;

/**
 * Unwrap the queue envelope the bridge sometimes puts around a payload.
 * Returns {payload, rewrap} where rewrap(newPayload) rebuilds the original shape.
 * @param {*} result - raw bridge result.
 */
export function unwrapPayload(result) {
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    result.success === true &&
    result.data &&
    typeof result.data === "object"
  ) {
    return {
      payload: result.data,
      rewrap: (next) => ({ ...result, data: next }),
    };
  }
  return { payload: result, rewrap: (next) => next };
}

/**
 * True when a component search found nothing the agent can use — either the type
 * name did not resolve, or it resolved to zero live instances. Both are recovered
 * the same way: show the types that actually exist.
 * @param {*} payload - unwrapped search/by-component payload.
 */
export function isComponentMiss(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (typeof payload.error === "string" && payload.error.length > 0) return true;
  return payload.totalFound === 0;
}

/**
 * True when an asset search missed AND a type filter was in play. Without a type
 * filter an empty result means "no asset by that name" — a retry adds nothing, so
 * we stay quiet rather than spend a call to say the same thing.
 * @param {*} payload - unwrapped search/assets payload.
 * @param {object} params - the tool params the caller passed.
 */
export function isAssetTypeMiss(payload, params) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (!params || !params.type) return false;
  if (typeof payload.error === "string" && payload.error.length > 0) return true;
  return payload.totalFound === 0;
}

/**
 * Component-type facets from a search/scene-stats payload.
 * Scene-stats already ships `topComponents: [{type, count}]`, so this is a rename
 * into facet shape plus a cap — no new C# route needed.
 * @returns {Array<{type: string, count: number}>}
 */
export function componentFacetsFromSceneStats(stats) {
  const { payload } = unwrapPayload(stats);
  const top = payload && payload.topComponents;
  if (!Array.isArray(top)) return [];
  return top
    .filter((row) => row && typeof row.type === "string")
    .map((row) => ({ type: row.type, count: Number(row.count) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_FACET_ROWS);
}

/**
 * Asset-type facets counted from result rows (each row carries its own `type`).
 * @returns {Array<{type: string, count: number}>}
 */
export function assetFacetsFromResults(searchResult) {
  const { payload } = unwrapPayload(searchResult);
  const rows = payload && payload.results;
  if (!Array.isArray(rows)) return [];
  const counts = new Map();
  for (const row of rows) {
    if (!row || typeof row.type !== "string" || row.type.length === 0) continue;
    counts.set(row.type, (counts.get(row.type) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    .slice(0, MAX_FACET_ROWS);
}

/**
 * Enrich a component search that missed with the component types present in the
 * active scene. Returns the original result unchanged on a hit or on any failure.
 * @param {*} result - raw bridge result from search/by-component.
 * @param {() => Promise<*>} fetchSceneStats - bound bridge.getSceneStats call.
 */
export async function enrichComponentSearch(result, fetchSceneStats) {
  const { payload, rewrap } = unwrapPayload(result);
  if (!isComponentMiss(payload)) return result;

  let facets;
  try {
    facets = componentFacetsFromSceneStats(await fetchSceneStats());
  } catch {
    return result; // Scene stats unreachable — the original answer still stands.
  }
  if (facets.length === 0) return result;

  // Scene-stats caps its own list at the 10 most common types, so this list is
  // "most common", not "all". Say so — a silent cap reads as exhaustive.
  return rewrap({
    ...payload,
    availableComponentTypes: facets,
    hint:
      "No match. availableComponentTypes lists the most common component types " +
      "in the active scene (most-common first, not the full set) — retry with one " +
      "of these names. Types on inactive objects need includeInactive:true.",
  });
}

/**
 * Enrich an asset search that missed with the asset types that DO match the query
 * once the type filter is dropped. Returns the original result unchanged on a hit,
 * when no type filter was used, or on any failure.
 * @param {*} result - raw bridge result from search/assets.
 * @param {object} params - the tool params the caller passed.
 * @param {(p: object) => Promise<*>} retrySearch - bound bridge.searchAssets call.
 */
export async function enrichAssetSearch(result, params, retrySearch) {
  const { payload, rewrap } = unwrapPayload(result);
  if (!isAssetTypeMiss(payload, params)) return result;

  const { type, ...withoutType } = params;
  let retry;
  try {
    retry = await retrySearch({ ...withoutType, maxResults: 200 });
  } catch {
    return result;
  }
  const facets = assetFacetsFromResults(retry);
  if (facets.length === 0) return result;

  const { payload: retryPayload } = unwrapPayload(retry);
  return rewrap({
    ...payload,
    availableAssetTypes: facets,
    matchesWithoutTypeFilter: Number(retryPayload && retryPayload.totalFound) || 0,
    hint:
      `No asset matched type '${type}'. availableAssetTypes lists the types that ` +
      "DO match this query with the type filter dropped — retry with one of these, " +
      "or omit type entirely.",
  });
}
