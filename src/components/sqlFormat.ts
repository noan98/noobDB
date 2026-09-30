// SQL 整形の非同期ラッパー (#1256)。
//
// 整形 (sql-formatter) は巨大な SQL で数百 ms〜数秒かかり、メインスレッドで実行する
// と UI 全体が固まる。`Worker` が使える環境では `sqlFormat.worker.ts` へ逃がし、
// 使えない環境 (テストの jsdom など) やワーカーの起動・実行に失敗したときは、同じ
// `sql-formatter` をメインスレッドで実行するフォールバックに切り替える。どちらの経路も
// 結果は同一。整形ロジック自体は変更しない (Rust へも移さない)。

import { sqlFormatterLanguageFor } from "./sqlDialect";

export type SqlFormatLanguage = ReturnType<typeof sqlFormatterLanguageFor>;

/** メインスレッド → ワーカー。 */
export interface SqlFormatRequest {
  id: number;
  text: string;
  language: SqlFormatLanguage;
}

/** ワーカー → メインスレッド。 */
export type SqlFormatResponse =
  | { id: number; ok: true; result: string }
  | { id: number; ok: false; message: string };

interface Pending {
  req: SqlFormatRequest;
  resolve: (formatted: string) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
/** ワーカーが使えないと分かったら以後はメインスレッド実行に固定する。 */
let workerUnavailable = false;
let nextId = 1;
const pending = new Map<number, Pending>();

/** メインスレッドでの整形 (フォールバック)。`sql-formatter` は初回だけ動的 import する
 *  ので、ワーカーが使えるときにメインバンドルへ取り込まれない。 */
async function formatInThread(text: string, language: SqlFormatLanguage): Promise<string> {
  const { format } = await import("sql-formatter");
  return format(text, { language });
}

function failWorker(): void {
  workerUnavailable = true;
  try {
    worker?.terminate();
  } catch {
    // 破棄に失敗しても以後は使わないので無視する。
  }
  worker = null;
  // 待っていた要求はメインスレッドでやり直す (結果は同じ)。
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) {
    formatInThread(p.req.text, p.req.language).then(p.resolve, p.reject);
  }
}

function getWorker(): Worker | null {
  if (workerUnavailable || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL("./sqlFormat.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<SqlFormatResponse>) => {
      const res = e.data;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.message));
    };
    w.onerror = () => failWorker();
    worker = w;
    return w;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

/**
 * `text` を整形して返す。構文エラーなど整形に失敗したときは reject (メッセージは
 * `sql-formatter` のもの)。`Worker` が使えなければメインスレッドで実行する。
 */
export function formatSqlAsync(text: string, driver: string): Promise<string> {
  const language = sqlFormatterLanguageFor(driver);
  const w = getWorker();
  if (!w) return formatInThread(text, language);
  return new Promise<string>((resolve, reject) => {
    const req: SqlFormatRequest = { id: nextId++, text, language };
    pending.set(req.id, { req, resolve, reject });
    try {
      w.postMessage(req);
    } catch {
      pending.delete(req.id);
      failWorker();
      formatInThread(text, language).then(resolve, reject);
    }
  });
}
