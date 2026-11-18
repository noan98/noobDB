# Rust ビルドの高速化設定

ローカルと CI の Rust ビルドを速くするための設定をいくつか入れています。

- `src-tauri/Cargo.toml` の `[profile.dev]` で `debug = "line-tables-only"` を
  指定し、dev ビルドの debuginfo を行テーブルのみに削減しています。リンク時間が
  減り dev ビルドの反復が速くなる一方、バックトレースのファイル:行情報は維持され
  ます。ツール導入不要で全環境に効きます。
- `[profile.release]` は **`lto = "thin"` + `codegen-units` 既定**です。以前の
  `lto = "fat"` + `codegen-units = 1` は依存ツリー全体を単一単位で再最適化するため、
  最終コンパイル + リンクが rust-cache でキャッシュできない毎回の固定コストとして
  リリースビルド (タグビルド 30 分超) を支配していました。本アプリは処理の大半が
  DB I/O 待ちで fat LTO の実行時性能メリットは計測困難な一方、thin LTO でも
  クレート跨ぎのインライン化はほぼ得られます。バイナリサイズの微増は release.yml
  の出荷バイナリサイズ可視化 (#549) で追跡します。**fat に戻す変更はビルド時間との
  トレードオフを必ず再計測してから**にしてください。
- `src-tauri/Cargo.toml` の `[lib] crate-type` は **`["rlib"]` のみ**にしています。
  `staticlib` / `cdylib` はモバイル (iOS/Android) 専用の生成物で、デスクトップ
  専用の本プロジェクトでは不要です。これらを残すとリリースビルドで依存ツリー全体を
  含む cdylib(.dll) の最適化リンクが余計に走るため、`rlib` 限定でその分を削減して
  います。**モバイル対応する場合は `["staticlib", "cdylib", "rlib"]` に戻す**こと。
- `src-tauri/.cargo/config.toml` が **Linux x86_64 ターゲットのリンカに
  `clang` + `mold`** を指定しています。インクリメンタルビルドではリンクが所要
  時間の大半を占めるため、効果が大きいです。**Linux で開発・テストする場合は
  `clang` と `mold` のインストールが必須**です (`sudo apt install clang mold`
  など)。未導入だと `cargo build` / `clippy` / `test` がリンカを見つけられず
  失敗します。用意できない場合は同ファイルの `-fuse-ld=mold` を `-fuse-ld=lld`
  に変えるか、`[target.*]` ブロックをコメントアウトしてください。この設定は
  Linux x86_64 ターゲット限定で、Windows のリリースビルドや macOS には影響
  しません。
- 同ファイルが **Windows (MSVC) ターゲットのリンカに LLVM の `lld-link`** を
  指定しています。既定の `link.exe` は巨大バイナリのリンクが遅く、リリースビルド
  (`release.yml`) の最終リンクを縮められます。GitHub Actions の `windows-latest`
  ランナーには LLVM がプリインストール済みで `lld-link` が PATH 上にあります。
  **ローカルで Windows ビルドする場合は LLVM (lld-link) が必須**で、未導入なら
  `[target.x86_64-pc-windows-msvc]` ブロックをコメントアウトすれば既定の `link.exe`
  に戻ります。Linux / macOS のビルドには影響しません。
- 同ファイルに **sccache** (`[build] rustc-wrapper`) の設定をコメントアウト
  状態で同梱しています。プロジェクト/ブランチを跨いでコンパイル成果物を再利用
  したい場合は `cargo install sccache` してから該当行を有効化してください。
  クリーンビルドや `Cargo.lock` 変更時のビルドに効きます (リンク時間は短縮
  されないので mold と併用すると効果的)。**CI では `config.toml` を書き換えず**、
  `ci.yml` の各コンパイルジョブで `RUSTC_WRAPPER=sccache` を環境変数として与える
  方式で有効化しています (`SCCACHE_DIR` を `actions/cache` で永続化)。ローカルの
  挙動を変えたくないため config はコメントアウトのままにしています。
- CI (`ci.yml` の rust ジョブ) では上記 config に合わせて `clang` と `mold` を
  apt で導入済みで、`cargo nextest` のテストバイナリ群のリンクが mold で高速化
  されます。加えて `rust (clippy)` / `rust (test)` / `rust (coverage)` / `rust (windows)` では
  **sccache** を `RUSTC_WRAPPER` で有効化し、コンパイル単位のキャッシュをブランチ
  跨ぎで再利用します (詳細は上の CI セクションを参照)。

## Windows ビルドの I/O 対策と Dev Drive の計測 (#2413)

- `ci.yml` の `rust (windows)`・`windows-db-smoke.yml`・`release.yml` の `build` は、
  checkout より前に Defender のリアルタイム保護を止める
  (`Set-MpPreference -DisableRealtimeMonitoring $true`)。`release.yml` も #2413 で揃えた。
  `src/__tests__/windowsJobParity.test.ts` が 3 ワークフローの抜けを検出する。
- `release.yml` にも `ci.yml` と同じ registry index の自前キャッシュと
  `cargo fetch --locked --offline` の probe を入れた (#1680 と同方式。キーは
  `cargo-index-<OS>-release-<Cargo.lock のハッシュ>`、保存は `github.ref == main` のとき: main push・schedule・main への dispatch)。
  そろっていれば `CARGO_NET_OFFLINE=true`、足りなければオンラインのまま。
- `build` ジョブの最後の `Job timing & cache summary (#565)` が、所要時間・rust-cache の
  ヒット・offline 化の有無・計測モードを Job Summary に出す。前後比較はここを見る。

### Dev Drive (ReFS) の計測手順と判断基準

**状態: 未計測 (採用 / 見送りは未決)。** この結果欄は、下の手順で計測して数値を埋める。
クラウド実行環境では Windows ランナーを動かせないため、計測用の条件付きステップだけを
`release.yml` に入れてある (通常実行では走らない)。

0. `release.yml` は `concurrency` で main の実行を cancel-in-progress するため、1 本ずつ順に、main への push が無い時間帯に実行する。
1. Actions の `release` を `workflow_dispatch` で **同じ main の ref** に対し 2 回実行する。
   入力 `measure` を (a) `cold` と (b) `cold-devdrive` にする。どちらも rust-cache と
   registry index のキャッシュを使わない (復元も保存もしない) コールドビルドで、
   (b) だけが ReFS の VHD (V:。`diskpart` の `format fs=refs` で、Dev Drive 指定の `Format-Volume -DevDrive` ではない) に `CARGO_HOME` / `CARGO_TARGET_DIR` を置く。
   Defender 停止は両方に入っている (「停止後も効果があるか」の条件)。
2. 各 run の Job Summary の「所要時間」を比べる。ノイズを見るため各 2 回ずつ (計 4 回) 推奨。
3. `rust (windows)` 側は、同じ要領で一時的に Dev Drive ステップを足したブランチで
   1 回ずつ測る (恒常的なステップは入れていない)。

判断基準:
- 採用: (b) が (a) より **おおむね 1 分以上かつ 5% 以上**短く、2 回とも同じ向きのとき。
  採用時は `rust-cache` の保存先 (`target`) を Dev Drive へ向ける設計が別途必要
  (現状の `workspaces: "./src-tauri -> target"` は `src-tauri/target` 固定)。
  キャッシュ復元・保存の I/O も含めた **キャッシュ有りの cache-warm** で再計測してから入れる。
- 見送り: 差が誤差 (上記未満・向きが揺れる) なら見送り、数値と根拠をここに残す
  (#1943 / LTO の前例)。

| 日付 (JST) | 計測モード | run | 所要時間 | 備考 |
| --- | --- | --- | --- | --- |
| (未計測) | cold | - | - | - |
| (未計測) | cold-devdrive | - | - | - |
