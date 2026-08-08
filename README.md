# @nemoir/web-ui

React UI components and hooks for NemoIR browser workflows — model loading, workflow run management, dialogs, and trace visualization.

## Installation

```bash
npm install @nemoir/web-ui
```

Requires `react` and `react-dom` (^18.0.0 or ^19.0.0) as peer dependencies, plus `@nemoir/web-runtime` for the runtime types and session factory.

## Compiler references

`@nemoir/web-ui` is a React UI layer for NemoIR's browser target. Canonical workflow language and target semantics live in the public compiler repo:

- [DSL and IR spec](https://github.com/hkalexling/nemoir/blob/master/docs/dsl-and-ir.md)
- [Web target guide](https://github.com/hkalexling/nemoir/blob/master/docs/targets/web.md)

This package documents only the UI surface.

## API

### Hooks

- **`useWebLlmSession(options)`** — WebLLM session lifecycle: readiness detection (WebGPU + cross-origin isolation), model list, explicit loading, storage assessment, cache state, and disposal. Returns structured `loadFailure` for diagnostics plus recovery actions (`retryWithFreshWorker`, `retryCleanDownload`, `deleteModelArtifacts`) and optional per-model fit assessments.
- **`useWorkflowRun(runner)`** — Generic async stream runner: start, cancel, raw event capture, coalesced timeline derivation, result/error state, stale-update and unmount safety.
- **`useWebUiHost()`** — Retrieve the `WebUiHost` from context (throws if used outside a provider).

### Components

- **`WebUiHostProvider`** — Context provider implementing `WebUiHost` with controlled, accessible dialogs for `elicit` and `confirm`. Supports custom renderer slots, AbortSignal integration, and safe concurrent-request handling.
- **`ModelLoader`** — Lightweight stateless model selection/loading UI with cache-grouped optgroups, progress bar, storage-insufficiency warnings, structured `LoadFailureDiagnostics` panel (phase description, failed URL, corrupt-cache hint, recovery buttons: retry fresh worker, retry clean download, delete cached model), and per-model `fitAssessments` annotations (recommended, unsupported, may OOM, large download).
- **`WorkflowTraceDrawer`** — Scrollable event timeline display consuming coalesced timeline items.

### Helpers

- **`eventsToJsonl(events)`** — Serialize `WorkflowEvent[]` to a JSONL string.
- **`downloadJsonl(events, filename)`** — Trigger a browser download of a JSONL file.
- **`coalesceTimeline(events)`** — Merge consecutive `model_delta` events (same stage + channel) into display-friendly `delta_run` items.

### Re-exported helpers (from `@nemoir/web-runtime`)

- **`assessModelFit(model, device, opts)`** — Classify a model's fitness for the current device.
- **`probeDeviceCapabilities()`** — Probe WebGPU adapter features and storage limits.
- **`mirrorModelId()`, `overlayModelRecords()`, `toMirroredModelRecord()`** — Deployer-controlled model-source profile helpers.

### Types

Re-exported from `@nemoir/web-runtime`: `WebLlmSession`, `WebLlmModelInfo`, `WebLlmProgressReport`, `StorageCapacityAssessment`, `WebLlmLoadFailure`, `ModelFitAssessment`, `ModelFitCategory`, `DeviceCapabilityReport`, `WorkflowEvent`, `WebUiHost`, `MirroredModelRecord`, `ModelSourceProfile`.

Package-specific: `UseWebLlmSessionOptions`, `UseWebLlmSessionResult`, `WorkflowRunner`, `CoalescedTimelineItem`, `UseWorkflowRunResult`, `ConfirmRendererProps`, `ConfirmRenderer`, `WebUiHostProviderProps`, `ModelLoaderProps`, `WorkflowTraceDrawerProps`.

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # tsc -p tsconfig.build.json
npm pack --dry-run   # preview package contents
```

## Releasing

Maintainers should follow [RELEASING.md](RELEASING.md); npm publication is
performed only by the trusted GitHub Actions workflow.

## License

MIT
