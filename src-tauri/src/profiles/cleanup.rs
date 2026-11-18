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
use crate::commands::assertions::blocking_store;
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
        profile_ids: || Box::pin(blocking_store(crate::snippets::store::scoped_profile_ids)),
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
        profile_ids: || Box::pin(blocking_store(crate::logical_relations::profile_ids)),
        delete: |id| {
            let id = id.to_string();
            Box::pin(blocking_store(move || {
                crate::logical_relations::delete_profile_data(&id)
            }))
        },
    },
    ProfileScopedStore {
        name: "advisor ignores",
        source: "advisor_ignore.rs",
        profile_ids: || Box::pin(blocking_store(crate::advisor_ignore::profile_ids)),
        delete: |id| {
            let id = id.to_string();
            Box::pin(blocking_store(move || {
                crate::advisor_ignore::delete_profile_data(&id)
            }))
        },
    },
    ProfileScopedStore {
        name: "table stat snapshots",
        source: "table_stat_store.rs",
        profile_ids: || Box::pin(blocking_store(crate::table_stat_store::profile_ids)),
        delete: |id| {
            let id = id.to_string();
            Box::pin(blocking_store(move || {
                crate::table_stat_store::delete_profile_data(&id)
            }))
        },
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
        profile_ids: || Box::pin(blocking_store(crate::import_templates::store::profile_ids)),
        delete: |id| {
            Box::pin(async move { crate::import_templates::store::delete_profile_data(id) })
        },
    },
];

/// `profile_id` を持つが、プロファイル削除では**意図的に掃除しない**ストア
/// (`src-tauri/src` からの相対パス, 理由)。
#[cfg(test)] // メタテストだけが読む許可リスト
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

/// フロントがサンドボックスを接続として扱うときの合成 ID の接頭辞 (`src/sandbox.ts`
/// `sandboxToProfile`)。`profiles.json` には書かれないが、インポートテンプレートやプラン監視は
/// この ID のまま保存するので、「存在しない = 孤立」と見なしてはならない。
const SANDBOX_ID_PREFIX: &str = "sandbox:";

/// 保存されている ID (`ids`) のうち、起動時の掃除で消してよい孤立 ID を選ぶ純粋ロジック。
/// 次のものは**残す**: 既知のプロファイル、既知プロファイルの派生接続 (`::db::`)、サンドボックスの
/// 合成 ID (`sandbox:`)、既知 ID の接頭辞になっているだけの候補 (`|` を含む ID を最初の `|` で
/// 切るストアのキー形式のため。誤削除より取り残しを選ぶ)。
fn select_orphans(ids: Vec<String>, known: &HashSet<String>) -> Vec<String> {
    ids.into_iter()
        .filter(|p| {
            !p.starts_with(SANDBOX_ID_PREFIX)
                && !known.contains(base_id(p))
                && !known.iter().any(|k| {
                    k.strip_prefix(p.as_str())
                        .is_some_and(|r| r.starts_with('|'))
                })
        })
        .collect()
}

/// 削除されたプロファイル `id` のデータを全ストアから掃除する。ベストエフォート:
/// 失敗したストアは `(名前, エラー)` で返し、他のストアの掃除は続ける。
pub async fn cleanup_profile(id: &str) -> Vec<(&'static str, AppError)> {
    cleanup_in(PROFILE_SCOPED_STORES, id).await
}

async fn cleanup_in(
    stores: &'static [ProfileScopedStore],
    id: &str,
) -> Vec<(&'static str, AppError)> {
    let mut failures = Vec::new();
    for s in stores {
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

/// 存在するプロファイルの ID 集合。プロファイル一覧を確実に読めないときは `None`
/// (読めないまま「存在しない」と見なして消すと、健全なデータまで失う)。
async fn known_profile_ids() -> Option<HashSet<String>> {
    blocking_store(|| {
        let profiles = store::load_all()?;
        if profiles.is_empty() {
            // 空 = 全削除済みか、profiles.json が壊れて退避された直後かを区別できない。
            return Ok(None);
        }
        let mut known: HashSet<String> = profiles.into_iter().map(|p| p.id).collect();
        // 解釈できずに読み飛ばされた要素 (新しい版が足したものなど) の ID も「存在する」扱い。
        // ID が読めない要素があるときは判定できないので掃除しない。
        for skipped in store::list_skipped()? {
            match skipped.id {
                Some(id) => {
                    known.insert(id);
                }
                None => return Ok(None),
            }
        }
        Ok(Some(known))
    })
    .await
    .ok()
    .flatten()
}

/// 孤立データの掃除の本体。**先に各ストアの ID を列挙し、その後で** `known` を読む
/// (逆だと、読んだ後に作られたプロファイルのデータを孤立と誤認して消しうる)。
/// `known` が `None` なら何もせず `None`、掃除したら全ストア成功かを `Some` で返す。
async fn sweep_in(
    stores: &'static [ProfileScopedStore],
    known: impl Future<Output = Option<HashSet<String>>>,
) -> Option<bool> {
    let mut listed = Vec::new();
    for s in stores {
        match (s.profile_ids)().await {
            Ok(ids) => listed.push((s, ids)),
            Err(e) => {
                tracing::warn!(store = s.name, error = %e, "failed to list profile ids for orphan sweep");
            }
        }
    }
    let known = known.await?;
    let mut all_ok = listed.len() == stores.len();
    for (s, ids) in listed {
        for id in select_orphans(ids, &known) {
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
    Some(all_ok)
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
    let done = {
        let marker = marker.clone();
        tauri::async_runtime::spawn_blocking(move || marker.exists())
            .await
            .unwrap_or(true)
    };
    if done {
        return;
    }
    if sweep_in(PROFILE_SCOPED_STORES, known_profile_ids()).await == Some(true) {
        let wrote = tauri::async_runtime::spawn_blocking(move || std::fs::write(&marker, b""))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r.map_err(|e| e.to_string()));
        if let Err(e) = wrote {
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

    /// テストモジュール (`#[cfg(test)]` の直後に `mod tests` が来る位置) より前だけを返す。
    /// 先頭付近の `#[cfg(test)]` 付きの関数・定数で本体が切れないようにする。
    fn production_part(src: &str) -> &str {
        let mut from = 0;
        while let Some(i) = src[from..].find("#[cfg(test)]") {
            let at = from + i;
            let rest = src[at + "#[cfg(test)]".len()..].trim_start();
            if rest.starts_with("mod tests") {
                return &src[..at];
            }
            from = at + 1;
        }
        src
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
            // 限界: 探すのは同じディレクトリの mod.rs だけ。それ以外の場所 (別モジュール) に
            // `profile_id` を持つ型を置くストアは検出できないので、そのときは手で登録すること。
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

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn strs(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn select_orphans_keeps_known_derived_sandbox_and_prefix_ids() {
        let known = set(&["abc", "a|b"]);
        let ids = strs(&[
            "abc",           // 既知
            "abc::db::shop", // 既知の派生接続
            "gone",          // 未知 = 孤立
            "gone::db::x",   // 未知の派生接続 = 孤立
            "sandbox:s1",    // サンドボックスの合成 ID
            "a",             // 既知 "a|b" の接頭辞 (キーを最初の | で切った結果)
            "a|b",           // 既知
            "abcd",          // 既知 "abc" と接頭辞が同じだけの別 ID = 孤立
        ]);
        assert_eq!(
            select_orphans(ids, &known),
            strs(&["gone", "gone::db::x", "abcd"])
        );
        assert!(select_orphans(strs(&["sandbox:x"]), &set(&[])).is_empty());
    }

    use std::sync::Mutex;

    static CLEAN_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
    static SWEEP_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
    static NOT_CALLED_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

    fn fake_ids() -> BoxFut<'static, Vec<String>> {
        Box::pin(async { Ok(strs(&["p", "p::db::x", "pp", "q", "sandbox:s1"])) })
    }

    static CLEAN_STORES: &[ProfileScopedStore] = &[ProfileScopedStore {
        name: "fake-clean",
        source: "fake.rs",
        profile_ids: fake_ids,
        delete: |id| {
            let id = id.to_string();
            Box::pin(async move {
                CLEAN_LOG.lock().expect("lock").push(id);
                Ok(1)
            })
        },
    }];

    static SWEEP_STORES: &[ProfileScopedStore] = &[ProfileScopedStore {
        name: "fake-sweep",
        source: "fake.rs",
        profile_ids: fake_ids,
        delete: |id| {
            let id = id.to_string();
            Box::pin(async move {
                SWEEP_LOG.lock().expect("lock").push(id);
                Ok(1)
            })
        },
    }];

    static NOT_CALLED_STORES: &[ProfileScopedStore] = &[ProfileScopedStore {
        name: "fake-unknown",
        source: "fake.rs",
        profile_ids: fake_ids,
        delete: |id| {
            let id = id.to_string();
            Box::pin(async move {
                NOT_CALLED_LOG.lock().expect("lock").push(id);
                Ok(1)
            })
        },
    }];

    #[tokio::test]
    async fn cleanup_deletes_the_profile_and_its_derived_ids_only() {
        let failures = cleanup_in(CLEAN_STORES, "p").await;
        assert!(failures.is_empty());
        assert_eq!(*CLEAN_LOG.lock().expect("lock"), strs(&["p", "p::db::x"]));
    }

    #[tokio::test]
    async fn sweep_deletes_only_orphans() {
        let known = async { Some(set(&["p", "pp"])) };
        assert_eq!(sweep_in(SWEEP_STORES, known).await, Some(true));
        // p / pp (既知)・p::db::x (既知の派生)・sandbox:s1 は残し、q だけが孤立。
        assert_eq!(*SWEEP_LOG.lock().expect("lock"), strs(&["q"]));
    }

    #[tokio::test]
    async fn sweep_does_nothing_when_the_profile_list_is_unknown() {
        assert_eq!(sweep_in(NOT_CALLED_STORES, async { None }).await, None);
        assert!(NOT_CALLED_LOG.lock().expect("lock").is_empty());
    }
}
