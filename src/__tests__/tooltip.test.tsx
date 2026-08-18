import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderWithProviders, screen } from "./testUtils";
import { Tooltip, TooltipBubble, useDelegatedTooltip } from "../components/Tooltip";
import { LoadingButton } from "../components/LoadingButton";

// 共有ツールチッププリミティブ (#814/#884) の挙動を固定するテスト。
// 位置決めの算術は `tooltipPosition.test.ts` が純関数として押さえているので、
// ここでは「開く/閉じる」「a11y 結線」「同時に 1 つだけ」という、native `title=`
// を全画面で置き換えるにあたって崩れると困る性質だけを見る。
//
// jsdom は `getBoundingClientRect` が常に 0 を返すため、実座標は検証できない
// (実ブラウザでの見え方は `src/__tests__/browser/` の Chromium スイートの領分)。

// 表示中の吹き出しは `aria-describedby` でトリガーと結ばれている。閉じた吹き出しの
// DOM は exit アニメーションのぶん残りうるので、「今見えているもの」はこの結線を
// たどって取り出す。
function describedText(trigger: HTMLElement): string | null {
  const id = trigger.getAttribute("aria-describedby");
  return id ? document.getElementById(id)?.textContent ?? null : null;
}

describe("Tooltip", () => {
  it("hover では openDelay 経過後に、フォーカスでは即座に表示される", () => {
    vi.useFakeTimers();
    try {
      renderWithProviders(
        <Tooltip label="ヒント" openDelay={400}>
          <button type="button">trigger</button>
        </Tooltip>,
      );
      const trigger = screen.getByRole("button", { name: "trigger" });

      fireEvent.mouseEnter(trigger);
      expect(screen.queryByRole("tooltip")).toBeNull();
      act(() => void vi.advanceTimersByTime(400));
      expect(screen.getByRole("tooltip").textContent).toBe("ヒント");

      // 閉じたことは `aria-describedby` の消滅で見る — 吹き出しの DOM は
      // `AnimatePresence` の exit が終わるまで残る (jsdom では時間が進まない)。
      fireEvent.mouseLeave(trigger);
      expect(trigger.getAttribute("aria-describedby")).toBeNull();

      // キーボードユーザは「まず hover して気付く」段階が無いので遅延を入れない。
      fireEvent.focus(trigger);
      expect(trigger.getAttribute("aria-describedby")).not.toBeNull();
      fireEvent.blur(trigger);
      expect(trigger.getAttribute("aria-describedby")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("表示中はトリガーの aria-describedby が吹き出しを指す", () => {
    renderWithProviders(
      <Tooltip label="説明">
        <button type="button">trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "trigger" });
    expect(trigger.getAttribute("aria-describedby")).toBeNull();

    fireEvent.focus(trigger);
    expect(trigger.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  });

  it("label が空なら children をそのまま描画する (リスナーも吹き出しも足さない)", () => {
    renderWithProviders(
      <Tooltip label={undefined}>
        <button type="button">trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "trigger" });
    fireEvent.focus(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
  });

  it("無効なトリガーでも focusableWrapper でキーボードから到達できる", () => {
    renderWithProviders(
      <Tooltip label="なぜ押せないか" focusableWrapper>
        <button type="button" disabled>
          trigger
        </button>
      </Tooltip>,
    );
    // 無効ボタン自身はタブ順序から外れるので、ラッパー側がフォーカスを受ける。
    const wrapper = screen.getByRole("button", { name: "trigger" }).parentElement!;
    expect(wrapper.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(wrapper);
    expect(screen.getByRole("tooltip").textContent).toBe("なぜ押せないか");
  });

  it("入れ子でも同時に見えるのは 1 つだけ (native title と同じ最内優先)", () => {
    // 一覧の行に行全体のツールチップ、その中のボタンに個別のツールチップ、という
    // #884 の置換で頻出する形。React の onMouseEnter は行 → 子への移動で行側の
    // onMouseLeave を発火しないため、登録簿が無いと 2 つ重なって見えてしまう。
    renderWithProviders(
      <Tooltip label="行のヒント" openDelay={0}>
        <div>
          row
          <Tooltip label="ボタンのヒント" openDelay={0}>
            <button type="button">copy</button>
          </Tooltip>
        </div>
      </Tooltip>,
    );
    const row = screen.getByText(/row/);
    const button = screen.getByRole("button", { name: "copy" });
    fireEvent.mouseEnter(row);
    expect(describedText(row)).toBe("行のヒント");

    fireEvent.mouseEnter(button);
    // 内側が開いた時点で外側は閉じている (どちらが「見えているか」は
    // `aria-describedby` が指しているかで判定する — 閉じた吹き出しの DOM は
    // exit アニメーションのぶんだけ残りうる)。
    expect(row.getAttribute("aria-describedby")).toBeNull();
    expect(describedText(button)).toBe("ボタンのヒント");
  });

  it("親の hover 遅延が保留中でも、先に開いた子を後から蹴散らさない", () => {
    // 親 (遅延あり) に入ってから子 (即時) へ移るケース。所有権を「表示予約の
    // 時点」ではなく「実際に開く時点」で取ると、親の予約タイマーが後から発火して
    // 子を閉じ親が出てしまう。
    vi.useFakeTimers();
    try {
      renderWithProviders(
        <Tooltip label="行のヒント" openDelay={400}>
          <div>
            row
            <Tooltip label="ボタンのヒント" openDelay={0}>
              <button type="button">copy</button>
            </Tooltip>
          </div>
        </Tooltip>,
      );
      const row = screen.getByText(/row/);
      const button = screen.getByRole("button", { name: "copy" });

      fireEvent.mouseEnter(row);
      // 親はまだ遅延中。この間に子へ入る。
      fireEvent.mouseEnter(button);
      expect(describedText(button)).toBe("ボタンのヒント");

      // 親の予約は子の要求時に解除済みなので、遅延が明けても親は開かない。
      act(() => void vi.advanceTimersByTime(1000));
      expect(row.getAttribute("aria-describedby")).toBeNull();
      expect(describedText(button)).toBe("ボタンのヒント");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ref を forward する関数コンポーネント (LoadingButton) にも適用できる", () => {
    // `cloneElement` で注入する測定用 ref が届かないトリガーだと、吹き出しは
    // 出るが位置が決まらない。プロジェクト内で使う代表的なラッパで確認する。
    renderWithProviders(
      <Tooltip label="適用する">
        <LoadingButton variant="success">apply</LoadingButton>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "apply" });
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip").textContent).toBe("適用する");
    expect(trigger.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  });

  it("複数行ラベルは改行を保ったまま表示する (native title と同じ)", () => {
    renderWithProviders(
      <Tooltip label={"ヒント\n\nSELECT 1"}>
        <button type="button">trigger</button>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "trigger" }));
    expect(screen.getByRole("tooltip").textContent).toBe("ヒント\n\nSELECT 1");
  });
});

describe("useDelegatedTooltip", () => {
  function DelegatedList({ openDelay }: { openDelay?: number }) {
    const { hovered, bind } = useDelegatedTooltip(openDelay);
    return (
      <div>
        <div {...bind("1 行目の説明")}>row1</div>
        <div {...bind("2 行目の説明")}>row2</div>
        <div {...bind(null)}>row3</div>
        {hovered && <TooltipBubble label={hovered.label} anchor={hovered.rect} />}
      </div>
    );
  }

  it("行ごとに 1 つの共有バブルを出し、離れると消える", () => {
    renderWithProviders(<DelegatedList openDelay={0} />);
    fireEvent.mouseEnter(screen.getByText("row1"));
    expect(screen.getByRole("tooltip").textContent).toBe("1 行目の説明");

    // 別の行へ移ってもバブルは 1 つのまま中身だけ入れ替わる。
    fireEvent.mouseEnter(screen.getByText("row2"));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip").textContent).toBe("2 行目の説明");

    fireEvent.mouseLeave(screen.getByText("row2"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("委譲側も hover 遅延を持つ (グリッドのセルやツリーの行を通過しただけでは出ない)", () => {
    // 委譲版は行/セル数に比例する一覧で使うため、遅延が無いとポインタの移動に
    // 追従して吹き出しが次々に開き、`Tooltip` 本体 (遅延あり) との体感差も出る。
    vi.useFakeTimers();
    try {
      renderWithProviders(<DelegatedList openDelay={400} />);
      const row1 = screen.getByText("row1");

      fireEvent.mouseEnter(row1);
      expect(screen.queryByRole("tooltip")).toBeNull();
      act(() => void vi.advanceTimersByTime(399));
      expect(screen.queryByRole("tooltip")).toBeNull();
      act(() => void vi.advanceTimersByTime(1));
      expect(screen.getByRole("tooltip").textContent).toBe("1 行目の説明");

      // 通過しただけ (遅延が明ける前に離脱) なら、あとから開くことはない。
      fireEvent.mouseLeave(row1);
      fireEvent.mouseEnter(screen.getByText("row2"));
      fireEvent.mouseLeave(screen.getByText("row2"));
      act(() => void vi.advanceTimersByTime(1000));
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("label が無い行にはリスナーを付けない", () => {
    renderWithProviders(<DelegatedList openDelay={0} />);
    fireEvent.mouseEnter(screen.getByText("row3"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
