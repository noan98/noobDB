import { describe, expect, it } from "vitest";
import { parseConnectionUrl, parseSslModeParam } from "../components/connectionUrl";

function parsed(input: string) {
  const r = parseConnectionUrl(input);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.value;
}

describe("parseConnectionUrl: ネットワーク DB (#1540)", () => {
  it("mysql:// の全要素を分解する", () => {
    expect(parsed("mysql://app:s3cret@db.example.com:3307/shop")).toEqual({
      driver: "mysql",
      host: "db.example.com",
      port: 3307,
      user: "app",
      password: "s3cret",
      database: "shop",
      ignoredParams: [],
    });
  });

  it("mariadb:// は MySQL、postgres:// と postgresql:// は PostgreSQL", () => {
    expect(parsed("mariadb://h/d").driver).toBe("mysql");
    expect(parsed("postgres://h/d").driver).toBe("postgres");
    expect(parsed("postgresql://h/d").driver).toBe("postgres");
    expect(parsed("POSTGRES://h/d").driver).toBe("postgres");
  });

  it("ユーザー / パスワード / DB 名の % エンコードをデコードする", () => {
    const v = parsed("postgres://us%40er:p%40ss%3Aw%2Ford%25@h:5432/my%20db");
    expect(v.user).toBe("us@er");
    expect(v.password).toBe("p@ss:w/ord%");
    expect(v.database).toBe("my db");
  });

  it("パスワード中の未エンコードの ? でも host / port を誤認しない (#1593)", () => {
    const v = parsed("mysql://root:12?3@db/app");
    expect(v.user).toBe("root");
    expect(v.password).toBe("12?3");
    expect(v.host).toBe("db");
    expect(v.port).toBeUndefined();
    expect(v.database).toBe("app");
    // 通常のクエリ (値に @ を含む) は従来どおりクエリとして扱う。
    const w = parsed("postgres://h/d?user=a@b");
    expect(w.host).toBe("h");
    expect(w.user).toBe("a@b");
  });

  it("パスワード中の未エンコードの @ は最後の @ で区切る", () => {
    const v = parsed("mysql://u:p@ss@host/db");
    expect(v.user).toBe("u");
    expect(v.password).toBe("p@ss");
    expect(v.host).toBe("host");
  });

  it("IPv6 ホスト ([::1]) とポート", () => {
    const v = parsed("postgres://u@[::1]:6543/db");
    expect(v.host).toBe("::1");
    expect(v.port).toBe(6543);
    expect(parsed("mysql://[2001:db8::1]/db").host).toBe("2001:db8::1");
    expect(parsed("mysql://[2001:db8::1]/db").port).toBeUndefined();
  });

  it("ユーザーのみ・パスワード空・ホストのみ・DB 無しを受ける", () => {
    expect(parsed("mysql://root@localhost")).toEqual({
      driver: "mysql",
      host: "localhost",
      user: "root",
      ignoredParams: [],
    });
    const v = parsed("postgres://u:@h/");
    expect(v.password).toBeUndefined();
    expect(v.database).toBeUndefined();
  });

  it("ホスト省略 (postgres:///db) ではホストを返さず、フォーム側の値を残せる", () => {
    const v = parsed("postgres:///mydb");
    expect(v.host).toBeUndefined();
    expect(v.database).toBe("mydb");
  });

  it("前後の空白・引用符・jdbc: 接頭辞を取り除く", () => {
    expect(parsed('  "mysql://h/d"  ').host).toBe("h");
    expect(parsed("jdbc:postgresql://h:5433/d").port).toBe(5433);
  });

  it("sslmode (PostgreSQL) と ssl-mode (MySQL) を TLS モードへ対応づける", () => {
    expect(parsed("postgres://h/d?sslmode=require").sslMode).toBe("require");
    expect(parsed("postgres://h/d?sslmode=verify-full").sslMode).toBe("verify_full");
    expect(parsed("postgres://h/d?sslmode=verify-ca").sslMode).toBe("verify_ca");
    expect(parsed("postgres://h/d?sslmode=disable").sslMode).toBe("disable");
    expect(parsed("postgres://h/d?sslmode=allow").sslMode).toBe("prefer");
    expect(parsed("mysql://h/d?ssl-mode=REQUIRED").sslMode).toBe("require");
    expect(parsed("mysql://h/d?ssl-mode=VERIFY_IDENTITY").sslMode).toBe("verify_full");
    expect(parsed("mysql://h/d?ssl-mode=DISABLED").sslMode).toBe("disable");
    expect(parsed("mysql://h/d?ssl=true").sslMode).toBe("require");
    expect(parsed("mysql://h/d?useSSL=false").sslMode).toBe("disable");
  });

  it("証明書のパスは取り込み、% エンコードもデコードする", () => {
    const v = parsed(
      "postgres://h/d?sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem&sslcert=/c.crt&sslkey=/c.key",
    );
    expect(v.sslRootCert).toBe("/etc/ca.pem");
    expect(v.sslClientCert).toBe("/c.crt");
    expect(v.sslClientKey).toBe("/c.key");
    const m = parsed("mysql://h/d?ssl-ca=/ca.pem&ssl-cert=/c.pem&ssl-key=/k.pem");
    expect(m.sslRootCert).toBe("/ca.pem");
    expect(m.sslClientCert).toBe("/c.pem");
    expect(m.sslClientKey).toBe("/k.pem");
  });

  it("user / password クエリは URL 本体に無いときだけ使う", () => {
    const v = parsed("postgres://h/d?user=alice&password=pw");
    expect(v.user).toBe("alice");
    expect(v.password).toBe("pw");
    const w = parsed("postgres://bob:own@h/d?user=alice&password=pw");
    expect(w.user).toBe("bob");
    expect(w.password).toBe("own");
  });

  it("未対応のクエリは名前だけ ignoredParams に残し、値は返さない", () => {
    const v = parsed("postgres://h/d?application_name=secretvalue&connect_timeout=5");
    expect(v.ignoredParams).toEqual(["application_name", "connect_timeout"]);
    expect(JSON.stringify(v)).not.toContain("secretvalue");
  });

  it("解釈できない sslmode 値は無視扱いにする", () => {
    const v = parsed("postgres://h/d?sslmode=bogus");
    expect(v.sslMode).toBeUndefined();
    expect(v.ignoredParams).toEqual(["sslmode"]);
  });

  it("フラグメントは無視する", () => {
    expect(parsed("mysql://h/d#frag").database).toBe("d");
  });
});

describe("parseConnectionUrl: SQLite (#1540)", () => {
  it("sqlite: の各表記をファイルパスにする", () => {
    expect(parsed("sqlite:rel/data.db").filePath).toBe("rel/data.db");
    expect(parsed("sqlite:/abs/data.db").filePath).toBe("/abs/data.db");
    expect(parsed("sqlite:///abs/data.db").filePath).toBe("/abs/data.db");
    expect(parsed("sqlite:////abs/data.db").filePath).toBe("/abs/data.db");
    expect(parsed("sqlite://data.db").filePath).toBe("data.db");
  });

  it("Windows パス (sqlite:///C:/...) は先頭の / を落とす", () => {
    expect(parsed("sqlite:///C:/Users/me/x.db").filePath).toBe("C:/Users/me/x.db");
  });

  it("% エンコードとクエリ (?mode=ro) を処理する", () => {
    expect(parsed("sqlite:///tmp/my%20db.sqlite?mode=ro").filePath).toBe("/tmp/my db.sqlite");
  });

  it("素のファイルパスは SQLite として扱う", () => {
    expect(parsed("/var/data/app.db")).toEqual({
      driver: "sqlite",
      filePath: "/var/data/app.db",
      ignoredParams: [],
    });
    expect(parsed("~/data/app.sqlite3").driver).toBe("sqlite");
    expect(parsed("./local.db").driver).toBe("sqlite");
    expect(parsed("C:\\Users\\me\\app.db").filePath).toBe("C:\\Users\\me\\app.db");
    expect(parsed("\\\\server\\share\\app.db").driver).toBe("sqlite");
    expect(parsed("app.db").filePath).toBe("app.db");
  });

  it("メモリ DB や空パスは取り込めない", () => {
    expect(parseConnectionUrl("sqlite::memory:")).toEqual({ ok: false, error: "malformed" });
    expect(parseConnectionUrl("sqlite:")).toEqual({ ok: false, error: "malformed" });
  });
});

describe("parseConnectionUrl: 失敗 (#1540)", () => {
  it("空入力", () => {
    expect(parseConnectionUrl("   ")).toEqual({ ok: false, error: "empty" });
  });

  it("未対応のスキームとスキームの無い文字列", () => {
    expect(parseConnectionUrl("mongodb://h/d")).toEqual({ ok: false, error: "unsupported_scheme" });
    expect(parseConnectionUrl("sqlserver://h/d")).toEqual({ ok: false, error: "unsupported_scheme" });
    expect(parseConnectionUrl("hello world")).toEqual({ ok: false, error: "unsupported_scheme" });
  });

  it("ポートが不正", () => {
    expect(parseConnectionUrl("mysql://h:abc/d")).toEqual({ ok: false, error: "invalid_port" });
    expect(parseConnectionUrl("mysql://h:0/d")).toEqual({ ok: false, error: "invalid_port" });
    expect(parseConnectionUrl("mysql://h:70000/d")).toEqual({ ok: false, error: "invalid_port" });
  });

  it("複数ホストは取り込めない", () => {
    expect(parseConnectionUrl("postgres://a:1,b:2/d")).toEqual({
      ok: false,
      error: "multiple_hosts",
    });
  });

  it("不正な % エンコード・閉じていない IPv6・// の無い URL", () => {
    expect(parseConnectionUrl("mysql://u:%ZZ@h/d")).toEqual({ ok: false, error: "malformed" });
    expect(parseConnectionUrl("mysql://[::1/d")).toEqual({ ok: false, error: "malformed" });
    expect(parseConnectionUrl("mysql:h/d")).toEqual({ ok: false, error: "malformed" });
  });

  it("失敗結果に入力内容 (パスワード) を含めない", () => {
    const r = parseConnectionUrl("mysql://u:topsecret@h:abc/d");
    expect(JSON.stringify(r)).not.toContain("topsecret");
  });
});

describe("parseSslModeParam", () => {
  it("大文字小文字とハイフン / アンダースコアを区別しない", () => {
    expect(parseSslModeParam("Verify-Full")).toBe("verify_full");
    expect(parseSslModeParam("VERIFY_CA")).toBe("verify_ca");
    expect(parseSslModeParam("")).toBeNull();
  });
});
