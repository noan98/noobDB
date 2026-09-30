// SQL 整形 (sql-formatter) を Web Worker で実行する (#1256)。
//
// 数千行の SQL を整形するとメインスレッドが秒単位で塞がる (入力・スクロール・
// 結果のストリーミング描画が止まる) ため、整形だけをワーカーへ逃がす。整形結果は
// メインスレッドで同期実行したときと同一 (同じ `sql-formatter` の `format` を同じ
// オプションで呼ぶだけ)。呼び出し側は `sqlFormat.ts` の `formatSqlAsync`。

import { format } from "sql-formatter";
import type { SqlFormatLanguage, SqlFormatRequest, SqlFormatResponse } from "./sqlFormat";

// ワーカーのグローバルは DOM の `Window` 型ではないため、必要な口だけを最小の型で
// 宣言し直す (tsconfig は DOM lib のみで WebWorker lib を持たない)。
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<SqlFormatRequest>) => void) | null;
  postMessage: (message: SqlFormatResponse) => void;
  location: { origin: string };
};

// 専用ワーカーへのメッセージは生成元ページからしか届かず、その MessageEvent の
// `origin` は空文字になる。念のため空文字か自分と同じオリジン以外は無視し、
// 形の合わない要求も捨てる (CodeQL: missing origin verification)。
function isTrustedRequest(e: MessageEvent<unknown>): e is MessageEvent<SqlFormatRequest> {
  if (e.origin !== "" && e.origin !== ctx.location.origin) return false;
  const d = e.data as Partial<SqlFormatRequest> | null;
  return (
    !!d &&
    typeof d.id === "number" &&
    typeof d.text === "string" &&
    typeof d.language === "string"
  );
}

function run(text: string, language: SqlFormatLanguage): string {
  return format(text, { language });
}

ctx.onmessage = (e) => {
  if (!isTrustedRequest(e)) return;
  const { id, text, language } = e.data;
  try {
    ctx.postMessage({ id, ok: true, result: run(text, language) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
