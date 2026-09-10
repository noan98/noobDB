# 設定ストア・SQL 安全網・エディタの構文チェック

- `settings.ts` — `useSyncExternalStore` ベースの設定ストア。シンタックスカラー
  (`syntaxColors` light/dark)・プレビューハイライト色・表示行数 (`defaultDisplayCount` /
  `streamPrefetchSize`)・自動 LIMIT (`autoLimitEnabled` / `autoLimitCount`)・SQL 構文
  チェック (`sqlLintEnabled`。#704)・本番接続確認
  (`confirmProductionConnect`)・危険クエリ確認 (`confirmDangerousQueries`)・新規タブ実行
  (`resultsInNewTab`)・タブ復元 (`tabRestoreMode`)・クエリタイムアウト
  (`queryTimeoutSecs`)・フォントサイズ (`fontSizePx`) / フォントファミリ
  (`monoFontFamily` / `uiFontFamily`)・アクセント色 (`accentColor`)・UI 密度
  (`density`)・自動リフレッシュ間隔 (`autoRefreshDefaultSecs`)・グリッド表示モード
  (`resultGridMode` scroll/paginate, `resultGridPageSize`)・セル編集の blur 挙動
  (`cellEditOnBlur`)・リッチセル描画 (`richCellRendering`)・列ヘッダの NULL 率
  ミニバー (`columnNullBars`。#911)・テーマプリセット
  (`themePreset` default/dracula/high-contrast/colorblind。後者 2 つは light/dark
  追従でアクセシビリティ向け。#558) などを保持します。
- `dangerousSql.ts` — WHERE なし UPDATE/DELETE・DROP・TRUNCATE を検出する
  フロント側の安全網 (バックエンド `is_read_only_sql` と同じくリテラル/コメントを
  マスクするベストエフォート判定)。`DangerousQueryDialog` の確認に使われます。
- `components/sqlLint.ts` — クエリエディタのリアルタイム SQL 構文チェック (#704) の
  純ロジック。`@codemirror/lang-sql` が既に構築した **Lezer パースツリーを再利用**し
  (`syntaxTree(state)`)、エラーノード (`node.type.isError` = 括弧不整合など) と、
  クオートで始まり閉じられていないトークン (未終端の文字列/引用符付き識別子。Lezer は
  未終端文字列をエラーにせず EOF まで伸びる 1 トークンにするためツリーから別途拾う) を
  `@codemirror/lint` の `Diagnostic[]` へ変換する。加えて、未終端のブロックコメント
  (`/*` 未クローズ) と、**文の先頭キーワードのタイポ** (`SELEC` など。各 `Statement`
  の先頭トークンが `Keyword` 系でなく素の `Identifier` の文を warning で報告。
  `STATEMENT_START_EXTRA` の許可リストが方言キーワード表の載り漏れに対する安全弁)、
  **句の順序ミス** (`ORDER BY` の後の `WHERE` など。文直下の `Keyword` 列を
  `WHERE → GROUP BY → HAVING → ORDER BY → LIMIT` のランクで走査し、違反句を warning
  で報告。サブクエリ / `OVER (...)` 内は `Parens` に包まれるため対象外。報告対象は
  3 方言で完全予約語の句のみで、非予約語 `OFFSET` は列名と区別できないため判定に
  使わない。SELECT / 集合演算でランクをリセットし `INSERT ... SELECT` も誤検出
  しない) も検出する。エディタの `closeBrackets()` が括弧/クオートをタイプ中に自動で閉じるため
  括弧系の検出は主に貼り付け・削除後に効き、タイプ中の主戦力は文頭キーワード判定。
  見た目判定はリーフトークン限定 (コンテナノードに適用するとクオートで始まる文全体を
  未終端と誤検出する)。`QueryEditor` が `lintGutter()` +
  `linter()` (デバウンス 500ms) を Compartment 越しに追加し、設定 `sqlLintEnabled`
  (既定オン) のオン/オフと言語切替で再構成する。方言追従は共有ツリー経由で自動 (別途
  dialect を渡さない)。診断メッセージは `i18n` (`editorLint*`) で日英対応。**編集支援
  (ベストエフォート) であって安全判定ではない**: 文法が寛容なため文中のタイポ
  (`FORM` 等) やカンマ抜けは検出できず、`apply_auto_limit` と同じく誤検出より見逃しを
  優先する保守的方針 (打ちかけの先頭単語 = 後続トークンなしも flag しない)。安全網
  (`dangerousSql.ts` / `is_read_only_sql`) とは目的も経路も別物で判定
  ロジックを共有しない。`sqlLint.test.ts` が正常 SQL の非検出・未終端/括弧/文頭
  タイポの検出・方言差を固定する。
- `i18n.ts` — 日本語/英語の文字列テーブルと `useT` フック。
- `tabPersistence.ts` — プロファイルごとの開きタブを localStorage に保存/復元。
- `errorHints.ts` — DB エラー文字列を人間向けのヒントに対応付け。
