import type { CellValue, QueryResult } from "../api/tauri";
import {
  type PlanNode,
  attrVal,
  parseExplainForDriver,
  parseNum,
} from "./explainPlan";

/**
 * 実行計画ウォッチ (#743) の純粋ロジック層 — 計画の正規化・同一判定・構造比較。
 *
 * `explainPlan.ts` がパースした `PlanNode` ツリーを方言非依存の `PlanOp` 列へ
 * 正規化し、2 世代の計画から「重要な変化」(アクセス方式・使用インデックス・
 * 結合方式・推定行数の桁違い) を検知する。コスト値の微変動などのノイズは
 * 比較対象に含めない (誤検出より見逃し優先の既存方針)。副作用なしの純関数のみで、
 * `src/__tests__/planDiff.test.ts` がユニットテストする。
 */

/** 正規化した計画の 1 オペレーション (ツリーを行きがけ順に平坦化したもの)。 */
export interface PlanOp {
  /** 構造パス (`PlanNode.id`)。世代間ペアリングの第一キー。 */
  path: string;
  /** ノード種別 (MySQL: query_block/table 等、PG: Node Type、SQLite: 先頭語)。 */
  kind: string;
  /** 対象オブジェクト (テーブル/リレーション名)。無ければ null。 */
  object: string | null;
  /** 正規化したアクセス方式 (MySQL access_type / PG Node Type / SQLite SCAN・SEARCH)。 */
  access: string | null;
  /** 使用インデックス名。 */
  index: string | null;
  /** 結合方式 (nested loop / hash join / merge join 等)。 */
  join: string | null;
  /** オプティマイザの推定行数。SQLite は持たないため null。 */
  estRows: number | null;
}

/** PG の結合ノード種別。 */
const PG_JOIN_TYPES = new Set(["Nested Loop", "Hash Join", "Merge Join"]);

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** MySQL `EXPLAIN FORMAT=JSON` のノード → PlanOp フィールド。 */
function mysqlFields(node: PlanNode): Partial<PlanOp> {
  if (node.kind === "table") {
    // MySQL 8.0.18+ はハッシュ結合を table ノードの using_join_buffer
    // ("hash join" / "Block Nested Loop") で表す。
    const joinBuffer = asString(attrVal(node, "using_join_buffer"));
    return {
      object: asString(attrVal(node, "table_name")),
      access: asString(attrVal(node, "access_type")),
      index: asString(attrVal(node, "key")),
      join: joinBuffer ? joinBuffer.toLowerCase() : null,
      estRows: parseNum(attrVal(node, "rows_examined_per_scan")),
    };
  }
  if (node.kind === "nested_loop") return { join: "nested loop" };
  return {};
}

/** PostgreSQL `EXPLAIN (FORMAT JSON)` のノード → PlanOp フィールド。 */
function postgresFields(node: PlanNode): Partial<PlanOp> {
  const nodeType = asString(attrVal(node, "Node Type")) ?? node.kind;
  const isScan = /scan/i.test(nodeType);
  return {
    object: asString(attrVal(node, "Relation Name")),
    access: isScan ? nodeType : null,
    index: asString(attrVal(node, "Index Name")),
    join: PG_JOIN_TYPES.has(nodeType) ? nodeType.toLowerCase() : null,
    estRows: parseNum(attrVal(node, "Plan Rows")),
  };
}

// SQLite `EXPLAIN QUERY PLAN` の detail 行。例:
//   "SCAN t"                                → フルスキャン
//   "SEARCH t USING INDEX ix_a (a=?)"       → インデックス探索
//   "SEARCH t USING COVERING INDEX ix (…)"  → カバリングインデックス
//   "SEARCH t USING INTEGER PRIMARY KEY (rowid=?)"
const SQLITE_STEP_RE =
  /^\s*(SCAN|SEARCH)\s+(?:TABLE\s+)?(\S+)(?:\s+AS\s+\S+)?(?:\s+USING\s+(?:(COVERING)\s+)?INDEX\s+(\S+)|\s+USING\s+INTEGER\s+PRIMARY\s+KEY)?/i;

/** SQLite `EXPLAIN QUERY PLAN` のステップ → PlanOp フィールド。 */
function sqliteFields(node: PlanNode): Partial<PlanOp> {
  const detail = asString(attrVal(node, "detail")) ?? node.label;
  const m = SQLITE_STEP_RE.exec(detail);
  if (!m) return {};
  const verb = m[1].toUpperCase();
  const index = m[4] ?? null;
  const usesPk = /USING\s+INTEGER\s+PRIMARY\s+KEY/i.test(detail);
  const access = index
    ? `${verb} USING ${m[3] ? "COVERING " : ""}INDEX`
    : usesPk
      ? `${verb} USING INTEGER PRIMARY KEY`
      : verb;
  return { object: m[2], access, index };
}

/**
 * パース済み計画ツリーを方言非依存の PlanOp 列へ正規化する (行きがけ順)。
 * ルートが null (空計画) なら空列。
 */
export function normalizePlan(root: PlanNode | null, driver: string): PlanOp[] {
  const ops: PlanOp[] = [];
  if (!root) return ops;
  const fieldsFor =
    driver === "postgres" ? postgresFields : driver === "sqlite" ? sqliteFields : mysqlFields;
  const walk = (node: PlanNode) => {
    const f = fieldsFor(node);
    ops.push({
      path: node.id,
      kind: node.kind,
      object: f.object ?? null,
      access: f.access ?? null,
      index: f.index ?? null,
      join: f.join ?? null,
      estRows: f.estRows ?? null,
    });
    node.children.forEach(walk);
  };
  walk(root);
  return ops;
}

/**
 * 推定行数の「桁」(log10 の床)。フィンガープリントと桁違い判定に使う。
 * null は不明 (SQLite 等)、0 以下は 0 桁として扱う。
 */
export function rowsMagnitude(rows: number | null): number | null {
  if (rows === null) return null;
  if (rows <= 0) return 0;
  return Math.floor(Math.log10(rows));
}

/**
 * 計画の同一判定に使うフィンガープリント。構造 (パス・種別) とアクセス方式・
 * インデックス・結合方式、および推定行数の**桁**のみを含める。コスト値や行数の
 * 微変動では変わらないため、「同一計画では世代を増やさない」dedupe と
 * 「桁違いの行数変化では世代が増えて検知される」性質を両立する。
 */
export function planFingerprint(ops: PlanOp[]): string {
  return JSON.stringify(
    ops.map((o) => [o.path, o.kind, o.object, o.access, o.index, o.join, rowsMagnitude(o.estRows)]),
  );
}

export type PlanChangeKind =
  | "access"
  | "index"
  | "join"
  | "estRows"
  | "opAdded"
  | "opRemoved";

export type PlanChangeSeverity = "info" | "warning";

/** 2 世代間で検知した 1 件の変化。before/after は表示用の文字列表現。 */
export interface PlanChange {
  kind: PlanChangeKind;
  severity: PlanChangeSeverity;
  /** 変化したノードの構造パス (追加/削除は残っている側のパス)。 */
  path: string;
  /** 対象オブジェクト名 (テーブル等)。無ければノード種別で代替。 */
  object: string;
  before: string | null;
  after: string | null;
}

export interface PlanComparison {
  changes: PlanChange[];
  /** 通知に値する変化が 1 件以上あるか。 */
  significant: boolean;
}

/** アクセス方式文字列がフルスキャン (テーブル全読み) を表すか (3 方言対応)。 */
export function isFullScanAccess(access: string | null): boolean {
  if (!access) return false;
  if (access === "ALL") return true; // MySQL
  if (/^seq scan$/i.test(access)) return true; // PostgreSQL
  return /^SCAN$/i.test(access); // SQLite (インデックスなしの SCAN)
}

/** 推定行数の変化を「桁違い」とみなす既定の倍率。 */
export const DEFAULT_ROW_FACTOR = 10;

function opDisplayName(op: PlanOp): string {
  return op.object ?? op.kind;
}

function pairOps(prev: PlanOp[], next: PlanOp[]): {
  pairs: [PlanOp, PlanOp][];
  removed: PlanOp[];
  added: PlanOp[];
} {
  const pairs: [PlanOp, PlanOp][] = [];
  const nextByPath = new Map(next.map((o) => [o.path, o]));
  const matchedNext = new Set<PlanOp>();
  const unmatchedPrev: PlanOp[] = [];
  // 第一パス: 構造パス + 対象オブジェクトの一致でペアリング。パスのみで対応
  // 付けると、ノード挿入で配列インデックスがずれたとき別テーブル同士を誤って
  // ペアにしてしまう (object を持たないラッパー/結合ノードは null === null で
  // パス一致のみになる)。
  for (const p of prev) {
    const n = nextByPath.get(p.path);
    if (n && !matchedNext.has(n) && p.object === n.object) {
      pairs.push([p, n]);
      matchedNext.add(n);
    } else {
      unmatchedPrev.push(p);
    }
  }
  // 第二パス: ノード挿入で配列インデックスがずれたケースを、オブジェクト名 +
  // 種別の一致で救済する (先勝ち)。
  const removed: PlanOp[] = [];
  for (const p of unmatchedPrev) {
    const n = next.find(
      (o) => !matchedNext.has(o) && o.object !== null && o.object === p.object && o.kind === p.kind,
    );
    if (n) {
      pairs.push([p, n]);
      matchedNext.add(n);
    } else {
      removed.push(p);
    }
  }
  const added = next.filter((o) => !matchedNext.has(o));
  return { pairs, removed, added };
}

/**
 * 2 世代の正規化済み計画を比較して重要な変化を列挙する。検知対象は
 * アクセス方式・使用インデックス・結合方式の変化と、推定行数の `rowFactor` 倍
 * 以上の変化、およびオペレーションの追加/削除。コスト値は見ない。
 */
export function comparePlans(
  prev: PlanOp[],
  next: PlanOp[],
  opts?: { rowFactor?: number },
): PlanComparison {
  const rowFactor = Math.max(2, opts?.rowFactor ?? DEFAULT_ROW_FACTOR);
  const changes: PlanChange[] = [];
  const { pairs, removed, added } = pairOps(prev, next);

  for (const [p, n] of pairs) {
    if ((p.access ?? null) !== (n.access ?? null)) {
      changes.push({
        kind: "access",
        // インデックスが効いていた読みがフルスキャンへ退行したときだけ警告。
        severity: isFullScanAccess(n.access) && !isFullScanAccess(p.access) ? "warning" : "info",
        path: n.path,
        object: opDisplayName(n),
        before: p.access,
        after: n.access,
      });
    } else if ((p.index ?? null) !== (n.index ?? null)) {
      // アクセス方式が同じままインデックス名だけ変わった (別インデックスへの
      // 乗り換え)。喪失 (→ null) はアクセス方式の変化として上で捕まるのが普通
      // だが、方言により index のみ落ちるケースは警告に格上げする。
      changes.push({
        kind: "index",
        severity: n.index === null ? "warning" : "info",
        path: n.path,
        object: opDisplayName(n),
        before: p.index,
        after: n.index,
      });
    }
    if ((p.join ?? null) !== (n.join ?? null)) {
      changes.push({
        kind: "join",
        severity: "info",
        path: n.path,
        object: opDisplayName(n),
        before: p.join,
        after: n.join,
      });
    }
    if (p.estRows !== null && n.estRows !== null && p.estRows !== n.estRows) {
      const lo = Math.max(1, Math.min(p.estRows, n.estRows));
      const hi = Math.max(p.estRows, n.estRows);
      if (hi / lo >= rowFactor) {
        changes.push({
          kind: "estRows",
          severity: n.estRows > p.estRows ? "warning" : "info",
          path: n.path,
          object: opDisplayName(n),
          before: String(p.estRows),
          after: String(n.estRows),
        });
      }
    }
  }
  for (const p of removed) {
    changes.push({
      kind: "opRemoved",
      severity: "info",
      path: p.path,
      object: opDisplayName(p),
      before: p.access ?? p.kind,
      after: null,
    });
  }
  for (const n of added) {
    changes.push({
      kind: "opAdded",
      // 追加されたノードがフルスキャンなら退行の疑いが強いので警告。
      severity: isFullScanAccess(n.access) ? "warning" : "info",
      path: n.path,
      object: opDisplayName(n),
      before: null,
      after: n.access ?? n.kind,
    });
  }
  return { changes, significant: changes.length > 0 };
}

// --- 世代スナップショットの直列化 -------------------------------------------
//
// ストア (`planWatch.ts`) は QueryResult そのものではなく、再パースに足る最小の
// ペイロードを保存する: MySQL/PG は単一セルの生 JSON 文字列、SQLite は
// (id, parent, detail) 行の JSON。ここでは QueryResult ⇔ ペイロードの変換と、
// ペイロード → PlanNode/PlanOp の復元を提供する。

export type PlanPayloadKind = "json" | "sqliteRows";

/** 保存用スナップショット (ドライバ + 直列化済みペイロード)。 */
export interface PlanSnapshot {
  driver: string;
  payloadKind: PlanPayloadKind;
  payload: string;
}

/**
 * EXPLAIN の QueryResult から保存用スナップショットを作る。空結果 (EXPLAIN が
 * 何も返さなかった) は null。
 */
export function snapshotFromResult(driver: string, result: QueryResult): PlanSnapshot | null {
  if (result.rows.length === 0) return null;
  if (driver === "sqlite") {
    const rows = result.rows.map((r) => [
      Number(r[0]) || 0,
      Number(r[1]) || 0,
      String(r[3] ?? r[r.length - 1] ?? ""),
    ]);
    return { driver, payloadKind: "sqliteRows", payload: JSON.stringify(rows) };
  }
  const cell = result.rows[0] && result.rows[0].length > 0 ? result.rows[0][0] : null;
  if (cell === null || cell === undefined) return null;
  return { driver, payloadKind: "json", payload: String(cell) };
}

/**
 * スナップショットを ExplainViewer にそのまま渡せる最小の QueryResult へ復元
 * する。SQLite は (id, parent, notused, detail) の 4 列に戻す。
 */
export function resultFromSnapshot(snapshot: PlanSnapshot): QueryResult {
  if (snapshot.payloadKind === "sqliteRows") {
    let rows: CellValue[][] = [];
    try {
      const parsed: unknown = JSON.parse(snapshot.payload);
      if (Array.isArray(parsed)) {
        rows = parsed
          .filter((r): r is unknown[] => Array.isArray(r))
          .map((r) => [Number(r[0]) || 0, Number(r[1]) || 0, 0, String(r[2] ?? "")]);
      }
    } catch {
      rows = [];
    }
    return {
      columns: ["id", "parent", "notused", "detail"].map((name) => ({ name, type_name: "" })),
      rows,
      rows_affected: 0,
      elapsed_ms: 0,
    };
  }
  return {
    columns: [{ name: "EXPLAIN", type_name: "" }],
    rows: [[snapshot.payload]],
    rows_affected: 0,
    elapsed_ms: 0,
  };
}

/** スナップショットを正規化済み PlanOp 列へ復元する (パース失敗時は空列)。 */
export function opsFromSnapshot(snapshot: PlanSnapshot): PlanOp[] {
  const { root } = parseExplainForDriver(snapshot.driver, resultFromSnapshot(snapshot));
  return normalizePlan(root, snapshot.driver);
}
