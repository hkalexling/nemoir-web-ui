/**
 * NemoIR Web UI — `WebUiHostProvider` and `useWebUiHost` hook.
 *
 * Implements the `WebUiHost` interface (elicit/confirm) as a React context
 * provider. The provider renders accessible controlled dialogs; it never
 * reaches into the DOM with `document.getElementById`.
 *
 * Design:
 * - A single provider manages a single active request at a time.  Elicit and
 *   confirm share one slot — a new request of either kind supersedes any
 *   in-flight request, so competing dialogs never render together.
 * - The active request is synchronously tracked in a ref.  If the provider is
 *   unmounted before the next effect flush the pending promise is still
 *   rejected with `AbortError`.
 * - Each request carries its own `AbortSignal`.  When the signal fires the
 *   promise is rejected with `AbortError` and the dialog is dismissed.
 *   Listeners are removed exactly once via an idempotent `clear()` guard.
 * - Custom renderer slots (`renderElicit` / `renderConfirm`) let consumers
 *   provide bespoke dialog UIs while the stable `WebUiHost` API surface
 *   remains unchanged.
 * - Never uses `document.getElementById` — all inputs are controlled React
 *   state.
 */

import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
  type FC,
} from "react";
import type { WebUiHost } from "@nemoir/web-runtime";

// ---------------------------------------------------------------------------
// Unified active-request type
// ---------------------------------------------------------------------------

type ActiveRequest =
  | {
      readonly kind: "elicit";
      readonly _id: number;
      readonly question: string;
      readonly options?: string[];
      readonly resolve: (v: string) => void;
      readonly reject: (e: unknown) => void;
    }
  | {
      readonly kind: "confirm";
      readonly _id: number;
      readonly message: string;
      readonly resolve: (v: boolean) => void;
      readonly reject: (e: unknown) => void;
    };

// ---------------------------------------------------------------------------
// Custom confirm renderer props
// ---------------------------------------------------------------------------

/**
 * Props passed to a custom confirmation renderer.
 *
 * `message` is always the runtime-provided confirmation text. A custom
 * renderer may show additional context (e.g. a sandboxed code preview)
 * alongside it.
 */
export interface ConfirmRendererProps {
  /** The message from the runtime's `confirm()` call. */
  readonly message: string;
  /** Resolve with `true` (confirmed) or `false` (denied). */
  readonly onResolve: (value: boolean) => void;
  /** Reject the confirmation (e.g. on cancel). */
  readonly onReject: (error: unknown) => void;
}

/** Signature for a custom confirmation renderer component. */
export type ConfirmRenderer = FC<ConfirmRendererProps>;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const WebUiHostContext = createContext<WebUiHost | null>(null);

/**
 * Retrieve the `WebUiHost` from the nearest `<WebUiHostProvider>`.
 * Throws if used outside a provider.
 */
export function useWebUiHost(): WebUiHost {
  const host = useContext(WebUiHostContext);
  if (!host) {
    throw new Error(
      "useWebUiHost() must be used within a <WebUiHostProvider>.",
    );
  }
  return host;
}

// ---------------------------------------------------------------------------
// Provider props
// ---------------------------------------------------------------------------

export interface WebUiHostProviderProps {
  readonly children: ReactNode;
  /**
   * Optional custom confirmation renderer. When provided, it replaces the
   * default Yes/No dialog while still receiving the runtime-provided
   * `message`. Use this for Phase 2 rich sandbox review.
   */
  readonly renderConfirm?: ConfirmRenderer;
  /**
   * Optional custom elicit renderer. When provided, replaces the default
   * question + options/input dialog.
   */
  readonly renderElicit?: FC<{
    readonly question: string;
    readonly options?: string[];
    readonly onResolve: (value: string) => void;
    readonly onReject: (error: unknown) => void;
  }>;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Provides a `WebUiHost` that renders dialogs for elicit/confirm.
 */
export const WebUiHostProvider: FC<WebUiHostProviderProps> = ({
  children,
  renderConfirm,
  renderElicit,
}) => {
  // Monotonic counter for item identity.  Equality checks on the item
  // reference are unreliable inside nested setState updaters because the
  // callback receives the *next* state, not the captured reference.
  const idRef = useRef(0);

  // Single state slot — elicit and confirm cannot render concurrently.
  const [active, setActive] = useState<ActiveRequest | null>(null);

  // Synchronous ref so that an immediate unmount can reject the promise
  // without waiting for the next effect flush.
  const activeRef = useRef<ActiveRequest | null>(null);

  // Unmount cleanup: reject any active promise via the sync ref.
  useEffect(() => {
    return () => {
      activeRef.current?.reject(new DOMException("Provider unmounted", "AbortError"));
    };
  }, []);

  // Build the WebUiHost implementation. Stable for the provider lifetime.
  const host: WebUiHost = useMemo(() => {
    /**
     * Reject any superseded request, then update the synchronous ref and
     * React state. Each caller owns its signal listener and clear logic.
     */
    function enqueue(req: ActiveRequest): void {
      // Supersede any existing active request.
      const prev = activeRef.current;
      if (prev) {
        prev.reject(new DOMException("Superseded", "AbortError"));
      }

      // Synchronously track the new active request.
      activeRef.current = req;
      setActive(req);
    }

    return {
      elicit(
        question: string,
        options?: string[],
        signal?: AbortSignal,
      ): Promise<string> {
        return new Promise<string>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          const myId = ++idRef.current;
          let settled = false;
          const clear = () => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener("abort", onAbort);
            setActive((prev) => (prev?._id === myId ? null : prev));
            if (activeRef.current?._id === myId) {
              activeRef.current = null;
            }
          };
          const onAbort = () => {
            clear();
            reject(new DOMException("Aborted", "AbortError"));
          };

          const req: ActiveRequest = {
            kind: "elicit",
            _id: myId,
            question,
            options,
            resolve: (v: string) => { clear(); resolve(v); },
            reject: (e: unknown) => { clear(); reject(e); },
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) {
            onAbort();
            return;
          }
          enqueue(req);
        });
      },

      confirm(
        message: string,
        signal?: AbortSignal,
      ): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          const myId = ++idRef.current;
          let settled = false;
          const clear = () => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener("abort", onAbort);
            setActive((prev) => (prev?._id === myId ? null : prev));
            if (activeRef.current?._id === myId) {
              activeRef.current = null;
            }
          };
          const onAbort = () => {
            clear();
            reject(new DOMException("Aborted", "AbortError"));
          };

          const req: ActiveRequest = {
            kind: "confirm",
            _id: myId,
            message,
            resolve: (v: boolean) => { clear(); resolve(v); },
            reject: (e: unknown) => { clear(); reject(e); },
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) {
            onAbort();
            return;
          }
          enqueue(req);
        });
      },
    };
  }, []);

  // ---- Render dialogs ----

  return (
    <WebUiHostContext.Provider value={host}>
      {children}

      {active?.kind === "elicit" && (
        <ElicitDialog
          question={active.question}
          options={active.options}
          resolve={active.resolve}
          reject={active.reject}
          renderElicit={renderElicit}
        />
      )}

      {active?.kind === "confirm" && (
        <ConfirmDialog
          message={active.message}
          resolve={active.resolve}
          reject={active.reject}
          renderConfirm={renderConfirm}
        />
      )}
    </WebUiHostContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Elicit dialog (controlled component)
// ---------------------------------------------------------------------------

const ElicitDialog: FC<{
  question: string;
  options?: string[];
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
  renderElicit?: WebUiHostProviderProps["renderElicit"];
}> = ({ question, options, resolve, reject, renderElicit: CustomElicit }) => {
  if (CustomElicit) {
    return (
      <CustomElicit
        question={question}
        options={options}
        onResolve={resolve}
        onReject={reject}
      />
    );
  }

  return (
    <ElicitDefault
      question={question}
      options={options}
      onResolve={resolve}
      onReject={reject}
    />
  );
};

const ElicitDefault: FC<{
  question: string;
  options?: string[];
  onResolve: (v: string) => void;
  onReject: (e: unknown) => void;
}> = ({ question, options, onResolve, onReject }) => {
  const [text, setText] = useState("");

  return (
    <div
      className="nemoir-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={question}
    >
      <div className="nemoir-modal">
        <p>{question}</p>
        {options && options.length > 0 ? (
          <div className="nemoir-modal-actions">
            {options.map((opt) => (
              <button
                key={opt}
                onClick={() => onResolve(opt)}
                autoFocus={options.indexOf(opt) === 0}
              >
                {opt}
              </button>
            ))}
            <button
              onClick={() =>
                onReject(new DOMException("Cancelled by user", "AbortError"))
              }
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <input
              type="text"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onResolve(text);
              }}
              placeholder="Type your answer…"
              aria-label="Your answer"
            />
            <div className="nemoir-modal-actions">
              <button
                className="nemoir-primary"
                onClick={() => onResolve(text)}
              >
                Submit
              </button>
              <button
                onClick={() =>
                  onReject(
                    new DOMException("Cancelled by user", "AbortError"),
                  )
                }
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

const ConfirmDialog: FC<{
  message: string;
  resolve: (v: boolean) => void;
  reject: (e: unknown) => void;
  renderConfirm?: ConfirmRenderer;
}> = ({ message, resolve, reject, renderConfirm: CustomConfirm }) => {
  if (CustomConfirm) {
    return (
      <CustomConfirm
        message={message}
        onResolve={resolve}
        onReject={reject}
      />
    );
  }

  return (
    <div
      className="nemoir-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={message}
    >
      <div className="nemoir-modal">
        <p
          style={{ whiteSpace: "pre-wrap", maxHeight: "50vh", overflow: "auto" }}
        >
          {message}
        </p>
        <div className="nemoir-modal-actions">
          <button onClick={() => resolve(true)} autoFocus>
            Yes
          </button>
          <button onClick={() => resolve(false)}>No</button>
          <button
            onClick={() =>
              reject(new DOMException("Cancelled by user", "AbortError"))
            }
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
