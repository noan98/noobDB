// 接続テスト結果 (#690) を、設定画面の Callout に出す「色の役割 + 文言キー + 差し込み値」へ
// 変換する純ロジック。認証エラー / ネットワークエラー / 成功 / その他を区別して見せる。

import type { AiConnectionTestResult } from "../api/tauri";
import type { I18nKey } from "../i18n";
import type { SemanticRole } from "../semanticColors";

export interface ConnectionTestView {
  tone: SemanticRole;
  key: I18nKey;
  vars: Record<string, string | number>;
}

export function connectionTestView(r: AiConnectionTestResult): ConnectionTestView {
  switch (r.status) {
    case "success":
      return {
        tone: "success",
        key: "aiTestSuccess",
        vars: { model: r.model ?? "", ms: r.elapsedMs, text: r.message },
      };
    case "authError":
      return { tone: "danger", key: "aiTestAuthError", vars: { message: r.message } };
    case "networkError":
      return { tone: "warning", key: "aiTestNetworkError", vars: { message: r.message } };
    case "refused":
      return { tone: "warning", key: "aiTestRefused", vars: { message: r.message } };
    case "apiError":
      return { tone: "danger", key: "aiTestApiError", vars: { message: r.message } };
  }
}
