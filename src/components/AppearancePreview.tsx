import { chakra } from "@chakra-ui/react";
import { useAnimate, useReducedMotionConfig } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { t } from "../i18n";
import { durations, easings } from "../motion";

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
 * #1781: マウント後に 1 回だけ、RunButton の押下 → 結果行の選択ハイライトが 1 行下へ滑る →
 * ハイライト枠が一瞬光る、という控えめなデモを再生する。ループしない。画面内・タブ可視に
 * なるまで待ち、`Element.animate` (WAAPI) で動かすので React の再描画は伴わない。
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

/** ハイコントラスト (hc-* / forced-colors) は装飾的な動きを出さない (useGlideFrame と同方針)。 */
function prefersStaticMotion(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.getAttribute("data-theme")?.startsWith("hc-")) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches;
}

export function AppearancePreview({ previewVars }: { previewVars?: Record<string, string> }) {
  const reduced = useReducedMotionConfig() ?? false;
  const [scope, animate] = useAnimate<HTMLDivElement>();
  // 初回描画時に決める。静止なら最初から終了状態、デモなら 1 行上から始める。
  const [armed] = useState(() => !reduced && !prefersStaticMotion());
  const played = useRef(false);

  useEffect(() => {
    const root = scope.current;
    // 再生中に reduced-motion へ切り替わったら cleanup がデモを止めて終了状態にする。
    if (!armed || reduced || played.current || !root) return;
    const bar = root.querySelector<HTMLElement>("[data-demo='bar']");
    const run = root.querySelector<HTMLElement>("[data-demo='run']");
    const flash = root.querySelector<HTMLElement>("[data-demo='flash']");
    if (!bar || !run || !flash) return;
    let started = false;
    let stopped = false;
    const controls: { stop: () => void }[] = [];
    const settle = () => {
      bar.style.transform = "";
      run.style.transform = "";
      flash.style.opacity = "";
    };
    const play = async () => {
      if (started || stopped) return;
      started = true;
      played.current = true;
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
    // 画面外・非表示タブでは始めない (見える状態になってから 1 回だけ)。
    let io: IntersectionObserver | null = null;
    const tryStart = () => {
      if (started || stopped || document.visibilityState !== "visible") return;
      if (typeof IntersectionObserver === "undefined") {
        void play();
        return;
      }
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io?.disconnect();
          void play();
        }
      });
      io.observe(root);
    };
    const onVisible = () => {
      if (!io) tryStart();
    };
    document.addEventListener("visibilitychange", onVisible);
    tryStart();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      io?.disconnect();
      for (const c of controls) c.stop();
      settle();
    };
  }, [armed, reduced, animate, scope]);

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
            <SelBar data-demo="bar" style={armed ? { transform: "translateY(-100%)" } : undefined}>
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
