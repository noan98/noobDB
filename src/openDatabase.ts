/**
 * 「同じサーバの別データベースを開く」(#2018, PostgreSQL) の純ロジック。
 *
 * PostgreSQL は 1 接続で別 DB へ切り替えられないため、現プロファイルの接続パラメータ
 * (TLS / SSH / IAM / keyring の認証情報) をそのまま使い、`database` だけ差し替えた
 * **派生プロファイル** で新しいセッションを張る。派生プロファイルは保存せず (一覧には出ない)、
 * 同時接続レジストリでは元の接続とは別の接続として扱われる。
 *
 * 派生 ID の区切り (`::db::`) はバックエンド `profiles/secrets.rs` の `DB_VARIANT_SEP` と
 * 同じ値。keyring の秘密は常に元のプロファイルのものを引くので、派生側に秘密は複製しない。
 */
import type { ConnectionProfile } from "./api/tauri";

export const DB_VARIANT_SEP = "::db::";

/** 派生プロファイル ID から元のプロファイル ID を取り出す (通常の ID はそのまま)。 */
export function baseProfileId(id: string): string {
  const i = id.indexOf(DB_VARIANT_SEP);
  return i < 0 ? id : id.slice(0, i);
}

/** 元のプロファイルから `database` だけ差し替えた派生プロファイルを作る。 */
export function databaseVariantProfile(profile: ConnectionProfile, database: string): ConnectionProfile {
  const baseId = baseProfileId(profile.id);
  const baseName =
    profile.name.includes(" / ") && profile.id !== baseId ? profile.name.split(" / ")[0] : profile.name;
  return {
    ...profile,
    id: `${baseId}${DB_VARIANT_SEP}${database}`,
    name: `${baseName} / ${database}`,
    database,
  };
}

/** 一覧を検索語で絞る (大文字小文字を無視した部分一致。空語は全件)。 */
export function filterDatabases(names: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? names.filter((n) => n.toLowerCase().includes(q)) : [...names];
}
