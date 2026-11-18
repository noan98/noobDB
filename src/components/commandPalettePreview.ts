import { extractQueryParams } from "../queryParams";
import { parseSnippetTemplate } from "../snippetTemplate";
import { relativeActivityTime, type RelativeTime } from "../activityLog";
import type { HistoryEntry, SnippetScope, TableColumnInfo } from "../api/tauri";

/**
 * コマンドパレットの「選択中の候補のプレビューペイン」(#2425) の純ロジック。
 * 候補の種別ごとの入力 (`PreviewSource`) を、描画しやすい表示モデルへ組み立てる。
 * 副作用なし。`CommandPalette.tsx` はこの結果を描画するだけ。
 *
 * - 秘密情報は扱わない。接続のプレビューはホスト・ドライバ・DB 名・バッジだけで、ユーザ名や
 *   パスワードは入力にも含めない (呼び出し側 `App.tsx` が渡さない)。
 * - SQL 本文は資格情報リテラルの伏せ字化 (`SqlPreview` の `maskCredentials`) を描画側で掛ける。
 * - プレビューのためにサーバへは問い合わせない (App は `loadTableDetail` を渡さず、列名だけを出す)。
 *   型・PK/FK・行数推定を出したい場合のみ、任意 prop `loadTableDetail` で遅延・キャッシュ付きの
 *   取得を有効にできる (`useCommandPreviewDetail.ts`)。
 */

/** 候補の中身を作るための元データ。`CommandItem.preview` に載せる。 */
export type PreviewSource =
  | {
      kind: "table";
      database: string;
      table: string;
      /** スキーマキャッシュ済みの列名 (型などの詳細は無い)。 */
      columns: string[];
    }
  | {
      kind: "snippet";
      name: string;
      sql: string;
      folder: string | null;
      tags: string[];
      scope: SnippetScope;
      /** スコープが接続のときの接続名 (削除済みなら null)。 */
      scopeProfileName: string | null;
      /** 本文の方言 (構文色分け用)。 */
      driver: string | null;
    }
  | {
      kind: "history";
      sql: string;
      meta: HistoryMeta | null;
      /** 履歴を実行した接続名 (分かるときだけ)。 */
      connectionName: string | null;
      driver: string | null;
    }
  | {
      kind: "connection";
      name: string;
      driver: string;
      host: string | null;
      port: number | null;
      /** DB 名 (SQLite はファイルパス)。 */
      database: string | null;
      group: string | null;
      isProduction: boolean;
      readOnly: boolean;
      connected: boolean;
    };

/** プレビュー内のアクション。候補の `run` とは別に、挿入・新しいタブ・実行を選べる。 */
export type PreviewActionKind = "insert" | "open" | "run";

export interface PreviewAction {
  kind: PreviewActionKind;
  run: () => void;
  /** 実行できない理由 (例: 未接続)。指定すると押せない。 */
  disabledReason?: string;
}

/** 履歴 1 件の実行メタ (`HistoryEntry` の一覧用サマリ。SQL 本文は含まない)。 */
export interface HistoryMeta {
  executedAt: string;
  elapsedMs: number | null;
  rows: number | null;
  rowsAffected: number | null;
  ok: boolean;
  error: string | null;
}

export function historyMetaOf(e: HistoryEntry): HistoryMeta {
  return {
    executedAt: e.executed_at,
    elapsedMs: e.elapsed_ms,
    rows: e.rows,
    rowsAffected: e.rows_affected,
    ok: e.status === "ok",
    error: e.error,
  };
}

/** 空白の連なりを 1 つの空白に畳む (履歴の `sql_preview` と同じ畳み方)。 */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 一覧の要約 (`sql_preview`) と全文 SQL が同じ行を指すか。文字数と先頭の一致で確かめる。 */
function historyRowMatches(entry: HistoryEntry, sql: string): boolean {
  if ([...sql].length !== entry.sql_len) return false;
  const preview = collapseWhitespace(
    entry.sql_preview.endsWith("…") ? entry.sql_preview.slice(0, -1) : entry.sql_preview,
  );
  return collapseWhitespace(sql).startsWith(preview);
}

/**
 * 履歴の一覧 (`listHistory`) と SQL 全文の一覧 (`listHistorySql`) は同じ並び (新しい順) で返るので、
 * 添字で組にして「SQL 全文 → 最新の実行メタ」の表を作る。同じ SQL が複数回あれば最新を採る。
 * 2 回の取得の間に履歴が増えると添字がずれるため、文字数と要約の先頭が合わない行にはメタを付けない。
 */
export function indexHistoryMeta(entries: HistoryEntry[], sqls: string[]): Map<string, HistoryMeta> {
  const map = new Map<string, HistoryMeta>();
  const n = Math.min(entries.length, sqls.length);
  for (let i = 0; i < n; i++) {
    const sql = sqls[i];
    if (!historyRowMatches(entries[i], sql)) continue;
    if (!map.has(sql)) map.set(sql, historyMetaOf(entries[i]));
  }
  return map;
}

/** `executed_at` (ISO8601) を相対時刻へ。解釈できなければ null。 */
export function relativeExecutedAt(executedAt: string, now: number): RelativeTime | null {
  const at = Date.parse(executedAt);
  if (!Number.isFinite(at)) return null;
  return relativeActivityTime(at, now);
}

/** テーブルの詳細 (遅延取得)。 */
export interface TableDetail {
  columns: TableColumnInfo[];
  /** 行数の推定 (統計が無ければ null)。 */
  rowEstimate: number | null;
}

/** プレビューに並べる 1 列。 */
export interface PreviewColumn {
  name: string;
  /** 型名。詳細が未取得のあいだは null (型グリフは出さない)。 */
  dataType: string | null;
  primaryKey: boolean;
  nullable: boolean | null;
  /** 外部キーの参照先 (`table.column`)。 */
  references: string | null;
  comment: string | null;
}

/** 列がこの件数を超えるテーブルは、先頭だけ描画して残りを件数で示す。 */
export const PREVIEW_COLUMN_LIMIT = 200;

/** テーブルのプレビュー用の列モデル。詳細があればそれを、無ければ列名だけを使う。 */
export function buildPreviewColumns(names: string[], detail: TableDetail | null): PreviewColumn[] {
  if (detail && detail.columns.length > 0) {
    return detail.columns.map((c) => ({
      name: c.name,
      dataType: c.data_type,
      primaryKey: c.key.toUpperCase() === "PRI",
      nullable: c.nullable,
      references: c.referenced_table
        ? c.referenced_column
          ? `${c.referenced_table}.${c.referenced_column}`
          : c.referenced_table
        : null,
      comment: c.comment?.trim() ? c.comment.trim() : null,
    }));
  }
  return names.map((name) => ({
    name,
    dataType: null,
    primaryKey: false,
    nullable: null,
    references: null,
    comment: null,
  }));
}

/** スニペット本文のプレースホルダ。タブストップ (`${name}` / `${1}`) と実行時パラメータ (`{{name}}`)。 */
export interface SnippetPlaceholders {
  tabStops: string[];
  params: string[];
}

export function snippetPlaceholders(sql: string): SnippetPlaceholders {
  const seen = new Set<string>();
  const tabStops: string[] = [];
  for (const p of parseSnippetTemplate(sql)) {
    if (p.kind !== "field") continue;
    // `${0}` は最後にカーソルを置く位置で、入力欄ではない。
    if (p.index === 0) continue;
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    tabStops.push(p.name ?? (p.placeholder ? `${p.index}: ${p.placeholder}` : String(p.index)));
  }
  return { tabStops, params: extractQueryParams(sql) };
}

/** 表示する SQL 本文の上限 (文字数)。これを超える分は切り詰めて件数を示す。 */
export const PREVIEW_SQL_LIMIT = 50_000;

export function clipPreviewSql(sql: string, limit = PREVIEW_SQL_LIMIT): { text: string; omitted: number } {
  if (sql.length <= limit) return { text: sql, omitted: 0 };
  return { text: sql.slice(0, limit), omitted: sql.length - limit };
}

/** 切り替えのクロスフェードを再生し直す識別子 (候補が変わったときだけ変わる)。 */
export function previewKey(itemId: string): string {
  return `cmdk-preview-${itemId}`;
}

/** 詳細取得のキャッシュキー。接続 (セッション) 単位で分ける呼び出しは呼び出し側が担う。 */
export function tableDetailKey(database: string, table: string): string {
  return `${database}\0${table}`;
}

/** 詳細キャッシュの保持上限 (件)。超えたら古いものから捨てる。 */
export const TABLE_DETAIL_CACHE_LIMIT = 50;
