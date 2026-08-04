/**
 * NemoIR Web UI — lightweight `WorkflowTraceDrawer` component.
 *
 * A stateless timeline display for workflow events. Consumes the coalesced
 * timeline items produced by `useWorkflowRun` (or any compatible array).
 *
 * Features:
 * - Delta runs (coalesced model output) shown as a text block with channel
 *   styling (reasoning in muted italic, assistant in default).
 * - Individual events shown with kind, sequence number, optional stage id,
 *   transition arrows, and error text.
 * - Scrollable container with a configurable max height.
 */

import { type FC } from "react";
import type { CoalescedTimelineItem } from "./useWorkflowRun.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkflowTraceDrawerProps {
  /** Coalesced timeline items to display. */
  readonly items: readonly CoalescedTimelineItem[];
  /** Maximum height of the scrollable timeline container. Default "400px". */
  readonly maxHeight?: string;
  /** Optional CSS class name for the outer container. */
  readonly className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Render a scrollable event timeline from coalesced items.
 *
 * Intended for generic runner use: pass `timeline` from `useWorkflowRun()`
 * as `items`.
 */
export const WorkflowTraceDrawer: FC<WorkflowTraceDrawerProps> = ({
  items,
  maxHeight = "400px",
  className,
}) => {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      <ol
        className="nemoir-timeline"
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          maxHeight,
          overflowY: "auto",
          fontSize: "0.82rem",
        }}
      >
        {items.map((item) =>
          item.kind === "delta_run" ? (
            <li
              key={`r${item.firstSeq}`}
              style={{
                padding: "0.2rem 0",
                borderBottom: "1px solid #f0f0f0",
              }}
            >
              <span
                className="nemoir-seq"
                style={{
                  color: "var(--nemoir-muted, #71717a)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {item.firstSeq}
                {item.lastSeq !== item.firstSeq ? `\u2013${item.lastSeq}` : ""}
              </span>{" "}
              <span
                className="nemoir-kind"
                style={{ fontWeight: 600, marginLeft: "0.3rem" }}
              >
                {item.channel === "reasoning" ? "reasoning" : "assistant"}
              </span>
              {item.stageId && (
                <span
                  className="nemoir-stage"
                  style={{
                    color: "var(--nemoir-accent, #4f46e5)",
                    marginLeft: "0.4rem",
                  }}
                >
                  {item.stageId}
                </span>
              )}
              <span
                className={
                  item.channel === "reasoning" ? "nemoir-delta reasoning" : "nemoir-delta"
                }
                style={{
                  display: "block",
                  margin: "0.25rem 0 0 1.4rem",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color:
                    item.channel === "reasoning" ? "#7c3aed" : "#166534",
                  fontStyle:
                    item.channel === "reasoning" ? "italic" : "normal",
                }}
              >
                {item.text}
              </span>
            </li>
          ) : (
            <li
              key={`e${item.seq}`}
              style={{
                padding: "0.2rem 0",
                borderBottom: "1px solid #f0f0f0",
              }}
            >
              <span
                className="nemoir-seq"
                style={{
                  color: "var(--nemoir-muted, #71717a)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {item.seq}
              </span>{" "}
              <span
                className="nemoir-kind"
                style={{ fontWeight: 600, marginLeft: "0.3rem" }}
              >
                {item.event.kind}
              </span>
              {item.event.stageId && (
                <span
                  className="nemoir-stage"
                  style={{
                    color: "var(--nemoir-accent, #4f46e5)",
                    marginLeft: "0.4rem",
                  }}
                >
                  {item.event.stageId}
                </span>
              )}
              {item.event.kind === "transition_selected" &&
                item.event.transitionTo && (
                  <span
                    className="nemoir-arrow"
                    style={{
                      color: "var(--nemoir-accent, #4f46e5)",
                      marginLeft: "0.4rem",
                    }}
                  >
                    {"\u2192"} {item.event.transitionTo}
                  </span>
                )}
              {item.event.error && (
                <span
                  className="nemoir-err"
                  style={{ color: "#dc2626", marginLeft: "0.4rem" }}
                >
                  {item.event.error}
                </span>
              )}
            </li>
          ),
        )}
      </ol>
    </div>
  );
};
