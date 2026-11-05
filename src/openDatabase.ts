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

/** 派生プロファイルの ID か。 */
export function isVariantProfileId(id: string): boolean {
  return id.includes(DB_VARIANT_SEP);
}

/**
 * 保存済み一覧に派生プロファイルを差し込む。各派生は元プロファイルの直下に (元が無ければ末尾に)
 * 並べる。保存済みの並びと派生同士の相対順は保つ。
 */
export function insertVariantProfiles(
  saved: readonly ConnectionProfile[],
  variants: readonly ConnectionProfile[],
): ConnectionProfile[] {
  if (variants.length === 0) return saved as ConnectionProfile[];
  const savedIds = new Set(saved.map((p) => p.id));
  const out: ConnectionProfile[] = [];
  for (const p of saved) {
    out.push(p);
    for (const v of variants) if (baseProfileId(v.id) === p.id) out.push(v);
  }
  for (const v of variants) if (!savedIds.has(baseProfileId(v.id))) out.push(v);
  return out;
}

/** 元のプロファイルから `database` だけ差し替えた派生プロファイルを作る。 */
export function databaseVariantProfile(profile: ConnectionProfile, database: string): ConnectionProfile {
  const baseId = baseProfileId(profile.id);
  // 派生から更に派生するときは、末尾の " / <db>" だけを外して元の名前に戻す。
  const cut = profile.name.lastIndexOf(" / ");
  const baseName = profile.id !== baseId && cut >= 0 ? profile.name.slice(0, cut) : profile.name;
  return {
    ...profile,
    // 固定ローカルポート (#1630) は元の接続が握っているので、派生は自動割当にする。
    ssh: profile.ssh ? { ...profile.ssh, local_port: null } : profile.ssh,
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

/**
 * プロファイル `id` の削除で切断される開いている接続 (本体と、その派生接続 #2018)。
 * 削除前の確認 (未適用編集・開いているトランザクション) の対象を決めるのに使う。
 */
export function connectionsAffectedByDelete<T extends { profile: { id: string } }>(
  connections: readonly T[],
  id: string,
): T[] {
  return connections.filter(
    (c) => c.profile.id === id || (isVariantProfileId(c.profile.id) && baseProfileId(c.profile.id) === id),
  );
}
