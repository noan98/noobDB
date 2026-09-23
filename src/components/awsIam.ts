/**
 * AWS RDS / Aurora の IAM データベース認証 (#734) の、接続フォーム側の純ロジック。
 *
 * トークン生成 (SigV4 署名) と資格情報の読み出しはすべてバックエンド
 * (`src-tauri/src/db/aws_iam.rs`) が行う。フロントが持つのは「どのドライバで
 * 選べるか」「TLS を何に強制するか」「エンドポイント名からリージョンを推定できるか」
 * の表示用判定だけ。後ろ 2 つは Rust 側と同じ規則で、共有ゴールデン
 * (`__tests__/fixtures/awsIamGolden.json`) で二重実装を固定している。
 */
import type { AwsIamConfig, DriverKind, SslMode } from "../api/tauri";

/** 接続フォームの認証方式。`aws_iam` はパスワードを保存しない。 */
export type DbAuthMethod = "password" | "aws_iam";

/** RDS の IAM データベース認証があるのは MySQL / PostgreSQL 系エンジンだけ。 */
export function isIamCapableDriver(driver: DriverKind): boolean {
  return driver === "mysql" || driver === "postgres";
}

/**
 * IAM 認証は TLS 必須 (RDS の要件)。未設定 / `disable` / `prefer` は平文へ
 * フォールバックしうるので `require` へ引き上げ、`require` 以上はそのまま。
 * Rust の `aws_iam::enforce_tls` と同じ規則。
 */
export function effectiveSslModeForIam(mode: SslMode | null | undefined): SslMode {
  if (mode == null || mode === "disable" || mode === "prefer") return "require";
  return mode;
}

/** IAM 認証時に TLS モードの選択肢として出してよいか (平文を許すモードは不可)。 */
export function isSslModeAllowedForIam(mode: SslMode): boolean {
  return effectiveSslModeForIam(mode) === mode;
}

function isRegionLike(s: string): boolean {
  return s.includes("-") && /^[a-z0-9-]+$/.test(s) && /[0-9]$/.test(s);
}

/**
 * RDS / Aurora / RDS Proxy のエンドポイント名 (`<name>.<id>.<region>.rds.amazonaws.com`、
 * 中国リージョンは `.com.cn`) からリージョンを推定する。該当しなければ `null`。
 * Rust の `aws_iam::infer_region_from_host` と同じ規則。
 */
export function inferRdsRegion(host: string): string | null {
  const labels = host.trim().replace(/\.+$/, "").toLowerCase().split(".");
  const rds = labels.lastIndexOf("rds");
  if (rds < 0) return null;
  const suffix = labels.slice(rds + 1).join(".");
  if (suffix !== "amazonaws.com" && suffix !== "amazonaws.com.cn") return null;
  if (rds < 2) return null;
  const region = labels[rds - 1];
  return isRegionLike(region) ? region : null;
}

/**
 * フォームの入力から接続要求 / 保存用の `aws_iam` を組み立てる。IAM 認証を
 * 選んでいない、または IAM 非対応のドライバなら `null` (= パスワード認証)。
 */
export function buildAwsIamConfig(
  method: DbAuthMethod,
  driver: DriverKind,
  region: string,
  profile: string,
): AwsIamConfig | null {
  if (method !== "aws_iam" || !isIamCapableDriver(driver)) return null;
  const p = profile.trim();
  return { region: region.trim(), profile: p === "" ? null : p };
}
