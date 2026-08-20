// AnkleBreaker Unity MCP — shared response payload formatter (WIN N: compact JSON).
//
// Compact JSON by default to save agent tokens (~44% byte reduction measured on
// nested payloads like deep scene hierarchies — the responses that matter most).
// The C# bridge (MiniJson) already serializes compact over HTTP; the Node side
// was re-inflating it with `null, 2` indentation that the model parses identically
// but pays for in tokens. This reverts that one unnecessary re-pretty step.
//
// Set UNITY_MCP_PRETTY_JSON=1 to restore human-readable indentation for debugging.
// AnkleBreaker Unity MCP — Shared response formatting
//
// formatResult(): single choke point for serializing tool results. Compact JSON by
// default — the C# plugin already sends compact JSON over HTTP; re-indenting it on the
// Node side only inflated every structured response by 20-50% in tokens. Set
// UNITY_MCP_PRETTY_JSON=1 to restore 2-space indentation for human debugging.
//
// isErrorText()/looksLikeErrorObject(): the Unity bridge returns HTTP 200 for logical
// failures, and handlers surface several error shapes ({error}, {success:false},
// {ok:false}, queue-wrapped {success:true, data:{error}}) — none of which set the MCP
// isError flag on their own. index.js uses these helpers at the CallTool seam so MCP
// clients stop reading logical failures as successes.
// (Idea credit: community PR #31 by D3vCrow, re-implemented on current main.)

const PRETTY = process.env.UNITY_MCP_PRETTY_JSON === "1";

/**
 * Serialize a tool result for the MCP text channel.
 * Compact by default; indented only when UNITY_MCP_PRETTY_JSON=1.
 * @param {*} value - the object/array/value to serialize.
 * @returns {string} JSON string.
 */
export function formatResult(value) {
  return PRETTY ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

// ─── Error-flag detection (WIN A keystone) ───
// The Unity bridge returns HTTP 200 for LOGICAL failures, and tool handlers
// return one of several error shapes — a `{error: "..."}` object (legacy), a
// `{success:false}` object, a queue-wrapped `{success:true, data:{error:...}}`,
// or (with the MCPResponse factory) a `{ok:false, error:{code,message,hint}}`
// envelope. None set the MCP `isError` flag by themselves, so a client reads a
// logical failure as success and the agent can't branch on it. These helpers let
// the Node seam set isError for every existing error shape with ZERO C# edits.

/**
 * True when a parsed object looks like a logical-error envelope.
 * A self-declared success (ok:true / success:true) is never treated as an error
 * even if it carries an `error` key (JsonUtility serializes null strings as "").
 */
export function looksLikeErrorObject(obj) {
  // Array guard taken from origin/main's rewrite: isErrorResult() screens arrays
  // before calling here, but isErrorText() (also from origin/main) does not, so the
  // guard belongs in the predicate itself.
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const claimsSuccess = obj.ok === true || obj.success === true;
  if (obj.ok === false) return true; // MCPResponse factory envelope
  if (obj.success === false) return true; // legacy success flag
  if (obj.error && !claimsSuccess) return true; // legacy {error: msg}
  if (obj.data && typeof obj.data === "object" && obj.data.error) return true; // queue-wrapped
  return false;
}

/**
 * True when a tool result (string, object, or content-block array) represents a
 * logical error and the MCP response should carry isError:true.
 */
export function isErrorResult(result) {
  // Content-block arrays (images, screenshots) are always non-error payloads.
  if (Array.isArray(result)) return false;
  if (typeof result === "string") {
    const s = result.trimStart();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return looksLikeErrorObject(JSON.parse(s));
      } catch {
        // Not JSON — fall through to the prose check.
      }
    }
    // Plain-string error convention used by the meta-tools (tool-tiers.js).
    return /^error\b/i.test(s);
  }
  return looksLikeErrorObject(result);
}

// ─── Model-facing error text: redact before it reaches the agent ───
// A caught JS exception's `.message` is written for a developer reading a
// terminal, not for a channel that ends up inside a model's context window.
// Node's own errors routinely carry the absolute path that failed — an ENOENT
// reads `no such file or directory, open 'C:\Users\<name>\...'` — and a fetch
// failure can carry the full request URL including any query credentials. Every
// tool result on this server is text the agent reads, so an unfiltered
// `${error.message}` puts the machine's username, its directory layout, and any
// token that rode in a URL into that context.
//
// The fix is one seam, not a rule people have to remember: build every
// model-facing error through `toolErrorText`, which forces a stable slug and
// redacts the detail. `tests/tool-error-contract.test.mjs` fails the build when
// a new unrouted site appears.
//
// Borrowed from Felsyn/felhaven's `{"error": "slug: detail"}` convention
// (CONVENTIONS.md §2), which caught a real API key leaking into its own logs
// through a request exception's URL. See
// F:/DevCrow/Dev/knowledge/research/2026-08-10-vet-felhaven.md.

import os from "node:os";

const HOME = os.homedir();

/**
 * Strip machine- and credential-identifying substrings from free text.
 * Deliberately narrow: a Unity-relative path like `Assets/Foo.prefab` is useful
 * to the agent and is left alone. Only the home prefix of an absolute path, and
 * things that look like credentials, are replaced.
 * @param {string} text
 * @returns {string}
 */
export function redactSensitive(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;

  // 1. This machine's home directory, in either slash style, case-insensitive
  //    (Windows paths compare case-insensitively and arrive both ways).
  if (HOME) {
    const variants = [HOME, HOME.replace(/\\/g, "/"), HOME.replace(/\//g, "\\")];
    for (const v of new Set(variants)) {
      if (!v) continue;
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(escaped, "gi"), "<home>");
    }
  }

  // 2. Any other user's profile dir, so an error forwarded from elsewhere is
  //    scrubbed too.
  out = out.replace(/([A-Za-z]:)([\\/])Users\2[^\\/\s"']+/gi, "$1$2Users$2<user>");
  out = out.replace(/\/(?:home|Users)\/[^/\s"']+/g, "/<user>");

  // 3. Credentials carried in a URL query string or an auth header.
  out = out.replace(
    /\b(token|key|secret|password|passwd|auth|api[-_]?key|access[-_]?token)\b(\s*[=:]\s*)("?)[^\s&"'`,)]+/gi,
    "$1$2$3<redacted>"
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>");

  // 4. Long opaque blobs — a bare token with no `key=` label in front of it.
  //    32 is above any Unity GUID-in-prose we want to keep readable (those are
  //    exactly 32 hex, so require 33+ to avoid eating them).
  out = out.replace(/\b[A-Fa-f0-9]{33,}\b/g, "<redacted>");
  out = out.replace(/\b[A-Za-z0-9_-]{40,}={0,2}\b/g, "<redacted>");

  return out;
}

/**
 * The ONE approved way to build a model-facing error string.
 * Shape: `Error: <slug>: <redacted detail>` — the `Error` prefix is required so
 * `isErrorResult` still flags it via the prose-string convention above, and the
 * slug stays stable so an agent can branch on the failure class rather than
 * pattern-matching an exception's wording.
 * @param {string} slug - stable, lowercase-hyphen failure class, e.g. "tool-exec-failed".
 * @param {unknown} err - the caught error (or any detail value).
 * @param {string} [suffix] - already-safe text to append, e.g. a did-you-mean hint.
 * @returns {string}
 */
export function toolErrorText(slug, err, suffix = "") {
  const raw =
    err && typeof err === "object" && "message" in err
      ? String(err.message)
      : String(err ?? "");
  const detail = redactSensitive(raw) || "no detail";
  return `Error: ${slug}: ${detail}${suffix}`;
}

/**
 * Strip per-property prose from a JSON schema while keeping its full STRUCTURE
 * (types, required, enums survive — strict clients still validate). Used by the
 * compact tools/list mode and the advanced-tool catalog's lean views.
 * @param {object} schema
 * @returns {object}
 */
export function stripSchemaDescriptions(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description") continue;
    if (key === "properties" && value && typeof value === "object") {
      const props = {};
      for (const [prop, sub] of Object.entries(value)) props[prop] = stripSchemaDescriptions(sub);
      out[key] = props;
    } else if (key === "items") {
      out[key] = stripSchemaDescriptions(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * First sentence of a description (abbreviation-safe, capped at 160 chars).
 * The token-diet summary used wherever a full description would be waste.
 * @param {string} text
 * @returns {string}
 */
export function firstSentence(text) {
  if (!text) return text;
  // Find the first sentence-ending ". " that isn't part of "e.g." / "i.e." — otherwise
  // descriptions get cut mid-abbreviation ("... in one call (e.g.").
  let from = 0;
  let cut = -1;
  while (true) {
    const idx = text.indexOf(". ", from);
    if (idx < 0) break;
    const before = text.slice(Math.max(0, idx - 3), idx).toLowerCase();
    if (before.endsWith("e.g") || before.endsWith("i.e")) {
      from = idx + 2;
      continue;
    }
    cut = idx;
    break;
  }
  const sentence = cut > 0 ? text.slice(0, cut + 1) : text;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/**
 * Does a tool's text output represent a logical failure?
 * Handles both JSON payloads (top level or bridge-enveloped) and plain-text
 * "Error ..." strings emitted by a few handlers.
 * @param {string} text
 * @returns {boolean}
 */
export function isErrorText(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  const first = text[0];
  if (first === "{" || first === "[") {
    try {
      const parsed = JSON.parse(text);
      if (looksLikeErrorObject(parsed)) return true;
      // Bridge envelope: HTTP 200 always sets outer success:true, so the real signal
      // is the inner data payload. An explicit inner success:true still wins (handled
      // inside looksLikeErrorObject).
      if (parsed && typeof parsed === "object" && looksLikeErrorObject(parsed.data)) return true;
      return false;
    } catch {
      // Fall through to the plain-text check.
    }
  }
  return /^Error[:\s]/.test(text);
}
