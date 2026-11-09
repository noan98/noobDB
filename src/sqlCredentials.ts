import { maskLiterals } from "./dangerousSql";

/**
 * SQL 文に含まれる資格情報リテラル (パスワード・ハッシュ) の判定と伏せ字化 (#2174)。
 *
 * バックエンドの `src-tauri/src/sql_credentials.rs` の二重実装で、両者は共有ゴールデン
 * (`__tests__/fixtures/credentialRedactVectors.json`) で同じ結果になるよう固定している。
 * 実行される SQL は変えず、**保存・表示のときだけ**伏せる。
 *
 * 判定は解析用マスク (`maskLiterals`) の上に載せる。マスク後の文字列は元の SQL と同じ長さで、
 * コメントとリテラルの中身が空白になっているので、それらの中に同じ語があっても対象にならない。
 * キーワードをマスク後の文字列で探し、元の SQL 上の同じ位置にあるリテラルを置き換える。
 *
 * 対象 (3 ドライバの資格情報構文に限る):
 * - MySQL: `IDENTIFIED BY '…'` / `IDENTIFIED BY PASSWORD '…'` / `IDENTIFIED WITH <plugin> BY|AS '…'` /
 *   MariaDB の `IDENTIFIED VIA <plugin> USING …` / `… REPLACE '…'` (旧パスワード) /
 *   文頭の `SET PASSWORD [FOR …] = '…'` (`PASSWORD('…')` も) /
 *   `CREATE|ALTER SERVER … OPTIONS (PASSWORD '…')` / `MASTER_PASSWORD|SOURCE_PASSWORD = '…'` /
 *   `START REPLICA|SLAVE … PASSWORD = '…'`
 * - PostgreSQL: `CREATE|ALTER ROLE|USER|GROUP` 内の `[ENCRYPTED] PASSWORD '…'`
 *   (`USER MAPPING … OPTIONS (password '…')` を含む。`E'…'` とドル引用も)
 * - SQLite: 対象なし
 *
 * リテラルの前置 (`E` / `U&` / `N` / `_utf8mb4`) は範囲に含めず残す。閉じていないリテラルは文末まで
 * (安全側)。`driver` を省略した場合は MySQL と PostgreSQL の規則を別々に走査して範囲を合わせる (広い側)。
 */

/** 伏せたあとのリテラル。 */
export const CREDENTIAL_PLACEHOLDER = "'********'";

/** 資格情報リテラルの範囲 (UTF-16 オフセットの半開区間 `[start, end)`)。 */
export interface CredentialRange {
  start: number;
  end: number;
}

function isWord(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;
}

function isWordStart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c) || c.charCodeAt(0) > 127;
}

function isWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\u000b" || c === "\u000c";
}

const isAlnum = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);

class Scanner {
  readonly out: CredentialRange[] = [];

  constructor(
    private readonly m: string,
    private readonly mysql: boolean,
    private readonly pg: boolean,
  ) {}

  private skipWs(from: number): number {
    let i = from;
    while (i < this.m.length && isWs(this.m[i])) i++;
    return i;
  }

  /** `i` から始まる語 (小文字) とその終端。 */
  private wordAt(i: number): { w: string; e: number } | null {
    const first = this.m[i];
    if (first === undefined || !isWordStart(first)) return null;
    let e = i;
    while (e < this.m.length && isWord(this.m[e])) e++;
    return { w: this.m.slice(i, e).toLowerCase(), e };
  }

  /** 引用符 `q` で始まるリテラルの終端 (閉じ引用符の次)。閉じていなければ文末。 */
  private quoteEnd(q: number): number {
    const idx = this.m.indexOf(this.m[q], q + 1);
    return idx < 0 ? this.m.length : idx + 1;
  }

  /** `$tag$` / `$$` の長さ。`$1` のようなパラメータは対象外。 */
  private dollarTagLen(p: number): number | null {
    let j = p + 1;
    const c = this.m[j];
    if (c !== undefined && /[A-Za-z_]/.test(c)) {
      while (j < this.m.length && /[A-Za-z0-9_]/.test(this.m[j])) j++;
    }
    return this.m[j] === "$" ? j + 1 - p : null;
  }

  /** `p` にあるリテラルの範囲。開始は引用符 (またはドル引用の `$`) の位置。 */
  private literalAt(p: number): CredentialRange | null {
    const c = this.m[p];
    if (c === undefined) return null;
    const next = this.m[p + 1];
    if (c === "'" || (c === '"' && this.mysql)) return { start: p, end: this.quoteEnd(p) };
    if (this.pg) {
      if ((c === "e" || c === "E") && next === "'") return { start: p + 1, end: this.quoteEnd(p + 1) };
      if ((c === "u" || c === "U") && next === "&" && this.m[p + 2] === "'") {
        return { start: p + 2, end: this.quoteEnd(p + 2) };
      }
      if (c === "$") {
        const tagLen = this.dollarTagLen(p);
        if (tagLen === null) return null;
        const close = this.m.indexOf(this.m.slice(p, p + tagLen), p + tagLen);
        return { start: p, end: close < 0 ? this.m.length : close + tagLen };
      }
    }
    if (this.mysql) {
      if ((c === "n" || c === "N") && next === "'") return { start: p + 1, end: this.quoteEnd(p + 1) };
      if (c === "_") {
        let j = p;
        while (j < this.m.length && (isAlnum(this.m[j]) || this.m[j] === "_")) j++;
        if (this.m[j] === "'" || this.m[j] === '"') return { start: j, end: this.quoteEnd(j) };
      }
    }
    return null;
  }

  private push(lit: CredentialRange): void {
    const last = this.out[this.out.length - 1];
    if (lit.start >= (last?.end ?? 0)) this.out.push(lit);
  }

  /** `p` にリテラル、または `PASSWORD('…')` / `OLD_PASSWORD('…')` があれば登録して、その終端を返す。 */
  private literalOrFn(p: number): number | null {
    const lit = this.literalAt(p);
    if (lit) {
      this.push(lit);
      return lit.end;
    }
    const word = this.wordAt(p);
    if (!word || (word.w !== "password" && word.w !== "old_password")) return null;
    let q = this.skipWs(word.e);
    if (this.m[q] !== "(") return null;
    q = this.skipWs(q + 1);
    const inner = this.literalAt(q);
    if (!inner) return null;
    this.push(inner);
    return inner.end;
  }

  /** 直前のリテラルの後ろに `REPLACE '旧パスワード'` が続けば、それも登録する。 */
  private replaceTail(after: number): void {
    const word = this.wordAt(this.skipWs(after));
    if (word?.w !== "replace") return;
    const lit = this.literalAt(this.skipWs(word.e));
    if (lit) this.push(lit);
  }

  /** `i` を含む文の先頭 (直前の `;` の次)。 */
  private stmtStart(i: number): number {
    return this.m.lastIndexOf(";", i - 1) + 1;
  }

  /** 文頭の語 2 つ (小文字)。 */
  private leadingWords(i: number): [string | null, string | null] {
    const a = this.wordAt(this.skipWs(this.stmtStart(i)));
    if (!a) return [null, null];
    const b = this.wordAt(this.skipWs(a.e));
    return [a.w, b?.w ?? null];
  }

  /** 文頭が `START REPLICA|SLAVE` (その `PASSWORD = '…'` はレプリケーションの資格情報)。 */
  private startsReplica(i: number): boolean {
    const [a, b] = this.leadingWords(i);
    return a === "start" && (b === "replica" || b === "slave");
  }

  private mysqlIdentified(e0: number): void {
    const head = this.wordAt(this.skipWs(e0));
    if (!head) return;
    if (head.w === "by") {
      let p = this.skipWs(head.e);
      const pw = this.wordAt(p);
      if (pw?.w === "password") p = this.skipWs(pw.e);
      const lit = this.literalAt(p);
      if (lit) {
        this.push(lit);
        this.replaceTail(lit.end);
      }
      return;
    }
    if (head.w !== "with" && head.w !== "via") return;
    const p = this.skipWs(head.e);
    const plugin = this.wordAt(p);
    let afterPlugin: number;
    if (plugin) {
      afterPlugin = plugin.e;
    } else {
      const quoted = this.literalAt(p);
      if (!quoted) return;
      afterPlugin = quoted.end;
    }
    const link = this.wordAt(this.skipWs(afterPlugin));
    if (!link) return;
    const ok = head.w === "with" ? link.w === "by" || link.w === "as" : link.w === "using";
    if (!ok) return;
    const end = this.literalOrFn(this.skipWs(link.e));
    if (end !== null) this.replaceTail(end);
  }

  private mysqlSetPassword(i: number, e0: number): void {
    // 文頭の `SET PASSWORD` だけ (`UPDATE t SET password = …` は対象外)。
    if (this.skipWs(this.stmtStart(i)) !== i) return;
    const word = this.wordAt(this.skipWs(e0));
    if (word?.w !== "password") return;
    let j = word.e;
    while (j < this.m.length && this.m[j] !== ";" && this.m[j] !== "=") j++;
    if (this.m[j] !== "=") return;
    const end = this.literalOrFn(this.skipWs(j + 1));
    if (end !== null) this.replaceTail(end);
  }

  scan(): void {
    const n = this.m.length;
    let i = 0;
    while (i < n) {
      if (!isWord(this.m[i])) {
        i++;
        continue;
      }
      let e = i;
      while (e < n && isWord(this.m[e])) e++;
      const w = this.m.slice(i, e).toLowerCase();
      if (w === "identified" && this.mysql) {
        this.mysqlIdentified(e);
      } else if (w === "set" && this.mysql) {
        this.mysqlSetPassword(i, e);
      } else if ((w === "master_password" || w === "source_password") && this.mysql) {
        const p = this.skipWs(e);
        if (this.m[p] === "=") {
          const lit = this.literalAt(this.skipWs(p + 1));
          if (lit) this.push(lit);
        }
      } else if (w === "password" && this.mysql && this.startsReplica(i)) {
        const p = this.skipWs(e);
        if (this.m[p] === "=") {
          const lit = this.literalAt(this.skipWs(p + 1));
          if (lit) this.push(lit);
        }
      } else if (w === "password") {
        const [a, b] = this.leadingWords(i);
        const inScope =
          (a === "create" || a === "alter") &&
          ((this.pg && (b === "role" || b === "user" || b === "group")) || (this.mysql && b === "server"));
        if (inScope) {
          const lit = this.literalAt(this.skipWs(e));
          if (lit) this.push(lit);
        }
      }
      i = e;
    }
  }
}

/**
 * 資格情報リテラルの範囲 (UTF-16 オフセットの半開区間、昇順・重なりなし)。
 * 確認ダイアログの SQL プレビューで伏せ字チップを出す側もこれを使う。
 */
export function findCredentialRanges(sql: string, driver?: string): CredentialRange[] {
  if (driver === "sqlite") return [];
  if (driver === "mysql" || driver === "postgres") return scanFor(sql, driver);
  // ドライバ不明: 文字列の終端の読み (`\'` を閉じ引用符とするか) が方言で違うので、方言ごとに
  // 別々に走査して範囲の和集合 (重なる範囲は広い側にまとめる) を取る。パスワードの後半を残さない。
  return mergeRanges([...scanFor(sql, "mysql"), ...scanFor(sql, "postgres")]);
}

function scanFor(sql: string, driver: "mysql" | "postgres"): CredentialRange[] {
  const scanner = new Scanner(maskLiterals(sql, driver), driver === "mysql", driver === "postgres");
  scanner.scan();
  return scanner.out;
}

function mergeRanges(ranges: CredentialRange[]): CredentialRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: CredentialRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** 資格情報リテラルを {@link CREDENTIAL_PLACEHOLDER} に置き換えた SQL。対象がなければ入力をそのまま返す。 */
export function redactCredentials(sql: string, driver?: string): string {
  const ranges = findCredentialRanges(sql, driver);
  if (ranges.length === 0) return sql;
  let out = "";
  let at = 0;
  for (const r of ranges) {
    out += sql.slice(at, r.start) + CREDENTIAL_PLACEHOLDER;
    at = r.end;
  }
  return out + sql.slice(at);
}
