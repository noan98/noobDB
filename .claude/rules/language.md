# 言語ポリシー

noobDB リポジトリで Claude Code が守る言語ルール。**例外なく適用**する。

- **ユーザへの応答はすべて日本語で行ってください。** 説明・質問・確認プロンプト・
  ツール実行前の説明・進捗報告・エラー説明・最終サマリーなど、チャットに出力する
  すべての文章を日本語で記述します。これは Claude Code on the web (クラウド実行
  環境) を含む、本リポジトリで Claude Code が動作するすべての状況に適用される、
  例外のないルールです (コード・コマンド・識別子など本来英語で書くべきものは除く)。
- **プルリクエスト (PR) の作成は必ず日本語で行ってください。** PR のタイトル・
  本文・サマリー・テスト計画など、PR に含まれるすべての記述を日本語で記述します。
  これは Claude Code が本リポジトリで PR を作成するすべての状況に適用される、
  例外のないルールです。

## 強制のしくみ (`.claude/settings.json`)

CLAUDE.md / 本ファイルの記述だけでは「指示」にとどまり、長いセッションや
`/compact` 後にポリシーが薄まって英語で応答が返ることがあります。そのため、
リポジトリ直下の `.claude/settings.json` (コミット対象 = チーム全員に適用) で
2 段構えの固定を行っています。

| 設定 | 役割 |
|---|---|
| `"language": "japanese"` | Claude Code 本体の言語設定。応答言語と音声ディクテーションの既定言語を日本語にする。 |
| `UserPromptSubmit` フック | `.claude/hooks/enforce-japanese.sh` を毎ターン実行し、言語ポリシーを `additionalContext` としてモデルのコンテキストへ注入する。compact をまたいでもポリシーが残る。 |

フックスクリプトは stdin のフック入力 JSON を読み捨て、以下の形の JSON を
標準出力に返すだけの薄いものです (`suppressOutput: true` なのでトランスクリプト
には出力されません)。

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  },
  "suppressOutput": true
}
```

注意点:

- **`.claude/settings.json` を編集した直後のセッションには反映されません。**
  Claude Code は設定ファイルをセッション開始時に読み込むため、`/hooks` を一度
  開く (設定が再読み込みされる) か、セッションを再起動してください。
- 個人用の上書きは `.claude/settings.local.json` (gitignore 済み) に書きます。
  設定の優先順位は user → project → local の順で、後のものが勝ちます。
- 動作確認は次のコマンドで行えます (フックと同じ入力を手で流し込む)。

  ```sh
  echo '{}' | bash .claude/hooks/enforce-japanese.sh | jq .
  ```
