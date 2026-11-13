import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import {
  api,
  type CloneCaptureOptions,
  type CloneColumnRule,
  type CloneRowsOutcome,
  type CloneRowsPreview,
} from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { copyToClipboard } from "./clipboard";
import { useConfirm } from "./ConfirmDialog";
import {
  buildCloneRequest,
  buildCloneRule,
  CLONE_DEFAULT_CHILD_DEPTH,
  CLONE_DEFAULT_CHILD_LIMIT,
  CLONE_MAX_CHILD_DEPTH,
  CLONE_MAX_CHILD_LIMIT,
  cloneBlockers,
  cloneExpressionError,
  cloneKey,
  describeRule,
  keyStatusLabelKey,
  mappingsToTsv,
  type RuleKind,
  upsertRule,
} from "./cloneRows";
import { ListboxSelect } from "./ListboxSelect";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { FieldError, FieldLabel, FormSection } from "./modalForm";
import { Spinner } from "./Spinner";
import { StreamProgressBar } from "./StreamProgressBar";
import { needsWriteConfirm } from "./subsetExtract";
import { useToast } from "./Toast";
import { Button, Input } from "./ui";

/**
 * 行を子レコードごと同じ DB 内に複製する (#2304)。結果グリッドで選んだ行を起点に、子の方向へ
 * 行を集め、複製した行どうしの参照だけを新しいキーへ張り替える (外部への参照は元のまま)。
 * 収集・採番・張り替え・1 トランザクションでの書き込みはバックエンド (`db/clone_rows.rs` /
 * `commands/clone_rows.rs`)。ここは指定の入力・プレビュー (表ごとの件数・主キーの決まり方・衝突)・
 * 列ごとの方針・実行と、旧キー → 新キーの対応表の表示を担う。判定の純ロジックは `cloneRows.ts`。
 */
interface Props {
  sessionId: string;
  database: string | null;
  table: string;
  /** 起点の行の条件 (主キーの IN 条件)。 */
  whereClause: string;
  /** 選んだ行数 (起点の最大行数)。 */
  rootLimit: number;
  /** 書き込み前の確認 (本番・書き込み確認ありの接続) に使う。 */
  profile: { name: string; is_production: boolean; confirm_writes: boolean } | null;
  /** フライトレコーダーの記録設定 (Undo 用)。null ならオフで、記録しない。 */
  capture: CloneCaptureOptions | null;
  /** 新しい親の行がある表を開く。 */
  onOpenTable: (database: string | null, table: string) => void;
  onClose: () => void;
}

type Status = "idle" | "previewing" | "running";

export function CloneRowsModal({
  sessionId,
  database,
  table,
  whereClause,
  rootLimit,
  profile,
  capture,
  onOpenTable,
  onClose,
}: Props) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [childDepth, setChildDepth] = useState(String(CLONE_DEFAULT_CHILD_DEPTH));
  const [childLimit, setChildLimit] = useState(String(CLONE_DEFAULT_CHILD_LIMIT));
  const [rules, setRules] = useState<CloneColumnRule[]>([]);
  const [ruleTable, setRuleTable] = useState("");
  const [ruleColumn, setRuleColumn] = useState("");
  const [ruleKind, setRuleKind] = useState<RuleKind>("expression");
  const [ruleText, setRuleText] = useState("");

  const [preview, setPreview] = useState<CloneRowsPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [outcome, setOutcome] = useState<CloneRowsOutcome | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const request = useMemo(
    () => buildCloneRequest({ sessionId, database, table, whereClause, rootLimit, childDepth, childLimit }),
    [sessionId, database, table, whereClause, rootLimit, childDepth, childLimit],
  );
  const currentKey = cloneKey(request, rules);
  const previewFresh = preview !== null && previewKey !== null && previewKey === currentKey;
  const blockers = useMemo(() => (preview ? cloneBlockers(preview) : []), [preview]);
  const busy = status !== "idle";
  const canRun = previewFresh && preview?.ready === true && !busy && outcome === null && request !== null;

  const runPreview = useCallback(async () => {
    if (!request) return;
    const seq = ++seqRef.current;
    const key = cloneKey(request, rules);
    setStatus("previewing");
    setPreviewError(null);
    try {
      const p = await api.previewCloneRows(request, rules);
      if (unmountedRef.current || seq !== seqRef.current) return;
      setPreview(p);
      setPreviewKey(key);
      if (p.tables.length > 0 && !p.tables.some((x) => x.table === ruleTable)) {
        setRuleTable(p.tables[0]?.table ?? "");
        setRuleColumn("");
      }
    } catch (e) {
      if (unmountedRef.current || seq !== seqRef.current) return;
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!unmountedRef.current && seq === seqRef.current) setStatus("idle");
    }
  }, [request, rules, ruleTable]);

  // 開いたときに 1 回、プレビューを取る (方針が要る表をすぐ見せる)。
  const firstPreviewRef = useRef(false);
  useEffect(() => {
    if (firstPreviewRef.current) return;
    firstPreviewRef.current = true;
    void runPreview();
  }, [runPreview]);

  const run = async () => {
    if (!canRun || !request) return;
    if (profile && needsWriteConfirm(profile)) {
      const ok = await confirm({
        title: t("productionConfirmTitle"),
        message: t("cloneRowsProductionConfirm", { name: profile.name, rows: preview?.totalRows ?? 0 }),
        tone: "warning",
      });
      if (!ok) return;
    }
    const seq = ++seqRef.current;
    setStatus("running");
    setRunError(null);
    try {
      const res = await api.cloneRows(request, rules, capture);
      if (unmountedRef.current || seq !== seqRef.current) return;
      setOutcome(res);
    } catch (e) {
      if (unmountedRef.current || seq !== seqRef.current) return;
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!unmountedRef.current && seq === seqRef.current) setStatus("idle");
    }
  };

  const ruleTableInfo = preview?.tables.find((x) => x.table === ruleTable) ?? null;
  const newRule = buildCloneRule(ruleTable, ruleColumn, ruleKind, ruleText);
  const ruleError = ruleKind === "expression" ? cloneExpressionError(ruleText) : null;
  const addRule = () => {
    if (!newRule) return;
    setRules((rs) => upsertRule(rs, newRule));
    setRuleText("");
  };

  const copyMappings = async () => {
    if (!outcome) return;
    const ok = await copyToClipboard(mappingsToTsv(outcome));
    if (ok) toast.success(t("cloneRowsCopied"));
    else toast.error(t("cloneRowsCopyFailed"));
  };

  const blockerText = (b: (typeof blockers)[number]): string => {
    switch (b.kind) {
      case "empty":
        return t("cloneRowsBlockEmpty");
      case "cycle":
        return t("cloneRowsBlockCycle", { tables: b.tables.join(", ") });
      case "policy":
        return t("cloneRowsBlockPolicy", { table: b.table });
      case "conflict":
        return t("cloneRowsBlockConflict", {
          table: b.table,
          index: b.index,
          columns: b.columns.join(", "),
          rows: b.rows,
        });
    }
  };

  return (
    <Modal
      onSubmit={() => void run()}
      submitDisabled={!canRun}
      submitBusy={status === "running"}
      width="680px"
      onClose={onClose}
      closeOnInteractOutside={status !== "running"}
      closeOnEscape={status !== "running"}
    >
      <ModalHeader onClose={onClose} closeLabel={t("cloneRowsClose")} closeDisabled={status === "running"}>
        {t("cloneRowsTitle")}
      </ModalHeader>
      <StreamProgressBar active={busy} />
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.p textStyle="caption" color="app.textMuted">
          {t("cloneRowsNote")}
        </chakra.p>

        <FormSection>
          <FieldLabel as="div">{t("cloneRowsStart")}</FieldLabel>
          <chakra.span fontFamily="mono" fontSize="md">
            {database ? `${database}.${table}` : table} {t("cloneRowsStartRows", { count: rootLimit })}
          </chakra.span>
        </FormSection>

        <FormSection>
          <Flex gap="3">
            <chakra.div flex="1">
              <FieldLabel htmlFor="clone-depth">{t("cloneRowsDepth")}</FieldLabel>
              <Input
                id="clone-depth"
                value={childDepth}
                onChange={(e) => setChildDepth(e.target.value)}
                disabled={busy || outcome !== null}
                inputMode="numeric"
              />
            </chakra.div>
            <chakra.div flex="1">
              <FieldLabel htmlFor="clone-limit">{t("cloneRowsChildLimit")}</FieldLabel>
              <Input
                id="clone-limit"
                value={childLimit}
                onChange={(e) => setChildLimit(e.target.value)}
                disabled={busy || outcome !== null}
                inputMode="numeric"
              />
            </chakra.div>
          </Flex>
          {request === null && (
            <FieldError>
              {t("cloneRowsInvalidNumber", { depth: CLONE_MAX_CHILD_DEPTH, limit: CLONE_MAX_CHILD_LIMIT })}
            </FieldError>
          )}
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("cloneRowsExternalNote")}
          </chakra.span>
        </FormSection>

        <FormSection>
          <Flex align="center" gap="2">
            <FieldLabel as="div" mb={0}>
              {t("cloneRowsPreviewTitle")}
            </FieldLabel>
            {status === "previewing" && <Spinner size={14} />}
          </Flex>
          {previewError && <FieldError>{t("cloneRowsPreviewError", { error: previewError })}</FieldError>}
          {!previewFresh && preview && !previewError && (
            <Callout tone="info" role="status">
              {t("cloneRowsPreviewStale")}
            </Callout>
          )}
          {preview && (
            <chakra.div
              border="1px solid"
              borderColor="app.border"
              borderRadius="md"
              overflow="hidden"
              data-testid="clone-preview"
            >
              {preview.tables.map((tb, i) => (
                <chakra.div
                  key={tb.table}
                  display="flex"
                  alignItems="baseline"
                  gap="3"
                  px="3"
                  py="1.5"
                  borderBottom={i < preview.tables.length - 1 ? "1px solid" : undefined}
                  borderColor="app.border"
                  fontSize="sm"
                >
                  <chakra.span color="app.textMuted" minW="4">
                    {i + 1}
                  </chakra.span>
                  <chakra.span flex="1" minW="0" fontFamily="mono" wordBreak="break-all">
                    {tb.table}
                  </chakra.span>
                  <chakra.span textStyle="caption" color={tb.needsPolicy ? "app.textError" : "app.textMuted"}>
                    {tb.keyColumns.length === 0
                      ? t("cloneKeyNone")
                      : tb.keyColumns.map((k) => `${k.name}: ${t(keyStatusLabelKey(k.status))}`).join(" / ")}
                  </chakra.span>
                  <chakra.span fontFamily="mono" minW="64px" textAlign="right">
                    {tb.rows}
                  </chakra.span>
                </chakra.div>
              ))}
            </chakra.div>
          )}
          {preview?.warnings.map((w) => (
            <Callout key={JSON.stringify(w)} tone="warning" role="status">
              {w.kind === "childTruncated"
                ? t("subsetWarnChildTruncated", { table: w.table, limit: w.limit })
                : w.kind === "rootTruncated"
                  ? t("subsetWarnRootTruncated", { table: w.table, limit: w.limit })
                  : w.kind === "unresolvedForeignKey"
                    ? t("subsetWarnUnresolved", { table: w.table, constraint: w.constraint })
                    : t("subsetWarnCycle", { tables: w.tables.join(", ") })}
            </Callout>
          ))}
          {preview && preview.tables.some((x) => x.keyColumns.length === 0) && (
            <Callout tone="warning" role="status">
              {t("cloneRowsPreviewNoUndo", {
                tables: preview.tables
                  .filter((x) => x.keyColumns.length === 0)
                  .map((x) => x.table)
                  .join(", "),
              })}
            </Callout>
          )}
          {previewFresh &&
            blockers.map((b) => <FieldError key={JSON.stringify(b)}>{blockerText(b)}</FieldError>)}
        </FormSection>

        {preview && preview.tables.length > 0 && outcome === null && (
          <FormSection>
            <FieldLabel as="div">{t("cloneRowsRulesTitle")}</FieldLabel>
            <chakra.span textStyle="caption" color="app.textMuted">
              {t("cloneRowsRulesHint")}
            </chakra.span>
            <Flex gap="2" wrap="wrap">
              <ListboxSelect
                value={ruleTable}
                options={preview.tables.map((x) => ({ value: x.table, label: x.table }))}
                onChange={(v) => {
                  setRuleTable(v);
                  setRuleColumn("");
                }}
                disabled={busy}
                css={{ flex: "1" }}
                ariaLabel={t("cloneRowsRuleTable")}
              />
              <ListboxSelect
                value={ruleColumn}
                options={(ruleTableInfo?.columns ?? []).map((c) => ({ value: c.name, label: c.name }))}
                onChange={setRuleColumn}
                disabled={busy}
                placeholder={t("cloneRowsRuleColumn")}
                css={{ flex: "1" }}
                ariaLabel={t("cloneRowsRuleColumn")}
              />
              <ListboxSelect
                value={ruleKind}
                options={[
                  { value: "expression", label: t("cloneRowsKindExpression") },
                  { value: "value", label: t("cloneRowsKindValue") },
                  { value: "null", label: t("cloneRowsKindNull") },
                ]}
                onChange={(v) => setRuleKind(v as RuleKind)}
                disabled={busy}
                css={{ flex: "1" }}
                ariaLabel={t("cloneRowsRuleKind")}
              />
            </Flex>
            <Flex gap="2">
              <Input
                value={ruleText}
                onChange={(e) => setRuleText(e.target.value)}
                disabled={busy || ruleKind === "null"}
                placeholder={
                  ruleKind === "expression"
                    ? t("cloneRowsExpressionPlaceholder")
                    : t("cloneRowsValuePlaceholder")
                }
                aria-label={t("cloneRowsRuleValue")}
                fontFamily="mono"
              />
              <Button type="button" variant="secondary" onClick={addRule} disabled={busy || newRule === null}>
                {t("cloneRowsRuleAdd")}
              </Button>
            </Flex>
            {ruleError && <FieldError>{t(ruleError)}</FieldError>}
            {rules.map((r) => (
              <Flex
                key={`${r.table}.${r.column}`}
                align="center"
                gap="2"
                fontSize="sm"
                data-testid="clone-rule"
              >
                <chakra.span fontFamily="mono" flex="1" minW="0" wordBreak="break-all">
                  {r.table}.{r.column} = {describeRule(r)}
                </chakra.span>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setRules((rs) => rs.filter((x) => !(x.table === r.table && x.column === r.column)))
                  }
                  disabled={busy}
                >
                  {t("cloneRowsRuleRemove")}
                </Button>
              </Flex>
            ))}
          </FormSection>
        )}

        {runError && <FieldError>{t("cloneRowsRunError", { error: runError })}</FieldError>}

        {outcome && (
          <chakra.div display="flex" flexDirection="column" gap="2" data-testid="clone-outcome">
            <Callout tone="success" role="status">
              {t("cloneRowsDone", { rows: outcome.totalRows, tables: outcome.tables.length })}
            </Callout>
            {!outcome.captureEnabled ? (
              <Callout tone="warning" role="status">
                {t("cloneRowsCaptureOff")}
              </Callout>
            ) : outcome.declinedTables.length > 0 ? (
              <Callout tone="warning" role="status">
                {t(outcome.recorded > 0 ? "cloneRowsUndoPartial" : "cloneRowsNoUndo", {
                  recorded: outcome.recorded,
                  tables: outcome.declinedTables.join(", "),
                })}
              </Callout>
            ) : (
              <Callout tone="info" role="status">
                {t("cloneRowsUndoHint", { recorded: outcome.recorded })}
              </Callout>
            )}
            <FieldLabel as="div">{t("cloneRowsMappingTitle")}</FieldLabel>
            <chakra.div
              maxH="240px"
              overflowY="auto"
              border="1px solid"
              borderColor="app.border"
              borderRadius="md"
              fontFamily="mono"
              fontSize="sm"
              px="3"
              py="2"
            >
              {outcome.tables.map((tb) => (
                <chakra.div key={tb.table} mb="2">
                  <chakra.div color="app.textMuted">
                    {tb.table} ({tb.rows}){tb.keyColumns.length > 0 ? ` [${tb.keyColumns.join(", ")}]` : ""}
                  </chakra.div>
                  {tb.keyColumns.length === 0 ? (
                    <chakra.div>{t("cloneRowsNoKeyMapping")}</chakra.div>
                  ) : (
                    tb.mappings.map((m) => (
                      <chakra.div key={JSON.stringify(m.oldKey)}>
                        {m.oldKey.join(", ")} → {m.newKey.join(", ")}
                        {m.root ? " *" : ""}
                      </chakra.div>
                    ))
                  )}
                </chakra.div>
              ))}
            </chakra.div>
            <Flex gap="2" justify="flex-end">
              <Button type="button" variant="secondary" onClick={() => void copyMappings()}>
                {t("cloneRowsCopyMapping")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  onOpenTable(database, outcome.rootTable);
                  onClose();
                }}
              >
                {t("cloneRowsOpenParent", { table: outcome.rootTable })}
              </Button>
            </Flex>
          </chakra.div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void runPreview()}
          disabled={busy || request === null || outcome !== null}
        >
          {status === "previewing" ? t("cloneRowsPreviewing") : t("cloneRowsPreviewButton")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose} disabled={status === "running"}>
          {t("cloneRowsClose")}
        </Button>
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={status === "running"}
          onClick={() => void run()}
          disabled={!canRun}
        >
          {status === "running" ? t("cloneRowsRunning") : t("cloneRowsExecute")}
        </LoadingButton>
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}
