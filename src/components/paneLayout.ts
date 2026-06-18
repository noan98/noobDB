/**
 * エディタ ⇔ 結果のスプリットペイン (#618) が共有する純ロジック。副作用なし
 * (localStorage / DOM に触れない) なので Vitest で単体テストできる。`Splitter`
 * のドラッグ/キーボード配分計算と、`App` のレイアウトモード (通常 / 結果最大化 /
 * エディタ集中) の正規化・トグルをここに集約し、両者でクランプ規則がズレないように
 * する。
 */

/** 値を [lo, hi] に収める。 */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * セパレータが取りうる配分 (0..1) の下限/上限。両ペインに最低 `minSize` px を
 * 残す。コンテナが狭すぎて両側に `minSize` を確保できない場合は 0..1 の全域を
 * 許可する (ドラッグでの行き詰まりを避ける)。total が非正のときも全域を返す。
 */
export function fractionBounds(
  total: number,
  minSize: number,
): { minF: number; maxF: number } {
  if (!(total > 2 * minSize)) return { minF: 0, maxF: 1 };
  return { minF: minSize / total, maxF: 1 - minSize / total };
}

/**
 * 永続化された配分値を検証して正規化する。0 < f < 1 の有限数だけを採用し、
 * それ以外 (null / NaN / 範囲外 / 文字列ゴミ) は fallback を返す。localStorage の
 * 破損耐性 (#566 方針) のため、Splitter の読み出しと共有する。
 */
export function normalizeFraction(raw: unknown, fallback: number): number {
  const f = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(f) && f > 0 && f < 1) return f;
  return fallback;
}

/**
 * レイアウトモード。`normal` は通常のスプリット表示、`result` は結果パネルの
 * 全画面化、`editor` はエディタ集中表示。同時にはどれか 1 つだけが有効。
 */
export type LayoutMode = "normal" | "result" | "editor";

/** 永続化された文字列を検証して `LayoutMode` に正規化する。未知値は `normal`。 */
export function parseLayoutMode(raw: unknown): LayoutMode {
  return raw === "result" || raw === "editor" ? raw : "normal";
}

/**
 * トグル操作の次状態を返す。現在が対象モードなら `normal` に戻し (オフ)、
 * それ以外なら対象モードへ切り替える (別モードからの直接切り替えも含む)。
 */
export function toggleLayoutMode(current: LayoutMode, target: Exclude<LayoutMode, "normal">): LayoutMode {
  return current === target ? "normal" : target;
}
