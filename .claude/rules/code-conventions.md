# コード規約とリンタ運用

Rust / TypeScript 両側の lint・デッドコード検出の運用方針。

## unwrap / expect / panic の lint 運用 (#527)

Rust 本体コードでの `unwrap()` / `expect()` / `panic!` によるクラッシュを構造的に
抑止するため、`src-tauri/src/lib.rs` の先頭に
`#![warn(clippy::unwrap_used, clippy::expect_used, clippy::panic)]` を置いています。
CI の clippy ジョブは `-D warnings` でこれをエラーに昇格させるため、**新規に
unwrap/expect/panic を本体コードに入れると CI が自動で fail** します。テストコードは
`src-tauri/clippy.toml` の `allow-unwrap-in-tests = true` 等で除外済みなので、既存の
テストには影響しません。どうしても本体コードに残す必要がある箇所 (回復不能な起動失敗など)
には `#[allow(clippy::unwrap_used)]` / `#[allow(clippy::panic)]` + **なぜ
panic/unwrap が妥当かの日本語根拠コメント**を必ず付けてください。

フロントエンドは `tsc` (`pnpm run build` 経由) で型チェックされ、さらに
**Biome (`biome.json`)** が `pnpm run lint` (= `scripts/biome-lint.mjs`) で CI の
frontend ジョブ内のステップとして走ります (#1176)。ルールは高シグナルなものだけで、
スタイル系・整形は入れません (formatter は無効)。

- `nursery/noFloatingPromises` (error): await 忘れの IPC 呼び出しは握り潰された失敗に
  なる。意図的な fire-and-forget は `void` で明示する (失敗が呼び出し先の try/catch で
  処理済みであることを確認すること)。
- `nursery/noMisusedPromises` (error): Promise を条件式や void 戻りのコールバック位置に
  渡すとエラー。Promise の null チェックは `!== null` と明示する。
- `correctness/useHookAtTopLevel` (error): hooks の呼び出し規則。
- `correctness/useExhaustiveDependencies` (**warn**): 既存の依存配列漏れが多いため
  段階導入。Biome には `--max-warnings` が無いので `scripts/biome-lint.mjs` の
  `WARNING_BUDGET` が違反フックの数を固定しており、新規の違反は CI で落ちる。
  直して件数が減ったら `WARNING_BUDGET` も下げる。意図的に依存を絞る箇所は
  `// biome-ignore lint/correctness/useExhaustiveDependencies: 理由` で明示する。
- `noFloatingPromises` / `noMisusedPromises` は Biome 2 時点で `nursery` (試験的) 扱い。
  卒業・改名で設定が壊れたら `biome migrate` を使う。TypeScript の JS API には依存しない
  (TypeScript 7 のネイティブ版と衝突しない)。

`tsconfig.json` では `strict`、`noUnusedLocals`、
`noUnusedParameters` が有効になっているため、未使用の import やパラメータがあると
ビルドが失敗します。テストランナーには **Vitest** を採用しており、`pnpm test`
(`vitest run`) で `src/__tests__/` 配下のユニットテストを実行します。テスト対象は
SQL の安全網・リテラル生成・方言判定など安全性に直結する純粋ロジック
(`dangerousSql.ts`・`components/cellEdit.ts`・`components/sqlDialect.ts` など) です。
テストファイルは `src/` 配下にあるため `tsc` の型チェック対象にも含まれます。CI
(`ci.yml`) の frontend ジョブが `pnpm run build` に続けて `pnpm test` を実行します。

未使用エクスポート・到達不能コード・未使用依存の検出には **knip** (`pnpm run knip`)
を使います (#470)。`tsc` の `noUnusedLocals` はファイル内の未使用しか拾えませんが、
knip は「エクスポートされているがどこからも import されない関数」や「未使用の依存」
などモジュール跨ぎのデッドコードを検出し、IPC ラッパ (`api/tauri.ts`) ⇔ UI 利用の
ドリフト (到達できない機能) を防ぎます。設定は `knip.json` で、`ignoreExportsUsedInFile`
により「同一ファイル内でのみ使う export」は許容し、意図的な公開 API は JSDoc の
`@public` タグ (`tags: ["-public"]`) で許可リスト化してベースラインを green にして
います。CI の frontend ジョブが `pnpm run build` の後に `pnpm run knip` を実行し、
新規の未使用エクスポートが入ると fail します。
