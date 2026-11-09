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
 *   と `CREATE|ALTER SUBSCRIPTION … CONNECTION '<接続文字列>'` (#2189。中身に `redactConninfo` が伏せる
 *   `password` / `sslpassword` / URI のパスワードがあるときだけリテラル全体)
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

  /**
   * `CONNECTION '…'` のリテラルの中身 (エスケープを解いたもの) に `redactConninfo` が伏せる値があるか。
   * `U&'…'` は `\XXXX` でキー名を隠せるので、中身を読まず常に「あり」(安全側)。
   */
  private conninfoHasSecret(lit: CredentialRange): boolean {
    const { start: s, end: e } = lit;
    let decoded = "";
    if (this.m[s] === "$") {
      const tagLen = this.dollarTagLen(s);
      if (tagLen === null) return true;
      const closed = e >= s + 2 * tagLen && this.m.slice(e - tagLen, e) === this.m.slice(s, s + tagLen);
      const innerEnd = closed ? e - tagLen : e;
      if (s + tagLen <= innerEnd) decoded = this.src.slice(s + tagLen, innerEnd);
    } else {
      if (s >= 2 && this.m[s - 1] === "&" && (this.m[s - 2] === "u" || this.m[s - 2] === "U")) return true;
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
        decoded += unescapeLiteral(this.src.slice(i + 1, innerEnd), "'", backslash);
        i = c < 0 ? e : c + 1;
      }
    }
    return redactConninfo(decoded) !== decoded;
  }

  /** PostgreSQL の `CREATE|ALTER SUBSCRIPTION … CONNECTION '<接続文字列>'` (#2189)。パスワードがあるときだけリテラル全体。 */
  private pgSubscriptionConnection(i: number, e: number): void {
    const [a, b] = this.leadingWords(i);
    if ((a !== "create" && a !== "alter") || b !== "subscription") return;
    const lit = this.literalAt(this.skipWs(e));
    if (lit && this.conninfoHasSecret(lit)) this.push(lit);
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
      } else if (w === "connection" && this.pg) {
        this.pgSubscriptionConnection(i, e);
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
): { ranges: CredentialRange[]; masked: string } {
  const masked = maskLiterals(sql, driver);
  const scanner = new Scanner(masked, sql, driver === "mysql", driver === "postgres");
  scanner.scan();
  return { ranges: scanner.out, masked };
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

/** 接続文字列に含まれるパスワードとして伏せるキーワード (小文字)。パスファイルへの**パス** (`passfile`) は対象外。 */
const CONNINFO_SECRET_KEYS = ["password", "sslpassword"];

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

/** `redactConninfo` の URI 形式: `user:パスワード@` と `?password=...` / `&sslpassword=...` を伏せる。 */
function redactConninfoUri(uri: string): string {
  const q = uri.indexOf("?");
  let head = q < 0 ? uri : uri.slice(0, q);
  const schemeEnd = head.indexOf("://") + 3;
  if (schemeEnd >= 3) {
    const slash = head.indexOf("/", schemeEnd);
    const authorityEnd = slash < 0 ? head.length : slash;
    // ユーザー情報の区切りは最後の `@`。
    const at = head.slice(0, authorityEnd).lastIndexOf("@");
    if (at >= schemeEnd) {
      const colon = head.slice(0, at).indexOf(":", schemeEnd);
      if (colon >= 0) head = `${head.slice(0, colon)}:********${head.slice(at)}`;
    }
  }
  if (q < 0) return head;
  const parts = uri
    .slice(q + 1)
    .split("&")
    .map((kv) => {
      const eq = kv.indexOf("=");
      if (eq >= 0 && CONNINFO_SECRET_KEYS.includes(asciiLower(percentDecode(kv.slice(0, eq))))) {
        return `${kv.slice(0, eq)}=********`;
      }
      return kv;
    });
  return `${head}?${parts.join("&")}`;
}

/**
 * PostgreSQL の接続文字列 (libpq の `key=value ...` 形式、または `postgresql://` の URI) から
 * パスワードを伏せる。バックエンドの `sql_credentials::redact_conninfo` (#2181) と同じ規則
 * (`password` / `sslpassword` の値を `'********'`、URI は `********`。解釈できない残りに "password" が
 * あれば残り全体を伏せる)。
 */
function redactConninfo(conninfo: string): string {
  const lower = asciiLower(conninfo.trimStart());
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
  const { ranges, masked: m } = scanWithMask(sql, driver);
  const found: string[] = [];
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
