/**
 * NemoIR Web UI — public API surface.
 *
 * A reusable React package providing hooks, components, and helpers for
 * building NemoIR web applications. Framework-neutral at the runtime
 * boundary (consumes types from `@nemoir/web-runtime`) and React-only
 * for the UI layer.
 *
 * ## Exports
 *
 * ### Hooks
 * - `useWebLlmSession` — WebLLM session lifecycle (readiness, model list,
 *   cached-model info, storage assessment, progress, explicit loading,
 *   disposal).
 * - `useWorkflowRun` — generic async stream runner hook with per-invocation
 *   AbortController, raw event capture, coalesced timeline derivation,
 *   result/error/cancellation handling, and stale-update prevention.
 * - `useWebUiHost` — retrieves the `WebUiHost` from context.
 *
 * ### Components
 * - `WebUiHostProvider` — context provider implementing `WebUiHost` with
 *   controlled, accessible dialogs. Supports custom `elicit`/`confirm`
 *   renderers.
 * - `ModelLoader` — lightweight model selection/loading UI (stateless,
 *   fed by props).
 * - `WorkflowTraceDrawer` — lightweight scrollable event timeline display.
 *
 * ### Helpers
 * - `eventsToJsonl` — serialize `WorkflowEvent[]` to JSONL string.
 * - `downloadJsonl` — trigger browser download of JSONL file.
 * - `coalesceTimeline` — merge consecutive `model_delta` events for display.
 *
 * ### Types
 * - Re-exported from `@nemoir/web-runtime` for convenience:
 *   `WebLlmSession`, `WebLlmModelInfo`, `WebLlmProgressReport`,
 *   `StorageCapacityAssessment`, `WorkflowEvent`, `WebUiHost`.
 * - Package-specific:
 *   `UseWebLlmSessionOptions`, `UseWebLlmSessionResult`,
 *   `WorkflowRunner`, `CoalescedTimelineItem`, `UseWorkflowRunResult`,
 *   `ConfirmRendererProps`, `ConfirmRenderer`, `WebUiHostProviderProps`,
 *   `ModelLoaderProps`, `WorkflowTraceDrawerProps`.
 */

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export { useWebLlmSession } from "./useWebLlmSession.js";
export type {
  UseWebLlmSessionOptions,
  UseWebLlmSessionResult,
} from "./useWebLlmSession.js";
export { useWorkflowRun, coalesceTimeline } from "./useWorkflowRun.js";
export type {
  WorkflowRunner,
  CoalescedTimelineItem,
  UseWorkflowRunResult,
} from "./useWorkflowRun.js";

export { useWebUiHost, WebUiHostProvider } from "./WebUiHostProvider.js";
export type {
  ConfirmRendererProps,
  ConfirmRenderer,
  WebUiHostProviderProps,
} from "./WebUiHostProvider.js";

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export { ModelLoader } from "./ModelLoader.js";
export type { ModelLoaderProps } from "./ModelLoader.js";

export { WorkflowTraceDrawer } from "./WorkflowTraceDrawer.js";
export type { WorkflowTraceDrawerProps } from "./WorkflowTraceDrawer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { eventsToJsonl, downloadJsonl } from "./jsonl.js";

// Device-capability helpers (re-exported for convenience)
export { assessModelFit, probeDeviceCapabilities } from "@nemoir/web-runtime";

// Model-source / controlled-mirror profiles (re-exported for convenience)
export {
  mirrorModelId,
  overlayModelRecords,
  toMirroredModelRecord,
  type MirroredModelRecord,
  type ModelSourceProfile,
} from "@nemoir/web-runtime";

// ---------------------------------------------------------------------------
// Re-exported runtime types (for consumer convenience)
// ---------------------------------------------------------------------------

export type {
  WebLlmSession,
  WebLlmModelInfo,
  WebLlmProgressReport,
  StorageCapacityAssessment,
  WebLlmLoadFailure,
  ModelFitAssessment,
  ModelFitCategory,
  DeviceCapabilityReport,
  WorkflowEvent,
  WebUiHost,
} from "@nemoir/web-runtime";
