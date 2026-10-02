import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, act, fireEvent } from "./testUtils";
import { WorkspaceSurface } from "../components/WorkspaceSurface";
import {
  KeepAlive,
  useKeepAliveActive,
  useRefreshOnReactivate,
} from "../components/KeepAlive";

/**
 * keep-alive の器 (#1311)。サイドバー / ボトムパネル / 全画面サーフェスの切替が
 * 「離れても中身を破棄しない」ことの土台。
 */

function Probe({ name, onMount }: { name: string; onMount: (n: string) => void }) {
  const active = useKeepAliveActive();
  useEffect(() => {
    onMount(name);
  }, [name, onMount]);
  return (
    <div data-testid={`probe-${name}`} data-active={String(active)}>
      {name}
    </div>
  );
}

function Host({ tab, limit = 4, resetKey, onMount }: {
  tab: string | null;
  limit?: number;
  resetKey?: string | null;
  onMount: (n: string) => void;
}) {
  return (
    <KeepAlive activeKey={tab} limit={limit} resetKey={resetKey}>
      {tab ? <Probe name={tab} onMount={onMount} /> : null}
    </KeepAlive>
  );
}

describe("KeepAlive (#1311)", () => {
  it("タブを往復しても中身を再マウントしない (state が残る)", () => {
    const onMount = vi.fn();
    const view = renderWithProviders(<Host tab="a" onMount={onMount} />);
    view.rerender(<Host tab="b" onMount={onMount} />);
    view.rerender(<Host tab="a" onMount={onMount} />);
    view.rerender(<Host tab="b" onMount={onMount} />);
    expect(onMount.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("非アクティブな中身は hidden + inert で残り、フォーカス・読み上げから外れる", () => {
    const onMount = vi.fn();
    const view = renderWithProviders(<Host tab="a" onMount={onMount} />);
    view.rerender(<Host tab="b" onMount={onMount} />);
    const a = screen.getByTestId("probe-a", { exact: true });
    const wrapA = a.parentElement as HTMLElement;
    expect(wrapA).toHaveAttribute("hidden");
    expect(wrapA).toHaveAttribute("inert");
    expect(wrapA.style.display).toBe("none");
    const wrapB = screen.getByTestId("probe-b").parentElement as HTMLElement;
    expect(wrapB).not.toHaveAttribute("hidden");
    expect(wrapB).not.toHaveAttribute("inert");
  });

  it("中身は useKeepAliveActive で非表示を知る (ポーリングを止める合図)", () => {
    const onMount = vi.fn();
    const view = renderWithProviders(<Host tab="a" onMount={onMount} />);
    expect(screen.getByTestId("probe-a")).toHaveAttribute("data-active", "true");
    view.rerender(<Host tab="b" onMount={onMount} />);
    expect(screen.getByTestId("probe-a")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("probe-b")).toHaveAttribute("data-active", "true");
    view.rerender(<Host tab="a" onMount={onMount} />);
    expect(screen.getByTestId("probe-a")).toHaveAttribute("data-active", "true");
  });

  it("非アクティブな中身は親の再レンダーで描き直されない (最後の要素を再利用)", () => {
    const renders = vi.fn();
    function Counter() {
      renders();
      return <div>c</div>;
    }
    function App({ tab, tick }: { tab: string; tick: number }) {
      return (
        <KeepAlive activeKey={tab} limit={4}>
          {tab === "a" ? <Counter key={tick} /> : <div>other</div>}
        </KeepAlive>
      );
    }
    const view = renderWithProviders(<App tab="a" tick={0} />);
    view.rerender(<App tab="b" tick={0} />);
    const before = renders.mock.calls.length;
    // 非アクティブの間に親の入力が変わっても a は再描画されない。
    view.rerender(<App tab="b" tick={1} />);
    view.rerender(<App tab="b" tick={2} />);
    expect(renders.mock.calls.length).toBe(before);
  });

  it("上限を超えたら最も長く使われていない中身から破棄する", () => {
    const onMount = vi.fn();
    const view = renderWithProviders(<Host tab="a" limit={2} onMount={onMount} />);
    view.rerender(<Host tab="b" limit={2} onMount={onMount} />);
    view.rerender(<Host tab="c" limit={2} onMount={onMount} />);
    expect(screen.queryByTestId("probe-a")).toBeNull();
    expect(screen.getByTestId("probe-b")).toBeInTheDocument();
    expect(screen.getByTestId("probe-c")).toBeInTheDocument();
    // 捨てられた a へ戻ると作り直される。
    view.rerender(<Host tab="a" limit={2} onMount={onMount} />);
    expect(onMount.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c", "a"]);
  });

  it("resetKey が変わったら保持している中身をすべて捨てる", () => {
    const onMount = vi.fn();
    const view = renderWithProviders(<Host tab="a" resetKey="s1" onMount={onMount} />);
    view.rerender(<Host tab="b" resetKey="s1" onMount={onMount} />);
    view.rerender(<Host tab="b" resetKey="s2" onMount={onMount} />);
    expect(screen.queryByTestId("probe-a")).toBeNull();
    expect(onMount.mock.calls.map((c) => c[0])).toEqual(["a", "b", "b"]);
  });

  it("activeKey が null なら全部を隠す (保持は続く)", () => {
    const onMount = vi.fn();
    const view = renderWithProviders(<Host tab="a" onMount={onMount} />);
    view.rerender(<Host tab={null} onMount={onMount} />);
    expect(screen.getByTestId("probe-a").parentElement).toHaveAttribute("hidden");
    view.rerender(<Host tab="a" onMount={onMount} />);
    expect(onMount).toHaveBeenCalledTimes(1);
  });
});

describe("useRefreshOnReactivate (#1311)", () => {
  function Refresher({ refresh }: { refresh: () => void }) {
    const active = useKeepAliveActive();
    useRefreshOnReactivate(active, refresh);
    return null;
  }
  it("非アクティブ → アクティブに戻ったときだけ 1 度呼ぶ (初回マウントでは呼ばない)", () => {
    const refresh = vi.fn();
    function App({ tab }: { tab: string }) {
      return (
        <KeepAlive activeKey={tab} limit={4}>
          {tab === "a" ? <Refresher refresh={refresh} /> : <div />}
        </KeepAlive>
      );
    }
    const view = renderWithProviders(<App tab="a" />);
    expect(refresh).not.toHaveBeenCalled();
    view.rerender(<App tab="b" />);
    expect(refresh).not.toHaveBeenCalled();
    view.rerender(<App tab="a" />);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

/**
 * 完了条件: 記録のような中身自身の state は、別のタブへ移っても消えず、interval も
 * (自分で止めない限り) 回り続ける。実パネルは `queryInspectorPanel.test.tsx` 側。
 */
describe("keep-alive 越しの state と interval (#1311)", () => {
  it("別タブへ移っても state と interval が生き続ける", () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      function Recorder() {
        const [rec] = useState(true);
        const n = useRef(0);
        useEffect(() => {
          if (!rec) return;
          const h = setInterval(() => {
            n.current += 1;
            ticks = n.current;
          }, 1000);
          return () => clearInterval(h);
        }, [rec]);
        return <div>rec</div>;
      }
      function App({ tab }: { tab: string }) {
        return (
          <KeepAlive activeKey={tab} limit={4}>
            {tab === "inspector" ? <Recorder /> : <div>other</div>}
          </KeepAlive>
        );
      }
      const view = renderWithProviders(<App tab="inspector" />);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      view.rerender(<App tab="processes" />);
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(ticks).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WorkspaceSurface と keep-alive (#1311)", () => {
  it("非表示の間は Escape に反応せず、表示中だけ閉じる", () => {
    const onClose = vi.fn();
    function App({ tab }: { tab: string }) {
      return (
        <KeepAlive activeKey={tab} limit={4}>
          {tab === "erd" ? (
            <WorkspaceSurface view="erd" onClose={onClose}>
              <div>erd</div>
            </WorkspaceSurface>
          ) : (
            <div>other</div>
          )}
        </KeepAlive>
      );
    }
    const view = renderWithProviders(<App tab="erd" />);
    view.rerender(<App tab="other" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    view.rerender(<App tab="erd" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
