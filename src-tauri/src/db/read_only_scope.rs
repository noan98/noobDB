//! サーバ側の読み取り専用の強制 (#2243)。
//!
//! 字句ガード (`is_read_only_sql_for`) は SQL の文字列しか見ないので、書き込みを行う
//! ユーザー定義関数 (`SELECT purge()`) や、拒否リストにない副作用関数は通してしまう。
//! そこで「読み取り専用を強制する経路」(read_only セッションの実行・自動更新・ブロード
//! キャスト・EXPLAIN ANALYZE・スケジューラ) では、字句ガードを残したまま、サーバ側でも
//! 読み取り専用にして二重に守る。
//!
//! - **PostgreSQL**: `BEGIN READ ONLY` で囲み、最後に必ず `ROLLBACK`。
//! - **MySQL**: `START TRANSACTION READ ONLY` で囲み、最後に必ず `ROLLBACK`。
//! - **SQLite**: 文の間だけ `PRAGMA query_only = ON`、終わったら `OFF` に戻す。
//!
//! 接続のセッション設定 (`default_transaction_read_only` 等) ではなくトランザクション
//! 単位にしているのは、(1) プールへ戻る接続に設定が残って書き込み経路へ漏れないため、
//! (2) 文の中から `set_config` で外されないため (読み取り専用トランザクション内では
//! 読み書きへ戻せない)。future が drop された (タイムアウト / キャンセル) 接続は
//! `ReleaseGuard` がプールへ戻さず閉じる。
//!
//! ドライバの `execute` / `execute_stream` のシグネチャを変えずに済むよう、強制の有無は
//! `task_local` で渡す ([`scope`] の内側で動く future だけが見る)。書き込みプレビュー
//! (dry-run) は独自のトランザクションを開く別経路で、この文脈を見ない (read_only でも
//! 従来どおり許可し、ロールバックする)。メタデータ取得などの内部処理も文脈の外で動く。

tokio::task_local! {
    static ENFORCE: ();
}

/// `fut` の中のドライバ実行をサーバ側の読み取り専用で包む。
pub async fn scope<F: std::future::Future>(fut: F) -> F::Output {
    ENFORCE.scope((), fut).await
}

/// `enforce` が真のときだけ [`scope`] で包む (偽なら外側の文脈をそのまま引き継ぐ)。
pub async fn scope_if<F: std::future::Future>(enforce: bool, fut: F) -> F::Output {
    if enforce {
        scope(fut).await
    } else {
        fut.await
    }
}

/// 現在のタスクがサーバ側の読み取り専用を強制されているか。ドライバが見る。
pub fn enforced() -> bool {
    ENFORCE.try_with(|_| ()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enforced_only_inside_scope() {
        assert!(!enforced());
        scope(async { assert!(enforced()) }).await;
        assert!(!enforced());
    }

    #[tokio::test]
    async fn scope_if_false_inherits_outer() {
        scope_if(false, async { assert!(!enforced()) }).await;
        scope(async { scope_if(false, async { assert!(enforced()) }).await }).await;
        scope_if(true, async { assert!(enforced()) }).await;
    }
}
