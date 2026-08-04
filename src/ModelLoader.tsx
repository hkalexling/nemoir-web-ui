/**
 * NemoIR Web UI — lightweight `ModelLoader` component.
 *
 * A stateless presentational component for displaying model selection,
 * cache-grouped `<optgroup>` lists, load progress, storage assessment
 * warnings, and an explicit "Load model" button.
 *
 * Not coupled to any particular hook; receives all state as props so it
 * can be fed by `useWebLlmSession` or any other state management.
 */

import { type FC } from "react";
import type {
  WebLlmModelInfo,
  WebLlmProgressReport,
  StorageCapacityAssessment,
  WebLlmLoadFailure,
  ModelFitAssessment,
} from "@nemoir/web-runtime";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ModelLoaderProps {
  /** All available models, pre-sorted by the caller. */
  readonly models: readonly WebLlmModelInfo[];
  /** Set of cached model ids (null means "still resolving"). */
  readonly cachedIds: readonly string[] | null;
  /** Currently selected model id. */
  readonly selectedModel: string;
  /** Change handler for model selection. */
  readonly onSelectModel: (modelId: string) => void;
  /** True when a model is loading. */
  readonly loading: boolean;
  /** True when the selected model is loaded and ready. */
  readonly isLoaded: boolean;
  /** Load progress report, or null. */
  readonly progress: WebLlmProgressReport | null;
  /** Storage assessment for the selected model, or null. */
  readonly storageAssessment: StorageCapacityAssessment | null;
  /** True when the storage warning has been dismissed by the user. */
  readonly storageWarningDismissed: boolean;
  /** Dismiss the storage warning. */
  readonly onDismissStorageWarning: () => void;
  /** Explicit load action. */
  readonly onLoad: () => void;
  /** Structured model-load failure for diagnostics, or null. */
  readonly loadFailure?: WebLlmLoadFailure | null;
  /** Retry loading with a fresh WebLLM worker. */
  readonly onRetryFreshWorker?: () => void;
  /** Retry loading after deleting the model's cached artifacts. */
  readonly onRetryCleanDownload?: () => void;
  /** Delete all cached artifacts for the selected model. */
  readonly onDeleteCache?: () => void;
  /** Per-model fit assessments to annotate options, or null while unresolved. */
  readonly fitAssessments?: ReadonlyMap<string, ModelFitAssessment> | null;
  /** True when the controls should be disabled (e.g. a run is in progress). */
  readonly disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Model selection and loading UI.
 *
 * Renders a `<select>` with `<optgroup>` elements for cached and
 * available models, a load button, a progress bar, and an optional
 * storage-insufficiency warning.
 */
export const ModelLoader: FC<ModelLoaderProps> = ({
  models,
  cachedIds,
  selectedModel,
  onSelectModel,
  loading,
  isLoaded,
  progress,
  storageAssessment,
  storageWarningDismissed,
  onDismissStorageWarning,
  onLoad,
  loadFailure,
  onRetryFreshWorker,
  onRetryCleanDownload,
  onDeleteCache,
  fitAssessments,
  disabled = false,
}) => {
  const cached = new Set(cachedIds ?? []);

  // Group models: cached first, then available.
  const cachedModels = models.filter((m) => cached.has(m.modelId));
  const availableModels = models.filter((m) => !cached.has(m.modelId));

  const showStorageWarning =
    storageAssessment &&
    !storageAssessment.likelySufficient &&
    !storageWarningDismissed &&
    !isLoaded;

  const buttonLabel = isLoaded
    ? "Loaded"
    : loading
      ? "Loading…"
      : "Load model";

  return (
    <div>
      <select
        value={selectedModel}
        onChange={(e) => onSelectModel(e.target.value)}
        disabled={disabled || loading}
        aria-label="Select model"
      >
        {cachedModels.length > 0 && (
          <optgroup label="Cached models">
            {cachedModels.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {optionLabel(m, "✓", fitAssessments?.get(m.modelId))}
              </option>
            ))}
          </optgroup>
        )}
        {/* Show available group when there are uncached models or cache
            state is still resolving (so the list is never empty). */}
        {(availableModels.length > 0 || cachedIds === null) && (
          <optgroup
            label={
              cachedIds === null ? "Available models" : "Available models (need download)"
            }
          >
            {(cachedIds === null ? models : availableModels).map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {optionLabel(m, undefined, fitAssessments?.get(m.modelId))}
              </option>
            ))}
          </optgroup>
        )}
      </select>{" "}
      <button
        onClick={onLoad}
        disabled={isLoaded || loading || disabled || !selectedModel}
      >
        {buttonLabel}
      </button>

      {showStorageWarning && (
        <div
          style={{
            marginTop: "0.75rem",
            padding: "0.5rem 0.75rem",
            background: "#fff7ed",
            border: "1px solid #f59e0b",
            borderRadius: "6px",
            fontSize: "0.85rem",
          }}
          role="alert"
        >
          <strong>Storage may be insufficient.</strong>{" "}
          {storageAssessment?.message}{" "}
          <button onClick={onDismissStorageWarning} style={{ marginLeft: "0.5rem" }}>
            Load anyway
          </button>
        </div>
      )}

      {loadFailure && !loading && (
        <LoadFailureDiagnostics
          failure={loadFailure}
          onRetryFreshWorker={onRetryFreshWorker}
          onRetryCleanDownload={onRetryCleanDownload}
          onDeleteCache={onDeleteCache}
        />
      )}

      {progress && (
        <div
          style={{
            marginTop: "0.5rem",
            position: "relative",
            height: "1.4rem",
            background: "#eee",
            borderRadius: "6px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "var(--nemoir-accent, #4f46e5)",
              opacity: 0.35,
              width: `${Math.round(progress.progress * 100)}%`,
              transition: "width 0.2s",
            }}
          />
          <span
            style={{
              position: "relative",
              padding: "0.2rem 0.5rem",
              fontSize: "0.8rem",
              display: "block",
            }}
          >
            {progress.text}
          </span>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Load-failure diagnostics + recovery
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<string, string> = {
  config_or_tokenizer: "Downloading model configuration/tokenizer",
  weight_shard: "Downloading model weight shards",
  wasm_library: "Downloading model library",
  webgpu_init: "Initializing WebGPU",
  cache_corruption: "Corrupt/partial browser cache",
  network: "Network failure",
  unknown: "Unknown failure",
};

const LoadFailureDiagnostics: FC<{
  readonly failure: WebLlmLoadFailure;
  readonly onRetryFreshWorker?: () => void;
  readonly onRetryCleanDownload?: () => void;
  readonly onDeleteCache?: () => void;
}> = ({ failure, onRetryFreshWorker, onRetryCleanDownload, onDeleteCache }) => {
  const phaseLabel = PHASE_LABELS[failure.phase] ?? failure.phase;
  return (
    <div className="model-load-failure" role="alert">
      <p className="model-load-failure-heading">
        <strong>Model load failed.</strong> Phase: {phaseLabel}.
      </p>
      {failure.failedUrl && (
        <p className="model-load-failure-url" title={failure.failedUrl}>
          Failed URL: <code>{truncateUrl(failure.failedUrl)}</code>
        </p>
      )}
      <p className="model-load-failure-message">{failure.message}</p>
      {failure.suggestsCorruptCache && (
        <p className="model-load-failure-hint">
          This can happen when a prior download was interrupted and left a
          partial cache entry. <strong>Retry clean download</strong> deletes
          only this model’s cached artifacts and redownloads.
        </p>
      )}
      <div className="model-load-failure-actions">
        {onRetryFreshWorker && (
          <button onClick={onRetryFreshWorker}>Retry (fresh worker)</button>
        )}
        {onRetryCleanDownload && (
          <button onClick={onRetryCleanDownload}>Retry clean download</button>
        )}
        {onDeleteCache && (
          <button onClick={onDeleteCache}>Delete cached model</button>
        )}
      </div>
    </div>
  );
};

function truncateUrl(url: string): string {
  if (url.length <= 80) return url;
  return url.slice(0, 38) + "…" + url.slice(-38);
}

function optionLabel(
  model: WebLlmModelInfo,
  prefix: string | undefined,
  fit: ModelFitAssessment | undefined,
): string {
  const size = `(~${modelSizeLabel(model)})`;
  const fitTag = fit ? fitTagFor(fit.category) : "";
  return [prefix, model.label, size, fitTag].filter(Boolean).join(" ");
}

function fitTagFor(category: ModelFitAssessment["category"]): string {
  switch (category) {
    case "recommended":
      return "★ recommended";
    case "missing_feature":
      return "⚠ unsupported";
    case "oversized_vram":
      return "⚠ may OOM";
    case "needs_download":
      return "⤓ large download";
    default:
      return "";
  }
}

function modelSizeLabel(model: WebLlmModelInfo): string {
  const mb = model.vramRequiredMb;
  if (mb == null) return "? GB";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}
