/**
 * NemoIR Web UI — lossless JSONL serialization and download helpers.
 *
 * Framework-neutral; usable from any React component or plain script.
 * Events are serialized exactly as emitted (no field stripping) so trace
 * exports are reproducible.
 */

import type { WorkflowEvent } from "@nemoir/web-runtime";

/**
 * Serialize an array of `WorkflowEvent` objects to a JSONL string.
 * Each event is one line of minified JSON. Trailing newline is included.
 */
export function eventsToJsonl(events: readonly WorkflowEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/**
 * Trigger a file download in the browser. Creates a temporary object URL
 * that is revoked after the download starts.
 *
 * The caller should handle user-gesture requirements (the download must be
 * triggered by a click or equivalent user action in most browsers).
 */
export function downloadJsonl(
  events: readonly WorkflowEvent[],
  filename: string,
): void {
  const jsonl = eventsToJsonl(events);
  const blob = new Blob([jsonl], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
