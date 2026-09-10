# アプリ内自動更新 (#705)

## アプリ内自動更新 (Tauri updater プラグイン統合、#705)

配布した旧バージョンのアプリが、GitHub Releases に上がった新バージョンを検出 →
ダウンロード → 適用 (再起動) までアプリ内で行える仕組みです。Tauri 公式の
`tauri-plugin-updater` (検出/ダウンロード/**署名検証**) と `tauri-plugin-process`
(適用後の `relaunch`) を統合しています。既存の dialog / notification プラグインと
同じく、フロントは Rust コマンドではなく**プラグイン自体の JS API**
(`@tauri-apps/plugin-updater` / `@tauri-apps/plugin-process`) を直接呼ぶため、
`invoke_handler!` へのコマンド追加はありません (`lib.rs` は desktop ターゲット限定の
`#[cfg(desktop)]` ブロックで両プラグインを登録)。

- **フロント構成**: 副作用層 `updater.ts` (プラグイン呼び出し: `getCurrentAppVersion`
  / `checkForAppUpdate` / `installUpdateAndRestart` / `dismissUpdate`) と、純粋な整形層
  `updaterFormat.ts` (`downloadProgressPercent` / `truncateReleaseNotes` /
  `displayVersion`。Vitest 対象) を通知 (`notifications.ts` ⇔ `queryNotify.ts`) と同じ
  方針で分離しています。確認ダイアログ → 承認時のダウンロード/適用という UI フローは
  `components/updatePrompt.tsx` の `confirmAndInstallUpdate` に集約し、起動時チェック
  (`App.tsx`) と設定画面の手動チェック (`SettingsView` の「更新を確認」ボタン + 現在
  バージョン表示) の両方から使います。
- **ユーザ承認制 / ベストエフォート**: 起動時に一度だけ自動チェックし
  (`settings.ts` の `autoUpdateCheckEnabled`、既定オン。オフラインや社内配布向けに
  設定でオフにできる)、更新があっても**ダウンロード・適用・再起動はユーザが確認
  ダイアログで承認したときだけ**行います (勝手に再起動しない)。オフラインや
  マニフェスト取得失敗など**チェック自体の失敗**は起動時は静かに無視し (起動を
  ブロックしない)、手動チェックのみエラーをトーストで知らせます
  (`checkForAppUpdate` は「最新 = null」と「失敗 = throw」を区別)。
- **capabilities**: 最小権限方針を維持し `updater:default` と `process:allow-restart`
  のみ追加 (`capabilities/default.json`)。
- **署名と配布**: `tauri.conf.json` の `bundle.createUpdaterArtifacts: true` で更新用
  成果物 (署名付き) と `latest.json` を生成し、`plugins.updater.pubkey` の**公開鍵**で
  署名を検証します (検証に失敗した更新は適用されません)。`endpoints` は
  `https://github.com/noan98/noobDB/releases/latest/download/latest.json`。**秘密鍵は
  リポジトリや `profiles.json` には置かず** (秘密分離の既存方針)、GitHub Actions の
  Secrets `TAURI_SIGNING_PRIVATE_KEY` (鍵にパスワードを付けた場合は
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) で管理します。`release.yml` のタグビルド
  (`tauri-action`) がこの Secrets を使って署名し `latest.json` を自動アップロード
  します。キャッシュ温めビルド (main push、鍵なし) は `--config` で
  `createUpdaterArtifacts` を false に上書きして署名を要求せずに通します。

> **セットアップ必須 (メンテナ作業)**: リポジトリに現在入っている
> `plugins.updater.pubkey` は**プレースホルダの公開鍵**です。実運用では
> `pnpm tauri signer generate` で鍵ペアを生成し、**公開鍵で
> `tauri.conf.json` の `pubkey` を差し替え**、**秘密鍵を GitHub Actions Secrets
> `TAURI_SIGNING_PRIVATE_KEY` に登録**してください (公開鍵は非秘密なのでコミット
> 可、秘密鍵は絶対にコミットしない)。公開鍵と Secrets の秘密鍵が対でないと、
> 署名検証が通らず更新が適用されません。ターゲットは Windows (NSIS) が最初で、
> macOS / Linux バンドル対応が入ったら同じマニフェストに載ります。
