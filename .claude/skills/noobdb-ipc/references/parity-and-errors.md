# パリティテストと構造化エラー

## UI 到達性の検証 (#907) — なぜ必要か


**さらに「UI からそのラッパーに到達できるか」も検証します (#907)。**
`ipcCommandParity` が担保するのは「lib.rs 登録 ⇔ `tauri.ts` ラッパ」の集合一致まで
で、その先の到達性は誰も見ていませんでした。`api` は単一オブジェクトとして export され
UI で使われているため **knip では原理的にプロパティ単位の未使用を検出できず**、逆に
`ipcCommandParity` は集合完全一致を強制するので UI 未接続のラッパーを消すと CI が
落ちる — 結果としてデッドラッパーが構造的に不可視でした。
`src/__tests__/apiReachabilityParity.test.ts` が `Object.keys(api)` と `src/` 配下
(`api/tauri.ts` と `__tests__/` を除く) の `api.<name>` 参照を突き合わせ、**どこからも
呼ばれないラッパーがあれば落ちます**。逃げ道の許可リスト
`INTENTIONALLY_UNREACHABLE` は**空のまま維持するのが理想**で、追加するときは理由を
併記してください (「まだ UI を作っていない」は理由になりません — UI を足すか、
ラッパーと Rust コマンドを一緒に消す)。この方針で #907 では
`run_captured_write` / `precheck_captured_write` を IPC ごと削除しました (書き込み記録は
`run_query_stream({ capture: true })` に一本化済み。`run_captured_write_inner` は

その共通コアとして残る)。`clear_flight_records` / `clear_task_runs` は同じ調査で
UI 未接続と分かりましたが、#910 が `FlightRecorderPanel` の「全消去」/ `TaskManager`
の「実行履歴をクリア」導線を追加して解消済みです。

**「3 点コントラクト」の残る 1 辺 (#1031)。** `ipcCommandParity` は `generate_handler!`
の**登録**集合を「正」とみなして `tauri.ts` と突き合わせるため、`#[tauri::command]`
が付いているのに `generate_handler!` から**登録し忘れた**関数はどちらの集合にも
現れず不可視のまま (`apiReachabilityParity` は Rust ソースを読まないので対象外、
knip は TS 限定で Rust の未使用関数を検出しない)。
`src/__tests__/commandRegistrationParity.test.ts` が `import.meta.glob` で
`src-tauri/src/commands/**/*.rs` を再帰的に読み、実在する `#[tauri::command]
pub (async) fn <name>` を抽出して `generate_handler!` 登録集合の部分集合であることを
検証し、この最後の 1 辺を塞ぎます。抽出前に行コメント (`//` 始まり、`///`/`//!` も
同じ手法で除去可能) を取り除くのが要点で、そうしないと「The `#[tauri::command]`
wrapper above is intentionally a one-liner over this.」のような**説明文中の記法**
(`commands/query.rs::run_query_inner` / `commands/sync.rs::apply_sync_sql_inner` /
`commands/sandbox.rs` のモジュール doc に実例あり) を誤って属性だと検出してしまいます。

エラーは `AppError` として上に
伝搬し、`{ kind, message }` の**構造化 JSON** としてシリアライズされます
(`error.rs::Serialize` / `AppError::kind()` を参照。#683)。`kind` はバリアント由来の
安定した判別子 (`ssh` / `sshHostKeyMismatch` / `timeout` / `readOnly` /
`connectionLost` / `invalidInput` / `db` ...) で、`message` は従来の `Display` 文字列
です。フロントの `src/api/tauri.ts` の `invoke` ラッパーが reject 値を
`BackendError` (`.kind` / `.message` を持つ。`toString()` は `message` を返すので
既存の `String(e)` 経路は不変) に正規化し、**旧形式の素の文字列も後方互換で受け付け**
ます (`normalizeBackendError`)。`src/errorHints.ts` は「`kind` による確実な分類
(`hintForKind`) → `message` パターンはフォールバック (`matchErrorHint`)」の 2 段構成
(`resolveErrorHint`) で、SSH 系 (認証失敗 / エージェント不在 / 鍵・パスフレーズ /
ホスト鍵不一致) のヒントもここで解決します。`kind` → ヒントの対応はフロント/バック
共有ゴールデン (`src/__tests__/fixtures/errorKindVectors.json` を
`errorKindGolden.test.ts` と `tests/error_kind_golden.rs` が突き合わせ) で固定して
います。**`error.rs` にバリアントを追加するときは `kind()` の分岐も更新**してください。
