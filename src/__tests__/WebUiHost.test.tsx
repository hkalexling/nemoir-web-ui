/**
 * `WebUiHostProvider` and `useWebUiHost` tests.
 *
 * Verifies:
 * - elicit dialog: text input + options, resolution, cancellation
 * - confirm dialog: yes/no resolution, cancellation
 * - AbortError rejection via AbortSignal
 * - Unmount cleanup (including immediate unmount before effect flush)
 * - Safe concurrent request handling (same-kind and cross-kind supersession)
 * - Custom renderer slots
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  useState,
  createElement,
  Component,
  type FC,
  type ReactNode,
} from "react";
import {
  WebUiHostProvider,
  useWebUiHost,
  type ConfirmRendererProps,
  type WebUiHostProviderProps,
} from "../WebUiHostProvider.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const Tester: FC<{
  onHost: (fn: {
    elicit: (q: string, o?: string[], s?: AbortSignal) => Promise<string>;
    confirm: (m: string, s?: AbortSignal) => Promise<boolean>;
  }) => void;
}> = ({ onHost }) => {
  const host = useWebUiHost();
  const [captured, setCaptured] = useState(false);
  if (!captured) {
    setCaptured(true);
    queueMicrotask(() => onHost({
      elicit: (q, o, s) => host.elicit(q, o, s),
      confirm: (m, s) => host.confirm(m, s),
    }));
  }
  return <div data-testid="tester" />;
};

async function renderProvider(
  props?: Partial<WebUiHostProviderProps>,
): Promise<{
  host: {
    elicit: (q: string, o?: string[], s?: AbortSignal) => Promise<string>;
    confirm: (m: string, s?: AbortSignal) => Promise<boolean>;
  };
  unmount: () => void;
}> {
  return new Promise((resolveHost) => {
    const { unmount } = render(
      <WebUiHostProvider {...props}>
        <Tester
          onHost={(h) => resolveHost({ host: h, unmount })}
        />
      </WebUiHostProvider>,
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebUiHostProvider", () => {
  describe("elicit", () => {
    it("renders a text input and resolves with the entered value", async () => {
      const { host } = await renderProvider();
      const user = userEvent.setup();

      let result: string | undefined;
      await act(async () => {
        host.elicit("What is your name?").then((v) => { result = v; });
      });

      expect(screen.getByText("What is your name?")).toBeInTheDocument();

      const input = screen.getByLabelText("Your answer");
      await user.type(input, "Alice");
      await user.click(screen.getByText("Submit"));

      await waitFor(() => expect(result).toBe("Alice"));
      expect(screen.queryByText("What is your name?")).not.toBeInTheDocument();
    });

    it("renders option buttons when options are provided", async () => {
      const { host } = await renderProvider();
      const user = userEvent.setup();

      let result: string | undefined;
      await act(async () => {
        host.elicit("Pick one", ["Red", "Green", "Blue"]).then((v) => { result = v; });
      });

      expect(screen.getByText("Pick one")).toBeInTheDocument();
      expect(screen.getByText("Red")).toBeInTheDocument();
      expect(screen.getByText("Green")).toBeInTheDocument();
      expect(screen.getByText("Blue")).toBeInTheDocument();

      await user.click(screen.getByText("Green"));
      await waitFor(() => expect(result).toBe("Green"));
    });

    it("resolves on Enter key press", async () => {
      const { host } = await renderProvider();
      const user = userEvent.setup();

      let result: string | undefined;
      await act(async () => {
        host.elicit("Enter something").then((v) => { result = v; });
      });

      const input = screen.getByLabelText("Your answer");
      await user.type(input, "value{Enter}");
      await waitFor(() => expect(result).toBe("value"));
    });

    it("rejects with AbortError when Cancel is clicked", async () => {
      const { host } = await renderProvider();
      const user = userEvent.setup();

      let error: unknown;
      await act(async () => {
        host.elicit("Question").catch((e) => { error = e; });
      });

      await user.click(screen.getByText("Cancel"));
      await waitFor(() => {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).message).toContain("Cancelled by user");
      });
    });

    it("rejects with AbortError when signal fires", async () => {
      const { host } = await renderProvider();

      const ac = new AbortController();
      let error: unknown;
      await act(async () => {
        host.elicit("Q", undefined, ac.signal).catch((e) => { error = e; });
      });

      expect(screen.getByText("Q")).toBeInTheDocument();

      act(() => ac.abort());

      await waitFor(() => {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe("AbortError");
      });
      expect(screen.queryByText("Q")).not.toBeInTheDocument();
    });

    it("rejects immediately when signal is already aborted", async () => {
      const { host } = await renderProvider();

      const ac = new AbortController();
      ac.abort();

      await expect(host.elicit("Q", undefined, ac.signal)).rejects.toThrow(
        "Aborted",
      );
    });
  });

  describe("confirm", () => {
    it("renders a message and resolves true on Yes", async () => {
      const { host } = await renderProvider();
      const user = userEvent.setup();

      let result: boolean | undefined;
      await act(async () => {
        host.confirm("Are you sure?").then((v) => { result = v; });
      });

      expect(screen.getByText("Are you sure?")).toBeInTheDocument();

      await user.click(screen.getByText("Yes"));
      await waitFor(() => expect(result).toBe(true));
    });

    it("resolves false on No", async () => {
      const { host } = await renderProvider();
      const user = userEvent.setup();

      let result: boolean | undefined;
      await act(async () => {
        host.confirm("Proceed?").then((v) => { result = v; });
      });

      await user.click(screen.getByText("No"));
      await waitFor(() => expect(result).toBe(false));
    });

    it("rejects with AbortError on Cancel", async () => {
      const { host } = await renderProvider();
      const user = userEvent.setup();

      let error: unknown;
      await act(async () => {
        host.confirm("Sure?").catch((e) => { error = e; });
      });

      await user.click(screen.getByText("Cancel"));
      await waitFor(() => {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).message).toContain("Cancelled by user");
      });
    });

    it("rejects with AbortError when signal fires", async () => {
      const { host } = await renderProvider();

      const ac = new AbortController();
      let error: unknown;
      await act(async () => {
        host.confirm("OK?", ac.signal).catch((e) => { error = e; });
      });

      expect(screen.getByText("OK?")).toBeInTheDocument();

      act(() => ac.abort());

      await waitFor(() => {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe("AbortError");
      });
      expect(screen.queryByText("OK?")).not.toBeInTheDocument();
    });
  });

  describe("unmount cleanup", () => {
    it("rejects pending elicit with AbortError on unmount", async () => {
      const { host, unmount } = await renderProvider();

      let error: unknown;
      await act(async () => {
        host.elicit("Q").catch((e) => { error = e; });
      });

      expect(screen.getByText("Q")).toBeInTheDocument();

      unmount();

      await waitFor(() => {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).message).toContain("Provider unmounted");
      });
    });

    it("rejects pending confirm with AbortError on unmount", async () => {
      const { host, unmount } = await renderProvider();

      let error: unknown;
      await act(async () => {
        host.confirm("OK?").catch((e) => { error = e; });
      });

      expect(screen.getByText("OK?")).toBeInTheDocument();

      unmount();

      await waitFor(() => {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).message).toContain("Provider unmounted");
      });
    });

    it("rejects a request when provider is unmounted immediately after eliciting (sync ref)", async () => {
      // This test verifies that the synchronous activeRef catches the request
      // even before the next effect flush.  We use a minimal setup that does
      // NOT go through the async renderProvider harness so we can synchronously
      // call elicit and then unmount in the same microtask.
      const Child: FC<{ onHost: (h: ReturnType<typeof useWebUiHost>) => void }> = ({ onHost }) => {
        const host = useWebUiHost();
        const [sent, setSent] = useState(false);
        if (!sent) {
          setSent(true);
          onHost(host);
        }
        return null;
      };

      let hostFromChild: ReturnType<typeof useWebUiHost> | undefined;
      const { unmount } = render(
        <WebUiHostProvider>
          <Child onHost={(h) => { hostFromChild = h; }} />
        </WebUiHostProvider>,
      );

      // Now synchronously elicit and unmount.
      let error: unknown;
      hostFromChild!.elicit("immediate").catch((e) => { error = e; });
      unmount();

      await waitFor(() => {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).message).toContain("Provider unmounted");
      });
    });
  });

  describe("concurrent requests", () => {
    it("supersedes older elicit with a new elicit", async () => {
      const { host } = await renderProvider();
      const user = userEvent.setup();

      let error1: unknown;
      await act(async () => {
        host.elicit("First").catch((e) => { error1 = e; });
      });

      expect(screen.getByText("First")).toBeInTheDocument();

      let result2: string | undefined;
      await act(async () => {
        host.elicit("Second").then((v) => { result2 = v; });
      });

      await waitFor(() => {
        expect(error1).toBeInstanceOf(DOMException);
        expect((error1 as DOMException).message).toContain("Superseded");
      });

      expect(screen.getByText("Second")).toBeInTheDocument();
      expect(screen.queryByText("First")).not.toBeInTheDocument();

      const input = screen.getByLabelText("Your answer");
      await user.type(input, "two{Enter}");
      await waitFor(() => expect(result2).toBe("two"));
    });

    it("supersedes older confirm with a new confirm", async () => {
      const { host } = await renderProvider();
      const user = userEvent.setup();

      let error1: unknown;
      await act(async () => {
        host.confirm("First confirm").catch((e) => { error1 = e; });
      });

      let result2: boolean | undefined;
      await act(async () => {
        host.confirm("Second confirm").then((v) => { result2 = v; });
      });

      await waitFor(() => {
        expect(error1).toBeInstanceOf(DOMException);
        expect((error1 as DOMException).message).toContain("Superseded");
      });

      expect(screen.getByText("Second confirm")).toBeInTheDocument();

      await user.click(screen.getByText("Yes"));
      await waitFor(() => expect(result2).toBe(true));
    });

    /** Cross-kind: elicit followed by confirm — confirm supersedes elicit. */
    it("supersedes an active elicit when a confirm arrives", async () => {
      const { host } = await renderProvider();

      let elicitError: unknown;
      await act(async () => {
        host.elicit("A question").catch((e) => { elicitError = e; });
      });

      expect(screen.getByText("A question")).toBeInTheDocument();

      let confirmResult: boolean | undefined;
      await act(async () => {
        host.confirm("Are you sure?").then((v) => { confirmResult = v; });
      });

      // The elicit should be superseded.
      await waitFor(() => {
        expect(elicitError).toBeInstanceOf(DOMException);
        expect((elicitError as DOMException).message).toContain("Superseded");
      });

      // Only the confirm dialog should be visible.
      expect(screen.getByText("Are you sure?")).toBeInTheDocument();
      expect(screen.queryByText("A question")).not.toBeInTheDocument();

      // Resolve the confirm.
      const user = userEvent.setup();
      await user.click(screen.getByText("Yes"));
      await waitFor(() => expect(confirmResult).toBe(true));
    });

    /** Cross-kind: confirm followed by elicit — elicit supersedes confirm. */
    it("supersedes an active confirm when an elicit arrives", async () => {
      const { host } = await renderProvider();

      let confirmError: unknown;
      await act(async () => {
        host.confirm("Sure?").catch((e) => { confirmError = e; });
      });

      expect(screen.getByText("Sure?")).toBeInTheDocument();

      let elicitResult: string | undefined;
      await act(async () => {
        host.elicit("What now?").then((v) => { elicitResult = v; });
      });

      // The confirm should be superseded.
      await waitFor(() => {
        expect(confirmError).toBeInstanceOf(DOMException);
        expect((confirmError as DOMException).message).toContain("Superseded");
      });

      // Only the elicit dialog should be visible.
      expect(screen.getByText("What now?")).toBeInTheDocument();
      expect(screen.queryByText("Sure?")).not.toBeInTheDocument();

      // Resolve the elicit.
      const user = userEvent.setup();
      const input = screen.getByLabelText("Your answer");
      await user.type(input, "next{Enter}");
      await waitFor(() => expect(elicitResult).toBe("next"));
    });
  });

  describe("custom renderers", () => {
    it("uses custom confirm renderer when provided", async () => {
      const CustomConfirm: FC<ConfirmRendererProps> = ({
        message,
        onResolve,
      }) => (
        <div data-testid="custom-confirm">
          <span data-testid="custom-message">{message}</span>
          <button onClick={() => onResolve(true)} data-testid="custom-yes">
            Approve
          </button>
        </div>
      );

      const { host } = await renderProvider({ renderConfirm: CustomConfirm });
      const user = userEvent.setup();

      let result: boolean | undefined;
      await act(async () => {
        host.confirm("Custom message here").then((v) => { result = v; });
      });

      expect(screen.getByTestId("custom-confirm")).toBeInTheDocument();
      expect(screen.getByTestId("custom-message")).toHaveTextContent(
        "Custom message here",
      );
      expect(screen.queryByText("Yes")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("custom-yes"));
      await waitFor(() => expect(result).toBe(true));
    });

    it("uses custom elicit renderer when provided", async () => {
      const CustomElicit: FC<{
        question: string;
        options?: string[];
        onResolve: (v: string) => void;
        onReject: (e: unknown) => void;
      }> = ({ question, onResolve, onReject }) => (
        <div data-testid="custom-elicit">
          <span data-testid="custom-q">{question}</span>
          <button onClick={() => onResolve("custom-value")} data-testid="custom-ok">
            OK
          </button>
          <button
            onClick={() =>
              onReject(new DOMException("nope", "AbortError"))
            }
            data-testid="custom-cancel"
          >
            Cancel
          </button>
        </div>
      );

      const { host } = await renderProvider({ renderElicit: CustomElicit });
      const user = userEvent.setup();

      let result: string | undefined;
      await act(async () => {
        host.elicit("Custom q").then((v) => { result = v; });
      });

      expect(screen.getByTestId("custom-elicit")).toBeInTheDocument();
      expect(screen.getByTestId("custom-q")).toHaveTextContent("Custom q");
      expect(screen.queryByLabelText("Your answer")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("custom-ok"));
      await waitFor(() => expect(result).toBe("custom-value"));
    });
  });

  describe("useWebUiHost error", () => {
    it("throws when used outside provider", () => {
      function BadComponent(): ReactNode {
        useWebUiHost();
        return null;
      }

      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      let caught: string | null = null;

      class ErrorBoundary extends Component<
        { children: ReactNode },
        { error: Error | null }
      > {
        constructor(props: { children: ReactNode }) {
          super(props);
          this.state = { error: null };
        }
        static getDerivedStateFromError(error: Error) {
          return { error };
        }
        render() {
          if (this.state.error) {
            caught = this.state.error.message;
            return null;
          }
          return this.props.children;
        }
      }

      render(
        createElement(ErrorBoundary, null, createElement(BadComponent)),
      );
      expect(caught).toBeTruthy();
      expect(caught).toContain(
        "useWebUiHost() must be used within a <WebUiHostProvider>",
      );

      spy.mockRestore();
    });
  });
});
