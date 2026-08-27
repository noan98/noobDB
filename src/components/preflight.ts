// 実行前の影響行数プリフライト (#737) の純ロジック。
//
// エディタの現在文が書き込み DML (UPDATE / DELETE) のとき、対象テーブルと WHERE
// 句を抽出して `SELECT COUNT(*) FROM <table> [WHERE <cond>]` へ変換する。UI は
// この COUNT を裏で実行し「影響: 約 1,240 行」「影響: 全行 (WHERE なし)」という
// バッジをゼロ操作で常時表示して、確認ダイアログより手前で異常 (桁違い・全行) に
// 気付けるようにする。
//
// **保守的判定 (迷ったら何もしない)**: `apply_auto_limit` や `dangerousSql.ts` と
// 同じ方針で、誤った数字を出すより出さないことを優先する。単一テーブルの素直な
// UPDATE / DELETE だけを「変換可能」と見なし、多表更新・JOIN・`UPDATE ... FROM`
// (PostgreSQL)・`DELETE ... USING`・`ORDER BY` / `LIMIT` 付き・複数文などは
// **「推定不可」に降格** (`countSql: null`) する。COUNT は読み取りなので read_only
// セッションでも安全に動作する。
//
// 解析基盤は `dangerousSql.ts` の `maskLiterals` (コメント/リテラルのマスク) を
// 共有する。マスクは方言非依存で、クオート付き識別子の中身も空白化するため、
// `` `order` `` という列名を句キーワード `ORDER` と誤認しない。一方で対象テーブル名
// (クオートされうる) と WHERE 条件は**元 SQL からそのまま切り出す**ことで、方言別の
// 再クオートを行わずに正確な COUNT を組み立てる (backtick / double-quote いずれの
// 引用でも原文を保持する)。
//
// 副作用が無いので Vitest (`src/__tests__/preflight.test.ts`) でユニットテストする。

import { maskLiterals } from "../dangerousSql";

/** プリフライト対象の書き込み DML 種別。 */
export type PreflightVerb = "update" | "delete";

export interface PreflightPlan {
  /** UPDATE か DELETE か。 */
  verb: PreflightVerb;
  /**
   * 対象テーブル参照 (元 SQL のまま。クオート/スキーマ修飾を保持)。変換不可能な
   * 形状では null。
   */
  table: string | null;
  /** WHERE 句が無い = テーブル全行が対象。`countSql` があれば全件数を数える。 */
  allRows: boolean;
  /**
   * 影響行数を数える `SELECT COUNT(*) ...` クエリ。**変換可能な形状のときだけ**
   * 非 null。多表・JOIN・サブクエリ FROM・`ORDER BY` / `LIMIT` など数え方が
   * 一意に決まらない形状では null (= UI は「推定不可」を表示)。
   */
  countSql: string | null;
}

/**
 * 対象テーブルより後ろ (WHERE 条件や末尾) に現れると COUNT へ素直に変換できない
 * トップレベルのキーワード (小文字)。JOIN 系・多表・並べ替え/件数制限を弾く。
 * これらが 1 つでもトップレベル (括弧深さ 0) に現れたら「推定不可」へ降格する。
 * サブクエリ内 (`WHERE id IN (SELECT ... ORDER BY ...)`) は括弧に包まれるため
 * トップレベル走査に現れず、誤検出しない。マスク済み文字列を走査するので、
 * クオートされた列名 (`` `order` `` 等) がこれらに一致することはない。
 */
const TROUBLE_KEYWORDS = new Set([
  "from",
  "using",
  "join",
  "order",
  "limit",
  "group",
  "having",
  "union",
  "intersect",
  "except",
]);

interface MaskedWord {
  /** 小文字化した単語テキスト (キーワード比較用)。 */
  text: string;
  /** マスク文字列 (= 元 SQL) 上の開始オフセット。 */
  from: number;
  /** マスク文字列 (= 元 SQL) 上の終端オフセット (排他)。 */
  to: number;
}

/** キーワード判定用の単語構成文字か (ドットは含めない: 句キーワードにドットは無い)。 */
function isKeywordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * マスク済み文字列 `[start, end)` を走査し、**括弧深さ 0** の単語トークンを順に返す。
 * 括弧の内側 (サブクエリ・関数引数・`OVER (...)`) は丸ごとスキップするので、返る
 * トークンは文のトップレベル構造だけを表す。`maskLiterals` 済みの入力を前提とし、
 * 文字列/コメント/クオート識別子の中身は空白化されているため、ここに現れる単語は
 * 実際の SQL キーワード/識別子だけになる。
 */
function maskedTopLevelWords(masked: string, start: number, end: number): MaskedWord[] {
  const out: MaskedWord[] = [];
  let depth = 0;
  let i = start;
  while (i < end) {
    const c = masked[i];
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (depth > 0) {
      i++;
      continue;
    }
    if (isKeywordChar(c)) {
      const wStart = i;
      while (i < end && isKeywordChar(masked[i])) i++;
      out.push({ text: masked.slice(wStart, i).toLowerCase(), from: wStart, to: i });
      continue;
    }
    i++;
  }
  return out;
}

/**
 * マスク済み文字列の位置 `p` から、テーブル参照を構成する**1 パート**を読み、その
 * 終端オフセットを返す (読めなければ null)。バッククオート (`` `t` ``)・ダブル
 * クオート (`"t"`)・裸の識別子 (`t`) のいずれかにマッチする。パート単位に切り出すのは、
 * ドット修飾の各パートが独立にクオートされうる (`` `db`.`t` `` / `"s"."t"` /
 * `db."t"`) ためで、`readTableRef` がこれを繰り返し呼ぶ。
 *
 * **走査は必ずマスク済み文字列に対して行う。** `maskLiterals` は長さを保ったまま
 * クオートの中身だけを空白化し**区切り記号は残す**ので、マスク上で次に現れる同じ
 * クオート文字が、そのまま「マスクがリテラルの終わりと判断した位置」になる。
 * 二重化によるエスケープ (`"a""b"`) や MySQL のバックスラッシュエスケープといった
 * 終端規則をここで再実装せずに済み、**この解析基盤が前提とするマスクとの一致**
 * (テーブル参照の終端 = マスク上の終端) が構造的に保証される。未終端クオートは
 * マスクが EOF まで空白化するため閉じ記号が見つからず、null (= 推定不可) になる。
 *
 * MSSQL の角括弧 (`[t]`) は**意図的に非対応** — `maskLiterals` が角括弧の中身を
 * 空白化しないため、`[order]` のようなクオート付き識別子が句キーワードとして
 * トップレベル走査に現れてしまい、この解析基盤の前提が崩れる。角括弧の参照は
 * パートとして読めず `readTableRef` が null を返すので、「推定不可」へ縮退する。
 */
function readTableRefPart(masked: string, p: number): number | null {
  const c = masked[p];
  if (c === "`" || c === '"') {
    const close = masked.indexOf(c, p + 1);
    // 空のクオート識別子 (`""`) と未終端クオートはどちらもテーブル名として
    // 成立しないので読めない扱いにする。
    if (close === -1 || close === p + 1) return null;
    return close + 1;
  }
  const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(masked.slice(p));
  return m ? p + m[0].length : null;
}

/**
 * マスク済み文字列の位置 `p` から (先頭空白を許して) 単一のテーブル参照を読む。
 * バッククオート (`` `t` ``)・ダブルクオート (`"t"`)・裸の識別子に加えて、**ドット
 * 修飾** (`schema.table`) をパートごとに読む。各パートは独立にクオートされてよいので、
 * `` `db`.`t` `` / `"s"."t"` / `db."t"` のような複合形も 1 つのテーブル参照として
 * 正しく読み切る (#1075。以前はここが先頭パートだけを貪欲にマッチし、
 * `` UPDATE `mydb`.`orders` … `` で `` `mydb` `` を対象テーブルと誤認して
 * **無関係なテーブルの COUNT** を影響行数バッジに出していた)。
 *
 * ドットの後にパートが読めない打ちかけの形 (`db.` / `` `db`. `` など) は
 * **null を返して**「推定不可」へ降格する — 先頭パートだけを採って誤った COUNT を
 * 出すより出さない方を優先する、本モジュールの保守的方針どおり。
 *
 * オフセットの決定はマスク済み文字列 (`masked`) 上で行い、返す生テキストは**元 SQL**
 * (`sql`) の同じ範囲から切り出す — マスクは長さを保つので両者のオフセットは一致する。
 * こうして再クオートせず原文 (クオートもドットもそのまま) を COUNT に使うことで、
 * 方言差 (引用文字の違い) を吸収する。
 */
function readTableRef(masked: string, sql: string, p: number): { raw: string; end: number } | null {
  const lead = /^\s*/.exec(masked.slice(p));
  const start = p + (lead ? lead[0].length : 0);
  let end = readTableRefPart(masked, start);
  if (end === null) return null;
  // ドット修飾を続く限り読む。ドットの前後の空白は SQL 上許されるので許容し、
  // 元テキストをそのまま切り出すことで COUNT へ写しても等価な参照を保つ。
  for (;;) {
    const gap = /^\s*\.\s*/.exec(masked.slice(end));
    if (!gap) break;
    const next = readTableRefPart(masked, end + gap[0].length);
    // ドットは読めたが次のパートが無い = 打ちかけ/未対応形。先頭だけ採らず降格する。
    if (next === null) return null;
    end = next;
  }
  return { raw: sql.slice(start, end), end };
}

/**
 * 単一文の UPDATE / DELETE を影響行数プリフライト用の `PreflightPlan` へ変換する。
 *
 * - 対象外 (SELECT/INSERT/DDL、空、または複数文) のときは **null** を返す
 *   (バッジ自体を出さない)。
 * - UPDATE / DELETE だが変換できない形状のときは
 *   `{ verb, table: null, allRows: false, countSql: null }` を返す (= 「推定不可」)。
 * - 変換できる単純形では `countSql` を伴う完全な計画を返す。
 *
 * `driver` は `maskLiterals` の文字列エスケープ規則を選ぶ (#852、#1004)。省略時は
 * 保守的な非 MySQL 解釈になる。
 */
export function buildPreflightPlan(sql: string, driver?: string): PreflightPlan | null {
  const masked = maskLiterals(sql, driver);
  // 末尾の空白と `;` を除いた実体。ここに `;` が残っていれば複数文なので対象外。
  // (文字列内の `;` はマスクで空白化済みなので誤検出しない。)
  const trimmed = masked.replace(/[\s;]+$/, "");
  if (trimmed.length === 0) return null;
  if (trimmed.includes(";")) return null;
  const stmtEnd = trimmed.length;

  const words = maskedTopLevelWords(masked, 0, stmtEnd);
  if (words.length === 0) return null;
  const lead = words[0].text;
  if (lead === "delete") return planForDelete(masked, sql, words, stmtEnd);
  if (lead === "update") return planForUpdate(masked, sql, words, stmtEnd);
  return null;
}

function unestimable(verb: PreflightVerb): PreflightPlan {
  return { verb, table: null, allRows: false, countSql: null };
}

function planForDelete(
  masked: string,
  sql: string,
  words: MaskedWord[],
  stmtEnd: number,
): PreflightPlan {
  // `DELETE FROM <table> ...` のみを扱う。`DELETE t FROM ...` (MySQL 多表削除) は
  // words[1] が "from" にならないので降格。
  if (words.length < 2 || words[1].text !== "from") return unestimable("delete");
  const table = readTableRef(masked, sql, words[1].to);
  if (!table) return unestimable("delete");
  // テーブル直後は WHERE / RETURNING か文末でなければならない。別名 (`DELETE FROM t
  // AS x` / `DELETE FROM t x`) や `USING` などが挟まると COUNT へ素直に写せないので
  // 降格する (`USING`/`JOIN` は TROUBLE でも弾かれるが、素の別名はここで捕捉する)。
  const after = maskedTopLevelWords(masked, table.end, stmtEnd);
  if (after.length > 0 && after[0].text !== "where" && after[0].text !== "returning") {
    return unestimable("delete");
  }
  return finishPlan("delete", masked, sql, table, stmtEnd);
}

function planForUpdate(
  masked: string,
  sql: string,
  words: MaskedWord[],
  stmtEnd: number,
): PreflightPlan {
  // `UPDATE <table> SET ...` のみを扱う。テーブル直後が SET でなければ (別名・
  // `UPDATE a, b` の多表・`UPDATE a JOIN b`) 降格する。
  const table = readTableRef(masked, sql, words[0].to);
  if (!table) return unestimable("update");
  const after = maskedTopLevelWords(masked, table.end, stmtEnd);
  if (after.length === 0 || after[0].text !== "set") return unestimable("update");
  return finishPlan("update", masked, sql, table, stmtEnd);
}

/**
 * テーブル参照が確定した後の共通処理。テーブルより後ろのトップレベル語を走査し、
 * トラブルキーワード (JOIN/多表/並べ替え等) があれば降格、無ければ WHERE の有無で
 * 全行 / 条件付きを判定して COUNT を組み立てる。
 */
function finishPlan(
  verb: PreflightVerb,
  masked: string,
  sql: string,
  table: { raw: string; end: number },
  stmtEnd: number,
): PreflightPlan {
  const rest = maskedTopLevelWords(masked, table.end, stmtEnd);
  let whereTok: MaskedWord | null = null;
  let returningTok: MaskedWord | null = null;
  for (const w of rest) {
    if (TROUBLE_KEYWORDS.has(w.text)) return unestimable(verb);
    if (w.text === "where" && !whereTok) whereTok = w;
    if (w.text === "returning" && !returningTok) returningTok = w;
  }

  if (!whereTok) {
    // WHERE が無い = テーブル全行。トラブル語も無いので (LIMIT なしの) 素の
    // UPDATE / DELETE と確定でき、全件 COUNT が影響行数そのものになる。
    return {
      verb,
      table: table.raw,
      allRows: true,
      countSql: `SELECT COUNT(*) FROM ${table.raw}`,
    };
  }

  // WHERE あり: 条件は元 SQL の「WHERE 直後」から「RETURNING 直前 or 文末」まで。
  // PostgreSQL の `RETURNING` は影響件数に関与しないので条件から切り落とす。
  const condEnd = returningTok && returningTok.from > whereTok.to ? returningTok.from : stmtEnd;
  const condition = sql.slice(whereTok.to, condEnd).trim();
  if (condition.length === 0) return unestimable(verb);
  return {
    verb,
    table: table.raw,
    allRows: false,
    countSql: `SELECT COUNT(*) FROM ${table.raw} WHERE ${condition}`,
  };
}

/** バッジの強調度。少数=中立 / 多数=警告 / 全行=危険 (#664 の意味色に対応)。 */
export type PreflightTone = "neutral" | "warning" | "danger";

/**
 * 「多数」と見なす影響行数の下限。これ以上で警告トーンにする。全行 (WHERE なし) は
 * 件数に関わらず危険トーン。閾値はバッジ配色の目安であり厳密な基準ではない。
 */
export const PREFLIGHT_LARGE_THRESHOLD = 1000;

/**
 * 影響規模からバッジの強調度を決める純関数。`allRows` (WHERE なし) は最優先で
 * 危険。件数不明 (null) や少数は中立、閾値以上は警告。
 */
export function preflightTone(allRows: boolean, count: number | null): PreflightTone {
  if (allRows) return "danger";
  if (count !== null && count >= PREFLIGHT_LARGE_THRESHOLD) return "warning";
  return "neutral";
}
