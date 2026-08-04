// サンドボックス (壊せる砂場・ブランチ、#747) のフロント純ロジック。
//
// 実データのコピー・書き戻し SQL の生成・適用はすべてバックエンド (IPC)・既存の
// Diff/Sync コマンド (`generateSyncSql` / `generateDataSyncSql` / `applySyncSql`)
// が担う。ここは UI 側だけで完結する純粋な補助 — 影テーブル名の判定 (テーブル
// ツリーから隠す)・行数上限の既定値クランプ・競合行の解決状態の集計 — に限る。
// 主キーの型付き同一性判定 (整数 `1` と文字列 `"1"` を区別する等) はバックエンドの
// `db::sandbox::key_signature` が正であり、フロントはそれをそのまま呼ぶ
// (`filterSandboxDataDiff` IPC) ので、ここでは再実装しない。

import type {
  CellValue,
  ConnectionProfile,
  ForeignKey,
  SandboxConflict,
  SandboxRecord,
} from "./api/tauri";

/** バックエンド `db::sandbox::SHADOW_PREFIX` と同じ値。テーブルツリーから
 *  base スナップショットテーブルを隠すために使う。 */
export const SANDBOX_SHADOW_PREFIX = "__noobdb_sandbox_base__";

/**
 * サンドボックスを示す専用色 (violet 系)。`TitleBar` の帯色 (`titleBarContext.ts`)
 * と `ProfileBadge.tsx` の `SandboxBadge` が共有し、「接続先へは一切影響しない
 * ローカルコピー」であることをタブ/ツールバーへ常時・一貫した色で明示する (#747)。
 */
export const SANDBOX_BAND_COLOR = "#8b5cf6";

/** 合成 (非永続) プロファイルの id プレフィックス。通常のプロファイル id
 *  (8 文字スラッグ) とは絶対に衝突しない形にしてある。 */
const SANDBOX_PROFILE_ID_PREFIX = "sandbox:";

/** サンドボックス id から、`ConnectionList` / タブ切替の既存機構に乗せるための
 *  合成プロファイル id を作る。 */
export function sandboxProfileId(sandboxId: string): string {
  return `${SANDBOX_PROFILE_ID_PREFIX}${sandboxId}`;
}

/** `sandboxProfileId` が作った合成プロファイル id かどうか。 */
export function isSandboxProfileId(id: string): boolean {
  return id.startsWith(SANDBOX_PROFILE_ID_PREFIX);
}

/** 合成プロファイル id から元のサンドボックス id を取り出す。合成 id でなければ
 *  `null`。 */
export function sandboxIdFromProfileId(id: string): string | null {
  return isSandboxProfileId(id) ? id.slice(SANDBOX_PROFILE_ID_PREFIX.length) : null;
}

/**
 * `SandboxRecord` を `ConnectionList` の接続ツリー・タブ切替 (`openConnections`)・
 * タブ復元など、既存のプロファイル単位の仕組みへそのまま乗せるための**非永続**
 * `ConnectionProfile`。`save_profile` を呼ばない・`profiles.json` に書かれない
 * 純粋なフロント側の合成値であり、`id` の予約プレフィックスで通常のプロファイルと
 * 一切衝突しない。サンドボックスは常に SQLite ファイルなので `driver`/`file_path`
 * のみが実質的な接続情報。
 */
export function sandboxToProfile(record: SandboxRecord): ConnectionProfile {
  return {
    id: sandboxProfileId(record.id),
    name: record.name,
    driver: "sqlite",
    host: "",
    port: 0,
    user: "",
    database: null,
    ssh: null,
    group: null,
    color: SANDBOX_BAND_COLOR,
    is_production: false,
    confirm_writes: false,
    read_only: false,
    skip_history: false,
    file_path: record.file_path,
  };
}

/** サンドボックスの base スナップショットテーブルかどうか。 */
export function isSandboxShadowTableName(name: string): boolean {
  return name.startsWith(SANDBOX_SHADOW_PREFIX);
}

/** バックエンド `db::sandbox::{DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT}` と同じ値。 */
export const SANDBOX_DEFAULT_ROW_LIMIT = 5_000;
export const SANDBOX_MAX_ROW_LIMIT = 100_000;

/** 作成フォームの行数上限入力を `[1, SANDBOX_MAX_ROW_LIMIT]` にクランプする。
 *  未入力/0 以下は既定値。バックエンドの `clamp_row_limit` と同じ方針 (呼び出し
 *  側の値を尊重しつつ暴走を防ぐ) だが、ここは UI 入力の正規化用で、実際の強制は
 *  常にバックエンド側で行われる。 */
export function clampSandboxRowLimit(limit: number | null | undefined): number {
  if (limit === null || limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return SANDBOX_DEFAULT_ROW_LIMIT;
  }
  return Math.min(Math.floor(limit), SANDBOX_MAX_ROW_LIMIT);
}

/**
 * 競合行を UI 上で Map/Set のキーとして扱うための署名。バックエンドの型付き
 * 署名 (整数 `1` と文字列 `"1"` を区別する) と完全に一致する必要はない —
 * ここでは「同じ画面内で表示された競合行を一意に指せればよい」用途に限るため、
 * 値と JS の型タグを連結するだけの簡易版で足りる。実際にどの行を書き戻し対象
 * から外すかの最終判定 (型付きの主キー一致) は `filterSandboxDataDiff` IPC
 * (`db::sandbox::key_signature` そのもの) が行う。
 */
export function sandboxKeySignature(key: CellValue[]): string {
  return key.map((v) => `${typeof v}:${JSON.stringify(v)}`).join("");
}

/**
 * バックエンド `db::sandbox::fk_closure` と同じ**片方向** (選択テーブル →
 * `referenced_table` のみ、選択テーブルを参照してくる側は含めない) の推移的
 * 閉包。作成モーダルのプレビュー用 — 実際にコピーされるテーブル集合は
 * バックエンドが権威 (`create_sandbox` の `include_related`) で、ここは UI が
 * 送信前に「関連テーブルを含めるとこうなる」を示すだけ。`schemaExport.ts` の
 * `expandWithFkRelated` は双方向 (AI へのスキーマ文脈提供が目的) で意図的に
 * 異なるため、共有せずここに独立実装する。
 */
export function sandboxFkClosure(
  selected: readonly string[],
  foreignKeys: readonly ForeignKey[],
): string[] {
  const set = new Set(selected);
  let added = true;
  while (added) {
    added = false;
    for (const fk of foreignKeys) {
      if (set.has(fk.table) && !set.has(fk.referenced_table)) {
        set.add(fk.referenced_table);
        added = true;
      }
    }
  }
  return [...set].sort();
}

export type SandboxConflictResolution = "overwrite" | "skip";

/** まだ解決 (overwrite/skip の選択) されていない競合行。 */
export function unresolvedSandboxConflicts(
  conflicts: SandboxConflict[],
  resolutions: Record<string, SandboxConflictResolution>,
): SandboxConflict[] {
  return conflicts.filter((c) => !resolutions[sandboxKeySignature(c.key)]);
}

/** 「スキップ (元 DB 側の値を維持し、書き戻さない)」と解決された行の主キー一覧。
 *  `api.filterSandboxDataDiff(diff, skipKeys)` にそのまま渡せる。 */
export function sandboxSkipKeys(
  conflicts: SandboxConflict[],
  resolutions: Record<string, SandboxConflictResolution>,
): CellValue[][] {
  return conflicts
    .filter((c) => resolutions[sandboxKeySignature(c.key)] === "skip")
    .map((c) => c.key);
}
