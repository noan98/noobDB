import type { QueryResult } from "../api/tauri";
import {
  buildFailureGuide,
  invalidIndexLookupSql,
  isLockTimeoutError,
  stepStatementsToSend,
  type DdlPlan,
  type DdlStep,
} from "./onlineDdl";

/**
 * `DdlPlan` を段階ごとに実行する (#2240)。段階は 1 トランザクション (`runQueryTransaction`) か、
 * CONCURRENTLY のためのトランザクション外の単独 1 文 (`runQuery`) で流す。どちらも既存のバックエンド経路なので
 * read_only のガード・履歴・キャッシュ無効化はそのまま効く (read_only では最初の段階でバックエンドが拒否する)。
 * 確認ダイアログ (`confirm_writes` / 本番の確認) は呼び出し側が実行前に済ませる。
 */
export interface DdlRunnerApi {
  runQuery: (sessionId: string, sql: string, database?: string | null) => Promise<QueryResult>;
  runQueryTransaction: (
    sessionId: string,
    statements: string[],
    database?: string | null,
  ) => Promise<QueryResult>;
  runLookupQuery: (params: {
    sessionId: string;
    sql: string;
    database?: string | null;
  }) => Promise<QueryResult>;
}

/** 画面から App へ渡す、DDL を計画どおりに流す指示 (#2240)。 */
export interface DdlRunOptions {
  plan: DdlPlan;
  /** 段階ごとの進捗 (完了数, 全段階数)。 */
  onProgress?: (done: number, total: number) => void;
}

export interface DdlRunReport {
  ok: boolean;
  totalSteps: number;
  /** 完了した段階数 (失敗時は失敗した段階の手前まで)。 */
  completedSteps: number;
  /** 失敗した段階 (成功時は null)。 */
  failedStep: DdlStep | null;
  /** 失敗した段階の番号 (0 始まり)。 */
  failedIndex: number | null;
  error: string | null;
  /** ロック待ちのタイムアウト (lock_timeout / lock_wait_timeout) による失敗か。 */
  lockTimeout: boolean;
  /** CONCURRENTLY の失敗後に INVALID なインデックスが残っているか。調べられなかったときは null。 */
  invalidIndexLeft: boolean | null;
  /** 失敗した段階以降の SQL (原因を直してからエディタで続きを実行する用)。 */
  remainingSql: string;
  /** 中途半端に残ったものを片付ける SQL。 */
  cleanupSql: string;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 段階の説明 (SQL コメントに入るので i18n に頼らず固定の英数字語彙)。画面の文言は呼び出し側が持つ。 */
export function stepComment(step: DdlStep, index: number, total: number): string {
  const label: Record<DdlStep["phase"], string> = {
    alter: "ALTER",
    addNotValid: "ADD CONSTRAINT ... NOT VALID",
    validate: "VALIDATE CONSTRAINT",
    setNotNull: "SET NOT NULL",
    createIndexConcurrently: "CREATE INDEX CONCURRENTLY",
    createIndex: "CREATE INDEX",
    dropIndex: "DROP INDEX",
    dropIndexConcurrently: "DROP INDEX CONCURRENTLY",
  };
  return `${index + 1}/${total} ${label[step.phase]}${step.subject ? ` (${step.subject})` : ""}`;
}

export async function runDdlPlan(
  api: DdlRunnerApi,
  sessionId: string,
  plan: DdlPlan,
  onProgress?: (done: number, total: number) => void,
): Promise<DdlRunReport> {
  const total = plan.steps.length;
  onProgress?.(0, total);
  for (let i = 0; i < total; i++) {
    const step = plan.steps[i];
    try {
      if (step.transactional) {
        await api.runQueryTransaction(sessionId, stepStatementsToSend(plan, step), plan.database);
      } else {
        // CONCURRENTLY はトランザクション内では実行できない。1 文ずつ単独で流す。
        for (const sql of step.statements) await api.runQuery(sessionId, sql, plan.database);
      }
    } catch (e) {
      const error = messageOf(e);
      let invalidIndexLeft: boolean | null = null;
      if (step.invalidIndex) {
        try {
          const r = await api.runLookupQuery({
            sessionId,
            sql: invalidIndexLookupSql(plan.database, step.invalidIndex),
            database: plan.database,
          });
          invalidIndexLeft = r.rows.length > 0;
        } catch {
          invalidIndexLeft = null;
        }
      }
      const guide = buildFailureGuide(plan, i, (st, idx) => stepComment(st, idx, total));
      return {
        ok: false,
        totalSteps: total,
        completedSteps: i,
        failedStep: step,
        failedIndex: i,
        error,
        lockTimeout: isLockTimeoutError(plan.driver, error),
        invalidIndexLeft,
        remainingSql: guide.remainingSql,
        // INVALID なインデックスが残っていると確認できたときだけ DROP を案内する。確認できなかった (null) ときや
        // 残っていないときに案内すると、「同名のインデックスが既に存在」で失敗した場合に有効な既存インデックスを落としかねない。
        cleanupSql:
          invalidIndexLeft === true
            ? guide.cleanupSql
            : guide.cleanupSql
                .split("\n")
                .filter((l) => !/^DROP INDEX CONCURRENTLY IF EXISTS/i.test(l))
                .join("\n"),
      };
    }
    onProgress?.(i + 1, total);
  }
  return {
    ok: true,
    totalSteps: total,
    completedSteps: total,
    failedStep: null,
    failedIndex: null,
    error: null,
    lockTimeout: false,
    invalidIndexLeft: null,
    remainingSql: "",
    cleanupSql: "",
  };
}
