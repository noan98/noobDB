/**
 * 接続プロファイルの視覚アイデンティティ (カラーチップ・グループアバター・
 * 本番/読取専用バッジ) を決定する純粋ロジック (#663)。
 *
 * `ConnectionList` / `TitleBar` / 本番接続確認ダイアログ (`App.tsx`) など、プロファ
 * イルを画面上に表示するすべての箇所がここを参照し、「色をどう正規化するか」
 * 「グループ名からどんなイニシャル/色を作るか」「どのバッジをどの順で出すか」を
 * 二重実装しないようにする。バッジそのものの配色 (danger/info) は
 * `semanticColors.ts` (#664) を参照し、ここでは色の“決定ロジック”だけを扱う。
 * コントラスト計算 (前景色の選択) は `accent.ts` の既存ユーティリティ
 * (`contrastRatio` ベースの `accentForeground`) をそのまま再利用し、二重定義を避ける。
 *
 * DOM に依存しない純関数のみで構成し、`__tests__/profileIdentity.test.ts` で
 * 境界ケース (空文字・1 文字・日本語・絵文字・不正な hex) を固定する。
 */

import { accentForeground, parseHex } from "./accent";
import { categoricalColor } from "./colorScale";

/** プロファイルに表示しうるバッジの種類。 */
export type ProfileBadgeKind = "production" | "readOnly";

/** バッジ種別判定に必要なプロファイルのフラグだけを取り出した最小の入力型。 */
export interface ProfileIdentityFlags {
  is_production: boolean;
  read_only: boolean;
}

/** `workspaceSpineColor` の入力に必要な最小フィールド。 */
export interface WorkspaceIdentityInput {
  is_production: boolean;
  color?: string | null;
}

/**
 * 表示すべきバッジの種類を、表示すべき優先順で返す (本番を常に先に)。
 * 両方 true ならどちらも返し、両方 false なら空配列。
 */
export function profileBadgeKinds(profile: ProfileIdentityFlags): ProfileBadgeKind[] {
  const kinds: ProfileBadgeKind[] = [];
  if (profile.is_production) kinds.push("production");
  if (profile.read_only) kinds.push("readOnly");
  return kinds;
}

/**
 * プロファイルの `color` を正規化する。`null`/`undefined`/空白のみの文字列は
 * 「未設定」として `null` を返す (呼び出し側はワークスペースアクセント等へ
 * フォールバックする)。
 */
export function normalizeChipColor(color: string | null | undefined): string | null {
  const trimmed = color?.trim();
  return trimmed ? trimmed : null;
}

/**
 * カラーチップ/アバターの塗り (`hex`) の上に文字/アイコンを乗せるときの前景色。
 * 白と濃紺のうちコントラスト比が高い方を返す `accent.ts` の `accentForeground` を
 * そのまま再利用する (二重定義しない)。不正な hex や未設定のときは呼び出し側の
 * 既定色に譲るため `null` を返す。
 *
 * 現状 `ProfileColorChip` はベタ塗りのみ (文字/アイコンを重ねていない) だが、
 * 将来チップ上にアクティブ接続チェックマーク等を重ねる拡張に備え、コントラスト
 * 計算ロジックとしてここに公開しテストで固定しておく (`groupAvatarForeground` が
 * 同じ仕組みを今日から実際に使っている)。
 */
export function chipForeground(color: string | null | undefined): string | null {
  const normalized = normalizeChipColor(color);
  if (!normalized || !parseHex(normalized)) return null;
  return accentForeground(normalized);
}

/**
 * アクティブ接続の「ワークスペース・アイデンティティ」を表す単色を決定する
 * (#791)。サイドバー左端のカラースパインなど、アプリ全体で「今どの接続で
 * 作業しているか」を一目で示す面が参照する単一の出所。優先順位は
 * `ConnectionList` の行スパインと同じ**本番が常に最優先**:
 *
 * 1. 未接続 (`active` が `null`) → `"transparent"` (何も塗らない)
 * 2. 本番接続 (`is_production`) → 常に危険色トークン (`--status-error`)。
 *    プロファイルの `color` がどんな色でも誤操作リスクを薄めないよう上書きする。
 * 3. プロファイルにカスタム色があればそれをそのまま使う。
 * 4. 色未設定ならワークスペースアクセント (`--ws-accent`、無ければブランド
 *    アクセント `--accent`) にフォールバックする — 未設定時も自然に見える。
 */
export function workspaceSpineColor(active: WorkspaceIdentityInput | null): string {
  if (!active) return "transparent";
  if (active.is_production) return "var(--status-error)";
  return normalizeChipColor(active.color) ?? "var(--ws-accent, var(--accent))";
}

/** イニシャルとして取り出すコードポイント数の上限 (単一語のとき)。 */
const MAX_INITIAL_CODEPOINTS = 2;

/**
 * グループ名からアバターに表示するイニシャルを生成する。サロゲートペア
 * (絵文字等) を壊さないよう `Array.from` でコードポイント単位に分割する。
 *
 * - 空文字/空白のみ → `""` (呼び出し側でフォールバック表示、またはアバター非表示)
 * - 複数語 (空白区切り) → 先頭 2 語それぞれの先頭 1 コードポイント
 *   (例: `"Prod Team"` → `"PT"`)
 * - 単一語 → 先頭 2 コードポイント (例: `"Production"` → `"PR"`、日本語
 *   `"本番環境"` → `"本番"`、絵文字始まりの `"🚀Ops"` → `"🚀O"`、1 文字の `"A"` → `"A"`)
 *
 * 大文字化 (`toLocaleUpperCase`) は ASCII にのみ効き、日本語/絵文字には無害。
 */
export function groupInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const first = Array.from(words[0])[0] ?? "";
    const second = Array.from(words[1])[0] ?? "";
    return (first + second).toLocaleUpperCase();
  }
  const codepoints = Array.from(words[0]);
  return codepoints.slice(0, MAX_INITIAL_CODEPOINTS).join("").toLocaleUpperCase();
}

/**
 * グループ名から安定した色を割り当てる (同じ名前は常に同じ色になる)。ユーザが
 * 選ぶ `profile.color` とは独立した「グループ単位」の色で、`colorScale.ts` の
 * カラーブラインド配慮済みカテゴリパレットを名前の簡易ハッシュで循環参照する
 * (チャート系列と同じパレットを再利用し、色を二重定義しない)。
 */
export function groupAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    // 単純な多項式ハッシュ (Java の String.hashCode と同型)。暗号用途ではなく
    // 「同名なら常に同じ色」を安定して得られれば十分。
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return categoricalColor(hash);
}

/**
 * グループアバターに乗せるイニシャル文字色。`groupAvatarColor` の塗りに対して
 * `accentForeground` でコントラストの高い側を選ぶ。
 */
export function groupAvatarForeground(name: string): string {
  return accentForeground(groupAvatarColor(name));
}
