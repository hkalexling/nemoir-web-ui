/**
 * `useWorkflowRun` hook tests.
 *
 * Verifies:
 * - Basic event streaming lifecycle
 * - Coalescing of consecutive model_delta events
 * - Result capture from run_completed
 * - Error capture from run_failed
 * - Cancellation via AbortController
 * - Stale async update prevention
 * - Reset on new start()
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorkflowRun, coalesceTimeline } from "../useWorkflowRun.js";
import type { WorkflowRunner, CoalescedTimelineItem } from "../useWorkflowRun.js";
import type { WorkflowEvent } from "@nemoir/web-runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    kind: "run_started",
    runId: "r1",
    sequence: 1,
    timestamp: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Helper: create a runner that yields scripted events, with optional delay. */
function scriptedRunner(
  events: WorkflowEvent[],
  opts?: { delayMs?: number },
): WorkflowRunner {
  return async function* (_input, signal) {
    for (const e of events) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (opts?.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      yield e;
    }
  };
}

// ---------------------------------------------------------------------------
// coalesceTimeline (pure function)
// ---------------------------------------------------------------------------

describe("coalesceTimeline", () => {
  it("returns empty array for empty input", () => {
    expect(coalesceTimeline([])).toEqual([]);
  });

  it("preserves non-delta events individually", () => {
    const events: WorkflowEvent[] = [
      makeEvent({ kind: "run_started", sequence: 1 }),
      makeEvent({ kind: "stage_started", sequence: 2, stageId: "s1" }),
      makeEvent({ kind: "run_completed", sequence: 3 }),
    ];
    const result = coalesceTimeline(events);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: "event", seq: 1, event: events[0] });
    expect(result[1]).toEqual({ kind: "event", seq: 2, event: events[1] });
    expect(result[2]).toEqual({ kind: "event", seq: 3, event: events[2] });
  });

  it("coalesces consecutive model_delta with same stage and channel", () => {
    const events: WorkflowEvent[] = [
      makeEvent({ kind: "model_delta", sequence: 1, stageId: "s1", channel: "assistant", text: "Hello" }),
      makeEvent({ kind: "model_delta", sequence: 2, stageId: "s1", channel: "assistant", text: " world" }),
      makeEvent({ kind: "model_delta", sequence: 3, stageId: "s1", channel: "assistant", text: "!" }),
    ];
    const result = coalesceTimeline(events);
    expect(result).toHaveLength(1);
    const item = result[0] as CoalescedTimelineItem & { kind: "delta_run" };
    expect(item.kind).toBe("delta_run");
    expect(item.firstSeq).toBe(1);
    expect(item.lastSeq).toBe(3);
    expect(item.text).toBe("Hello world!");
    expect(item.stageId).toBe("s1");
    expect(item.channel).toBe("assistant");
  });

  it("splits delta runs on stage change", () => {
    const events: WorkflowEvent[] = [
      makeEvent({ kind: "model_delta", sequence: 1, stageId: "s1", text: "a" }),
      makeEvent({ kind: "model_delta", sequence: 2, stageId: "s2", text: "b" }),
      makeEvent({ kind: "model_delta", sequence: 3, stageId: "s1", text: "c" }),
    ];
    const result = coalesceTimeline(events);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ kind: "delta_run", firstSeq: 1, lastSeq: 1, text: "a" });
    expect(result[1]).toMatchObject({ kind: "delta_run", firstSeq: 2, lastSeq: 2, text: "b" });
    expect(result[2]).toMatchObject({ kind: "delta_run", firstSeq: 3, lastSeq: 3, text: "c" });
  });

  it("splits delta runs on channel change", () => {
    const events: WorkflowEvent[] = [
      makeEvent({ kind: "model_delta", sequence: 1, channel: "assistant", text: "a" }),
      makeEvent({ kind: "model_delta", sequence: 2, channel: "reasoning", text: "b" }),
      makeEvent({ kind: "model_delta", sequence: 3, channel: "assistant", text: "c" }),
    ];
    const result = coalesceTimeline(events);
    expect(result).toHaveLength(3);
  });

  it("interleaves delta runs and non-delta events", () => {
    const events: WorkflowEvent[] = [
      makeEvent({ kind: "run_started", sequence: 1 }),
      makeEvent({ kind: "model_delta", sequence: 2, stageId: "s1", text: "a" }),
      makeEvent({ kind: "model_delta", sequence: 3, stageId: "s1", text: "b" }),
      makeEvent({ kind: "stage_completed", sequence: 4, stageId: "s1" }),
      makeEvent({ kind: "model_delta", sequence: 5, stageId: "s2", text: "c" }),
    ];
    const result = coalesceTimeline(events);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ kind: "event", seq: 1, event: events[0] });
    expect(result[1]).toMatchObject({ kind: "delta_run", firstSeq: 2, lastSeq: 3, text: "ab" });
    expect(result[2]).toEqual({ kind: "event", seq: 4, event: events[3] });
    expect(result[3]).toMatchObject({ kind: "delta_run", firstSeq: 5, lastSeq: 5, text: "c" });
  });
});

// ---------------------------------------------------------------------------
// useWorkflowRun hook
// ---------------------------------------------------------------------------

describe("useWorkflowRun", () => {
  it("starts with idle state", () => {
    const runner = scriptedRunner([]);
    const { result } = renderHook(() => useWorkflowRun(runner));
    expect(result.current.running).toBe(false);
    expect(result.current.events).toEqual([]);
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.timeline).toEqual([]);
  });

  it("streams events and updates state", async () => {
    const events: WorkflowEvent[] = [
      makeEvent({ kind: "run_started", sequence: 1 }),
      makeEvent({ kind: "stage_started", sequence: 2, stageId: "s1" }),
      makeEvent({ kind: "stage_completed", sequence: 3, stageId: "s1" }),
      makeEvent({ kind: "run_completed", sequence: 4, result: { output: { score: 42 } } }),
    ];
    const runner = scriptedRunner(events);
    const { result } = renderHook(() => useWorkflowRun(runner));

    await act(async () => {
      result.current.start({ task: "test" });
    });

    // After all events have streamed synchronously:
    expect(result.current.running).toBe(false);
    expect(result.current.events).toHaveLength(4);
    expect(result.current.result).toEqual({ score: 42 });
    expect(result.current.error).toBeNull();
  });

  it("captures error from run_failed", async () => {
    const events: WorkflowEvent[] = [
      makeEvent({ kind: "run_started", sequence: 1 }),
      makeEvent({ kind: "run_failed", sequence: 2, error: "something went wrong" }),
    ];
    const runner = scriptedRunner(events);
    const { result } = renderHook(() => useWorkflowRun(runner));

    await act(async () => {
      result.current.start({});
    });

    expect(result.current.running).toBe(false);
    expect(result.current.error).toBe("something went wrong");
    expect(result.current.result).toBeNull();
  });

  it("captures error from thrown exception", async () => {
    const runner: WorkflowRunner = async function* () {
      yield makeEvent({ kind: "run_started", sequence: 1 });
      throw new Error("boom");
    };
    const { result } = renderHook(() => useWorkflowRun(runner));

    await act(async () => {
      result.current.start({});
    });

    expect(result.current.error).toBe("boom");
    expect(result.current.running).toBe(false);
  });

  it("does not set error on AbortError (cancellation)", async () => {
    // A runner that throws AbortError
    const runner: WorkflowRunner = async function* (_input, signal) {
      yield makeEvent({ kind: "run_started", sequence: 1 });
      // Simulate the abort happening externally
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    };
    const { result } = renderHook(() => useWorkflowRun(runner));

    act(() => {
      result.current.start({});
    });

    // Wait a tick for the async runner to start, then cancel.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
      result.current.cancel();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.running).toBe(false);
  });

  it("resets state on new start()", async () => {
    const events1: WorkflowEvent[] = [
      makeEvent({ kind: "run_started", sequence: 1 }),
      makeEvent({ kind: "run_completed", sequence: 2, result: { output: { a: 1 } } }),
    ];
    const events2: WorkflowEvent[] = [
      makeEvent({ kind: "run_started", sequence: 3 }),
      makeEvent({ kind: "run_completed", sequence: 4, result: { output: { b: 2 } } }),
    ];

    let events = events1;
    const runner: WorkflowRunner = async function* (_input, signal) {
      for (const e of events) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        yield e;
      }
    };

    const { result } = renderHook(() => useWorkflowRun(runner));

    // First run.
    await act(async () => {
      result.current.start({});
    });
    expect(result.current.result).toEqual({ a: 1 });
    expect(result.current.events).toHaveLength(2);

    // Second run.
    events = events2;
    await act(async () => {
      result.current.start({});
    });
    expect(result.current.result).toEqual({ b: 2 });
    expect(result.current.events).toHaveLength(2);
  });

  it("prevents stale async updates when a new run starts mid-stream", async () => {
    // The first runner is slow; the second starts before the first finishes.
    let resolveFirst: (() => void) | null = null;
    const runner1: WorkflowRunner = async function* (_input, signal) {
      yield makeEvent({ kind: "run_started", sequence: 1, runId: "old" });
      // Pause until we allow it.
      await new Promise<void>((r) => {
        resolveFirst = r;
      });
      if (signal.aborted) return;
      yield makeEvent({ kind: "run_completed", sequence: 2, runId: "old", result: { output: { old: true } } });
    };

    const runner2: WorkflowRunner = async function* (_input, _signal) {
      yield makeEvent({ kind: "run_started", sequence: 1, runId: "new" });
      yield makeEvent({ kind: "run_completed", sequence: 2, runId: "new", result: { output: { new: true } } });
    };

    let currentRunner = runner1;
    const runner: WorkflowRunner = (input, signal) => currentRunner(input, signal);

    const { result } = renderHook(() => useWorkflowRun(runner));

    // Start the first (slow) run.
    act(() => {
      result.current.start({});
    });
    expect(result.current.running).toBe(true);

    // Start the second run before the first finishes.
    currentRunner = runner2;
    await act(async () => {
      result.current.start({});
    });

    // The second run should have finished synchronously.
    // Result should be from run 2, not run 1.
    expect(result.current.result).toEqual({ new: true });
    expect(result.current.running).toBe(false);

    // Now let the first run resolve. It should NOT overwrite state.
    act(() => {
      resolveFirst?.();
    });

    // Wait a tick.
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    // State should still reflect run 2.
    expect(result.current.result).toEqual({ new: true });
  });

  it("derives coalesced timeline", async () => {
    const events: WorkflowEvent[] = [
      makeEvent({ kind: "run_started", sequence: 1 }),
      makeEvent({ kind: "model_delta", sequence: 2, stageId: "s1", channel: "assistant", text: "Hello" }),
      makeEvent({ kind: "model_delta", sequence: 3, stageId: "s1", channel: "assistant", text: " world" }),
      makeEvent({ kind: "stage_completed", sequence: 4, stageId: "s1" }),
    ];
    const runner = scriptedRunner(events);
    const { result } = renderHook(() => useWorkflowRun(runner));

    await act(async () => {
      result.current.start({});
    });

    expect(result.current.events).toHaveLength(4);
    expect(result.current.timeline).toHaveLength(3);
    expect(result.current.timeline[0]).toEqual({ kind: "event", seq: 1, event: events[0] });
    expect(result.current.timeline[1]).toMatchObject({
      kind: "delta_run",
      firstSeq: 2,
      lastSeq: 3,
      text: "Hello world",
    });
    expect(result.current.timeline[2]).toEqual({ kind: "event", seq: 4, event: events[3] });
  });

  it("does not set error on non-DOMException AbortError (polyfill compat)", async () => {
    // Some environments throw a plain Error with name "AbortError" instead
    // of DOMException. The hook must treat that as clean cancellation.
    const runner: WorkflowRunner = async function* (_input, _signal) {
      yield makeEvent({ kind: "run_started", sequence: 1 });
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    };
    const { result } = renderHook(() => useWorkflowRun(runner));

    await act(async () => {
      result.current.start({});
    });

    expect(result.current.error).toBeNull();
    expect(result.current.running).toBe(false);
  });

  it("aborts run on component unmount and does not update state", async () => {
    // A runner that pauses until an external trigger, allowing us to unmount
    // mid-run and verify no state corruption.
    let aborted = false;
    const runner: WorkflowRunner = async function* (_input, signal) {
      signal.addEventListener("abort", () => { aborted = true; });
      yield makeEvent({ kind: "run_started", sequence: 1 });
      // Pause until aborted (unmount triggers abort).
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      yield makeEvent({ kind: "run_completed", sequence: 2 });
    };

    const { result, unmount } = renderHook(() => useWorkflowRun(runner));

    act(() => {
      result.current.start({});
    });

    // Wait for the run to start and pause.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.running).toBe(true);
    expect(result.current.events).toHaveLength(1);

    // Unmount while the run is in progress.
    unmount();

    // Wait for the async cleanup.
    await act(async () => new Promise((r) => setTimeout(r, 20)));

    // The abort signal should have fired.
    expect(aborted).toBe(true);
  });

  it("cancel() aborts the current run", async () => {
    let aborted = false;
    const runner: WorkflowRunner = async function* (_input, signal) {
      signal.addEventListener("abort", () => { aborted = true; });
      yield makeEvent({ kind: "run_started", sequence: 1 });
      // Wait for abort, then throw to complete the generator.
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    };
    const { result } = renderHook(() => useWorkflowRun(runner));

    act(() => {
      result.current.start({});
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
      result.current.cancel();
      // Wait a tick for the async runner to finish.
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(aborted).toBe(true);
    expect(result.current.running).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
