import { useCallback, useEffect, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { DangerFinding, DangerKind } from "../dangerousSql";
import { typedConfirmMatches } from "../typeToConfirm";
import { semanticColorToken } from "../semanticColors";
import { AiImpactAnalysis } from "./AiImpactAnalysis";
import { Callout } from "./Callout";
import { RefImpactList } from "./RefImpactList";
import type { CascadeImpacts } from "../refImpact";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input } from "./ui";
import { api } from "../api/tauri";
import { useRowSample } from "../useRowSample";
import { RowSampleTable } from "./RowSampleTable";
import { PREFLIGHT_SAMPLE_ROWS } from "./preflight";

interface Props {
  findings: DangerFinding[];
  isProduction: boolean;
  /**
   * True when the dialog was opened solely because the production connection
   * requires approval for any data-modifying statement (not because a specific
   * destructive pattern was detected). Drives a generic message when `findings`
   * is empty.
   */
  writeApproval?: boolean;
  /**
   * When set, this is an irreversible DROP/TRUNCATE on a production
   * connection: the confirm button stays disabled until the user types this
   * text exactly (the table name when it could be resolved unambiguously,
   * otherwise `TYPE_TO_CONFIRM_FALLBACK`). Null/undefined skips the extra
   * gate — non-production connections keep the existing one-click confirm.
   * A UI safety net only (#675), not backend-enforced.
   */
  typedConfirmTarget?: string | null;
  /**
   * 影響行数プリフライト (#737) から引き継いだ件数。エディタの現在文が単純な
   * UPDATE / DELETE のとき、実行前の推定影響行数を「約 N 行が削除/更新されます」と
   * 併記する。null のときは何も出さない。
   */
  impact?: PreflightImpact | null;
  /**
   * AI 影響分析 (#694) に必要な接続コンテキスト。渡されたときだけ「影響を AI で分析」を
   * 出す (AI 無効 / キー未設定のときは AiImpactAnalysis 側が設定へ案内するリンクだけを描く)。
   * UX ガードであり、バックエンド強制ではない。
   */
  aiContext?: {
    sessionId: string;
    /** `mysql` / `postgres` / `sqlite`。 */
    driver: string;
    database: string | null;
    sql: string;
  } | null;
  /**
   * WHERE なしの UPDATE / DELETE に添える「主キーで絞る」提案 (#1626)。`template` は `WHERE id = ` のような
   * 雛形で、`onInsert` を押すとダイアログを閉じ (実行はしない)、エディタの文の末尾へ雛形を挿入する。
   * 判定ロジックは変えず、止めるだけでなく安全な書き方を示すための追加。
   */
  pkSuggestion?: { template: string; onInsert: () => void } | null;
  /**
   * エディタの単一表 DELETE が消す行を参照している子行への影響 (CASCADE / RESTRICT / SET NULL、#1767)。
   * 渡されたときだけ、ダイアログを開いた時点で `load` を 1 回呼んで確認欄を出す。読み取り専用の集計で、
   * 失敗・タイムアウトしても実行は妨げず「確認できませんでした」と表示する。
   */
  fkImpact?: { driver: string; load: () => Promise<CascadeImpacts> } | null;
  /**
   * 影響行のプレビュー (#1881)。件数だけでなく実際にどの行が変わる/消えるかを、確認ダイアログ内の小さな表で
   * 見せる。`sampleSql` はプリフライトの `buildPreflightSampleSql` と同じ対象・WHERE の読み取り専用 SELECT で、
   * `run_lookup_query` (read_only でも動き、履歴を汚さない) で取得する。`setColumns` は UPDATE の SET 対象列。
   * UX ガードであり、バックエンド強制ではない。
   */
  rowPreview?: {
    sessionId: string;
    database: string | null;
    sampleSql: string;
    verb: "update" | "delete";
    /** プリフライトで確定した影響行数 (表示の「全 N 行中」に使う)。 */
    total: number | null;
    setColumns: readonly string[];
  } | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface PreflightImpact {
  verb: "update" | "delete";
  /** 影響行数 (COUNT 結果)。全行だが件数未取得のときは null。 */
  count: number | null;
  /** WHERE なし = テーブル全行が対象。 */
  allRows: boolean;
}

const KIND_LABEL_KEYS: Record<DangerKind, Parameters<ReturnType<typeof useT>>[0]> = {
  deleteNoWhere: "dangerousKindDeleteNoWhere",
  updateNoWhere: "dangerousKindUpdateNoWhere",
  drop: "dangerousKindDrop",
  truncate: "dangerousKindTruncate",
  dropColumn: "dangerousKindDropColumn",
  dropConstraint: "dangerousKindDropConstraint",
};

export function DangerousQueryDialog({
  findings,
  isProduction,
  writeApproval,
  typedConfirmTarget,
  impact,
  aiContext,
  pkSuggestion,
  fkImpact,
  rowPreview,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT();
  // 注意: 別接続で実行する読み取りなので、明示トランザクション中の未コミットの変更は見えない。
  // 重いテーブルで確認を待たせないよう 5 秒で打ち切る (失敗はエラー表示になるだけで、実行ボタンは有効のまま)。
  const previewSession = rowPreview?.sessionId ?? null;
  const previewDb = rowPreview?.database ?? null;
  const previewRun = useCallback(
    (sql: string, rowCap: number) =>
      previewSession
        ? api.runLookupQuery({
            sessionId: previewSession,
            sql,
            database: previewDb,
            rowCap,
            queryTimeoutSecs: 5,
          })
        : Promise.reject(new Error("no preview")),
    [previewSession, previewDb],
  );
  const previewState = useRowSample(
    previewRun,
    rowPreview?.sampleSql ?? null,
    PREFLIGHT_SAMPLE_ROWS,
    !!rowPreview,
  );
  const [fkState, setFkState] = useState<
    { status: "loading" } | { status: "failed" } | { status: "ready"; result: CascadeImpacts } | null
  >(fkImpact ? { status: "loading" } : null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ダイアログを開いた時点の 1 回だけ集計する (load は毎描画で作り直される)
  useEffect(() => {
    if (!fkImpact) return;
    let alive = true;
    fkImpact
      .load()
      .then((result) => alive && setFkState({ status: "ready", result }))
      .catch(() => alive && setFkState({ status: "failed" }));
    return () => {
      alive = false;
    };
  }, []);
  // Default focus to Cancel so a stray Enter doesn't run the query — unless a
  // typed confirmation is required, in which case the user needs to type
  // into the input anyway, so focus starts there.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const typedInputRef = useRef<HTMLInputElement>(null);
  const [typedValue, setTypedValue] = useState("");
  const requiresTyped = !!typedConfirmTarget;
  const typedMatches = !requiresTyped || typedConfirmMatches(typedValue, typedConfirmTarget);
  // 同一インスタンスを使い回す呼び出し側でも、対象が変わったら前回入力を
  // 持ち越さない (安全網の入力欄が汚染されないようにする)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 確認対象が変わったら入力を捨てるトリガ依存 (effect 内では参照しない)
  useEffect(() => {
    setTypedValue("");
  }, [typedConfirmTarget]);

  return (
    <Modal
      // no-submit: 危険クエリの確認。実行は明示的なクリック / フォーカス移動に限る
      width="640px"
      onClose={onCancel}
      initialFocusEl={() => (requiresTyped ? typedInputRef.current : cancelRef.current)}
    >
      <ModalHeader onClose={onCancel} closeLabel={t("dangerousCancel")}>
        {t("dangerousTitle")}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="3">
        {isProduction && (
          // 意味色「danger」の状態バナー (#664 / #1145)。以前はボタン専用の
          // `app.dangerBg`/`app.dangerFg` (ライト/ダーク 2 値のみでテーマ
          // プリセットに追従しない) をベタ塗り背景に転用していた。
          <Callout tone="danger" icon="production" fontWeight={600}>
            {t("dangerousProductionNote")}
          </Callout>
        )}
        {findings.length > 0 ? (
          <>
            <chakra.p m={0} color="app.text">
              {t("dangerousIntro")}
            </chakra.p>
            <chakra.ul m={0} p={0} listStyleType="none" display="flex" flexDirection="column" gap="2">
              {findings.map((f, idx) => (
                <chakra.li
                  key={idx}
                  display="flex"
                  flexDirection="column"
                  gap="0.5"
                  py="2"
                  px="2.5"
                  border="1px solid"
                  borderColor="app.border"
                  borderLeft="3px solid"
                  borderLeftColor={semanticColorToken("danger", "solid")}
                  borderRadius="md"
                  bg="app.toolbar"
                >
                  <chakra.span textStyle="subheading">{t(KIND_LABEL_KEYS[f.kind])}</chakra.span>
                  <chakra.span fontSize="sm" color="app.textMuted" fontFamily="mono">
                    {f.target ? t("dangerousTargetTable", { target: f.target }) : t("dangerousTargetUnknown")}
                  </chakra.span>
                </chakra.li>
              ))}
            </chakra.ul>
          </>
        ) : (
          <chakra.p m={0} color="app.text">
            {t(
              writeApproval
                ? "dangerousWriteApprovalIntro"
                : fkImpact
                  ? "dangerousFkIntro"
                  : "dangerousIntro",
            )}
          </chakra.p>
        )}
        {impact && (impact.count !== null || impact.allRows) && (
          // プリフライトの影響行数を「約 N 行が削除/更新されます」と併記する (#737)。
          // 全行 (WHERE なし) は危険色バナーで一段強調する。
          <Callout tone={impact.allRows ? "danger" : "warning"}>
            {impact.count !== null && (
              <chakra.span display="block" fontWeight={600}>
                {t(impact.verb === "delete" ? "dangerousImpactDelete" : "dangerousImpactUpdate", {
                  count: impact.count.toLocaleString(),
                })}
              </chakra.span>
            )}
            {impact.allRows && <chakra.span display="block">{t("dangerousImpactAllRows")}</chakra.span>}
            <chakra.span display="block" color="app.textMuted">
              {t("dangerousImpactNote")}
            </chakra.span>
          </Callout>
        )}
        {rowPreview && (
          // 影響行のプレビュー (#1881)。取得に失敗しても実行は妨げない (エラー文だけ出る)。
          <chakra.div display="flex" flexDirection="column" gap="1.5" data-testid="dangerous-row-preview">
            <chakra.span textStyle="subheading">
              {t(rowPreview.verb === "delete" ? "dangerousRowPreviewDelete" : "dangerousRowPreviewUpdate", {
                shown:
                  rowPreview.total !== null
                    ? Math.min(rowPreview.total, PREFLIGHT_SAMPLE_ROWS).toLocaleString()
                    : PREFLIGHT_SAMPLE_ROWS.toLocaleString(),
                total: rowPreview.total !== null ? rowPreview.total.toLocaleString() : "?",
              })}
            </chakra.span>
            <RowSampleTable
              state={previewState}
              label={t(
                rowPreview.verb === "delete" ? "dangerousRowPreviewDelete" : "dangerousRowPreviewUpdate",
                {
                  shown: PREFLIGHT_SAMPLE_ROWS.toLocaleString(),
                  total: rowPreview.total !== null ? rowPreview.total.toLocaleString() : "?",
                },
              )}
              testId="dangerous-row-preview-table"
              highlightColumns={rowPreview.verb === "update" ? rowPreview.setColumns : undefined}
            />
            {rowPreview.verb === "update" && rowPreview.setColumns.length > 0 && (
              <chakra.span color="app.textMuted" textStyle="caption">
                {t("dangerousRowPreviewSetCols", { columns: rowPreview.setColumns.join(", ") })}
              </chakra.span>
            )}
          </chakra.div>
        )}
        {fkImpact && fkState?.status === "loading" && (
          <Callout tone="info" role="status" data-testid="dangerous-fk-loading">
            {t("statusCheckingRefs")}
          </Callout>
        )}
        {fkImpact && fkState?.status === "failed" && (
          <Callout tone="warning" role="status" data-testid="dangerous-fk-failed">
            {t("refImpactCheckFailed")}
          </Callout>
        )}
        {fkImpact && fkState?.status === "ready" && (
          <RefImpactList
            impacts={fkState.result.impacts}
            mode="rows"
            driver={fkImpact.driver}
            moreCascade={fkState.result.moreCascade}
            unverified={fkState.result.unverified.length > 0 ? fkState.result.unverified : undefined}
          />
        )}
        {pkSuggestion && (
          <Callout tone="info" data-testid="dangerous-pk-suggestion">
            <chakra.span display="block" fontWeight={600}>
              {t("dangerousPkSuggestTitle")}
            </chakra.span>
            <chakra.span display="block" fontFamily="mono" my="1">
              {pkSuggestion.template}
            </chakra.span>
            <Button type="button" variant="secondary" size="sm" onClick={pkSuggestion.onInsert}>
              {t("dangerousPkSuggestInsert")}
            </Button>
          </Callout>
        )}
        {aiContext && (
          // オンデマンドの AI 影響分析 (#694)。分析中も下の実行 / キャンセルは押せる。
          <AiImpactAnalysis
            sessionId={aiContext.sessionId}
            driver={aiContext.driver}
            database={aiContext.database}
            sql={aiContext.sql}
            findings={findings}
            isProduction={isProduction}
            preflight={impact ?? null}
          />
        )}
        {requiresTyped && (
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <chakra.label htmlFor="dangerous-type-confirm-input" textStyle="subheading">
              {t("typeToConfirmLabel", { target: typedConfirmTarget })}
            </chakra.label>
            <Input
              id="dangerous-type-confirm-input"
              ref={typedInputRef}
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={typedConfirmTarget}
              autoComplete="off"
              spellCheck={false}
            />
          </chakra.div>
        )}
      </ModalBody>

      {/*
        安全側優先レイアウト: 不可逆な「実行」は非強調で左側に置き、安全な
        「キャンセル」を強調色 (primary) で右側 + デフォルトフォーカスにする。
        HIG 各種ガイドラインに倣い、破壊的アクションを視覚的に優位にしない。
        実行側はベタ塗りにせず dangerOutline (枠線 + 危険色文字) にすることで、
        非強調のまま「これは破壊的操作である」ことを色でも伝える。
      */}
      <ModalFooter>
        <Button
          type="button"
          variant="dangerOutline"
          onClick={onConfirm}
          disabled={requiresTyped && !typedMatches}
        >
          {t("dangerousConfirm")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button ref={cancelRef} type="button" variant="primary" onClick={onCancel}>
          {t("dangerousCancel")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
