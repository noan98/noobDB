//! プロファイル削除時の付随ストアの掃除 (#2422)。
//!
//! `profile_id` をキーに持つアプリ側ストアは、プロファイルを消しても自動では消えない。
//! 掃除対象を [`PROFILE_SCOPED_STORES`] の 1 か所にまとめ、`delete_profile` と起動時の
//! 孤立データ掃除 ([`sweep_orphans_once`]) の両方がこの一覧だけを見る。意図的に残すストアは
//! [`RETAINED_STORES`] に理由付きで載せる。メタテスト (`tests`) が `src/` を走査して、
//! `profile_id` を持つストアがどちらにも載っていなければ fail させる。
//!
//! - 掃除はベストエフォート: 1 つのストアの失敗が他のストアの掃除を止めない。
//! - 秘密情報は扱わない (keyring は `profiles::secrets`)。

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use super::store::{self, DB_VARIANT_SEP};
use crate::error::{AppError, Result};

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// `profile_id` をキーに持つストア 1 つぶんの掃除手続き。
pub struct ProfileScopedStore {
    /// ログ・テスト用の名前。
    pub name: &'static str,
    /// ストア実装のソース (`src-tauri/src` からの相対パス)。メタテストが突き合わせる。
    #[cfg_attr(not(test), allow(dead_code))] // 本体では未使用 (メタテストだけが読む)
    pub source: &'static str,
    /// このストアに保存されているプロファイル ID (重複なし)。
    pub profile_ids: fn() -> BoxFut<'static, Vec<String>>,
    /// そのプロファイルのデータを消す。消した (または戻した) 件数を返す。
    pub delete: for<'a> fn(&'a str) -> BoxFut<'a, u64>,
}

/// 掃除対象のストア一覧。`profile_id` を持つストアを足したら、ここに載せる
/// (載せ忘れはメタテストが検出する)。
pub const PROFILE_SCOPED_STORES: &[ProfileScopedStore] = &[
    ProfileScopedStore {
        name: "snippets (scope)",
        source: "snippets/store.rs",
        profile_ids: || Box::pin(async { crate::snippets::store::scoped_profile_ids() }),
        // 削除ではなく、専用スコープを Any へ戻す。
        delete: |id| {
            Box::pin(
                async move { crate::snippets::store::release_profile_scope(id).map(|n| n as u64) },
            )
        },
    },
    ProfileScopedStore {
        name: "timelapse",
        source: "timelapse/store.rs",
        profile_ids: || Box::pin(crate::timelapse::store::profile_ids()),
        delete: |id| Box::pin(crate::timelapse::store::delete_profile_data(id)),
    },
    ProfileScopedStore {
        name: "logical relations",
        source: "logical_relations.rs",
        profile_ids: || Box::pin(async { crate::logical_relations::profile_ids() }),
        delete: |id| Box::pin(async move { crate::logical_relations::delete_profile_data(id) }),
    },
    ProfileScopedStore {
        name: "advisor ignores",
        source: "advisor_ignore.rs",
        profile_ids: || Box::pin(async { crate::advisor_ignore::profile_ids() }),
        delete: |id| Box::pin(async move { crate::advisor_ignore::delete_profile_data(id) }),
    },
    ProfileScopedStore {
        name: "table stat snapshots",
        source: "table_stat_store.rs",
        profile_ids: || Box::pin(async { crate::table_stat_store::profile_ids() }),
        delete: |id| Box::pin(async move { crate::table_stat_store::delete_profile_data(id) }),
    },
    ProfileScopedStore {
        name: "schema drift generations",
        source: "schema_drift/store.rs",
        profile_ids: || Box::pin(crate::schema_drift::store::profile_ids()),
        delete: |id| Box::pin(crate::schema_drift::store::delete_profile_data(id)),
    },
    ProfileScopedStore {
        name: "plan watch",
        source: "plan_watch/store.rs",
        profile_ids: || Box::pin(crate::plan_watch::store::profile_ids()),
        delete: |id| Box::pin(crate::plan_watch::store::delete_profile_data(id)),
    },
    ProfileScopedStore {
        name: "import templates",
        source: "import_templates/store.rs",
        profile_ids: || Box::pin(async { crate::import_templates::store::profile_ids() }),
        delete: |id| {
            Box::pin(async move { crate::import_templates::store::delete_profile_data(id) })
        },
    },
];

/// `profile_id` を持つが、プロファイル削除では**意図的に掃除しない**ストア
/// (`src-tauri/src` からの相対パス, 理由)。
#[cfg_attr(not(test), allow(dead_code))] // 本体では未使用 (メタテストだけが読む許可リスト)
pub const RETAINED_STORES: &[(&str, &str)] = &[
    (
        "profiles/store.rs",
        "プロファイル本体 (delete_profile が直接消す)",
    ),
    (
        "history/store.rs",
        "実行履歴は監査証跡。保持日数・件数上限で自動回収され、履歴画面から消せる",
    ),
    (
        "flight_recorder/store.rs",
        "DML の記録と Undo の元データ。保持日数・件数・容量上限で自動回収され、固定 (pin) もできる",
    ),
    (
        "tasks/store.rs",
        "利用者が書いたタスク定義。削除すると定義を黙って失うため残し、画面から整理してもらう",
    ),
    (
        "tasks/runs.rs",
        "タスクの実行履歴。件数上限で自動回収される (タスク ID キーで、プロファイルの行データは持たない)",
    ),
    (
        "assertions/store.rs",
        "利用者が書いたアサーション (スコープ付き。ゴミ箱あり)。黙って消さない",
    ),
    (
        "assertions/history.rs",
        "アサーション ID をキーにした実行サンプルで、プロファイル ID は持たない",
    ),
    (
        "sandboxes/store.rs",
        "サンドボックスは元プロファイルから独立した複製 (source_profile_id は由来の記録だけ)",
    ),
];

/// `stored` が削除対象のプロファイル `id` のデータか。フロントが「同じサーバの別データベース」
/// 用に作る派生接続の ID (`<id>::db::<名前>`, #2018) で保存されたぶんも含める。
fn belongs_to(stored: &str, id: &str) -> bool {
    stored == id
        || stored
            .strip_prefix(id)
            .is_some_and(|rest| rest.starts_with(DB_VARIANT_SEP))
}

/// 派生接続の ID から元のプロファイル ID を取り出す。
fn base_id(stored: &str) -> &str {
    stored.split(DB_VARIANT_SEP).next().unwrap_or(stored)
}

/// 削除されたプロファイル `id` のデータを全ストアから掃除する。ベストエフォート:
/// 失敗したストアは `(名前, エラー)` で返し、他のストアの掃除は続ける。
pub async fn cleanup_profile(id: &str) -> Vec<(&'static str, AppError)> {
    let mut failures = Vec::new();
    for s in PROFILE_SCOPED_STORES {
        let mut targets: Vec<String> = match (s.profile_ids)().await {
            Ok(ids) => ids.into_iter().filter(|p| belongs_to(p, id)).collect(),
            Err(e) => {
                failures.push((s.name, e));
                Vec::new()
            }
        };
        if !targets.iter().any(|t| t == id) {
            targets.push(id.to_string());
        }
        for t in targets {
            match (s.delete)(&t).await {
                Ok(n) if n > 0 => {
                    tracing::info!(store = s.name, profile_id = %t, count = n, "cleaned up profile data");
                }
                Ok(_) => {}
                Err(e) => failures.push((s.name, e)),
            }
        }
    }
    failures
}

/// 各ストアにあるプロファイル ID のうち、`known` (存在するプロファイル) に無いもの。
/// 派生接続の ID は元のプロファイルで判定する。
async fn orphan_ids(known: &HashSet<String>) -> Vec<(&'static ProfileScopedStore, Vec<String>)> {
    let mut out = Vec::new();
    for s in PROFILE_SCOPED_STORES {
        match (s.profile_ids)().await {
            Ok(ids) => {
                let orphans: Vec<String> = ids
                    .into_iter()
                    .filter(|p| !known.contains(base_id(p)))
                    .collect();
                if !orphans.is_empty() {
                    out.push((s, orphans));
                }
            }
            Err(e) => {
                tracing::warn!(store = s.name, error = %e, "failed to list profile ids for orphan sweep");
            }
        }
    }
    out
}

/// 存在するプロファイルの ID 集合。プロファイル一覧を確実に読めないときは `None`
/// (読めないまま「存在しない」と見なして消すと、健全なデータまで失う)。
fn known_profile_ids() -> Option<HashSet<String>> {
    let profiles = store::load_all().ok()?;
    if profiles.is_empty() {
        // 空 = 全削除済みか、profiles.json が壊れて退避された直後かを区別できない。何もしない。
        return None;
    }
    let mut known: HashSet<String> = profiles.into_iter().map(|p| p.id).collect();
    // 解釈できずに読み飛ばされた要素 (新しい版が足したものなど) の ID も「存在する」扱い。
    // ID が読めない要素があるときは判定できないので掃除しない。
    for skipped in store::list_skipped().ok()? {
        known.insert(skipped.id?);
    }
    Some(known)
}

fn marker_path() -> Option<PathBuf> {
    store::data_dir().map(|d| d.join("profile_data_sweep_v1.done"))
}

/// すでに孤立しているデータ (この掃除が入る前に削除されたプロファイルのぶん) を一度だけ掃除する。
/// 完了したらデータディレクトリにマーカーを置き、以後は走らない (以降の孤立は `delete_profile`
/// が防ぐ)。プロファイル一覧を確実に読めないときは何もせず、次回起動で再試行する。
pub async fn sweep_orphans_once() {
    let Some(marker) = marker_path() else {
        return;
    };
    if marker.exists() {
        return;
    }
    let Some(known) = known_profile_ids() else {
        return;
    };
    let mut all_ok = true;
    for (s, ids) in orphan_ids(&known).await {
        for id in ids {
            match (s.delete)(&id).await {
                Ok(n) => {
                    tracing::info!(store = s.name, profile_id = %id, count = n, "swept orphaned profile data");
                }
                Err(e) => {
                    all_ok = false;
                    tracing::warn!(store = s.name, profile_id = %id, error = %e, "failed to sweep orphaned profile data");
                }
            }
        }
    }
    if all_ok {
        if let Err(e) = std::fs::write(&marker, b"") {
            tracing::warn!(error = %e, "failed to write orphan sweep marker");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn belongs_to_matches_the_profile_and_its_derived_connections_only() {
        assert!(belongs_to("abc", "abc"));
        assert!(belongs_to("abc::db::shop", "abc"));
        assert!(!belongs_to("abcd", "abc"));
        assert!(!belongs_to("abcd::db::shop", "abc"));
        assert!(!belongs_to("xabc", "abc"));
    }

    #[test]
    fn base_id_strips_the_derived_connection_suffix() {
        assert_eq!(base_id("abc"), "abc");
        assert_eq!(base_id("abc::db::shop"), "abc");
    }

    fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read_dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                collect_rs(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// `#[cfg(test)]` より前 (本体コード) だけを返す。
    fn production_part(src: &str) -> &str {
        src.find("#[cfg(test)]").map_or(src, |i| &src[..i])
    }

    fn rel(src_root: &Path, p: &Path) -> String {
        p.strip_prefix(src_root)
            .expect("under src")
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// アプリ側の永続ストアを持つファイルの目印。
    const STORE_MARKERS: [&str; 3] = [
        "JsonStore::new(",
        "store_lock::acquire(",
        "OnceCell<SqlitePool>",
    ];

    /// `src/` を走査し、`profile_id` を持つ永続ストアがすべて一覧 (掃除対象 or 意図的に残す)
    /// に載っていることを確かめる。新しいストアを足して掃除登録を忘れると、ここで落ちる。
    #[test]
    fn every_profile_scoped_store_is_registered_for_cleanup() {
        let src_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        collect_rs(&src_root, &mut files);

        let registered: HashSet<&str> = PROFILE_SCOPED_STORES
            .iter()
            .map(|s| s.source)
            .chain(RETAINED_STORES.iter().map(|(p, _)| *p))
            .collect();

        let mut missing = Vec::new();
        let mut detected = HashSet::new();
        for path in &files {
            let name = rel(&src_root, path);
            // ストアの共通部品そのもの (定義側) は対象外。
            if matches!(
                name.as_str(),
                "json_store.rs" | "store_lock.rs" | "profiles/cleanup.rs"
            ) {
                continue;
            }
            let body = std::fs::read_to_string(path).expect("read source");
            let body = production_part(&body);
            if !STORE_MARKERS.iter().any(|m| body.contains(m)) {
                continue;
            }
            // 型の定義は同じディレクトリの mod.rs にあることが多いので、そちらも見る。
            let mut scoped = body.contains("profile_id");
            if !scoped && !name.ends_with("mod.rs") {
                let sibling = path.with_file_name("mod.rs");
                if let Ok(m) = std::fs::read_to_string(&sibling) {
                    scoped = production_part(&m).contains("profile_id");
                }
            }
            if !scoped {
                continue;
            }
            detected.insert(name.clone());
            if !registered.contains(name.as_str()) {
                missing.push(name);
            }
        }
        assert!(
            missing.is_empty(),
            "profile_id を持つストアが profiles/cleanup.rs に未登録です: {missing:?}\n\
             削除時に消すなら PROFILE_SCOPED_STORES へ、意図的に残すなら理由付きで RETAINED_STORES へ載せてください"
        );

        // 一覧に載っているパスが実在し、検出された (= 一覧が古びていない) ことも確かめる。
        for p in &registered {
            assert!(
                src_root.join(p).is_file(),
                "cleanup.rs の一覧にあるファイルが存在しません: {p}"
            );
            assert!(
                detected.contains(*p),
                "cleanup.rs の一覧にあるのに、profile_id を持つストアとして検出されません (不要な登録?): {p}"
            );
        }
    }

    #[test]
    fn registry_has_no_duplicates_and_every_retained_store_has_a_reason() {
        let mut seen = HashSet::new();
        for s in PROFILE_SCOPED_STORES {
            assert!(seen.insert(s.source), "重複: {}", s.source);
        }
        for (p, reason) in RETAINED_STORES {
            assert!(seen.insert(p), "掃除対象と許可リストで重複: {p}");
            assert!(!reason.trim().is_empty(), "理由が空: {p}");
        }
    }
}
