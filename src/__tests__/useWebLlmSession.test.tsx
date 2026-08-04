/**
 * `useWebLlmSession` hook tests.
 *
 * Uses a fake WebLlmSession implementation to verify state transitions:
 * - Platform detection (WebGPU / COI)
 * - Session creation and model list population
 * - Model selection
 * - Explicit loading (load, progress, error)
 * - Cache state refresh
 * - Storage assessment
 * - Disposal on unmount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { UseWebLlmSessionOptions } from "../useWebLlmSession.js";
import type {
  WebLlmSession,
  WebLlmModelInfo,
  WebLlmProgressReport,
  StorageCapacityAssessment,
} from "@nemoir/web-runtime";

// ---------------------------------------------------------------------------
// Fake WebLLM session implementation
// ---------------------------------------------------------------------------

function fakeModelInfo(overrides: Partial<WebLlmModelInfo> = {}): WebLlmModelInfo {
  return {
    modelId: "test-model-1",
    label: "Test Model 1",
    vramRequiredMb: 1024,
    ...overrides,
  };
}

function fakeStorageAssessment(
  overrides: Partial<StorageCapacityAssessment> = {},
): StorageCapacityAssessment {
  return {
    supported: true,
    quota: 10 * 1024 * 1024 * 1024,
    usage: 2 * 1024 * 1024 * 1024,
    available: 8 * 1024 * 1024 * 1024,
    estimatedModelBytes: 1024 * 1024 * 1024,
    marginBytes: 512 * 1024 * 1024,
    isCached: false,
    likelySufficient: true,
    message: "Sufficient storage.",
    ...overrides,
  };
}

function makeFakeSession(opts?: {
  models?: WebLlmModelInfo[];
  cachedIds?: string[];
  loadDelayMs?: number;
  loadError?: string;
  assessment?: StorageCapacityAssessment;
}): WebLlmSession {
  const models = opts?.models ?? [
    fakeModelInfo({ modelId: "m1", label: "Model 1", vramRequiredMb: 512 }),
    fakeModelInfo({ modelId: "m2", label: "Model 2", vramRequiredMb: 2048 }),
    fakeModelInfo({ modelId: "m3", label: "Model 3", vramRequiredMb: 4096 }),
  ];

  let loadedModelId: string | undefined;

  return {
    models,
    currentModelId: loadedModelId,
    isModelLoaded(modelId: string): boolean {
      return loadedModelId === modelId;
    },
    async cachedModelIds(): Promise<readonly string[]> {
      return opts?.cachedIds ?? [];
    },
    async assessStorage(modelId: string): Promise<StorageCapacityAssessment> {
      const model = models.find((m) => m.modelId === modelId);
      return opts?.assessment ?? fakeStorageAssessment({
        estimatedModelBytes: model?.estimatedDownloadBytes ?? model?.vramRequiredMb
          ? (model.vramRequiredMb ?? 0) * 1024 * 1024
          : 0,
      });
    },
    async ensureLoaded(modelId: string, _signal?: AbortSignal): Promise<void> {
      if (opts?.loadError) throw new Error(opts.loadError);
      if (opts?.loadDelayMs) {
        await new Promise((r) => setTimeout(r, opts.loadDelayMs));
      }
      loadedModelId = modelId;
    },
    async switchModel(modelId: string, signal?: AbortSignal): Promise<void> {
      await this.ensureLoaded(modelId, signal);
    },
    async interrupt(): Promise<void> {},
    async dispose(): Promise<void> {
      loadedModelId = undefined;
    },
    async retryLoad(_modelId: string, _opts?: { cleanCache?: boolean; freshWorker?: boolean }, _signal?: AbortSignal): Promise<void> {
      loadedModelId = _modelId;
    },
    async deleteModelArtifacts(_modelId: string): Promise<void> {},
    lastLoadFailure: null,
    adapter: null as unknown as WebLlmSession["adapter"],
  };
}

// ---------------------------------------------------------------------------
// Mock createWebllmSession
// ---------------------------------------------------------------------------

// We mock @nemoir/web-runtime's createWebllmSession to return our fake.
// isWebGPUAvailable and isCrossOriginIsolated need real browser values.

// Full mock approach: mock @nemoir/web-runtime to return controlled values.
function mockRuntime(opts: {
  webgpu: boolean;
  coi: boolean;
  session?: WebLlmSession;
  sessionError?: string;
}) {
  vi.doMock("@nemoir/web-runtime", () => ({
    createWebllmSession: async (sessionOpts: unknown) => {
      // Call onProgress if provided so we can test progress reporting.
      const optsWithProgress = sessionOpts as {
        onProgress?: (r: WebLlmProgressReport) => void;
      };
      if (opts.sessionError) throw new Error(opts.sessionError);
      const session = opts.session ?? makeFakeSession();
      // Trigger initial progress.
      optsWithProgress.onProgress?.({
        text: "Loading catalog…",
        progress: 0.5,
        timeElapsed: 1,
      });
      return session;
    },
    isWebGPUAvailable: () => opts.webgpu,
    isCrossOriginIsolated: () => opts.coi,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useWebLlmSession", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function defaultOpts(): UseWebLlmSessionOptions {
    return {
      workerFactory: () =>
        ({ terminate() {}, postMessage() {} }) as unknown as Worker,
    };
  }

  it("does not create a session when cross-origin isolation is absent", async () => {
    // WebGPU available but COI missing — WebLLM cannot function.
    mockRuntime({ webgpu: true, coi: false });
    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    expect(result.current.webgpuAvailable).toBe(true);
    expect(result.current.crossOriginIsolated).toBe(false);
    expect(result.current.session).toBeNull();
    // platformUnavailable should still be false — COI is missing, not WebGPU.
    // But no session should have been created.
  });

  it("detects platform unavailability when WebGPU is absent", async () => {
    mockRuntime({ webgpu: false, coi: true });
    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    expect(result.current.webgpuAvailable).toBe(false);
    expect(result.current.platformUnavailable).toBe(true);
    expect(result.current.session).toBeNull();
  });

  it("creates a session when WebGPU is available", async () => {
    const session = makeFakeSession({
      models: [
        fakeModelInfo({ modelId: "m3", vramRequiredMb: 4096 }),
        fakeModelInfo({ modelId: "m1", vramRequiredMb: 512 }),
        fakeModelInfo({ modelId: "m2", vramRequiredMb: 2048 }),
      ],
    });
    mockRuntime({ webgpu: true, coi: true, session });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    await waitFor(() => {
      expect(result.current.session).not.toBeNull();
    });

    expect(result.current.models.map((model) => model.modelId)).toEqual(["m1", "m2", "m3"]);
    // Smallest model should be auto-selected: m1 (512 MB).
    expect(result.current.selectedModel).toBe("m1");
  });

  it("reports session error", async () => {
    mockRuntime({
      webgpu: true,
      coi: true,
      sessionError: "WebGPU not supported",
    });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    await waitFor(() => {
      expect(result.current.error).toBe("WebGPU not supported");
    });
    expect(result.current.session).toBeNull();
  });

  it("loads model explicitly (not on selection change)", async () => {
    const session = makeFakeSession();
    mockRuntime({ webgpu: true, coi: true, session });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    await waitFor(() => {
      expect(result.current.session).not.toBeNull();
    });

    // Change selection — should NOT trigger loading.
    act(() => {
      result.current.setSelectedModel("m2");
    });
    expect(result.current.isModelLoaded).toBe(false);
    expect(result.current.loading).toBe(false);

    // Explicit load.
    await act(async () => {
      await result.current.loadModel();
    });

    expect(result.current.isModelLoaded).toBe(true);
  });

  it("handles load error", async () => {
    const session = makeFakeSession({ loadError: "OOM" });
    mockRuntime({ webgpu: true, coi: true, session });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    await waitFor(() => {
      expect(result.current.session).not.toBeNull();
    });

    await act(async () => {
      await result.current.loadModel();
    });

    expect(result.current.error).toBe("OOM");
    expect(result.current.isModelLoaded).toBe(false);
  });

  it("computes storage assessment for selected model", async () => {
    const assessment = fakeStorageAssessment({
      estimatedModelBytes: 512 * 1024 * 1024,
      likelySufficient: true,
    });
    const session = makeFakeSession({ assessment });
    mockRuntime({ webgpu: true, coi: true, session });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    await waitFor(() => {
      expect(result.current.storageAssessment).not.toBeNull();
    });

    expect(result.current.storageAssessment?.estimatedModelBytes).toBe(
      512 * 1024 * 1024,
    );
    expect(result.current.storageAssessment?.likelySufficient).toBe(true);
  });

  it("cachedIds default to null (unresolved)", async () => {
    const session = makeFakeSession({ cachedIds: ["m1"] });
    mockRuntime({ webgpu: true, coi: true, session });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    // Before the async resolution, cachedIds may still be null.
    await waitFor(() => {
      expect(result.current.session).not.toBeNull();
    });

    // After session creation, cachedIds should resolve.
    await waitFor(() => {
      expect(result.current.cachedIds).toEqual(["m1"]);
    });
  });

  it("refreshes cached state after load", async () => {
    const session = makeFakeSession();
    mockRuntime({ webgpu: true, coi: true, session });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    await waitFor(() => {
      expect(result.current.session).not.toBeNull();
    });

    // Initially no cached models.
    await waitFor(() => {
      expect(result.current.cachedIds).toEqual([]);
    });

    // Change the fake session's cache state after load.
    const origCachedIds = session.cachedModelIds;
    session.cachedModelIds = async () => ["m1"];

    await act(async () => {
      await result.current.loadModel();
    });

    expect(result.current.cachedIds).toEqual(["m1"]);

    // Restore.
    session.cachedModelIds = origCachedIds;
  });

  it("manual dispose resets state to idle baseline", async () => {
    const session = makeFakeSession();
    mockRuntime({ webgpu: true, coi: true, session });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    await waitFor(() => {
      expect(result.current.session).not.toBeNull();
    });

    // Manually dispose.
    await act(async () => {
      await result.current.dispose();
    });

    expect(result.current.session).toBeNull();
    expect(result.current.models).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.cachedIds).toBeNull();
    expect(result.current.storageAssessment).toBeNull();
  });

  it("disposes on unmount", async () => {
    let disposed = false;
    const session = makeFakeSession();
    const origDispose = session.dispose.bind(session);
    session.dispose = async () => {
      disposed = true;
      await origDispose();
    };

    mockRuntime({ webgpu: true, coi: true, session });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result, unmount } = renderHook(() =>
      hookImpl(defaultOpts()),
    );

    await waitFor(() => {
      expect(result.current.session).not.toBeNull();
    });

    unmount();

    // Wait for async dispose.
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(disposed).toBe(true);
  });

  it("returns dormant idle state when enabled=false (deterministic-only)", async () => {
    // Even with WebGPU and COI available, an enabled=false hook must
    // not create a session and must not probe platform capabilities.
    mockRuntime({ webgpu: true, coi: true });

    const { useWebLlmSession: hookImpl } = await import(
      "../useWebLlmSession.js"
    );
    const { result } = renderHook(() =>
      hookImpl({ ...defaultOpts(), enabled: false }),
    );

    expect(result.current.webgpuAvailable).toBe(false);
    expect(result.current.crossOriginIsolated).toBe(false);
    expect(result.current.platformUnavailable).toBe(false);
    expect(result.current.session).toBeNull();
    expect(result.current.models).toEqual([]);
    expect(result.current.isModelLoaded).toBe(false);
    expect(result.current.loading).toBe(false);

    // loadModel and dispose must be no-ops.
    await act(async () => {
      await result.current.loadModel();
    });
    expect(result.current.session).toBeNull();

    await act(async () => {
      await result.current.dispose();
    });
    expect(result.current.session).toBeNull();
  });
});
