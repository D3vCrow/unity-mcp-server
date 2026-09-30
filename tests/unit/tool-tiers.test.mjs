// Unit tests for the two-tier tool system. The exact tier counts are pinned on purpose:
// the exposed surface is client-facing compatibility (issue #27 — oversized registries can
// break MCP clients). Adding/moving a tool must consciously update these numbers.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitToolTiers, checkDestructiveConfirm } from "../../src/tool-tiers.js";
import { editorTools } from "../../src/tools/editor-tools.js";
import { umaTools } from "../../src/tools/uma-tools.js";
import { probuilderTools } from "../../src/tools/probuilder-tools.js";

describe("splitToolTiers on the real tool set", () => {
  const split = splitToolTiers([...editorTools, ...umaTools, ...probuilderTools]);

  test("tier counts are pinned (update deliberately when the surface changes)", () => {
    // 43/295, not upstream's 69/269: this fork trims the core tier on purpose
    // (see the CORE_TOOLS header in src/tool-tiers.js). Everything moved out stays
    // reachable through unity_advanced_tool, so the total below is the real invariant.
    assert.equal(split.coreCount, 43, "core tier count");
    assert.equal(split.advancedCount, 295, "advanced tier count");
    assert.equal(
      split.coreCount + split.advancedCount,
      editorTools.length + umaTools.length + probuilderTools.length
    );
  });

  test("meta-tools are generated with strict-enough schemas", () => {
    const names = split.metaTools.map((t) => t.name);
    assert.deepEqual(names, ["unity_list_advanced_tools", "unity_advanced_tool"]);
    for (const tool of split.metaTools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(typeof tool.handler, "function");
    }
    const dispatcher = split.metaTools[1];
    assert.deepEqual(dispatcher.inputSchema.required, ["tool"]);
  });

  test("core tier keeps the daily-driver tools", () => {
    const coreNames = new Set(split.coreTools.map((t) => t.name));
    for (const name of [
      "unity_editor_state", "unity_scene_hierarchy", "unity_gameobject_info",
      "unity_component_set_property", "unity_execute_code", "unity_console_log",
      "unity_play_mode", "unity_search_assets", "unity_undo_last",
    ]) {
      assert.ok(coreNames.has(name), `${name} stays core`);
    }
  });

  // The fork's trim dropped these two from the direct surface (they were core upstream).
  // That is a routing decision, not a capability cut — the trim's whole promise is "no
  // loss of functionality, just fewer tools per handshake", so assert they are still
  // dispatchable through the advanced tier rather than dropping the coverage.
  test("tools trimmed out of core are still reachable via the advanced tier", () => {
    const coreNames = new Set(split.coreTools.map((t) => t.name));
    // The dispatcher's advanced map is exactly "every tool that isn't core", so a name
    // in this set is callable as unity_advanced_tool({ tool: name }).
    const advancedNames = new Set(
      [...editorTools, ...umaTools, ...probuilderTools]
        .map((t) => t.name)
        .filter((n) => !coreNames.has(n))
    );
    for (const name of ["unity_gameobject_create", "unity_get_compilation_errors"]) {
      assert.ok(!coreNames.has(name), `${name} is trimmed out of core`);
      assert.ok(advancedNames.has(name), `${name} stays callable via unity_advanced_tool`);
    }
  });

  test("no tool is lost or duplicated across tiers", () => {
    const all = [...editorTools, ...umaTools, ...probuilderTools];
    const seen = new Set();
    for (const t of all) {
      assert.ok(!seen.has(t.name), `duplicate tool definition: ${t.name}`);
      seen.add(t.name);
    }
    const coreNames = new Set(split.coreTools.map((t) => t.name));
    let advanced = 0;
    for (const t of all) if (!coreNames.has(t.name)) advanced++;
    assert.equal(advanced, split.advancedCount);
  });

  test("every tool definition has the {name, description, inputSchema, handler} contract", () => {
    for (const t of [...editorTools, ...umaTools, ...probuilderTools]) {
      assert.ok(/^unity_[a-z0-9_]+$/.test(t.name), `name convention: ${t.name}`);
      assert.equal(typeof t.description, "string");
      assert.equal(t.inputSchema?.type, "object", `${t.name} schema root`);
      assert.equal(typeof t.handler, "function", `${t.name} handler`);
    }
  });

  // Strict-client schema shaping must hold for ADVANCED tools too, not only the exposed
  // core surface (the protocol test only sees the ~80 exposed tools). A batch of advanced
  // tools once shipped `value: { description }` with no `type`, which a strict validator
  // rejects — this guards the whole 346-tool surface, recursively.
  test("every property of every tool (all tiers) is explicitly type-shaped", () => {
    const isShaped = (s) =>
      s && typeof s === "object" &&
      ("type" in s || "enum" in s || "const" in s || "anyOf" in s || "oneOf" in s || "allOf" in s || "$ref" in s);
    const walk = (toolName, path, schema, out) => {
      if (!isShaped(schema)) { out.push(`${toolName}.${path}`); return; }
      for (const [k, sub] of Object.entries(schema.properties || {})) walk(toolName, `${path}.${k}`, sub, out);
      if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items))
        walk(toolName, `${path}[]`, schema.items, out);
    };
    const violations = [];
    for (const t of [...editorTools, ...umaTools, ...probuilderTools])
      for (const [prop, schema] of Object.entries(t.inputSchema?.properties || {}))
        walk(t.name, prop, schema, violations);
    assert.deepEqual(violations, [], `${violations.length} untyped properties: ${violations.slice(0, 10).join(", ")}`);
  });

  test("all 14 ProBuilder tools land in the advanced tier under the 'probuilder' category", () => {
    const coreNames = new Set(split.coreTools.map((t) => t.name));
    assert.equal(probuilderTools.length, 14, "ProBuilder tool count");
    for (const t of probuilderTools) {
      assert.ok(!coreNames.has(t.name), `${t.name} must be advanced, not core`);
      const category = t.name.replace(/^unity_/, "").split("_")[0];
      assert.equal(category, "probuilder", `${t.name} category`);
    }
  });

  test("ProBuilder tool names derive to the exact plugin routes (lazy-load parity)", () => {
    // Mirrors toolNameToRoute in tool-tiers.js: unity_probuilder_create_shape → probuilder/create-shape.
    const derive = (name) => {
      const parts = name.replace(/^unity_/, "").split("_");
      return `${parts[0]}/${parts.slice(1).join("-")}`;
    };
    const expected = new Set([
      "probuilder/create-shape", "probuilder/info", "probuilder/extrude-faces",
      "probuilder/bevel-edges", "probuilder/subdivide", "probuilder/delete-faces",
      "probuilder/translate-faces", "probuilder/flip-normals", "probuilder/set-face-material",
      "probuilder/boolean", "probuilder/combine", "probuilder/probuilderize",
      "probuilder/center-pivot", "probuilder/export-mesh",
    ]);
    const derived = new Set(probuilderTools.map((t) => derive(t.name)));
    assert.deepEqual(derived, expected, "derived routes must match the plugin's registered routes");
  });
});

describe("splitToolTiers on synthetic input", () => {
  test("unknown names fall into the advanced tier", () => {
    const fake = [
      { name: "unity_editor_state", description: "core-listed", inputSchema: { type: "object" }, handler: async () => "" },
      { name: "unity_experimental_new_thing", description: "not core-listed", inputSchema: { type: "object" }, handler: async () => "" },
    ];
    const split = splitToolTiers(fake);
    assert.equal(split.coreCount, 1);
    assert.equal(split.advancedCount, 1);
    assert.equal(split.coreTools[0].name, "unity_editor_state");
  });
});

describe("checkDestructiveConfirm", () => {
  const tokenOf = (text) => JSON.parse(text).confirm_token;
  const rejected = (text) => JSON.parse(text).error === "confirm_token_rejected";

  test("non-destructive tools pass straight through", () => {
    assert.equal(checkDestructiveConfirm("unity_material_create", { a: 1 }), null);
  });

  test("a token only unlocks the same tool with the same params, key order ignored", () => {
    const t1 = tokenOf(checkDestructiveConfirm("unity_asset_delete", { path: "A", force: true }));
    assert.equal(checkDestructiveConfirm("unity_asset_delete", { force: true, path: "A" }, t1), null);

    const t2 = tokenOf(checkDestructiveConfirm("unity_asset_delete", { path: "A" }));
    assert.ok(rejected(checkDestructiveConfirm("unity_asset_delete", { path: "B" }, t2)), "different params");

    const t3 = tokenOf(checkDestructiveConfirm("unity_asset_delete", { path: "A" }));
    assert.ok(rejected(checkDestructiveConfirm("unity_component_remove", { path: "A" }, t3)), "different tool");
  });

  test("tokens expire after five minutes", () => {
    const t0 = 1_000_000;
    const token = tokenOf(checkDestructiveConfirm("unity_asset_delete", { path: "A" }, undefined, t0));
    assert.ok(rejected(checkDestructiveConfirm("unity_asset_delete", { path: "A" }, token, t0 + 5 * 60 * 1000 + 1)));
  });
});
