// AnkleBreaker Unity MCP — shared response payload formatter (WIN N: compact JSON).
//
// Compact JSON by default to save agent tokens (~44% byte reduction measured on
// nested payloads like deep scene hierarchies — the responses that matter most).
// The C# bridge (MiniJson) already serializes compact over HTTP; the Node side
// was re-inflating it with `null, 2` indentation that the model parses identically
// but pays for in tokens. This reverts that one unnecessary re-pretty step.
//
// Set UNITY_MCP_PRETTY_JSON=1 to restore human-readable indentation for debugging.

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
