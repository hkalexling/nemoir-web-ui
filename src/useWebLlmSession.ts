/**
 * NemoIR Web UI — `useWebLlmSession` hook.
 *
 * Provides React-friendly lifecycle management for a WebLLM session.
 *
 * Key design decisions:
 * - The hook does NOT require a particular generated worker URL; the caller
 *   passes a `workerFactory` (and optionally `extraModels`, etc.) so the
 *   hook remains generic across generated apps.
 * - Model loading is explicit-only (no auto-load on selection change).
 * - Readiness is gated on WebGPU + cross-origin isolation detection.
 * - Cache state is refreshed eagerly after each load and lazily otherwise.
 * - Disposal is handled on unmount and on session recreation.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  createWebllmSession,
  isWebGPUAvailable,
  isCrossOriginIsolated,
  type WebLlmSession,
  type WebLlmSessionOptions,
  type WebLlmModelInfo,
  type WebLlmProgressReport,
  type StorageCapacityAssessment,
  type WebLlmLoadFailure,
} from "@nemoir/web-runtime";

// ---------------------------------------------------------------------------
// Hook options
// ---------------------------------------------------------------------------

export interface UseWebLlmSessionOptions {
  /**
   * When `false`, the hook returns a dormant idle state without creating a
   * WebLLM session or detecting platform capabilities. This is intended for
   * deterministic-only workflows that have no model stages.
   *
   * Defaults to `true` (model support enabled).
   */
  readonly enabled?: boolean;
  /**
   * Creates the WebLLM worker. The generated app supplies:
   * `() => new Worker(new URL("./webllm.worker.ts", import.meta.url), { type: "module" })`.
   */
  readonly workerFactory: () => Worker;
  /** Extra model records appended to the prebuilt list. Passed through to
   * `createWebllmSession`. The concrete type is `ModelRecord` from
   * `@mlc-ai/web-llm` but we accept a structural subtype for loose coupling. */
  readonly extraModels?: readonly {
    model_id: string;
    model?: string;
    model_lib?: string;
    vram_required_MB?: number;
    low_resource_required?: boolean;
    required_features?: readonly string[];
  }[];
  /** Per-model download-size overrides (bytes). */
  readonly modelDownloadSizeOverrides?: Readonly<Record<string, number>>;
  /** Cache backend override. Auto-detected by default. */
  readonly cacheBackend?: WebLlmSessionOptions["cacheBackend"];
  /** Optional progress callback (passed through to the session). */
  readonly onProgress?: (report: WebLlmProgressReport) => void;
}

// ---------------------------------------------------------------------------
// Hook return value
// ---------------------------------------------------------------------------

export interface UseWebLlmSessionResult {
  /** True when WebGPU is available in this browser. */
  readonly webgpuAvailable: boolean;
  /** True when cross-origin isolation (COOP/COEP) is active. */
  readonly crossOriginIsolated: boolean;
  /** True when the platform is not capable of running WebLLM. */
  readonly platformUnavailable: boolean;
  /** The live session handle, or null when unavailable/not yet created. */
  readonly session: WebLlmSession | null;
  /** All available LLM models (sorted by VRAM). */
  readonly models: readonly WebLlmModelInfo[];
  /** The currently selected model id. */
  readonly selectedModel: string;
  /** Set the selected model id. Does not trigger loading. */
  readonly setSelectedModel: (modelId: string) => void;
  /** True while a model is being loaded. */
  readonly loading: boolean;
  /** Loading progress report, or null when idle. */
  readonly progress: WebLlmProgressReport | null;
  /** Session-creation or model-load error message, or null. */
  readonly error: string | null;
  /** Structured model-load failure for diagnostics, or null. */
  readonly loadFailure: WebLlmLoadFailure | null;
  /** Set of model ids currently cached in the browser. Null means unresolved. */
  readonly cachedIds: readonly string[] | null;
  /** Latest storage assessment for the selected model, or null. */
  readonly storageAssessment: StorageCapacityAssessment | null;
  /** True when the selected model is loaded and ready. */
  readonly isModelLoaded: boolean;
  /** Load the selected model (explicit trigger only). */
  readonly loadModel: () => Promise<void>;
  /** Retry loading the selected model with a fresh WebLLM worker. */
  readonly retryWithFreshWorker: () => Promise<void>;
  /** Retry loading the selected model after deleting its cached artifacts. */
  readonly retryCleanDownload: () => Promise<void>;
  /** Delete all cached artifacts for the selected model. */
  readonly deleteModelArtifacts: () => Promise<void>;
  /** Re-assess storage for the selected model and return the fresh result. */
  readonly assessStorageForSelected: () => Promise<StorageCapacityAssessment | null>;
  /** Dispose the session and release resources. Callable manually or on unmount. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * Create and manage a WebLLM session lifecycle inside a React component.
 *
 * Session creation is deferred until the hook mounts in a browser with
 * WebGPU available. On unmount the session is disposed automatically.
 *
 * Model selection is decoupled from loading: call `loadModel()` explicitly
 * to download and initialize the selected model.
 */
export function useWebLlmSession(
  opts: UseWebLlmSessionOptions,
): UseWebLlmSessionResult {
  const enabled = opts.enabled !== false;

  // When disabled, return a dormant idle state without probing the platform
  // or creating a session. All operations are no-ops.
  const webgpuAvailable = enabled ? isWebGPUAvailable() : false;
  const crossOriginIsolated = enabled ? isCrossOriginIsolated() : false;
  const platformUnavailable = enabled ? !isWebGPUAvailable() : false;

  const [session, setSession] = useState<WebLlmSession | null>(null);
  const [models, setModels] = useState<readonly WebLlmModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<WebLlmProgressReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<WebLlmLoadFailure | null>(null);
  const [cachedIds, setCachedIds] = useState<readonly string[] | null>(null);
  const [storageAssessment, setStorageAssessment] = useState<StorageCapacityAssessment | null>(null);

  // Keep a ref to the session so disposal on unmount is always against the
  // latest instance even if state has not yet flushed.
  const sessionRef = useRef<WebLlmSession | null>(null);

  // Track whether the component is still mounted so we avoid state updates
  // after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Create the session on mount (requires both WebGPU and cross-origin
  // isolation; WebLLM cannot function without COOP/COEP headers).
  // When `enabled` is false, skip session creation entirely.
  useEffect(() => {
    if (!enabled || !webgpuAvailable || !crossOriginIsolated) return;

    let cancelled = false;
    const workerFactory = opts.workerFactory;

    createWebllmSession({
      workerFactory,
      // Cast: hook type is intentionally a loose structural subtype;
      // ModelRecord has `model` and `model_lib` as required string.
      extraModels: opts.extraModels as WebLlmSessionOptions["extraModels"],
      modelDownloadSizeOverrides: opts.modelDownloadSizeOverrides,
      cacheBackend: opts.cacheBackend,
      onProgress: (r) => {
        if (!cancelled && mountedRef.current) {
          setProgress(r);
          opts.onProgress?.(r);
        }
      },
    })
      .then((s) => {
        if (cancelled) {
          void s.dispose();
          return;
        }
        if (!mountedRef.current) {
          void s.dispose();
          return;
        }
        sessionRef.current = s;
        setSession(s);
        // Keep the public list stable and sorted for model-loader consumers.
        const sorted = [...s.models].sort(
          (a, b) => (a.vramRequiredMb ?? 0) - (b.vramRequiredMb ?? 0),
        );
        setModels(sorted);
        // Auto-select the smallest model.
        if (sorted.length > 0 && !selectedModel) {
          setSelectedModel(sorted[0].modelId);
        }
        // Resolve cached state lazily.
        s.cachedModelIds()
          .then((ids) => {
            if (mountedRef.current) setCachedIds(ids);
          })
          .catch(() => {});
      })
      .catch((e) => {
        if (!cancelled && mountedRef.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });

    return () => {
      cancelled = true;
    };
    // Run once on mount; selectedModel is deliberately excluded so
    // changing selection does not recreate the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, webgpuAvailable]);

  // Re-assess storage when selected model or cache state changes.
  useEffect(() => {
    const s = sessionRef.current;
    if (!s || !selectedModel) {
      setStorageAssessment(null);
      return;
    }
    let cancelled = false;
    s.assessStorage(selectedModel)
      .then((a) => {
        if (!cancelled && mountedRef.current) setStorageAssessment(a);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, selectedModel, cachedIds]);

  // Explicit load.
  const loadModel = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !selectedModel) return;
    setLoading(true);
    setError(null);
    setLoadFailure(null);
    setProgress(null);
    try {
      await s.ensureLoaded(selectedModel);
      setProgress(null);
      setLoadFailure(null);
      // Refresh cached state.
      try {
        const ids = await s.cachedModelIds();
        if (mountedRef.current) setCachedIds(ids);
      } catch { /* best effort */ }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e));
        setLoadFailure(s.lastLoadFailure);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [selectedModel]);

  const retryWithFreshWorker = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !selectedModel) return;
    setLoading(true);
    setError(null);
    setLoadFailure(null);
    setProgress(null);
    try {
      await s.retryLoad(selectedModel, { freshWorker: true });
      setLoadFailure(null);
      try {
        const ids = await s.cachedModelIds();
        if (mountedRef.current) setCachedIds(ids);
      } catch { /* best effort */ }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e));
        setLoadFailure(s.lastLoadFailure);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [selectedModel]);

  const retryCleanDownload = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !selectedModel) return;
    setLoading(true);
    setError(null);
    setLoadFailure(null);
    setProgress(null);
    try {
      await s.retryLoad(selectedModel, { cleanCache: true, freshWorker: true });
      setLoadFailure(null);
      try {
        const ids = await s.cachedModelIds();
        if (mountedRef.current) setCachedIds(ids);
      } catch { /* best effort */ }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e));
        setLoadFailure(s.lastLoadFailure);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [selectedModel]);

  const deleteModelArtifacts = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !selectedModel) return;
    try {
      await s.deleteModelArtifacts(selectedModel);
      try {
        const ids = await s.cachedModelIds();
        if (mountedRef.current) setCachedIds(ids);
      } catch { /* best effort */ }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [selectedModel]);

  const assessStorageForSelected = useCallback(async (): Promise<StorageCapacityAssessment | null> => {
    const s = sessionRef.current;
    if (!s || !selectedModel) return null;
    try {
      const assessment = await s.assessStorage(selectedModel);
      if (mountedRef.current) setStorageAssessment(assessment);
      return assessment;
    } catch {
      return null;
    }
  }, [selectedModel]);

  // Dispose (manual or on unmount). Resets all state to a coherent idle
  // baseline so callers don't hold references to a disposed session.
  const dispose = useCallback(async () => {
    const s = sessionRef.current;
    if (s) {
      sessionRef.current = null;
      await s.dispose();
      if (mountedRef.current) {
        setSession(null);
        setModels([]);
        setLoading(false);
        setProgress(null);
        setError(null);
        setLoadFailure(null);
        setCachedIds(null);
        setStorageAssessment(null);
      }
    }
  }, []);

  // Dispose on unmount.
  useEffect(() => {
    return () => {
      void (async () => {
        await sessionRef.current?.dispose();
      })();
    };
  }, []);

  const isModelLoaded = session?.isModelLoaded(selectedModel) ?? false;

  return {
    webgpuAvailable,
    crossOriginIsolated,
    platformUnavailable,
    session,
    models,
    selectedModel,
    setSelectedModel,
    loading,
    progress,
    error,
    loadFailure,
    cachedIds,
    storageAssessment,
    isModelLoaded,
    loadModel,
    retryWithFreshWorker,
    retryCleanDownload,
    deleteModelArtifacts,
    assessStorageForSelected,
    dispose,
  };
}
