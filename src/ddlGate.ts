import { analyzeDangerousSql, analyzeSqliteAttach, isReadOnlySql, type DangerFinding } from "./dangerousSql";
import { resolveTypedConfirmTarget } from "./typeToConfirm";

/**
 * GUI モーダル経由の DDL (拡張機能・ENUM 変更・保守 DDL・名前空間作成など) に掛ける実行ゲートの判定 (#2176)。
 *
 * SQL エディタの実行ゲート (`App.tsx` の `runInTabWithGate`) と同じ条件を純関数に切り出したもの:
 * - 本番 + `confirm_writes` (read-only 接続は除く) または緊急モードのとき、書き込みは毎回承認を求める
 * - 危険文 (DROP / TRUNCATE ほか) は、本番または「危険なクエリを確認」設定が有効なら検出して警告する
 * - 本番の DROP / TRUNCATE は対象名の型入力確認 (#675)
 *
 * どれも UI レベルの誤操作防止で、バックエンドは強制しない (CLAUDE.md の「安全網の強制レベル」参照)。
 */
export interface DdlGateInput {
  sql: string;
  driver: string | undefined;
  isProduction: boolean;
  confirmWrites: boolean;
  readOnly: boolean;
  emergencyMode: boolean;
  /** 設定の「危険なクエリを確認」。本番接続では設定に関わらず検出する。 */
  confirmDangerousQueries: boolean;
  /** 型入力確認の対象名を呼び出し側が確定しているときだけ渡す (省略時は検出結果の対象名)。 */
  destructiveTargets?: readonly string[];
}

export interface DdlGate {
  findings: DangerFinding[];
  isProduction: boolean;
  /** 本番 confirm_writes / 緊急モードによる承認が要るか。 */
  writeApproval: boolean;
  typedConfirmTarget: string | null;
}

/** ゲートが不要 (確認なしで実行してよい) なら null。 */
export function evaluateDdlGate(input: DdlGateInput): DdlGate | null {
  const { sql, driver, isProduction } = input;
  const requireWriteApproval = isProduction && input.confirmWrites && !input.readOnly;
  const findings = [
    ...(isProduction || input.confirmDangerousQueries ? analyzeDangerousSql(sql, driver) : []),
    ...analyzeSqliteAttach(sql, driver),
  ];
  const writeApproval = (requireWriteApproval || input.emergencyMode) && !isReadOnlySql(sql, driver);
  if (findings.length === 0 && !writeApproval) return null;
  const destructive = findings.filter((f) => f.kind === "drop" || f.kind === "truncate");
  const targets = input.destructiveTargets ?? destructive.map((f) => f.target);
  const typedConfirmTarget =
    isProduction && destructive.length > 0 ? resolveTypedConfirmTarget(targets) : null;
  return { findings, isProduction, writeApproval, typedConfirmTarget };
}
