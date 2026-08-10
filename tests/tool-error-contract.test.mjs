// Tool-error contract: no raw exception text reaches the agent's context.
//
// Every tool result on this server is text a model reads. A caught JS exception's
// `.message` is written for a developer at a terminal — Node's ENOENT carries the
// absolute path that failed, a fetch failure can carry the request URL and any
// credential in it. So `${error.message}` in a model-facing string leaks the
// machine's username, its directory layout, and potentially a bridge token.
//
// Part 1 unit-tests the redaction seam. Part 2 is a ratchet: it scans src/ and
// fails when a NEW model-facing site interpolates an exception message without
// going through `toolErrorText`.
//
// Pattern borrowed from Felsyn/felhaven's `{"error": "slug: detail"}` convention,
// which caught a real API key leaking into its own logs through a request
// exception's URL. Vet: F:/DevCrow/Dev/knowledge/research/2026-08-10-vet-felhaven.md
//
// KNOWN LIMIT — this scan is weaker than felhaven's original. Theirs parses the
// module's own AST, so it can tell `str(e)` from a literal that merely looks like
// one. Node ships no JS parser in its stdlib and this project deliberately runs
// zero devDependencies, so Part 2 is regex + a one-line lookback + an explicit
// allowlist. A stderr call split across three or more lines can still fool it.
// It catches the common shape and ratchets against new ones; it is not a proof.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import { redactSensitive, toolErrorText, isErrorResult } from "../src/response-format.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HOME = os.homedir();

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    pass++;
  } catch {
    failures.push(`FAIL: ${label}\n    expected: ${expected}\n    got:      ${actual}`);
  }
}

function checkThat(label, cond) {
  if (cond) pass++;
  else failures.push(`FAIL: ${label}`);
}

// ─── Part 1: the redaction seam ───

check(
  "home dir is replaced",
  redactSensitive(`ENOENT: no such file, open '${HOME}\\Projects\\a.unity'`),
  "ENOENT: no such file, open '<home>\\Projects\\a.unity'"
);

check(
  "home dir with forward slashes is replaced",
  redactSensitive(`open '${HOME.replace(/\\/g, "/")}/Projects/a.unity'`),
  "open '<home>/Projects/a.unity'"
);

check(
  "another user's profile dir is replaced",
  redactSensitive("open 'C:\\Users\\SomeoneElse\\secret.txt'"),
  "open 'C:\\Users\\<user>\\secret.txt'"
);

check(
  "posix home of another user is replaced",
  redactSensitive("open '/home/someoneelse/.ssh/id_rsa'"),
  "open '/<user>/.ssh/id_rsa'"
);

check(
  "token in a query string is redacted",
  redactSensitive("fetch failed: http://127.0.0.1:7890/api/x?token=s3cr3tvalue&a=1"),
  "fetch failed: http://127.0.0.1:7890/api/x?token=<redacted>&a=1"
);

check(
  "bearer header is redacted",
  redactSensitive("401 Unauthorized (Authorization: Bearer abc.def-ghi_jkl)"),
  "401 Unauthorized (Authorization: Bearer <redacted>)"
);

check(
  "long opaque blob is redacted",
  redactSensitive("unexpected id 0123456789abcdef0123456789abcdef01234567"),
  "unexpected id <redacted>"
);

// Under-redaction guard: the agent still needs to read useful detail.
check(
  "project-relative asset path survives",
  redactSensitive("Could not load Assets/Prefabs/Player.prefab"),
  "Could not load Assets/Prefabs/Player.prefab"
);
check(
  "loopback bridge url survives when it carries no credential",
  redactSensitive("connect ECONNREFUSED http://127.0.0.1:7890/api/ping"),
  "connect ECONNREFUSED http://127.0.0.1:7890/api/ping"
);
check(
  "a 32-hex unity GUID survives (only 33+ is treated as a token)",
  redactSensitive("guid 0123456789abcdef0123456789abcdef missing"),
  "guid 0123456789abcdef0123456789abcdef missing"
);

// ─── Part 2 of the seam: toolErrorText shape ───

check(
  "toolErrorText builds the slug shape and redacts",
  toolErrorText("tool-exec-failed", new Error(`open '${HOME}\\a.txt'`)),
  "Error: tool-exec-failed: open '<home>\\a.txt'"
);
check(
  "toolErrorText appends an already-safe suffix",
  toolErrorText("lazy-route-failed", new Error("boom"), " Did you mean x?"),
  "Error: lazy-route-failed: boom Did you mean x?"
);
check(
  "toolErrorText handles a non-Error value",
  toolErrorText("weird", "just a string"),
  "Error: weird: just a string"
);
check(
  "toolErrorText handles an empty message",
  toolErrorText("empty", new Error("")),
  "Error: empty: no detail"
);

// Compatibility: the `Error` prefix must survive so isErrorResult still flags it
// via the prose-string convention (src/response-format.js).
checkThat(
  "toolErrorText output is still detected by isErrorResult",
  isErrorResult(toolErrorText("tool-exec-failed", new Error("boom"))) === true
);

// ─── Part 3: the ratchet — no new unrouted model-facing error sites ───
//
// Allowlist = sites that write to stderr or throw internally, and therefore never
// reach the agent's context. Each entry is file + the exact matched fragment.
// Adding to this list is a deliberate act; the reviewer should confirm the site is
// genuinely not model-facing.
const ALLOWLIST = [
  ["index.js", "[MCP] Instance discovery failed"],
  ["instance-discovery.js", "[MCP Discovery] Error reading registry"],
  ["unity-editor-bridge.js", "[MCP Bridge] Unexpected error in queue mode"],
  ["state-persistence.js", "persistState"],
  ["unity-hub.js", "error.message || String(error)"],
  ["unity-hub.js", 'e.message.includes("ENOENT")'],
  ["unity-editor-bridge.js", 'const msg = error.message || ""'],
];

const INTERPOLATES_MESSAGE = /\$\{\s*(?:[A-Za-z_$][\w$]*\.)?(?:err|error|e)\.message\s*\}|\$\{\s*String\(\s*(?:err|error|e)\s*\)\s*\}/;
const STDERR_CALL = /console\.(error|warn|log)\s*\(|debugLog\s*\(/;

const offenders = [];
for (const file of readdirSync(SRC).filter((f) => f.endsWith(".js"))) {
  const lines = readFileSync(join(SRC, file), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!INTERPOLATES_MESSAGE.test(line)) return;
    // Comments can't leak. A line-comment or a block-comment body is skipped —
    // this file's own header quotes the dangerous pattern to explain it.
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (STDERR_CALL.test(line)) return; // same-line stderr call
    // One-line lookback: `console.error(` on the previous line, template below.
    const prev = i > 0 ? lines[i - 1] : "";
    if (STDERR_CALL.test(prev) && /\($/.test(prev.trim())) return;
    if (ALLOWLIST.some(([f, frag]) => f === file && (line.includes(frag) || prev.includes(frag)))) return;
    offenders.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (offenders.length === 0) {
  pass++;
} else {
  failures.push(
    "FAIL: model-facing error sites bypass toolErrorText — route them through it,\n" +
      "      or add to ALLOWLIST if the site is genuinely stderr-only:\n" +
      offenders.map((o) => `        ${o}`).join("\n")
  );
}

for (const f of failures) console.error(f);
console.log(`tool-error-contract: ${pass}/${pass + failures.length} passed`);
process.exit(failures.length === 0 ? 0 : 1);
