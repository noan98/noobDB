// 接続 URL (mysql:// postgres:// sqlite: ...) をフォーム項目へ分解する純ロジック (#1540)。
//
// 既存の接続文字列を貼り付けてフォームへ取り込むための入口。**このモジュールは
// 副作用を持たず、入力文字列 (パスワードを含みうる) をログにも例外メッセージにも
// 出さない**。失敗は理由コードだけを返す。パスワードは `password` として返すだけで、
// 呼び出し側 (ConnectionForm) が keyring 保存対象のパスワード欄へ入れる
// (profiles.json には書かない)。

import type { DriverKind, SslMode } from "../api/tauri";

/** 取り込みに失敗した理由。UI は理由ごとの文言を出す (入力内容は出さない)。 */
export type ConnectionUrlError =
  | "empty"
  | "unsupported_scheme"
  | "invalid_port"
  | "multiple_hosts"
  | "malformed";

export interface ParsedConnectionUrl {
  driver: DriverKind;
  /** ネットワーク DB のホスト。URL に無ければ `undefined` (フォームの値を残す)。 */
  host?: string;
  port?: number;
  user?: string;
  /** keyring 保存対象。URL に無ければ `undefined`。 */
  password?: string;
  database?: string;
  /** SQLite のファイルパス。 */
  filePath?: string;
  sslMode?: SslMode;
  sslRootCert?: string;
  sslClientCert?: string;
  sslClientKey?: string;
  /** 取り込めなかったクエリパラメータの**名前だけ** (値は秘密を含みうるので返さない)。 */
  ignoredParams: string[];
}

export type ConnectionUrlResult =
  | { ok: true; value: ParsedConnectionUrl }
  | { ok: false; error: ConnectionUrlError };

const SCHEME_DRIVER: Record<string, DriverKind> = {
  mysql: "mysql",
  mariadb: "mysql",
  postgres: "postgres",
  postgresql: "postgres",
  sqlite: "sqlite",
  sqlite3: "sqlite",
};

const SQLITE_EXTENSIONS = /\.(db|db3|sqlite|sqlite3|s3db)$/i;

class MalformedError extends Error {}

/** `%XX` をデコードする。不正なエンコードは握りつぶさず失敗にする。 */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new MalformedError();
  }
}

/** SSL モード名 (PostgreSQL の sslmode / MySQL の ssl-mode / 真偽値) を SslMode へ。 */
export function parseSslModeParam(raw: string): SslMode | null {
  const v = raw.trim().toLowerCase().replace(/-/g, "_");
  switch (v) {
    case "disable":
    case "disabled":
    case "false":
    case "0":
    case "off":
    case "no":
      return "disable";
    // libpq の allow は「まず平文、だめなら TLS」。5 段階では prefer が最も近い。
    case "allow":
    case "prefer":
    case "preferred":
      return "prefer";
    case "require":
    case "required":
    case "true":
    case "1":
    case "on":
    case "yes":
      return "require";
    case "verify_ca":
      return "verify_ca";
    case "verify_full":
    case "verify_identity":
      return "verify_full";
    default:
      return null;
  }
}

function parseSqlitePath(rest: string): string {
  // rest は `sqlite:` を除いた残り。`//` 付き (`sqlite:///abs`, `sqlite://rel`) と
  // 無し (`sqlite:rel.db`, `sqlite:/abs.db`) の両方を受ける。
  let p = rest;
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q); // ?mode=ro などは取り込まない
  if (p.startsWith("//")) {
    p = p.slice(2);
    // SQLAlchemy 流の `sqlite:////abs/path` (スラッシュ 4 本) は絶対パス。
    if (p.startsWith("//")) p = p.slice(1);
  }
  p = decode(p);
  // `sqlite:///C:/dir/x.db` は先頭の `/` を落として Windows パスにする。
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  return p;
}

function looksLikeFilePath(s: string): boolean {
  return (
    s.startsWith("/") ||
    s.startsWith("~") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(s) ||
    s.startsWith("\\\\") ||
    SQLITE_EXTENSIONS.test(s)
  );
}

function ok(value: ParsedConnectionUrl): ConnectionUrlResult {
  return { ok: true, value };
}

/**
 * 接続 URL またはファイルパスをフォーム項目へ分解する。
 *
 * - `mysql://` `mariadb://` → MySQL、`postgres://` `postgresql://` → PostgreSQL、
 *   `sqlite:` と素のファイルパス (`/..`, `~/..`, `C:\..`, `*.db` など) → SQLite。
 *   `jdbc:` 接頭辞は外して扱う。
 * - ユーザー / パスワード / DB 名は `%XX` デコードする。ホストは IPv6 の `[::1]` 形式可。
 * - クエリ: `sslmode` / `ssl-mode` / `ssl` / `tls` (TLS モード)、`sslrootcert` / `ssl-ca` /
 *   `sslcert` / `ssl-cert` / `sslkey` / `ssl-key` (証明書の**パス**)、`user` / `password`
 *   (URL 本体に無いときのフォールバック)。それ以外は `ignoredParams` に名前だけ残す。
 */
export function parseConnectionUrl(input: string): ConnectionUrlResult {
  let text = input
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (text === "") return { ok: false, error: "empty" };
  if (/^jdbc:/i.test(text)) text = text.slice(5);

  try {
    const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(text);
    // `C:\x.db` の `C:` をスキームと誤認しない (1 文字は Windows ドライブ)。
    const scheme = schemeMatch && schemeMatch[1].length > 1 ? schemeMatch[1].toLowerCase() : null;

    if (scheme === null) {
      if (looksLikeFilePath(text)) {
        return ok({ driver: "sqlite", filePath: text, ignoredParams: [] });
      }
      return { ok: false, error: "unsupported_scheme" };
    }
    const driver = SCHEME_DRIVER[scheme];
    if (!driver || !schemeMatch) return { ok: false, error: "unsupported_scheme" };
    const rest = schemeMatch[2];

    if (driver === "sqlite") {
      const filePath = parseSqlitePath(rest);
      if (filePath === "" || filePath === ":memory:") {
        return { ok: false, error: "malformed" };
      }
      return ok({ driver, filePath, ignoredParams: [] });
    }

    if (!rest.startsWith("//")) return { ok: false, error: "malformed" };
    let body = rest.slice(2);
    const hash = body.indexOf("#");
    if (hash >= 0) body = body.slice(0, hash);
    let queryStart = body.indexOf("?");
    if (queryStart >= 0) {
      // パスワードに未エンコードの `?` があると、その後ろの `@host` までがクエリ扱いになり
      // host / port を誤認する。`?` の前に `@` も `/` も無く、`?` の後ろ (最初の `/` まで) に
      // `k=v` ではない形で `@` が続くなら、その `?` はパスワードの一部とみなし、`@` より後ろ
      // の最初の `?` をクエリの開始にする。
      const before = body.slice(0, queryStart);
      if (!before.includes("@") && !before.includes("/")) {
        const seg = body.slice(queryStart + 1).split("/")[0];
        const segAt = seg.lastIndexOf("@");
        if (segAt >= 0 && !seg.slice(0, segAt).includes("=")) {
          queryStart = body.indexOf("?", queryStart + 1 + segAt + 1);
        }
      }
    }
    const query = queryStart >= 0 ? body.slice(queryStart + 1) : "";
    if (queryStart >= 0) body = body.slice(0, queryStart);
    const slash = body.indexOf("/");
    const authority = slash >= 0 ? body.slice(0, slash) : body;
    const pathPart = slash >= 0 ? body.slice(slash + 1) : "";

    const out: ParsedConnectionUrl = { driver, ignoredParams: [] };

    // userinfo は最後の `@` まで (パスワードに未エンコードの `@` が来ても拾えるように)。
    const at = authority.lastIndexOf("@");
    const userinfo = at >= 0 ? authority.slice(0, at) : "";
    const hostport = at >= 0 ? authority.slice(at + 1) : authority;
    if (at >= 0) {
      const colon = userinfo.indexOf(":");
      const user = decode(colon >= 0 ? userinfo.slice(0, colon) : userinfo);
      if (user !== "") out.user = user;
      if (colon >= 0) {
        const password = decode(userinfo.slice(colon + 1));
        if (password !== "") out.password = password;
      }
    }

    if (hostport.includes(",")) return { ok: false, error: "multiple_hosts" };
    let hostText = hostport;
    let portText = "";
    if (hostport.startsWith("[")) {
      const close = hostport.indexOf("]");
      if (close < 0) return { ok: false, error: "malformed" };
      hostText = hostport.slice(1, close);
      const after = hostport.slice(close + 1);
      if (after !== "") {
        if (!after.startsWith(":")) return { ok: false, error: "malformed" };
        portText = after.slice(1);
      }
    } else {
      const colon = hostport.lastIndexOf(":");
      if (colon >= 0) {
        hostText = hostport.slice(0, colon);
        portText = hostport.slice(colon + 1);
      }
    }
    const host = decode(hostText);
    if (host !== "") out.host = host;
    if (portText !== "") {
      if (!/^\d+$/.test(portText)) return { ok: false, error: "invalid_port" };
      const port = Number(portText);
      if (port < 1 || port > 65535) return { ok: false, error: "invalid_port" };
      out.port = port;
    }

    const database = decode(pathPart);
    if (database !== "") out.database = database;

    for (const pair of query.split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      const key = decode((eq >= 0 ? pair.slice(0, eq) : pair).replace(/\+/g, " ")).trim();
      const value = decode((eq >= 0 ? pair.slice(eq + 1) : "").replace(/\+/g, " "));
      const k = key.toLowerCase();
      switch (k) {
        case "sslmode":
        case "ssl-mode":
        case "ssl_mode":
        case "ssl":
        case "tls":
        case "usessl": {
          const mode = parseSslModeParam(value);
          if (mode) out.sslMode = mode;
          else out.ignoredParams.push(key);
          break;
        }
        case "sslrootcert":
        case "sslca":
        case "ssl-ca":
          if (value) out.sslRootCert = value;
          break;
        case "sslcert":
        case "ssl-cert":
          if (value) out.sslClientCert = value;
          break;
        case "sslkey":
        case "ssl-key":
          if (value) out.sslClientKey = value;
          break;
        case "user":
        case "username":
          if (out.user === undefined && value) out.user = value;
          break;
        case "password":
          if (out.password === undefined && value) out.password = value;
          break;
        default:
          out.ignoredParams.push(key);
      }
    }
    return ok(out);
  } catch (e) {
    if (e instanceof MalformedError) return { ok: false, error: "malformed" };
    throw e;
  }
}
