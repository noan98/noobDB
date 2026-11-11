import type { AlterStatement, OnlineHint } from "./alterTable";
import { fitPgName, qualifiedTableName } from "./sqlDialect";
import { quoteString } from "./cellEdit";

/**
 * 大きな表への DDL を「ロックを長く持たない手順」で適用するための実行計画 (#2240, 親 Epic #2232)。
 *
 * - PostgreSQL: `CREATE INDEX CONCURRENTLY` はトランザクション外でしか動かず、`ADD CONSTRAINT ... NOT VALID` →
 *   `VALIDATE CONSTRAINT` は別々のトランザクションで流さないと分ける意味が無い (強いロックを持ったまま全件を検証してしまう)。
 *   そこで DDL を「段階 (`DdlStep`)」に分け、段階ごとに 1 トランザクション (または単独の 1 文) で流す。
 * - ロック待ちの上限: PostgreSQL は `SET LOCAL lock_timeout`、MySQL は `SET SESSION lock_wait_timeout` を段階の先頭に付ける。
 *   `ACCESS EXCLUSIVE` を待つ DDL の後ろに SELECT まで並んで待つ「ロックキューの詰まり」を防ぐ。
 *   CONCURRENTLY の段階には付けない (強いロックを取らず、既存トランザクションの終了待ちが本質のため)。
 *
 * この層は SQL の組み立てと失敗時の案内文 (残りの SQL・後始末の SQL) だけを担う純ロジック。実行は
 * `onlineDdlRunner.ts`。方言差は `advisor.rs::create_index_online_ddl` と同じ規約 (CONCURRENTLY / MySQL は既存の
 * `ALGORITHM=INPLACE, LOCK=NONE` トグル `alterCost.ts` をそのまま使い、ここでは触らない)。SQLite は対象外 (計画を作らない)。
 */

export type DdlPhase =
  /** 通常の ALTER / DDL 一式 (1 トランザクション)。 */
  | "alter"
  /** `ADD CONSTRAINT ... NOT VALID` (既存行は検証しない)。 */
  | "addNotValid"
  /** `VALIDATE CONSTRAINT` (`SHARE UPDATE EXCLUSIVE`。読み書きと並行して全件を検証)。 */
  | "validate"
  /** `SET NOT NULL` + 一時的な CHECK の DROP (検証済みの CHECK があるので全件走査は起きない, PostgreSQL 12 以降)。 */
  | "setNotNull"
  /** `CREATE [UNIQUE] INDEX CONCURRENTLY` (トランザクション外)。 */
  | "createIndexConcurrently"
  /** `CREATE INDEX` (通常)。 */
  | "createIndex"
  /** `DROP INDEX` (通常)。 */
  | "dropIndex"
  /** `DROP INDEX CONCURRENTLY` (トランザクション外)。 */
  | "dropIndexConcurrently";

export interface DdlStep {
  phase: DdlPhase;
  /** 対象の制約名 / 列名 / インデックス名 (画面の段階ラベル用。`alter` では空)。 */
  subject: string;
  /** この段階の本体 SQL (ロック待ちの上限の文は含まない)。 */
  statements: string[];
  /** true: 1 トランザクションで流す。false: CONCURRENTLY のため 1 文を単独で流す。 */
  transactional: boolean;
  /** ロック待ちの上限の文を前後に付けるか。 */
  lockTimeout: boolean;
  /** 同じ目的の段階の束 (NOT VALID → VALIDATE など)。失敗時に「どの束が中途半端か」を判定する。 */
  group: number;
  /** 束が中途半端なまま止まったときの後始末 (適用済みの段階の取り消し)。 */
  undo?: string[];
  /** この段階自体が失敗したときに残りうるものの後始末 (CONCURRENTLY の INVALID なインデックス)。 */
  undoOnFail?: string[];
  /** 失敗したときに INVALID なインデックスが残ったかを調べる対象 (PostgreSQL)。 */
  invalidIndex?: string;
}

export interface DdlPlan {
  driver: string;
  /** 実行先のスキーマ / データベース。 */
  database: string | null;
  /** 段階に分けて実行するか。false は 1 段階 (従来どおり 1 トランザクション) で、プレビューに区切りは出さない。 */
  staged: boolean;
  /** ロック待ちの上限 (秒)。0 は付けない。 */
  lockTimeoutSecs: number;
  steps: DdlStep[];
}

/** ロック待ちの上限を付けられるドライバか (PostgreSQL / MySQL)。 */
export function supportsLockTimeout(driver: string): boolean {
  return driver === "postgres" || driver === "mysql";
}

/** 段階の前後に付けるロック待ちの上限の文。秒は 1 以上の整数に丸める。付けないときは空。 */
export function lockTimeoutStatements(driver: string, secs: number): { before: string[]; after: string[] } {
  const n = Math.floor(secs);
  if (!Number.isFinite(n) || n < 1) return { before: [], after: [] };
  if (driver === "postgres") return { before: [`SET LOCAL lock_timeout = '${n}s';`], after: [] };
  if (driver === "mysql") {
    // プールの接続へ設定が残らないよう、成功時は末尾で戻す。失敗時はバックエンドが戻す。元の値は
    // プロファイルの初期化 SQL が設定したセッション値かもしれないので、先頭で退避して戻す (time_zone と同じ #2100)。
    return {
      before: [
        "SET @noobdb_prev_lwt = @@SESSION.lock_wait_timeout;",
        `SET SESSION lock_wait_timeout = ${n};`,
      ],
      after: ["SET SESSION lock_wait_timeout = IFNULL(@noobdb_prev_lwt, @@GLOBAL.lock_wait_timeout);"],
    };
  }
  return { before: [], after: [] };
}

/** 段階を実際に送るときの文 (ロック待ちの上限を前後に付ける)。 */
export function stepStatementsToSend(plan: DdlPlan, step: DdlStep): string[] {
  if (!step.transactional || !step.lockTimeout) return step.statements;
  const { before, after } = lockTimeoutStatements(plan.driver, plan.lockTimeoutSecs);
  return [...before, ...step.statements, ...after];
}

/** 計画の本体 SQL を、段階の区切りなしで 1 本に連ねたもの (確認ゲート・スキーマ変更の記録用)。 */
export function planAllSql(plan: DdlPlan): string {
  return plan.steps.flatMap((s) => s.statements).join("\n");
}

/**
 * プレビュー / エディタ送り用の SQL。段階実行のときは `-- 段階 i/n: ...` のコメントで区切りを見せる
 * (エディタへ送ってそのまま順に実行できる)。`describe` は段階の説明文 (i18n は呼び出し側)。
 */
export function planPreviewSql(plan: DdlPlan, describe: (step: DdlStep, index: number) => string): string {
  if (!plan.staged) return planAllSql(plan);
  return plan.steps.map((s, i) => [`-- ${describe(s, i)}`, ...s.statements].join("\n")).join("\n\n");
}

/** `CREATE [UNIQUE] INDEX ...` を CONCURRENTLY 付きにする。すでに付いていれば何もしない。 */
export function withConcurrently(sql: string): string {
  if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(sql)) return sql;
  return sql.replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX)\s+/i, "$1 CONCURRENTLY ");
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 一時的な CHECK の名前 (`SET NOT NULL` の前段)。63 バイトに収める (引用符つきなので日本語の列名もそのまま)。 */
export function tempNotNullCheckName(columnName: string): string {
  return fitPgName(`noobdb_nn_${columnName}`, "", new Set());
}

/** CONCURRENTLY で作成する 1 段階。失敗すると INVALID なインデックスが残りうるので後始末を持つ。 */
function concurrentCreateStep(sql: string, name: string, database: string | null, group: number): DdlStep {
  return {
    phase: "createIndexConcurrently",
    subject: name,
    statements: [withConcurrently(sql)],
    transactional: false,
    lockTimeout: false,
    group,
    undoOnFail: [`DROP INDEX CONCURRENTLY IF EXISTS ${qualifiedTableName("postgres", database, name)};`],
    invalidIndex: name,
  };
}

export interface BuildPlanOptions {
  database: string | null;
  /** 段階に分けて実行する (PostgreSQL のみ有効)。 */
  staged: boolean;
  /** ロック待ちの上限 (秒)。0 / 非対応ドライバは付けない。 */
  lockTimeoutSecs: number;
}

/** 文を段階実行へ組み替えられる (NOT VALID / CONCURRENTLY の対象がある) か。 */
export function canStage(driver: string, statements: readonly AlterStatement[]): boolean {
  return driver === "postgres" && statements.some((s) => s.online !== undefined);
}

function hintedSteps(
  stmt: AlterStatement,
  hint: OnlineHint,
  database: string | null,
  group: number,
): DdlStep[] {
  switch (hint.type) {
    case "constraint":
      return [
        {
          phase: "addNotValid",
          subject: hint.name,
          statements: [`ALTER TABLE ${hint.table} ADD ${hint.clause} NOT VALID;`],
          transactional: true,
          lockTimeout: true,
          group,
          undo: [`ALTER TABLE ${hint.table} DROP CONSTRAINT ${quoteIdent(hint.name)};`],
        },
        {
          phase: "validate",
          subject: hint.name,
          statements: [`ALTER TABLE ${hint.table} VALIDATE CONSTRAINT ${quoteIdent(hint.name)};`],
          transactional: true,
          lockTimeout: true,
          group,
        },
      ];
    case "setNotNull": {
      const tmp = quoteIdent(tempNotNullCheckName(hint.columnName));
      return [
        {
          phase: "addNotValid",
          subject: hint.columnName,
          statements: [
            `ALTER TABLE ${hint.table} ADD CONSTRAINT ${tmp} CHECK (${hint.column} IS NOT NULL) NOT VALID;`,
          ],
          transactional: true,
          lockTimeout: true,
          group,
          undo: [`ALTER TABLE ${hint.table} DROP CONSTRAINT IF EXISTS ${tmp};`],
        },
        {
          phase: "validate",
          subject: hint.columnName,
          statements: [`ALTER TABLE ${hint.table} VALIDATE CONSTRAINT ${tmp};`],
          transactional: true,
          lockTimeout: true,
          group,
        },
        {
          phase: "setNotNull",
          subject: hint.columnName,
          statements: [stmt.sql, `ALTER TABLE ${hint.table} DROP CONSTRAINT ${tmp};`],
          transactional: true,
          lockTimeout: true,
          group,
        },
      ];
    }
    case "index":
      return [concurrentCreateStep(stmt.sql, hint.name, database, group)];
  }
}

/**
 * ALTER の文 (`AlterStatement[]`) から実行計画を作る。
 * - `staged` (PostgreSQL): FK / CHECK の追加は NOT VALID → VALIDATE、SET NOT NULL は一時 CHECK 経由、インデックスは
 *   CONCURRENTLY の別段階へ分ける。それ以外の文は、順序を保ったまま連続するものを 1 トランザクションの段階にまとめる。
 * - それ以外: 全文を 1 段階 (1 トランザクション) にし、ロック待ちの上限だけ付ける。
 */
export function buildAlterExecutionPlan(
  driver: string,
  statements: readonly AlterStatement[],
  opts: BuildPlanOptions,
): DdlPlan {
  const lockTimeoutSecs = supportsLockTimeout(driver) ? Math.max(0, Math.floor(opts.lockTimeoutSecs)) : 0;
  const base = { driver, database: opts.database, lockTimeoutSecs };
  if (!(opts.staged && canStage(driver, statements))) {
    return {
      ...base,
      staged: false,
      steps: [
        {
          phase: "alter",
          subject: "",
          statements: statements.map((s) => s.sql),
          transactional: true,
          lockTimeout: true,
          group: 0,
        },
      ],
    };
  }
  const steps: DdlStep[] = [];
  let pending: string[] = [];
  let group = 0;
  const flush = () => {
    if (pending.length === 0) return;
    steps.push({
      phase: "alter",
      subject: "",
      statements: pending,
      transactional: true,
      lockTimeout: true,
      group: group++,
    });
    pending = [];
  };
  for (const stmt of statements) {
    if (!stmt.online) {
      pending.push(stmt.sql);
      continue;
    }
    flush();
    steps.push(...hintedSteps(stmt, stmt.online, opts.database, group++));
  }
  flush();
  return { ...base, staged: true, steps };
}

/**
 * インデックス作成 / DROP の実行計画。PostgreSQL で `concurrently` のときは CONCURRENTLY をトランザクション外の
 * 1 段階にする (CREATE の `sql` は CONCURRENTLY 付きでも無しでもよい。DROP は呼び出し側が
 * `DROP INDEX CONCURRENTLY` を組んで渡す)。それ以外は 1 トランザクション + ロック待ちの上限。
 */
export function buildIndexExecutionPlan(
  driver: string,
  sql: string,
  opts: {
    database: string | null;
    indexName: string;
    kind: "create" | "drop";
    concurrently: boolean;
    lockTimeoutSecs: number;
  },
): DdlPlan {
  const lockTimeoutSecs = supportsLockTimeout(driver) ? Math.max(0, Math.floor(opts.lockTimeoutSecs)) : 0;
  const base = { driver, database: opts.database, lockTimeoutSecs, staged: false };
  if (driver === "postgres" && opts.concurrently) {
    if (opts.kind === "create") {
      return { ...base, steps: [concurrentCreateStep(sql, opts.indexName, opts.database, 0)] };
    }
    return {
      ...base,
      steps: [
        {
          phase: "dropIndexConcurrently",
          subject: opts.indexName,
          statements: [sql],
          transactional: false,
          lockTimeout: false,
          group: 0,
          // DROP INDEX CONCURRENTLY が失敗すると、インデックスが INVALID のまま残る。
          invalidIndex: opts.indexName,
          undoOnFail: [
            `${sql.replace(/;\s*$/, "").replace(/^(\s*DROP INDEX CONCURRENTLY)\s+/i, "$1 IF EXISTS ")};`,
          ],
        },
      ],
    };
  }
  return {
    ...base,
    steps: [
      {
        phase: opts.kind === "create" ? "createIndex" : "dropIndex",
        subject: opts.indexName,
        statements: [sql],
        transactional: true,
        lockTimeout: true,
        group: 0,
      },
    ],
  };
}

/** 従来の 1 回の呼び出しでは足りない (段階実行 / CONCURRENTLY / ロック待ちの上限) 計画か。 */
export function planNeedsRunner(plan: DdlPlan): boolean {
  return plan.staged || plan.lockTimeoutSecs > 0 || plan.steps.some((s) => !s.transactional);
}

/** ロック待ちのタイムアウトによる失敗か (PostgreSQL: SQLSTATE 55P03 / MySQL: エラー 1205)。 */
export function isLockTimeoutError(driver: string, message: string): boolean {
  if (driver === "postgres") return /lock timeout|55P03/i.test(message);
  if (driver === "mysql") return /lock wait timeout exceeded|\b1205\b/i.test(message);
  return false;
}

/** INVALID なインデックスが (指定スキーマに) 残っているかを調べる読み取り専用の SELECT (PostgreSQL)。 */
export function invalidIndexLookupSql(database: string | null, name: string): string {
  const schema =
    database && database.length > 0
      ? `n.nspname = ${quoteString("postgres", database)}`
      : "n.nspname = ANY (current_schemas(false))";
  return (
    "SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid " +
    "JOIN pg_namespace n ON n.oid = c.relnamespace " +
    `WHERE NOT i.indisvalid AND c.relname = ${quoteString("postgres", name)} AND ${schema}`
  );
}

/** 段階が失敗したときの案内 (どこまで適用済みか・残りの SQL・後始末の SQL)。 */
export interface DdlFailureGuide {
  /** 適用済みの段階数 (失敗した段階は含まない)。 */
  appliedSteps: number;
  totalSteps: number;
  /** 失敗した段階以降の SQL (原因を直してからエディタで続きを実行できる)。 */
  remainingSql: string;
  /** 中途半端に残ったもの (NOT VALID の制約・INVALID なインデックス・一時 CHECK) を片付ける SQL。 */
  cleanupSql: string;
}

export function buildFailureGuide(
  plan: DdlPlan,
  failedIndex: number,
  describe: (step: DdlStep, index: number) => string,
): DdlFailureGuide {
  const cleanup: string[] = [];
  // 束の一部だけが適用済みなら、その束の undo を (適用順の逆に) 集める。
  const groups = [...new Set(plan.steps.map((s) => s.group))].reverse();
  for (const g of groups) {
    const idx = plan.steps.flatMap((s, i) => (s.group === g ? [i] : []));
    const partial = idx.some((i) => i < failedIndex) && idx.some((i) => i >= failedIndex);
    if (!partial) continue;
    for (const i of [...idx].reverse()) {
      if (i < failedIndex) cleanup.push(...(plan.steps[i].undo ?? []));
    }
  }
  // 失敗した段階自体が不完全な状態を残す (CONCURRENTLY の INVALID) 場合。
  for (const u of plan.steps[failedIndex]?.undoOnFail ?? []) if (!cleanup.includes(u)) cleanup.push(u);
  const rest: DdlPlan = { ...plan, steps: plan.steps.slice(failedIndex) };
  return {
    appliedSteps: failedIndex,
    totalSteps: plan.steps.length,
    remainingSql: planPreviewSql(rest, (s, i) => describe(s, i + failedIndex)),
    cleanupSql: cleanup.join("\n"),
  };
}
