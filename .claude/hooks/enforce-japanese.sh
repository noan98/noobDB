#!/usr/bin/env bash
# UserPromptSubmit フック: 応答言語を日本語に固定する (.claude/rules/language.md)。
#
# CLAUDE.md の記述だけだと、長いセッションや /compact 後に指示が薄まって英語で
# 応答が返ることがある。このフックは毎ターン `additionalContext` として言語
# ポリシーをモデルのコンテキストへ注入し、ドリフトを防ぐ。
#
# stdin にはフック入力 JSON が渡ってくるが、この用途では参照しないので読み捨てる。
set -euo pipefail

cat >/dev/null || true

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "【言語ポリシー: 例外なし】ユーザへの応答はすべて日本語で記述すること。説明・質問・確認プロンプト・ツール実行前の説明・進捗報告・エラー説明・最終サマリーを含む、チャットに出力するすべての文章が対象。プルリクエストのタイトル・本文・サマリー・テスト計画も日本語で記述すること。コード・コマンド・識別子・ファイルパスなど、本来英語で書くべきものは除く。詳細は .claude/rules/language.md を参照。"
  },
  "suppressOutput": true
}
JSON
