// Tests for the connection-mode cache invalidation (statics-reset on peer change).
// Run: node --test src/unity-editor-bridge.test.js   (Node >= 18, zero deps)
//
// Guards the bug where a mid-session plugin upgrade / instance port-swap left the server
// pinned to whatever queue-vs-legacy mode the FIRST plugin negotiated. The reset decision
// is asserted via the function's return value, so no live Unity or network is involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resetConnectionModeIfPeerChanged } from "./unity-editor-bridge.js";
import { setPortOverride, clearPortOverride } from "./instance-discovery.js";

test("resetConnectionModeIfPeerChanged: baseline on first contact, resets on peer change, dedupes", () => {
  clearPortOverride();

  // First contact establishes the baseline (default port) and resets nothing.
  assert.equal(resetConnectionModeIfPeerChanged(), false, "first contact = baseline, no reset");
  // Same peer → no reset (this is what keeps the 404-probe cache useful mid-session).
  assert.equal(resetConnectionModeIfPeerChanged(), false, "unchanged peer = no reset");

  // Port-swap to a different instance → reset the stale mode decision.
  setPortOverride(59991);
  assert.equal(resetConnectionModeIfPeerChanged(), true, "port-swap = reset");
  assert.equal(resetConnectionModeIfPeerChanged(), false, "same override again = no reset");

  // Swap to yet another port → reset again.
  setPortOverride(59992);
  assert.equal(resetConnectionModeIfPeerChanged(), true, "second port-swap = reset");

  // Clearing the override returns to the default port — still a peer change → reset.
  clearPortOverride();
  assert.equal(resetConnectionModeIfPeerChanged(), true, "clearing override changes peer = reset");

  clearPortOverride(); // leave global state clean for any other suite in this process
});
