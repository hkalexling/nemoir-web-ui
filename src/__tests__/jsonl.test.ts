/**
 * JSONL serialization and download helper tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { eventsToJsonl, downloadJsonl } from "../jsonl.js";
import type { WorkflowEvent } from "@nemoir/web-runtime";

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    kind: "run_started",
    runId: "r1",
    sequence: 1,
    timestamp: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("eventsToJsonl", () => {
  it("serializes an empty array to an empty string", () => {
    expect(eventsToJsonl([])).toBe("\n");
  });

  it("serializes one event to one line of JSON with trailing newline", () => {
    const e = makeEvent();
    const result = eventsToJsonl([e]);
    expect(result).toBe(JSON.stringify(e) + "\n");
  });

  it("serializes multiple events to multiple lines", () => {
    const e1 = makeEvent({ kind: "run_started", sequence: 1 });
    const e2 = makeEvent({ kind: "stage_started", sequence: 2, stageId: "s1" });
    const result = eventsToJsonl([e1, e2]);
    const lines = result.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).kind).toBe("run_started");
    expect(JSON.parse(lines[1]).kind).toBe("stage_started");
  });

  it("preserves all fields including nulls", () => {
    const e = makeEvent({
      kind: "model_delta",
      sequence: 5,
      stageId: "s1",
      text: null,
      channel: null,
      error: null,
    });
    const result = eventsToJsonl([e]);
    const parsed = JSON.parse(result.trim());
    expect(parsed.text).toBeNull();
    expect(parsed.channel).toBeNull();
    expect(parsed.stageId).toBe("s1");
  });

  it("produces minified JSON (no pretty-print)", () => {
    const e = makeEvent({
      kind: "run_completed",
      result: { output: { key: "value" } },
    });
    const result = eventsToJsonl([e]);
    // Should be one line (no newlines inside the event).
    expect(result.split("\n").length).toBe(2); // event + trailing newline
    expect(result).not.toContain("  "); // no indentation
  });
});

describe("downloadJsonl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a Blob and triggers a download click", () => {
    const createObjectURL = vi
      .fn()
      .mockReturnValue("blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL,
    });

    const clickSpy = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === "a") {
        vi.spyOn(el, "click").mockImplementation(clickSpy);
      }
      return el;
    });

    const events = [
      makeEvent({ kind: "run_started", sequence: 1 }),
      makeEvent({ kind: "run_completed", sequence: 2 }),
    ];
    downloadJsonl(events, "trace.jsonl");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob: Blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("application/x-ndjson");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});
