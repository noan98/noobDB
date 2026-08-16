import type { DiffStatus } from "../api/tauri";
import { semanticColorVar, type SemanticRole } from "../semanticColors";

/**
 * `DiffStatus` (スキーマ/データ比較・サンドボックス書き戻しの差分行が共通で持つ状態)
 * の色語彙 (#1008)。`SchemaCompareView` と `SandboxReviewModal` の両方が同じ関数を
 * import することで、状態色を二重管理せず語彙を一本化する。
 *
 * 独立したこのファイルに切り出しているのは、`SandboxReviewModal.tsx` が
 * `SchemaCompareView.tsx` を直接 import すると、`App.tsx` が `SchemaCompareView` を
 * 遅延 import (`lazy`) している意図 (初期バンドルからの除外) が壊れるため
 * (静的 import 1 本でもバンドラは同一チャンクへ引き込む — ビルド時の
 * `INEFFECTIVE_DYNAMIC_IMPORT` 警告で顕在化した)。色マッピングという純粋ロジック
 * だけを共有すれば足りるので、View コンポーネント同士を結合させない。
 */

/**
 * `DiffStatus` に対応する意味役割。「追加 (source_only) = success /
 * 削除 (target_only) = danger / 変更 (different) = warning」。`same` (差分なし) は
 * 意味色を持たない中立ステータスなので `null` を返す。
 */
function statusRole(status: DiffStatus): SemanticRole | null {
  switch (status) {
    case "source_only":
      return "success";
    case "target_only":
      return "danger";
    case "different":
      return "warning";
    case "same":
      return null;
  }
}

/**
 * DiffStatus に対応する文字色/枠色 (chip / badge / アコーディオンの左スパイン共通)。
 * `semanticColors.ts` の `semanticColorVar` (#664) 経由で解決し、`--status-*` の
 * 直書きは行わない。
 *
 * text/border とも同じ tier (`text`) を使うのは #1009 の判断を引き継いだもの —
 * このチップは淡色地の "subtle" 背景ではなく中立地 (`--bg-muted`) の上に単色の
 * 文字色 + 枠色を重ねるデザインのため、tier を分けると (テーマによっては) 文字色と
 * 枠色の色相がずれてしまう。`same` (無変化) は状態色を持たないニュートラル表示。
 */
export function statusColors(status: DiffStatus): { color: string; borderColor: string } {
  const role = statusRole(status);
  if (!role) return { color: "var(--text-muted)", borderColor: "var(--border)" };
  const c = semanticColorVar(role, "text");
  return { color: c, borderColor: c };
}
