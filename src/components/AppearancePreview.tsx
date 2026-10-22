import { chakra } from "@chakra-ui/react";
import { useAnimate, useReducedMotionConfig } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { t } from "../i18n";
import { durations, easings } from "../motion";
import { prefersStaticMotion } from "./revealOrigin";

/**
 * 設定「表示」セクションのライブ・アピアランス・プレビュー (#1581)。
 *
 * ツールバー 1 個 + サイドバー行 + 結果の行 (選択中を含む) + SQL トークン列からなる
 * ミニ・アプリクロームのモック。色・余白・文字サイズはすべて `app.*` / `syntax.*` トークンと
 * `--density-*` 変数を参照するだけなので、テーマ / アクセント / 密度 / フォント拡大 /
 * シンタックス配色の変更はそのまま映る (値の二重管理なし)。
 * `previewVars` を渡すと、その CSS 変数だけをモックの範囲で上書きして「選ぶ前」の
 * 見た目を出す (`appearancePreviewVars`)。色の切替は短い transition でクロスフェードする
 * (reduced-motion では App.css のグローバル規則が無効化する)。
 *
 * #1781: マウント後と、確定した設定値 (`replayKey`) が変わるたびに 1 回ずつ、RunButton の押下 → 結果行の選択ハイライトが 1 行下へ滑る →
 * ハイライト枠が一瞬光る、という控えめなデモを再生する。ループしない。画面内・タブ可視に
 * なるまで待ち、`useAnimate` で DOM を直接動かす (React の再描画なし)。
 * 終了状態は従来の静止表示 (2 行目が選択) と同じで、reduced-motion (OS / アプリ内設定) と
 * ハイコントラストは最初からその終了状態を出す。再生中に reduced へ切り替わったら直ちに
 * 終了状態へ止める。
 */

const fade = {
  transitionProperty: "background-color, color, border-color",
  transitionDuration: "var(--dur-med)",
  transitionTimingFunction: "var(--ease-out)",
};

const Frame = chakra("div", {
  base: {
    borderWidth: "1px",
    borderColor: "app.borderStrong",
    borderRadius: "md",
    bg: "app.bg",
    color: "app.text",
    overflow: "hidden",
    fontSize: "sm",
    ...fade,
  },
});

const Toolbar = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "2",
    px: "2",
    py: "1.5",
    bg: "app.toolbar",
    borderBottomWidth: "1px",
    borderColor: "app.border",
    ...fade,
  },
});

const RunButton = chakra("span", {
  base: {
    px: "2",
    py: "0.5",
    borderRadius: "sm",
    display: "inline-block",
    bg: "app.accent",
    color: "app.accentText",
    fontSize: "xs",
    fontWeight: 600,
    ...fade,
  },
});

const Body = chakra("div", { base: { display: "flex" } });

const Sidebar = chakra("div", {
  base: {
    width: "28%",
    display: "flex",
    flexDirection: "column",
    borderRightWidth: "1px",
    borderColor: "app.border",
    bg: "app.surface",
    py: "1",
    ...fade,
  },
});

const SideRow = chakra("div", {
  base: {
    px: "2",
    fontSize: "xs",
    color: "app.textSecondary",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    ...fade,
  },
  variants: {
    selected: {
      true: { bg: "app.accentHighlight", color: "app.text", fontWeight: 600 },
    },
  },
});

const Main = chakra("div", { base: { flex: 1, minWidth: 0 } });

/** 選択行の下地。2 行目に絶対配置し、デモ中は 1 行上 (-100%) から滑り降りる。 */
const SelBar = chakra("span", {
  base: {
    position: "absolute",
    inset: 0,
    bg: "app.accentHighlight",
    pointerEvents: "none",
    ...fade,
  },
});

/** 着地時に一瞬光る枠 (apply-flash の縮小版)。 */
const SelFlash = chakra("span", {
  base: {
    position: "absolute",
    inset: 0,
    borderWidth: "1px",
    borderColor: "app.accent",
    opacity: 0,
    pointerEvents: "none",
  },
});

const Sql = chakra("div", {
  base: {
    px: "2",
    py: "1.5",
    fontFamily: "mono",
    fontSize: "xs",
    borderBottomWidth: "1px",
    borderColor: "app.border",
    whiteSpace: "nowrap",
    overflow: "hidden",
    ...fade,
  },
});

const GridRow = chakra("div", {
  base: {
    position: "relative",
    display: "flex",
    gap: "3",
    fontSize: "xs",
    ...fade,
  },
  variants: {
    kind: {
      head: { bg: "app.header", color: "app.textMuted", fontWeight: 600 },
      body: { color: "app.text" },
      selected: { color: "app.text" },
    },
  },
});

// セルは選択下地 (SelBar) より前面に出す。
const Cell = chakra("span", {
  base: {
    position: "relative",
    zIndex: 1,
    flex: 1,
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

// 行の縦余白・横余白は表示密度 (--density-cell-*) をそのまま使う。
const rowPad: CSSProperties = {
  paddingBlock: "var(--density-cell-py)",
  paddingInline: "var(--density-cell-px)",
};

/** 見えてから開始までの待ち / 設定変更連打のデバウンス (ms)。 */
const START_DELAY_MS = 250;
/** デモを始める可視割合。 */
const VISIBLE_RATIO = 0.6;
const START_TRANSFORM = "translateY(-100%)";

/**
 * `replayKey` は「確定した設定値」の識別子 (ホバー中の previewVars は含めない)。変わるたびに
 * 1 回だけデモを再生し直す (連打は START_DELAY_MS でまとめる)。
 */
export function AppearancePreview({
  previewVars,
  replayKey = "",
}: {
  previewVars?: Record<string, string>;
  replayKey?: string;
}) {
  const reduced = useReducedMotionConfig() ?? false;
  const [scope, animate] = useAnimate<HTMLDivElement>();
  // 初回描画だけに使う。静止なら最初から終了状態、デモなら 1 行上から始める。
  const [armed] = useState(() => !reduced && !prefersStaticMotion());
  // 再生を始めた replayKey。同じキーでは reduced の切替などで再生し直さない。
  const playedKey = useRef<string | null>(null);

  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    const bar = root.querySelector<HTMLElement>("[data-demo='bar']");
    const run = root.querySelector<HTMLElement>("[data-demo='run']");
    const flash = root.querySelector<HTMLElement>("[data-demo='flash']");
    if (!bar || !run || !flash) return;
    const settle = () => {
      bar.style.transform = "";
      run.style.transform = "";
      flash.style.opacity = "";
    };
    // reduced と再生済みのキーは終了状態のまま。hc の判定は play() だけで行う (data-theme の更新が
    // 子の effect より後になりうるため、ここで見ると古い値で誤判定する)。再生中に reduced へ変わった
    // 場合は前回の cleanup が止めて settle 済み。
    if (reduced || playedKey.current === replayKey) {
      settle();
      return;
    }
    // 初回だけ開始位置 (1 行上) を先に置く (StrictMode の二重 effect でも cleanup の settle を打ち消す)。
    // 2 回目以降は動きなしで 1 行目へ跳ばないよう、play() の押下の直前に移す。
    if (playedKey.current === null && !prefersStaticMotion()) bar.style.transform = START_TRANSFORM;
    let started = false;
    let stopped = false;
    const controls: { stop: () => void }[] = [];
    const play = async () => {
      if (started || stopped) return;
      if (prefersStaticMotion()) {
        settle();
        return;
      }
      started = true;
      playedKey.current = replayKey;
      bar.style.transform = START_TRANSFORM;
      const press = animate(run, { scale: [1, 0.92, 1] }, { duration: durations.base, ease: easings.out });
      controls.push(press);
      await press;
      if (stopped) return;
      const glide = animate(bar, { y: ["-100%", "0%"] }, { duration: durations.med, ease: easings.out });
      controls.push(glide);
      await glide;
      if (stopped) return;
      const blink = animate(flash, { opacity: [0, 1, 0] }, { duration: durations.slow, ease: easings.out });
      controls.push(blink);
      await blink;
      if (!stopped) settle();
    };
    // 画面内・タブ可視になってから START_DELAY_MS 待って 1 回だけ始める。
    let timer: number | undefined;
    let io: IntersectionObserver | null = null;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void play(), START_DELAY_MS);
    };
    const observe = () => {
      if (io || started || stopped || document.visibilityState !== "visible") return;
      if (typeof IntersectionObserver === "undefined") {
        schedule();
        return;
      }
      io = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((e) => e.isIntersecting);
          if (visible) schedule();
          else window.clearTimeout(timer);
        },
        { threshold: VISIBLE_RATIO },
      );
      io.observe(root);
    };
    document.addEventListener("visibilitychange", observe);
    observe();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", observe);
      io?.disconnect();
      for (const c of controls) c.stop();
      settle();
    };
  }, [reduced, replayKey, animate, scope]);

  return (
    <Frame
      ref={scope}
      role="img"
      aria-label={t("settingsAppearancePreviewLabel")}
      data-testid="appearance-preview"
      style={previewVars as CSSProperties | undefined}
    >
      <Toolbar>
        <RunButton data-demo="run">{t("settingsAppearancePreviewRun")}</RunButton>
        <chakra.span textStyle="caption">{t("settingsAppearancePreviewConn")}</chakra.span>
      </Toolbar>
      <Body>
        <Sidebar>
          <SideRow style={{ paddingBlock: "var(--density-tree-py)" }}>users</SideRow>
          <SideRow selected style={{ paddingBlock: "var(--density-tree-py)" }}>
            orders
          </SideRow>
          <SideRow style={{ paddingBlock: "var(--density-tree-py)" }}>items</SideRow>
        </Sidebar>
        <Main>
          <Sql>
            <chakra.span color="app.syntax.keyword">SELECT</chakra.span> id,{" "}
            <chakra.span color="app.syntax.function">COUNT</chakra.span>(*){" "}
            <chakra.span color="app.syntax.keyword">FROM</chakra.span> orders{" "}
            <chakra.span color="app.syntax.keyword">WHERE</chakra.span> total{" "}
            <chakra.span color="app.syntax.operator">&gt;</chakra.span>{" "}
            <chakra.span color="app.syntax.number">100</chakra.span>{" "}
            <chakra.span color="app.syntax.string">&apos;paid&apos;</chakra.span>{" "}
            <chakra.span color="app.syntax.comment">-- sample</chakra.span>
          </Sql>
          <GridRow kind="head" style={rowPad}>
            <Cell>id</Cell>
            <Cell>status</Cell>
            <Cell>total</Cell>
          </GridRow>
          <GridRow kind="body" style={rowPad}>
            <Cell>1</Cell>
            <Cell>paid</Cell>
            <Cell>120</Cell>
          </GridRow>
          <GridRow kind="selected" style={rowPad}>
            <SelBar data-demo="bar" style={armed ? { transform: START_TRANSFORM } : undefined}>
              <SelFlash data-demo="flash" />
            </SelBar>
            <Cell>2</Cell>
            <Cell>pending</Cell>
            <Cell>80</Cell>
          </GridRow>
        </Main>
      </Body>
    </Frame>
  );
}
