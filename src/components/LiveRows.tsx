import { useState, type ReactNode } from "react";
import { chakra, type HTMLChakraProps, type SystemStyleObject } from "@chakra-ui/react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";

import { transitions, variants } from "../motion";
import { diffLiveRows, type LiveChanges, type LiveField } from "./liveDiff";

/**
 * ライブ監視パネル (#1022) の共通部品。ポーリングで差し替わる一覧を
 * 「飛び跳ねるリフレッシュ」ではなくライブダッシュボードとして読めるようにする。
 *
 * - **行の出入り:** `LiveRowsPresence` 配下の `LiveTr` / `LiveCollapse` が
 *   `AnimatePresence` + `variants.collapse` (高さ) で滑らかに現れ/消える。
 *   `initial={false}` なので初期表示とセッション切替直後の一括表示は動かない。
 * - **値変化フラッシュ:** `useLiveChanges` が前回スナップショットとの差分
 *   (`liveDiff.ts` の純関数) を求め、`LiveFlash` が変化セルだけを既存の
 *   `@keyframes apply-flash` (ResultGrid の編集適用フラッシュ) で一瞬光らせる。
 *   新しいキーフレームは増やさない。
 *
 * ## reduced-motion
 *
 * - `MotionConfig reducedMotion` は transform / layout しか抑制せず、`height` /
 *   `opacity` の補間は残る。そこで `LiveRowsPresence` が `useReducedMotion()`
 *   (OS 設定とアプリ内 `motionPreference` の両方を反映) を見て、配下の transition
 *   を 0 秒へ差し替える。
 * - フラッシュは CSS アニメーションなので、`App.css` 末尾の reduced-motion
 *   ブロック (`@media` と `:root[data-motion="reduced"]`) が自動で静止化する。
 *
 * ## <table> の高さアニメについて
 *
 * `<tr>` / `<td>` は `height: 0` まで縮まない (内容とパディングが下限になる) ため、
 * 高さの補間はセル内側の `LiveCollapse` (div) で行い、パディングもその内側の
 * `LiveFlash` へ移す。`<td>` 自体はパディング 0 のシェルにする。
 */

const MotionTr = chakra(motion.tr, {}, {
  forwardProps: ["variants", "initial", "animate", "exit", "transition"],
});
const MotionDiv = chakra(motion.div, {}, {
  forwardProps: ["variants", "initial", "animate", "exit", "transition"],
});

/** 即時化した transition (reduced-motion 時)。 */
const INSTANT = { duration: 0 } as const;

/**
 * 行の出入りを司る `AnimatePresence`。配下の transition を一括で決め、
 * reduced-motion なら即時化する。直下の子は `key` 付きの `LiveTr` /
 * `LiveCollapse` にすること (Fragment や Tooltip で包むと出入りを追跡できない)。
 */
export function LiveRowsPresence({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion() ?? false;
  return (
    <MotionConfig transition={reduced ? INSTANT : transitions.layout}>
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </MotionConfig>
  );
}

/**
 * ライブ表の行。variant ラベル (`initial` / `animate` / `exit`) を配下の
 * `LiveCell` へ伝播させ、行全体を同時に伸縮させる。
 */
export function LiveTr({ children }: { children: ReactNode }) {
  return (
    <MotionTr variants={variants.fade} initial="initial" animate="animate" exit="exit">
      {children}
    </MotionTr>
  );
}

/** 高さ 0 ↔ auto で伸縮するブロック。`LiveTr` の子孫なら variant を継承する。 */
export function LiveCollapse({
  children,
  standalone = false,
}: {
  children: ReactNode;
  /** `LiveRowsPresence` の直下に置く (親 `LiveTr` を持たない) とき true。 */
  standalone?: boolean;
}) {
  return standalone ? (
    <MotionDiv variants={variants.collapse} initial="initial" animate="animate" exit="exit">
      {children}
    </MotionDiv>
  ) : (
    <MotionDiv variants={variants.collapse}>{children}</MotionDiv>
  );
}

/**
 * `apply-flash` と同じキーフレームを同じ尺で再生する (ResultGrid の
 * `is-apply-flash` と揃える)。
 */
const flashCss: SystemStyleObject = {
  animation: "apply-flash 0.7s ease-out",
};

/**
 * 値変化フラッシュ。`token` が数値のとき、その値ごとに要素を作り直して
 * `apply-flash` を 1 回再生する (同じ値が続く間は再生しない)。`null` は静止。
 */
export function LiveFlash({
  token,
  css,
  children,
  ...rest
}: { token: number | null; css?: SystemStyleObject; children?: ReactNode } & Omit<
  HTMLChakraProps<"div">,
  "css"
>) {
  return (
    <chakra.div
      key={token === null ? "static" : `flash-${token}`}
      css={token === null ? css : { ...css, ...flashCss }}
      data-live-flash={token === null ? undefined : ""}
      {...rest}
    >
      {children}
    </chakra.div>
  );
}

/** `<td>` のシェル (パディング 0)。パディングは `innerCss` 側に書く。 */
const cellShellCss: SystemStyleObject = { padding: 0 };

/**
 * ライブ表のセル。`<td>` → `LiveCollapse` → `LiveFlash` の 3 層で、
 * 行の伸縮と値変化フラッシュを両立する。`Tooltip` のトリガーにできるよう、
 * 残りの props (ref / マウスハンドラ等) は `<td>` へそのまま渡す。
 */
export function LiveCell({
  css,
  innerCss,
  flash = null,
  children,
  ...rest
}: {
  /** `<td>` の見た目 (境界線・フォント等)。padding は無視され 0 になる。 */
  css: SystemStyleObject;
  /** セル内側 (パディング・折り返し) のスタイル。 */
  innerCss: SystemStyleObject;
  flash?: number | null;
  children?: ReactNode;
} & Omit<HTMLChakraProps<"td">, "css">) {
  return (
    <chakra.td css={{ ...css, ...cellShellCss }} {...rest}>
      <LiveCollapse>
        <LiveFlash token={flash} css={innerCss}>
          {children}
        </LiveFlash>
      </LiveCollapse>
    </chakra.td>
  );
}

/**
 * ポーリングで差し替わる `rows` について、前回スナップショットとの差分を返す。
 * `keyOf` と `fields` はモジュールレベルの安定した値を渡すこと。
 *
 * `tick` は差分を取り直すたびに増える世代番号で、`flashToken` がこれを
 * フラッシュの再生キーとして使う (同じ変化を 2 回光らせない)。
 */
export function useLiveChanges<T, K, F extends string>(
  rows: readonly T[],
  keyOf: (row: T) => K,
  fields: readonly LiveField<T, F>[],
): { flashToken: (key: K, field: F) => number | null } {
  // 「前回のレンダーの情報を保持する」React 公式パターン (render 中の setState)。
  // effect で差分を取ると 1 フレーム遅れて素の値が先に描画されてしまうため。
  const [snap, setSnap] = useState<{
    rows: readonly T[];
    tick: number;
    changes: LiveChanges<K, F>;
  }>(() => ({ rows, tick: 0, changes: new Map() }));
  let current = snap;
  if (snap.rows !== rows) {
    current = {
      rows,
      tick: snap.tick + 1,
      changes: diffLiveRows(snap.rows, rows, keyOf, fields),
    };
    setSnap(current);
  }
  const { changes, tick } = current;
  return {
    flashToken: (key, field) => (changes.get(key)?.has(field) ? tick : null),
  };
}
