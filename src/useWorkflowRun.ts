/**
 * NemoIR Web UI — `useWorkflowRun` hook.
 *
 * Generic React hook that drives an async workflow runner, captures
 * streaming events, derives coalesced display timeline items, and manages
 * the run lifecycle (start, cancel, result, error).
 *
 * The hook is deliberately NOT coupled to a particular generated `Agent`
 * class. It accepts a structural async stream runner function:
 *
 *   (input: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<WorkflowEvent>
 *
 * This allows tests, custom runners, generated agents, and the generic
 * runtime to all use the same hook.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { WorkflowEvent } from "@nemoir/web-runtime";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A runner is any function that yields WorkflowEvents for a given input. */
export type WorkflowRunner = (
  input: Record<string, unknown>,
  signal: AbortSignal,
) => AsyncIterable<WorkflowEvent>;

/** A coalesced event suitable for inline rendering in a timeline. */
export type CoalescedTimelineItem =
  | {
      readonly kind: "delta_run";
      readonly firstSeq: number;
      lastSeq: number;
      readonly stageId?: string;
      readonly channel?: string | null;
      text: string;
    }
  | {
      readonly kind: "event";
      readonly seq: number;
      readonly event: WorkflowEvent;
    };

export interface UseWorkflowRunResult {
  /** True while a run is in progress. */
  readonly running: boolean;
  /** All raw WorkflowEvent objects captured so far (for trace export). */
  readonly events: readonly WorkflowEvent[];
  /** Coalesced timeline items for display. Consecutive model_delta events
   * with the same stage + channel are merged into a single `delta_run`. */
  readonly timeline: readonly CoalescedTimelineItem[];
  /** The completed workflow result, or null. */
  readonly result: Record<string, unknown> | null;
  /** Error message from a failed run, or null. Cancel does not set error. */
  readonly error: string | null;
  /** Start a new run with the given inputs. Cancels any in-progress run. */
  readonly start: (input: Record<string, unknown>) => void;
  /** Cancel the currently running workflow. */
  readonly cancel: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manage a single workflow run lifecycle.
 *
 * Each call to `start()` creates a fresh `AbortController`, cancelling any
 * previous run. Events accumulate per run; calling `start()` again resets
 * the stream.
 *
 * The hook guards against stale async updates: if the component unmounts
 * or a new run starts before the previous stream finishes, intermediate
 * state updates are discarded.
 */
export function useWorkflowRun(
  runner: WorkflowRunner,
): UseWorkflowRunResult {
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<readonly WorkflowEvent[]>([]);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // AbortController ref — one per invocation.
  const abortRef = useRef<AbortController | null>(null);

  // Generation counter prevents stale async updates when a new run replaces
  // an old one before it finishes.
  const runIdRef = useRef(0);

  // Mounted flag prevents state updates after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Abort any in-progress run when the component unmounts.
      abortRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(
    (input: Record<string, unknown>) => {
      // Cancel any in-progress run.
      abortRef.current?.abort();

      // Reset state for the new run.
      setError(null);
      setEvents([]);
      setResult(null);
      setRunning(true);

      const ac = new AbortController();
      abortRef.current = ac;
      const thisRunId = ++runIdRef.current;

      (async () => {
        try {
          const collected: WorkflowEvent[] = [];
          for await (const event of runner(input, ac.signal)) {
            // Check that this run is still current AND the component is mounted.
            if (runIdRef.current !== thisRunId || !mountedRef.current) return;
            collected.push(event);
            // Append to state immutably so event listeners always see the
            // full array.
            setEvents([...collected]);

            if (event.kind === "run_completed") {
              const output =
                (event.result as { output?: Record<string, unknown> } | undefined)?.output ?? null;
              if (runIdRef.current !== thisRunId || !mountedRef.current) return;
              setResult(output);
            }
            if (event.kind === "run_failed") {
              if (runIdRef.current !== thisRunId || !mountedRef.current) return;
              setError(event.error ?? "run failed");
            }
          }
        } catch (e) {
          if (runIdRef.current !== thisRunId || !mountedRef.current) return;
          // AbortError from cancellation is expected; don't show as error.
          // Some polyfills throw a plain Error with name "AbortError"
          // rather than a DOMException, so we check both.
          if (
            (e instanceof DOMException && e.name === "AbortError") ||
            (e instanceof Error && e.name === "AbortError")
          ) {
            // Nothing to do — cancellation is clean.
          } else {
            setError(e instanceof Error ? e.message : String(e));
          }
        } finally {
          if (runIdRef.current === thisRunId && mountedRef.current) {
            setRunning(false);
            abortRef.current = null;
          }
        }
      })();
    },
    [runner],
  );

  // Derive coalesced timeline from events.
  const timeline = useMemo(() => coalesceTimeline(events), [events]);

  return { running, events, timeline, result, error, start, cancel };
}

// ---------------------------------------------------------------------------
// Coalescing logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Coalesce consecutive `model_delta` events (same stage + channel) into a
 * single `delta_run` item, while non-delta events stay as individual rows.
 */
export function coalesceTimeline(
  events: readonly WorkflowEvent[],
): readonly CoalescedTimelineItem[] {
  const items: CoalescedTimelineItem[] = [];
  let run: CoalescedTimelineItem & { kind: "delta_run" } | null = null;

  const flush = () => {
    if (run) {
      items.push(run);
      run = null;
    }
  };

  for (const e of events) {
    if (e.kind === "model_delta") {
      const ch = e.channel ?? null;
      if (
        run &&
        run.stageId === e.stageId &&
        (run.channel ?? null) === ch
      ) {
        run.text += e.text ?? "";
        run.lastSeq = e.sequence;
      } else {
        flush();
        run = {
          kind: "delta_run",
          firstSeq: e.sequence,
          lastSeq: e.sequence,
          stageId: e.stageId,
          channel: ch,
          text: e.text ?? "",
        };
      }
    } else {
      flush();
      items.push({ kind: "event", seq: e.sequence, event: e });
    }
  }
  flush();

  return items;
}
