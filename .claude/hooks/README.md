# `.claude/hooks/`

プロジェクト共有の Claude Code フック。設定は `.claude/settings.json`。

## 言語ポリシーの強制 (`enforce-japanese.sh`)

CLAUDE.md / `.claude/rules/language.md` の記述だけでは「指示」にとどまり、長いセッションや
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
