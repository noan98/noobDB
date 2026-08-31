# Rust ビルドの高速化設定

ローカルと CI の Rust ビルドを速くするための設定をいくつか入れています。

- `src-tauri/Cargo.toml` の `[profile.dev]` で `debug = "line-tables-only"` を
  指定し、dev ビルドの debuginfo を行テーブルのみに削減しています。リンク時間が
  減り dev ビルドの反復が速くなる一方、バックトレースのファイル:行情報は維持され
  ます。ツール導入不要で全環境に効きます。
- `[profile.release]` は **`lto = "thin"` + `codegen-units` 既定**です。以前の
  `lto = "fat"` + `codegen-units = 1` は依存ツリー全体 (DuckDB #709 の bundled
  静的ライブラリを含む) を単一単位で再最適化するため、最終コンパイル + リンクが
  rust-cache でキャッシュできない毎回の固定コストとしてリリースビルド (タグ
  ビルド 30 分超) を支配していました。本アプリは処理の大半が DB I/O 待ちで
  fat LTO の実行時性能メリットは計測困難な一方、thin LTO でもクレート跨ぎの
  インライン化はほぼ得られます。バイナリサイズの微増は release.yml の出荷
  バイナリサイズ可視化 (#549) で追跡します。**fat に戻す変更はビルド時間との
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
  されます。加えて `rust (clippy)` / `rust (test)` / `rust (windows clippy)` /
  `rust (windows test)` では
  **sccache** を `RUSTC_WRAPPER` で有効化し、コンパイル単位のキャッシュをブランチ
  跨ぎで再利用します (詳細は上の CI セクションを参照)。
