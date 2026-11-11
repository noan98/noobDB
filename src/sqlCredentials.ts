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
 *   `START REPLICA|SLAVE|GROUP_REPLICATION … PASSWORD = '…'` (#2245)
 * - PostgreSQL: `CREATE|ALTER ROLE|USER|GROUP` 内の `[ENCRYPTED] PASSWORD '…'`
 *   (`USER MAPPING … OPTIONS (password '…')` を含む。`E'…'` とドル引用も)
 *   と `CREATE|ALTER SUBSCRIPTION … CONNECTION '<接続文字列>'` (#2189。中身に `redactConninfo` が伏せる
 *   `password` / `sslpassword` / URI のパスワードがあるときだけリテラル全体)。
 *   同じ規則で #2245: `dblink(…)` / `dblink_exec(…)` / `dblink_connect[_u](…)` の括弧内の文字列リテラルと、
 *   `primary_conninfo [=|TO] '…'` (`ALTER SYSTEM SET` / `SET` / `ALTER DATABASE|ROLE … SET`)・
 *   `set_config('primary_conninfo', '…', …)`
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
  /** SUBSCRIPTION / dblink / primary_conninfo の接続文字列から取り出した秘密の値 (`secretsFor` 用)。 */
  readonly secrets: string[] = [];

  constructor(
    private readonly m: string,
    private readonly src: string,
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

  /** PostgreSQL の連結文字列: 改行を含む空白 (コメントも可) だけで隔てた次の `'…'` は同じ値の続き。 */
  private pgContinue(from: number): number {
    let end = from;
    for (;;) {
      let j = end;
      let newline = false;
      while (j < this.m.length && isWs(this.m[j])) {
        newline ||= this.m[j] === "\n";
        j++;
      }
      if (newline && this.m[j] === "'") end = this.quoteEnd(j);
      else return end;
    }
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
    if (c === "'" || (c === '"' && this.mysql)) {
      const end = this.quoteEnd(p);
      return { start: p, end: this.pg && c === "'" ? this.pgContinue(end) : end };
    }
    if (this.pg) {
      if ((c === "e" || c === "E") && next === "'") {
        return { start: p + 1, end: this.pgContinue(this.quoteEnd(p + 1)) };
      }
      if ((c === "u" || c === "U") && next === "&" && this.m[p + 2] === "'") {
        return { start: p + 2, end: this.pgContinue(this.quoteEnd(p + 2)) };
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

  /** 文頭が `START REPLICA|SLAVE|GROUP_REPLICATION` (その `PASSWORD = '…'` はレプリケーションの資格情報)。 */
  private startsReplica(i: number): boolean {
    const [a, b] = this.leadingWords(i);
    return a === "start" && (b === "replica" || b === "slave" || b === "group_replication");
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

  /**
   * `CONNECTION '…'` のリテラルが伏せ対象なら、その中の秘密の値 (エラー文の置換用。空もありうる) を返す。
   * 対象外なら null。Rust 側 `conninfo_literal_secrets` と同じ規則 (安全側):
   * `U&'…'` / 中身に `\` がある `E'…'` / エスケープを解いた中身に "password" を含む /
   * `redactConninfo` や `conninfoSecretValues` が値を見つける / URI で最後の `@` の前に `:` がある (パスワードに `/` `?` が素で入っても漏らさない)。
   * `strict` (問い合わせ SQL の引数など接続文字列と限らないリテラル用) は "password" の語と opaque を見ず、値が見つかるときだけ対象にする。
   */
  private conninfoLiteralSecrets(lit: CredentialRange, strict: boolean): string[] | null {
    const { start: s, end: e } = lit;
    let decoded = "";
    let opaque = false;
    if (this.m[s] === "$") {
      const tagLen = this.dollarTagLen(s);
      if (tagLen === null) return [];
      const closed = e >= s + 2 * tagLen && this.m.slice(e - tagLen, e) === this.m.slice(s, s + tagLen);
      const innerEnd = closed ? e - tagLen : e;
      if (s + tagLen <= innerEnd) decoded = this.src.slice(s + tagLen, innerEnd);
    } else {
      const uAmp = s >= 2 && this.m[s - 1] === "&" && (this.m[s - 2] === "u" || this.m[s - 2] === "U");
      const esc = uescapeChar(this.m, this.src, e);
      const backslash = s >= 1 && (this.m[s - 1] === "e" || this.m[s - 1] === "E");
      let i = s;
      while (i < e) {
        if (this.m[i] !== "'") {
          i++;
          continue;
        }
        // 連結文字列は各片の中身をつなげる。閉じていなければ文末まで。
        let c = this.m.indexOf("'", i + 1);
        if (c < 0 || c >= e) c = -1;
        const innerEnd = c < 0 ? e : c;
        const raw = this.src.slice(i + 1, innerEnd);
        // `U&'…'` は `\XXXX` でキー名を隠せるので、常に伏せ対象にする。
        opaque ||= uAmp || (backslash && raw.includes("\\"));
        decoded += decodeLiteralPiece(raw, uAmp, backslash, esc);
        i = c < 0 ? e : c + 1;
      }
    }
    const values = conninfoSecretValues(decoded);
    const lower = asciiLower(decoded);
    const t = trimStartLikeRust(lower);
    const schemeAt = t.indexOf("://");
    const atPos = schemeAt < 0 ? -1 : t.lastIndexOf("@");
    const uriAt =
      (t.startsWith("postgresql://") || t.startsWith("postgres://")) &&
      atPos > schemeAt &&
      t.slice(schemeAt + 3, atPos).includes(":");
    const secret =
      (opaque && !strict) ||
      uriAt ||
      (!strict && lower.includes("password")) ||
      values.length > 0 ||
      (!strict && redactConninfo(decoded) !== decoded);
    return secret ? values : null;
  }

  /** PostgreSQL の `CREATE|ALTER SUBSCRIPTION … CONNECTION '<接続文字列>'` (#2189)。パスワードがあるときだけリテラル全体。 */
  private pgSubscriptionConnection(i: number, e: number): void {
    const [a, b] = this.leadingWords(i);
    if ((a !== "create" && a !== "alter") || b !== "subscription") return;
    const lit = this.literalAt(this.skipWs(e));
    if (lit) this.pushConninfo(lit, false);
  }

  /** リテラルが接続文字列で秘密を含むなら伏せ対象にして、秘密の値を集める。 */
  private pushConninfo(lit: CredentialRange, strict: boolean): void {
    const values = this.conninfoLiteralSecrets(lit, strict);
    if (values === null) return;
    this.push(lit);
    this.secrets.push(...values);
  }

  /**
   * dblink 関数 (`dblink` / `dblink_exec` / `dblink_connect[_u]`) の括弧内のリテラルをすべて接続文字列として検査する
   * (`'host=h ' || 'password=…'`・`CAST('…' AS text)`・名前付き引数・第 1 引数が変数でも拾う)。`dblink` / `dblink_exec` は
   * 第 2 引数以降 (問い合わせ SQL) を strict にし、password を含む接続文字列と判定できたものだけ伏せる。`e` は関数名の終端。
   */
  private pgDblinkCall(w: string, e: number): void {
    const p = this.skipWs(e);
    if (this.m[p] !== "(") return;
    const connect = w.startsWith("dblink_connect");
    let depth = 0;
    let commas = 0;
    let j = p;
    while (j < this.m.length) {
      const c = this.m[j];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) return;
      } else if (c === "," && depth === 1) commas++;
      if ("'\"$eEuU".includes(c) && (j === 0 || !isWord(this.m[j - 1]))) {
        const lit = this.literalAt(j);
        if (lit) {
          this.pushConninfo(lit, !connect && commas > 0);
          j = lit.end;
          continue;
        }
      }
      j++;
    }
  }

  /** `primary_conninfo [=|TO] '<接続文字列>'` (`ALTER SYSTEM SET` / `SET` / `ALTER DATABASE|ROLE … SET`)。`e` は設定名の終端。 */
  private pgPrimaryConninfo(e: number): void {
    let p = this.skipWs(e);
    if (this.m[p] === "=") {
      p++;
    } else {
      const t = this.wordAt(p);
      if (!t || t.w !== "to") return;
      p = t.e;
    }
    const lit = this.literalAt(this.skipWs(p));
    if (lit) this.pushConninfo(lit, false);
  }

  /** `set_config('primary_conninfo', '<接続文字列>', …)`。`e` は関数名の終端。 */
  private pgSetConfig(e: number): void {
    const p = this.skipWs(e);
    if (this.m[p] !== "(") return;
    const name = this.literalAt(this.skipWs(p + 1));
    if (!name || this.m[name.start] !== "'") return;
    const inner = this.src.slice(name.start + 1, Math.max(name.end - 1, name.start + 1));
    if (inner.toLowerCase() !== "primary_conninfo") return;
    const q = this.skipWs(name.end);
    if (this.m[q] !== ",") return;
    const lit = this.literalAt(this.skipWs(q + 1));
    if (lit) this.pushConninfo(lit, false);
  }

  scan(): void {
    const n = this.m.length;
    let i = 0;
    while (i < n) {
      if (this.pg && this.m[i] === '"') {
        // 引用符つきの関数名 (`"dblink_connect"(…)`)。解析用マスクは中身を空白にするので元の SQL から読む。
        const close = this.m.indexOf('"', i + 1);
        if (close >= 0) {
          const name = this.src.slice(i + 1, close);
          if (
            name === "dblink" ||
            name === "dblink_exec" ||
            name === "dblink_connect" ||
            name === "dblink_connect_u"
          ) {
            this.pgDblinkCall(name, close + 1);
          } else if (name === "primary_conninfo") {
            this.pgPrimaryConninfo(close + 1);
          } else if (name === "set_config") {
            this.pgSetConfig(close + 1);
          }
          i = close + 1;
          continue;
        }
      }
      if (!isWord(this.m[i])) {
        i++;
        continue;
      }
      let e = i;
      while (e < n && isWord(this.m[e])) e++;
      const w = this.m.slice(i, e).toLowerCase();
      if (w === "identified" && this.mysql) {
        this.mysqlIdentified(e);
      } else if (w === "connection" && this.pg) {
        this.pgSubscriptionConnection(i, e);
      } else if (
        (w === "dblink" || w === "dblink_exec" || w === "dblink_connect" || w === "dblink_connect_u") &&
        this.pg
      ) {
        this.pgDblinkCall(w, e);
      } else if (w === "primary_conninfo" && this.pg) {
        this.pgPrimaryConninfo(e);
      } else if (w === "set_config" && this.pg) {
        this.pgSetConfig(e);
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
  return scanWithMask(sql, driver).ranges;
}

function scanWithMask(
  sql: string,
  driver: "mysql" | "postgres",
): { ranges: CredentialRange[]; masked: string; extra: string[] } {
  const masked = maskLiterals(sql, driver);
  const scanner = new Scanner(masked, sql, driver === "mysql", driver === "postgres");
  scanner.scan();
  return { ranges: scanner.out, masked, extra: scanner.secrets };
}

/** 誤置換を避けるため、これより短い値はエラー文の置換対象にしない (UTF-16 コード単位ではなく文字数)。 */
const MIN_SECRET_CHARS = 4;

function unescapeLiteral(raw: string, quote: string, backslash: boolean): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (backslash && c === "\\" && i + 1 < raw.length) {
      out += raw[++i];
    } else if (c === quote && raw[i + 1] === quote) {
      out += quote;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** 16 進 `n` 桁ちょうどを読む (配列 `a` の `start` から)。 */
function hexAt(a: string[], start: number, n: number): number | null {
  if (start + n > a.length) return null;
  let v = 0;
  for (let k = 0; k < n; k++) {
    if (!/^[0-9a-fA-F]$/.test(a[start + k])) return null;
    v = v * 16 + Number.parseInt(a[start + k], 16);
  }
  return v;
}

/** サロゲートペアの上位 `hi` と下位 `lo` を 1 文字にする。ペアでなければ null。 */
function combineSurrogates(hi: number, lo: number): string | null {
  if (hi >= 0xd800 && hi < 0xdc00 && lo >= 0xdc00 && lo < 0xe000) {
    return String.fromCodePoint(0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00));
  }
  return null;
}

const codePointString = (code: number): string | null =>
  code <= 0x10ffff && !(code >= 0xd800 && code < 0xe000) ? String.fromCodePoint(code) : null;

/**
 * PostgreSQL の `E'…'` の中身 (引用符の内側) を、サーバ (libpq が受け取る文字列) と同じにデコードする。
 * `\b \f \n \r \t`、8 進、`\x`、`\u` / `\U` (サロゲートペア可)、それ以外の `\c` は `c`、`''` は `'`。
 * 8 進・`\x` はバイト値で、全体を UTF-8 として読む (不正なバイトは U+FFFD)。Rust 側 `decode_pg_e` と同じ。
 */
function decodePgE(rawText: string): string {
  const raw = Array.from(rawText);
  const enc = new TextEncoder();
  const out: number[] = [];
  const push = (c: string): void => {
    out.push(...enc.encode(c));
  };
  const isOct = (c: string | undefined): boolean => c !== undefined && /^[0-7]$/.test(c);
  const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'" && raw[i + 1] === "'") {
      out.push(0x27);
      i += 2;
      continue;
    }
    if (c !== "\\" || i + 1 >= raw.length) {
      push(c);
      i++;
      continue;
    }
    const d = raw[i + 1];
    i += 2;
    if (d === "b") out.push(8);
    else if (d === "f") out.push(12);
    else if (d === "n") out.push(10);
    else if (d === "r") out.push(13);
    else if (d === "t") out.push(9);
    else if (isOct(d)) {
      let v = Number.parseInt(d, 8);
      for (let used = 1; used < 3 && isOct(raw[i]); used++) v = v * 8 + Number.parseInt(raw[i++], 8);
      out.push(v & 0xff);
    } else if (d === "x") {
      let v = 0;
      let used = 0;
      while (used < 2 && isHex(raw[i])) {
        v = v * 16 + Number.parseInt(raw[i++], 16);
        used++;
      }
      out.push(used === 0 ? 0x78 : v);
    } else if (d === "u" || d === "U") {
      const n = d === "u" ? 4 : 8;
      const code = hexAt(raw, i, n);
      if (code === null) {
        push(d);
        continue;
      }
      i += n;
      let ch = codePointString(code);
      if (ch === null && d === "u" && raw[i] === "\\" && raw[i + 1] === "u") {
        const lo = hexAt(raw, i + 2, 4);
        if (lo !== null) {
          ch = combineSurrogates(code, lo);
          if (ch !== null) i += 6;
        }
      }
      push(ch ?? "\ufffd");
    } else push(d);
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

/**
 * PostgreSQL の `U&'…'` の中身 (`''` は解いたもの) を `esc` (既定 `\`、`UESCAPE` で変更) でデコードする。
 * `esc` + 4 桁 16 進、`esc` + `+` + 6 桁 16 進 (サロゲートペア可)、`esc esc` は `esc` 自身。
 */
function decodePgU(rawText: string, esc: string): string {
  const raw = Array.from(rawText);
  const read = (at: number): [number, number] | null => {
    if (raw[at] !== esc) return null;
    if (raw[at + 1] === "+") {
      const v = hexAt(raw, at + 2, 6);
      return v === null ? null : [v, at + 8];
    }
    const v = hexAt(raw, at + 1, 4);
    return v === null ? null : [v, at + 5];
  };
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const r = raw[i] === esc && raw[i + 1] === esc ? null : read(i);
    if (raw[i] === esc && raw[i + 1] === esc) {
      out += esc;
      i += 2;
    } else if (r) {
      i = r[1];
      let ch = codePointString(r[0]);
      if (ch === null) {
        const lo = read(i);
        if (lo) {
          ch = combineSurrogates(r[0], lo[0]);
          if (ch !== null) i = lo[1];
        }
      }
      out += ch ?? "\ufffd";
    } else {
      out += raw[i++];
    }
  }
  return out;
}

/** リテラルの終端 `e` の後ろに `UESCAPE '<1 文字>'` があればその文字、なければ `\`。 */
function uescapeChar(m: string, src: string, e: number): string {
  const skip = (from: number): number => {
    let i = from;
    while (i < m.length && isWs(m[i])) i++;
    return i;
  };
  const p = skip(e);
  let wordEnd = p;
  while (wordEnd < m.length && /[A-Za-z]/.test(m[wordEnd])) wordEnd++;
  if (m.slice(p, wordEnd).toLowerCase() !== "uescape") return "\\";
  const q = skip(wordEnd);
  const c = src.codePointAt(q + 1);
  if (m[q] !== "'" || c === undefined) return "\\";
  const ch = String.fromCodePoint(c);
  return m[q + 1 + ch.length] === "'" ? ch : "\\";
}

/** 連結文字列の 1 片 `raw` (引用符の内側) をデコードする。`uAmp` は `U&'…'`、`backslash` は `E'…'` / MySQL。 */
function decodeLiteralPiece(raw: string, uAmp: boolean, backslash: boolean, esc: string): string {
  if (uAmp) return decodePgU(unescapeLiteral(raw, "'", false), esc);
  return backslash ? decodePgE(raw) : unescapeLiteral(raw, "'", false);
}

/** 接続文字列に含まれるパスワードとして伏せるキーワード (小文字)。パスファイルへの**パス** (`passfile`) は対象外。 */
const CONNINFO_SECRET_KEYS = ["password", "sslpassword"];

/** Rust の `str::trim_start` (Unicode の White_Space) と同じ空白定義。JS の `trimStart` は U+FEFF も除くので使わない。 */
const trimStartLikeRust = (s: string): string =>
  s.replace(/^[\t\n\u000b\u000c\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "");

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** URI のクエリのキーのパーセントデコード (`pass%77ord` → `password`)。不正な `%` はそのまま残す。 */
function percentDecode(s: string): string {
  const bytes: number[] = [];
  const enc = new TextEncoder().encode(s);
  for (let i = 0; i < enc.length; i++) {
    const h = /^[0-9a-fA-F]{2}$/.test(String.fromCharCode(enc[i + 1] ?? 0, enc[i + 2] ?? 0));
    if (enc[i] === 0x25 && h) {
      bytes.push(Number.parseInt(String.fromCharCode(enc[i + 1], enc[i + 2]), 16));
      i += 2;
    } else {
      bytes.push(enc[i]);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * key の位置にある語が URI 風 (`user:パスワード@host…`) か。libpq のキーワードは `:` を含まないので、
 * key の位置 (`=` か空白まで) に `:` があれば URI の打ち間違いと見なす (安全側)。
 */
function looksLikeUserinfo(word: string): boolean {
  return word.includes(":");
}

/**
 * URI 風の語 (`rest` はその語の先頭から文末まで) をエラー文で引用されうる形の候補にする。Rust 側
 * `userinfo_word_secrets` と同じ規則。候補は定数個 (`:` の数に比例させると二乗時間になる)。
 */
function userinfoWordSecrets(rest: string): string[] {
  const MAX_WORDS = 32;
  const text = rest;
  let keyEnd = text.search(/[=\t\n\r\u000b\u000c ]/);
  if (keyEnd < 0) keyEnd = text.length;
  const key = text.slice(0, keyEnd);
  const base: string[] = [key, text.replace(/[\t\n\r\u000b\u000c ]+$/, "")];
  const first = key.indexOf(":");
  const last = key.lastIndexOf(":");
  if (first >= 0) {
    base.push(key.slice(first + 1), key.slice(last + 1));
    const at = key.lastIndexOf("@");
    if (at > last) base.push(key.slice(last + 1, at));
  }
  base.push(
    ...text
      .slice(keyEnd)
      .split(/[\t\n\r\u000b\u000c ]+/)
      .filter((w) => w !== "")
      .slice(0, MAX_WORDS),
  );
  const out: string[] = [];
  for (const b of base) {
    for (const v of [b, percentDecode(b)]) out.push(...v.split("/").filter((x) => x !== ""), v);
  }
  return out.filter((v) => v !== "");
}

/**
 * `redactConninfo` の URI 形式: `user:パスワード@` と `?password=...` / `&sslpassword=...` を伏せる。
 * ユーザー情報は「スキームの後の最初の `/` より前にある最後の `@`」で決め、その後で `?` のクエリを分ける
 * (パスワードに素の `?` があっても取りこぼさない)。
 */
function redactConninfoUri(uri: string): string {
  const schemeAt = uri.indexOf("://");
  const schemeEnd = schemeAt < 0 ? 0 : schemeAt + 3;
  const slash = uri.indexOf("/", schemeEnd);
  const authorityEnd = slash < 0 ? uri.length : slash;
  let prefix = uri.slice(0, schemeEnd);
  let restStart = schemeEnd;
  // ユーザー情報の区切りは最後の `@`。
  // authority にユーザー情報がなくても、スキーム以降の最後の `@` の前に `:` があれば伏せる (安全側)。
  // ただしフォールバックでは、`h:5432/db?application_name=me@corp` のようにポート (数字だけ) の `:` は
  // ユーザー情報の区切りと見なさない (正常な URI の表示を崩さない)。Rust の `redact_conninfo_uri` と同じ。
  let at = uri.slice(0, authorityEnd).lastIndexOf("@");
  if (at < schemeEnd) {
    at = uri.lastIndexOf("@");
    if (at >= schemeEnd) {
      const c = uri.slice(0, at).indexOf(":", schemeEnd);
      if (c >= 0) {
        const after = uri.slice(c + 1, at);
        const cut = after.search(/[/?]/);
        const port = cut < 0 ? after : after.slice(0, cut);
        if (port !== "" && /^[0-9]+$/.test(port)) at = -1;
      }
    }
  }
  if (at >= schemeEnd) {
    const colon = uri.slice(0, at).indexOf(":", schemeEnd);
    if (colon >= 0) {
      prefix = `${uri.slice(0, colon)}:********`;
      restStart = at;
    }
  }
  const redactParams = (q: string): string =>
    q
      .split("&")
      .map((kv) => {
        const eq = kv.indexOf("=");
        if (eq >= 0 && CONNINFO_SECRET_KEYS.includes(asciiLower(percentDecode(kv.slice(0, eq))))) {
          return `${kv.slice(0, eq)}=********`;
        }
        return kv;
      })
      .join("&");
  const rest = uri.slice(restStart);
  const q = rest.indexOf("?");
  let head = q < 0 ? rest : rest.slice(0, q);
  // クエリの値に `@` があって `?` が伏せ字に呑まれたときは、残りの `&` 以降もクエリとして伏せる
  // (Rust の `redact_conninfo_uri` と同じ)。
  const amp = head.indexOf("&");
  if (uri.slice(schemeEnd, restStart).includes("?") && amp >= 0) {
    head = `${head.slice(0, amp)}&${redactParams(head.slice(amp + 1))}`;
  }
  head = prefix + head;
  if (q < 0) return head;
  return `${head}?${redactParams(rest.slice(q + 1))}`;
}

/**
 * 接続文字列の中のパスワードの**値** (エラー文の置換用)。Rust 側 `conninfo_secret_values` と同じ規則:
 * key=value の `password` / `sslpassword` の値 (引用符を外したもの・`\` を解いたもの、空白で切れた続きの語)、
 * URI の `user:パスワード@` と、クエリの `password` / `sslpassword` の値 (生とパーセントデコード後)。
 */
function conninfoSecretValues(conninfo: string): string[] {
  const t = trimStartLikeRust(conninfo);
  const out: string[] = [];
  const lower = asciiLower(t);
  if (lower.startsWith("postgresql://") || lower.startsWith("postgres://")) {
    const schemeAt = t.indexOf("://");
    const rest = t.slice(schemeAt < 0 ? 0 : schemeAt + 3);
    const at = rest.lastIndexOf("@");
    if (at >= 0) {
      const colon = rest.slice(0, at).indexOf(":");
      if (colon >= 0) {
        const pw = rest.slice(colon + 1, at);
        // libpq は `/` の手前までで `@` を探すので、素の `/` を含むパスワードは前半が host:port として
        // 引用される。`/` で分けた各片も秘密値にする。
        for (const v of [pw, percentDecode(pw)]) out.push(...v.split("/"), v);
      }
    }
    const q = rest.indexOf("?");
    if (q >= 0) {
      for (const kv of rest.slice(q + 1).split("&")) {
        const eq = kv.indexOf("=");
        if (eq >= 0 && CONNINFO_SECRET_KEYS.includes(asciiLower(percentDecode(kv.slice(0, eq))))) {
          const v = kv.slice(eq + 1);
          out.push(v, percentDecode(v));
        }
      }
    }
    return out;
  }
  const n = conninfo.length;
  let i = 0;
  while (i < n) {
    if (isWs(conninfo[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && conninfo[i] !== "=" && !isWs(conninfo[i])) i++;
    const key = conninfo.slice(start, i);
    if (looksLikeUserinfo(key)) {
      out.push(...userinfoWordSecrets(conninfo.slice(start)));
      break;
    }
    let j = i;
    while (j < n && isWs(conninfo[j])) j++;
    if (conninfo[j] !== "=") break;
    j++;
    while (j < n && isWs(conninfo[j])) j++;
    const quoted = conninfo[j] === "'";
    let rawStart: number;
    let rawEnd: number;
    let end: number;
    if (quoted) {
      let e = j + 1;
      let close = -1;
      while (e < n) {
        if (conninfo[e] === "\\") e += 2;
        else if (conninfo[e] === "'") {
          close = e;
          e++;
          break;
        } else e++;
      }
      e = Math.min(e, n);
      [rawStart, rawEnd, end] = [j + 1, close < 0 ? e : close, e];
    } else {
      let e = j;
      while (e < n && !isWs(conninfo[e])) e += conninfo[e] === "\\" ? 2 : 1;
      e = Math.min(e, n);
      [rawStart, rawEnd, end] = [j, e, e];
    }
    i = end;
    if (CONNINFO_SECRET_KEYS.includes(asciiLower(key))) {
      const raw = conninfo.slice(rawStart, rawEnd);
      out.push(raw, unescapeLiteral(raw, "'", true));
      // 空白で切れた値の続き、または引用符が途中で閉じた値の残り (`'ab''cd'` など):
      // 次の `key=` (または `key =`) が現れるまでの語。
      for (;;) {
        let a = i;
        while (a < n && isWs(conninfo[a])) a++;
        let b = a;
        while (b < n && !isWs(conninfo[b])) b++;
        let c = b;
        while (c < n && isWs(conninfo[c])) c++;
        if (a === b || conninfo.slice(a, b).includes("=") || conninfo[c] === "=") break;
        out.push(conninfo.slice(a, b));
        i = b;
      }
    }
  }
  return out;
}

/**
 * PostgreSQL の接続文字列 (libpq の `key=value ...` 形式、または `postgresql://` の URI) から
 * パスワードを伏せる。バックエンドの `sql_credentials::redact_conninfo` (#2181) と同じ規則
 * (`password` / `sslpassword` の値を `'********'`、URI は `********`。解釈できない残りに "password" が
 * あれば残り全体を伏せる)。
 */
function redactConninfo(conninfo: string): string {
  const lower = asciiLower(trimStartLikeRust(conninfo));
  if (lower.startsWith("postgresql://") || lower.startsWith("postgres://"))
    return redactConninfoUri(conninfo);
  let out = "";
  let i = 0;
  while (i < conninfo.length) {
    if (isWs(conninfo[i])) {
      out += conninfo[i++];
      continue;
    }
    const start = i;
    while (i < conninfo.length && conninfo[i] !== "=" && !isWs(conninfo[i])) i++;
    const key = conninfo.slice(start, i);
    if (looksLikeUserinfo(key)) {
      // `postgresql:/u:secret@h` や先頭が U+FEFF の URI は libpq が key=value として読み、エラー文は全体を
      // 引用する。`user:パスワード@` のような語は残り全体を伏せる (安全側)。
      return out + CREDENTIAL_PLACEHOLDER;
    }
    let j = i;
    while (j < conninfo.length && isWs(conninfo[j])) j++;
    if (conninfo[j] !== "=") {
      // `key=value` の形でない。パスワードの語を含むなら残り全体を伏せる。
      const rest = conninfo.slice(start);
      return out + (asciiLower(rest).includes("password") ? CREDENTIAL_PLACEHOLDER : rest);
    }
    j++;
    while (j < conninfo.length && isWs(conninfo[j])) j++;
    // 値の範囲 [j, end)。
    let end = j;
    if (conninfo[j] === "'") {
      end++;
      while (end < conninfo.length) {
        const c = conninfo[end];
        if (c === "\\") end += 2;
        else if (c === "'") {
          end++;
          break;
        } else end++;
      }
    } else {
      while (end < conninfo.length && !isWs(conninfo[end])) end += conninfo[end] === "\\" ? 2 : 1;
    }
    end = Math.min(end, conninfo.length);
    out += CONNINFO_SECRET_KEYS.includes(asciiLower(key))
      ? `${asciiLower(key)}=${CREDENTIAL_PLACEHOLDER}`
      : conninfo.slice(start, end);
    i = end;
  }
  return out;
}

function secretsFor(sql: string, driver: "mysql" | "postgres"): string[] {
  const { ranges, masked: m, extra } = scanWithMask(sql, driver);
  const found: string[] = [...extra];
  for (const { start: s, end: e } of ranges) {
    if (m[s] === "$") {
      const close = m.indexOf("$", s + 1);
      const tagLen = close < 0 ? 1 : close - s + 1;
      const closed = e >= s + 2 * tagLen && m.slice(e - tagLen, e) === m.slice(s, s + tagLen);
      const innerEnd = closed ? e - tagLen : e;
      if (s + tagLen <= innerEnd) found.push(sql.slice(s + tagLen, innerEnd));
      continue;
    }
    const eString = driver === "postgres" && s >= 1 && (sql[s - 1] === "e" || sql[s - 1] === "E");
    const backslash = driver === "mysql" || eString;
    let i = s;
    while (i < e) {
      if (m[i] !== "'" && m[i] !== '"') {
        i++;
        continue;
      }
      const q = m[i];
      let c = m.indexOf(q, i + 1);
      if (c < 0 || c >= e) c = -1;
      const innerEnd = c < 0 ? e : c;
      const raw = sql.slice(i + 1, innerEnd);
      found.push(raw, unescapeLiteral(raw, q, backslash));
      if (driver === "postgres" && q === "'") {
        if (eString) found.push(decodePgE(raw));
        else if (s >= 2 && m[s - 1] === "&" && (m[s - 2] === "u" || m[s - 2] === "U")) {
          found.push(decodeLiteralPiece(raw, true, false, uescapeChar(m, sql, e)));
        }
      }
      i = c < 0 ? e : c + 1;
    }
  }
  return found;
}

/**
 * サーバのエラー文から資格情報を伏せる (#2174)。エラー文は SQL 断片を引用する
 * (`near 'IDENTIFIED BY 'secret'' at line 1`) ので、キーワード走査では伏せられない。
 * 元の SQL の資格情報リテラルの中身 (元の表記とエスケープを解いた値) がエラー文に現れたら、
 * すべて `********` に置き換える。4 文字未満の値は、エラー文の別の箇所を潰さないよう対象外にする。
 */
export function redactErrorText(error: string, sql: string, driver?: string): string {
  let secrets: string[] = [];
  if (driver === "mysql" || driver === "postgres") secrets = secretsFor(sql, driver);
  else if (driver !== "sqlite") secrets = [...secretsFor(sql, "mysql"), ...secretsFor(sql, "postgres")];
  const uniq = [...new Set(secrets)]
    .filter((v) => [...v].length >= MIN_SECRET_CHARS)
    .sort((a, b) => [...b].length - [...a].length);
  let out = error;
  for (const v of uniq) out = out.split(v).join("********");
  return redactCredentials(out, driver);
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
