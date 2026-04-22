// AnkleBreaker Unity MCP — Two-tier tool system
// Reduces the exposed tool count to avoid overwhelming MCP clients.
//
// Core tools: Always exposed as individual MCP tools (~60 tools)
// Advanced tools: Accessed via unity_advanced_tool (200+ tools)
//
// Why: MCP clients like Claude Cowork silently fail when a server
// exposes too many tools (our 268 tools / 125KB response was ~5x
// larger than working servers). This keeps us under the safe limit.
//
// Lazy loading: Advanced tools support dynamic dispatch. If a tool
// isn't in the cached map, the route is derived from the tool name
// (unity_terrain_list → terrain/list) and called directly via sendCommand.
// This means new tools added to the C# plugin work immediately without
// restarting the MCP server.

import { sendCommand } from "./unity-editor-bridge.js";

/**
 * Explicit route overrides for tools whose API endpoints
 * don't follow the standard name → route derivation pattern.
 * E.g. unity_mppm_* tools use "scenario/*" endpoints on the C# side.
 */
const ROUTE_OVERRIDES = {
  unity_mppm_list_scenarios: "scenario/list",
  unity_mppm_status: "scenario/status",
  unity_mppm_activate_scenario: "scenario/activate",
  unity_mppm_start: "scenario/start",
  unity_mppm_stop: "scenario/stop",
  unity_mppm_info: "scenario/info",
};

/**
 * Derive an HTTP route from a tool name.
 * unity_terrain_raise_lower → terrain/raise-lower
 * unity_animation_create_clip → animation/create-clip
 */
function toolNameToRoute(toolName) {
  // Check explicit overrides first (for tools whose API routes don't match their name)
  if (ROUTE_OVERRIDES[toolName]) return ROUTE_OVERRIDES[toolName];

  // Remove unity_ prefix
  const withoutPrefix = toolName.replace(/^unity_/, "");
  // Split into parts: first part is category, rest is action
  const parts = withoutPrefix.split("_");
  if (parts.length < 2) return null;
  const category = parts[0];
  const action = parts.slice(1).join("-");
  return `${category}/${action}`;
}

// ─── Core tool names (always exposed individually) ───
// Personal trim: 17 tools covering ~91% of a 15-session / 944-call audit
// (Thrion Arena Multiplayer Update, 2026-03 → 2026-04).
// All other tools remain reachable via unity_advanced_tool (with lazy route fallback).
const CORE_TOOLS = new Set([
  // Connection & state
  "unity_editor_ping",
  "unity_editor_state",

  // Scene
  "unity_scene_info",
  "unity_scene_hierarchy",
  "unity_scene_save",

  // GameObject
  "unity_gameobject_info",

  // Components
  "unity_component_add",
  "unity_component_set_property",
  "unity_component_get_properties",
  "unity_component_set_reference",

  // Code execution & console
  "unity_execute_code",
  "unity_console_log",

  // Play & editor actions
  "unity_play_mode",
  "unity_execute_menu_item",

  // Search
  "unity_search_by_name",
  "unity_search_by_component",
  "unity_search_assets",
]);

/**
 * Split a flat tool array into { core, advanced }.
 * Also generates the meta-tools for accessing advanced tools.
 */
export function splitToolTiers(allEditorTools) {
  const core = [];
  const advanced = [];

  for (const tool of allEditorTools) {
    if (CORE_TOOLS.has(tool.name)) {
      core.push(tool);
    } else {
      advanced.push(tool);
    }
  }

  // Build an index of advanced tools for the catalog
  const advancedIndex = advanced.map((t) => ({
    name: t.name,
    description: t.description,
  }));

  // Group advanced tools by category for the catalog
  const categories = {};
  for (const t of advanced) {
    // Extract category from tool name: unity_animation_create_clip → animation
    const parts = t.name.replace(/^unity_/, "").split("_");
    const cat = parts[0];
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(t.name);
  }

  // Build the handler map for quick lookup
  const advancedMap = new Map();
  for (const t of advanced) {
    advancedMap.set(t.name, t);
  }

  // ─── Meta-tools ───

  const catalogTool = {
    name: "unity_list_advanced_tools",
    description:
      "List all available advanced/specialized Unity tools organized by category. " +
      "These tools are not directly exposed but can be called via unity_advanced_tool. " +
      "Categories include: uma, animation, prefab, physics, lighting, audio, shadergraph, " +
      "amplify, terrain, particle, navmesh, ui, texture, profiler, memory, settings, " +
      "input, asmdef, scriptableobject, constraint, lod, editorprefs, playerprefs, " +
      "vfx, graphics, sceneview, and more.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            'Filter by category name (e.g. "animation", "prefab", "shadergraph"). Omit for full list.',
        },
      },
    },
    handler: async ({ category } = {}) => {
      // Try to fetch dynamic routes from Unity plugin for lazy discovery
      let dynamicRoutes = null;
      try {
        dynamicRoutes = await sendCommand("_meta/routes", {});
      } catch (_) {
        // Plugin might not support _meta/routes yet, use cached list only
      }

      // Merge dynamic routes into the advanced tool list
      // Dynamic routes that aren't in our cached map get listed as lazy-loadable tools
      let mergedCategories = { ...categories };
      let dynamicCount = 0;

      if (dynamicRoutes && dynamicRoutes.routes) {
        for (const route of dynamicRoutes.routes) {
          // Convert route to tool name: terrain/list → unity_terrain_list
          const toolName = "unity_" + route.replace(/\//g, "_").replace(/-/g, "_");
          const cat = route.split("/")[0];

          // Skip if already in our cached map
          if (advancedMap.has(toolName) || CORE_TOOLS.has(toolName)) continue;

          // Add to merged categories
          if (!mergedCategories[cat]) mergedCategories[cat] = [];
          if (!mergedCategories[cat].includes(toolName)) {
            mergedCategories[cat].push(toolName);
            dynamicCount++;
          }
        }
      }

      if (category) {
        const cat = category.toLowerCase();

        // Check cached tools first
        const matching = advanced.filter((t) => {
          const toolCat = t.name.replace(/^unity_/, "").split("_")[0];
          return toolCat === cat;
        });

        // Also include dynamic-only tools for this category
        const dynamicTools = (mergedCategories[cat] || [])
          .filter((name) => !advancedMap.has(name))
          .map((name) => ({ name, description: `(lazy-loaded from Unity plugin)` }));

        const all = [
          ...matching.map((t) => ({ name: t.name, description: t.description })),
          ...dynamicTools,
        ];

        if (all.length === 0) {
          return `No advanced tools found for category "${category}". Available categories: ${Object.keys(mergedCategories).join(", ")}`;
        }
        return JSON.stringify(all, null, 2);
      }

      // Full catalog grouped by category
      const result = {};
      for (const [cat, names] of Object.entries(mergedCategories)) {
        result[cat] = names;
      }
      return JSON.stringify(
        {
          totalAdvancedTools: advanced.length + dynamicCount,
          dynamicTools: dynamicCount,
          categories: result,
        },
        null,
        2
      );
    },
  };

  const advancedTool = {
    name: "unity_advanced_tool",
    description:
      "Execute an advanced/specialized Unity tool by name. Use unity_list_advanced_tools " +
      "to discover available tools and their parameters. This provides access to 200+ " +
      "specialized tools for animation, prefabs, physics, shaders, terrain, particles, " +
      "UI, profiling, and more.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description:
            'The tool name to execute (e.g. "unity_animation_create_controller", "unity_shadergraph_create")',
        },
        params: {
          type: "object",
          description:
            "Parameters to pass to the tool. Use unity_list_advanced_tools to see required parameters.",
          additionalProperties: true,
        },
      },
      required: ["tool"],
    },
    handler: async ({ tool, params } = {}) => {
      if (!tool) {
        return "Error: 'tool' parameter is required. Use unity_list_advanced_tools to see available tools.";
      }

      const targetTool = advancedMap.get(tool);
      if (targetTool) {
        return await targetTool.handler(params || {});
      }

      // ─── Lazy loading fallback ───
      // Tool not in cached map — derive the route from the name and call Unity directly.
      // This allows new tools added to the C# plugin to work without restarting the MCP server.
      const route = toolNameToRoute(tool);
      if (route) {
        try {
          // Log to stderr, not stdout — stdout carries the MCP JSON-RPC transport.
          console.error(`[MCP] Lazy-loading tool "${tool}" via route "${route}"`);
          const result = await sendCommand(route, params || {});
          return JSON.stringify(result, null, 2);
        } catch (err) {
          return `Error executing "${tool}" (lazy route: ${route}): ${err.message}`;
        }
      }

      return `Error: Unknown tool "${tool}". Use unity_list_advanced_tools to see available tools.`;
    },
  };

  return {
    coreTools: core,
    metaTools: [catalogTool, advancedTool],
    advancedCount: advanced.length,
    coreCount: core.length,
  };
}
