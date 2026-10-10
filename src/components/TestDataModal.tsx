import { useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type CellValue, type TableColumnInfo } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiStream } from "../ai/useAiStream";
import {
  buildTestDataAiContext,
  buildTestDataPlan,
  buildTestDataPrompt,
  buildTestDataSystem,
  generateAiRows,
  isAiEligible,
  parseTestDataResponse,
  summarizeTestDataSend,
  TEST_DATA_FORMAT,
  TEST_DATA_HINT_MAX,
  resolveUniqueColumns,
  type TestDataAiPlan,
  type UniqueColumnInfo,
} from "../ai/testData";
import { useAiAvailable } from "../ai/useAiAvailable";
import { useLocale, useT, type I18nKey } from "../i18n";
import { useSettings } from "../settings";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, Select } from "./ui";
import { AiStreamProgress } from "./AiStreamProgress";
import { AiUsageNote } from "./AiUsageNote";
import { Spinner } from "./Spinner";
import { LoadingButton } from "./LoadingButton";
import { Callout } from "./Callout";
import { CodePreview, ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";
import { Tooltip } from "./Tooltip";
import {
  activeSpecs,
  buildFkSelectSql,
  generateRows,
  inferColumnSpec,
  type ColumnGenSpec,
  type GenStrategy,
} from "./testDataGen";

/**
 * スキーマに基づくテストデータ生成ウィザード (#602)。
 *
 * テーブルの `describe_table` からカラムごとの既定生成方針を推定し
 * (`testDataGen.inferColumnSpec`)、行数・シード・カラム別方針を編集のうえ、
 * 先頭数行のプレビューを確認してから投入する。FK カラムは参照先の既存値を
 * `run_query` (SELECT DISTINCT ... LIMIT) で取得してランダム選択し整合性を保つ。
 *
 * 投入は `insert_generated_rows` (#1259、生成行を Rust の `import_rows` へ直接渡す
 * 1 トランザクション = all-or-nothing) で行う。読み取り専用セッションはバックエンドが拒否する
 * (導線もメニュー側で無効化済み)。本番接続 (`is_production`) ではテーブル名の
 * タイプ入力を要求する強確認を挟む (DangerousQueryDialog 系と同じ UX ガード)。
 */
interface Props {
  sessionId: string;
  database: string;
  table: string;
  driver: string;
  /** 本番フラグ。true なら投入前にタイプ確認付きの強確認を挟む。 */
  isProduction: boolean;
  onClose: () => void;
  /** 投入成功後に呼ばれる (開いているテーブルタブの再読込など)。 */
  onInserted: () => void;
}

const MAX_ROWS = 10000;
const PREVIEW_ROWS = 5;
/** AI モードは生成結果の見た目を確認したいので、プレビューを広めに取る。 */
const AI_PREVIEW_ROWS = 20;
const FK_CANDIDATE_LIMIT = 1000;

const STRATEGY_LABEL_KEYS: Record<GenStrategy, I18nKey> = {
  serial: "testDataStrategySerial",
  uuid: "testDataStrategyUuid",
  randomNumber: "testDataStrategyRandomNumber",
  randomString: "testDataStrategyRandomString",
  randomDate: "testDataStrategyRandomDate",
  randomBool: "testDataStrategyRandomBool",
  fixed: "testDataStrategyFixed",
  choice: "testDataStrategyChoice",
  fkRef: "testDataStrategyFkRef",
  omit: "testDataStrategyOmit",
};

/** そのカラムで選択できる戦略。choice / fkRef は候補源があるときだけ出す。 */
function strategyOptions(spec: ColumnGenSpec): GenStrategy[] {
  const opts: GenStrategy[] = [
    "serial",
    "uuid",
    "randomNumber",
    "randomString",
    "randomDate",
    "randomBool",
    "fixed",
  ];
  if (spec.kind === "enum") opts.push("choice");
  if (spec.fkTable && spec.fkColumn) opts.push("fkRef");
  opts.push("omit");
  return opts;
}

type AiState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "raw"; raw: string }
  | { kind: "error"; message: string; refused: boolean }
  | { kind: "cancelled" };

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

export function TestDataModal({
  sessionId,
  database,
  table,
  driver,
  isProduction,
  onClose,
  onInserted,
}: Props) {
  const t = useT();
  const toast = useToast();
  const locale = useLocale();
  const aiSettings = useSettings().ai;
  const aiAvailable = useAiAvailable();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [mode, setMode] = useState<"rule" | "ai">("rule");
  const [cols, setCols] = useState<TableColumnInfo[] | null>(null);
  const [uniqueInfo, setUniqueInfo] = useState<UniqueColumnInfo>({ columns: [], composite: [] });
  const [hints, setHints] = useState<Record<string, string>>({});
  const [aiState, setAiState] = useState<AiState>({ kind: "idle" });
  const [plan, setPlan] = useState<TestDataAiPlan | null>(null);
  const stream = useAiStream({ idPrefix: "ai_testdata" });
  // AI が使えない状態 (無効化・キー削除) では必ずルールベースとして扱う。
  const aiMode = aiAvailable && mode === "ai";
  const aiRunning = aiState.kind === "running";

  const [specs, setSpecs] = useState<ColumnGenSpec[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowCountText, setRowCountText] = useState("100");
  const [seed, setSeed] = useState<number>(() => randomSeed());
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // カラム定義を取得して既定方針を推定し、FK カラムは参照先の既存値を
  // ベストエフォートで読み込む (失敗/空でも開ける — その列は NULL 生成になり、
  // 警告ヒントで気付ける)。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [described, indexes] = await Promise.all([
          api.describeTable(sessionId, database, table),
          // describe_table の key は MySQL の UNI しか持たないため、PG / SQLite の UNIQUE index は
          // インデックス一覧から補う (取れなくても開ける)。
          api.listIndexes(sessionId, database, table).catch(() => []),
        ]);
        if (!cancelled) {
          setCols(described);
          setUniqueInfo(resolveUniqueColumns(described, indexes));
        }
        const inferred = described.map(inferColumnSpec);
        const withFk = await Promise.all(
          inferred.map(async (spec) => {
            if (spec.strategy !== "fkRef" || !spec.fkTable || !spec.fkColumn) return spec;
            try {
              const res = await api.runQuery(
                sessionId,
                buildFkSelectSql(driver, database, spec.fkTable, spec.fkColumn, FK_CANDIDATE_LIMIT),
                database,
              );
              const choices: CellValue[] = res.rows.map((r) => r[0]).filter((v) => v !== null);
              return { ...spec, choices };
            } catch {
              return spec; // 候補ゼロのまま (NULL 生成 + 警告表示)。
            }
          }),
        );
        if (!cancelled) setSpecs(withFk);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table, driver]);

  const rowCount = useMemo(() => {
    const n = Number(rowCountText);
    if (!Number.isFinite(n)) return 0;
    return Math.floor(n);
  }, [rowCountText]);
  const rowCountValid = rowCount >= 1 && rowCount <= MAX_ROWS;

  const insertColumns = useMemo(() => (specs ? activeSpecs(specs) : []), [specs]);

  const aiContext = useMemo(
    () => (cols && specs ? buildTestDataAiContext(cols, specs, hints, uniqueInfo.columns) : null),
    [cols, specs, hints, uniqueInfo],
  );
  const aiDataset = useMemo(() => {
    if (!aiMode || !plan || !specs || !cols || !rowCountValid) return null;
    return generateAiRows({ specs, plan, uniqueColumns: uniqueInfo.columns, count: rowCount }, seed);
  }, [aiMode, plan, specs, cols, rowCountValid, rowCount, seed, uniqueInfo]);

  // プレビュー: 先頭 PREVIEW_ROWS 行。実投入と同じシード/設定で生成するため、
  // 先頭行はプレビューと完全に一致する (generateRows は決定論的)。
  const previewRows = useMemo(() => {
    if (aiMode) return aiDataset ? aiDataset.rows.slice(0, AI_PREVIEW_ROWS) : [];
    if (!specs || insertColumns.length === 0) return [];
    return generateRows(specs, Math.min(PREVIEW_ROWS, Math.max(rowCount, 1)), seed);
  }, [aiMode, aiDataset, specs, insertColumns.length, rowCount, seed]);

  const fkEmptyColumns = useMemo(
    () => (specs ?? []).filter((s) => s.strategy === "fkRef" && s.choices.length === 0),
    [specs],
  );

  const updateSpec = (index: number, patch: Partial<ColumnGenSpec>) => {
    setSpecs((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next[index] = { ...next[index], ...patch };
      return next;
    });
  };

  const aiSends = useMemo(
    () => (aiContext ? summarizeTestDataSend(table, aiContext, rowCount, locale) : null),
    [aiContext, table, rowCount, locale],
  );
  const aiSendsLine = aiSends
    ? t("testDataAiSends", {
        table: aiSends.table,
        columns: aiSends.columns,
        fks: aiSends.foreignKeys,
        rows: aiSends.rows,
        locale: aiSends.locale === "ja" ? t("testDataAiLocaleJa") : t("testDataAiLocaleEn"),
      })
    : null;
  const canAiGenerate =
    aiMode && !!aiContext && aiContext.columns.length > 0 && rowCountValid && !aiRunning && !running;

  const generateWithAi = async () => {
    if (!canAiGenerate || !aiContext) return;
    // 二重実行 (連打・Cmd+Enter の連続) で 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await generateWithAiInner(aiContext);
    } catch (e) {
      stream.release();
      setAiState({ kind: "error", message: String(e), refused: false });
    }
  };

  const generateWithAiInner = async (context: NonNullable<typeof aiContext>) => {
    if (isProduction) {
      const ok = await confirm({
        title: t("testDataAiConfirmTitle"),
        message: (
          <>
            <chakra.p m={0}>{t("testDataAiConfirmBody")}</chakra.p>
            <chakra.p m={0} mt="2" color="app.textMuted">
              {aiSendsLine ?? ""}
            </chakra.p>
          </>
        ),
        confirmLabel: t("testDataAiConfirmSend"),
        tone: "warning",
      });
      if (!ok) {
        stream.release();
        return;
      }
    }
    setAiState({ kind: "running" });
    await stream.start(
      {
        task: "testData",
        system: buildTestDataSystem({ driver, table, rowCount, locale, context }),
        prompt: buildTestDataPrompt(table, rowCount),
        settings: toAiSnapshot(aiSettings),
        format: TEST_DATA_FORMAT,
      },
      {
        parse: parseTestDataResponse,
        onDone: ({ parsed }) => {
          if (parsed.ok) {
            setPlan(buildTestDataPlan(parsed.value, context.columns));
            setAiState({ kind: "idle" });
          } else {
            setAiState({ kind: "raw", raw: parsed.raw });
          }
        },
        onError: (f) => setAiState({ kind: "error", message: f.message, refused: f.refused }),
        onCancelled: () => setAiState({ kind: "cancelled" }),
      },
    );
  };

  const handleRun = async () => {
    if (!specs || !rowCountValid || insertColumns.length === 0 || running || aiRunning) return;
    if (aiMode && !aiDataset) return;
    setRunError(null);
    // 本番接続では対象テーブル名のタイプ入力を要求する強確認 (#675 と同じ流儀)。
    if (isProduction) {
      const ok = await confirm({
        title: t("testDataProductionConfirmTitle", { table }),
        message: t("testDataProductionConfirmBody", { count: rowCount, table }),
        confirmLabel: t("testDataRun"),
        tone: "danger",
        typedConfirmation: table,
      });
      if (!ok) return;
    }
    setRunning(true);
    try {
      const rows = aiMode && aiDataset ? aiDataset.rows : generateRows(specs, rowCount, seed);
      // 生成行を Rust の `insert_generated_rows` (`Connection::import_rows`、1 トランザクション)
      // へそのまま渡す。100 行ずつのリテラル INSERT 文を JS で組み立てて送る経路は廃止 (#1259)。
      const result = await api.insertGeneratedRows({
        sessionId,
        database,
        table,
        columns: insertColumns.map((s) => s.column),
        rows,
      });
      toast.success(t("testDataSuccess", { count: rowCount, table, ms: result.elapsed_ms }));
      onInserted();
      onClose();
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const insertDisabled =
    running ||
    aiRunning ||
    !specs ||
    !rowCountValid ||
    insertColumns.length === 0 ||
    (aiMode && !aiDataset);

  return (
    <Modal
      onSubmit={handleRun}
      submitDisabled={insertDisabled}
      width="760px"
      onClose={onClose}
      closeOnInteractOutside={!running}
      closeOnEscape={!running}
    >
      <ModalHeader onClose={onClose} closeLabel={t("testDataClose")} closeDisabled={running}>
        {t("testDataTitle", { table })}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.p fontSize="xs" color="app.textMuted" m={0}>
          {t("testDataHint")}
        </chakra.p>

        {aiAvailable && (
          <FormSection>
            <FieldLabel htmlFor="testdata-mode">{t("testDataModeLabel")}</FieldLabel>
            <Select
              id="testdata-mode"
              maxW="260px"
              value={mode}
              onChange={(e) => setMode(e.target.value === "ai" ? "ai" : "rule")}
              disabled={running || aiRunning}
            >
              <option value="rule">{t("testDataModeRule")}</option>
              <option value="ai">{t("testDataModeAi")}</option>
            </Select>
          </FormSection>
        )}

        <FormSection flexDirection="row" flexWrap="wrap" gap="3.5" alignItems="flex-end">
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <FieldLabel htmlFor="testdata-rows">{t("testDataRowCount")}</FieldLabel>
            <Input
              id="testdata-rows"
              type="number"
              min={1}
              max={MAX_ROWS}
              css={{ width: "120px" }}
              value={rowCountText}
              onChange={(e) => setRowCountText(e.target.value)}
              disabled={running}
              aria-invalid={!rowCountValid}
            />
          </chakra.div>
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <FieldLabel htmlFor="testdata-seed">{t("testDataSeed")}</FieldLabel>
            <Input
              id="testdata-seed"
              type="number"
              css={{ width: "160px" }}
              value={String(seed)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setSeed(Math.floor(n));
              }}
              disabled={running}
            />
          </chakra.div>
          <Button type="button" onClick={() => setSeed(randomSeed())} disabled={running}>
            {t("testDataReseed")}
          </Button>
        </FormSection>

        {!rowCountValid && (
          <ErrorNote>{t("testDataRowCountInvalid", { max: MAX_ROWS })}</ErrorNote>
        )}
        {loadError && <ErrorNote>{loadError}</ErrorNote>}
        {!specs && !loadError && (
          <chakra.div display="inline-flex" alignItems="center" gap="1.5" color="app.textMuted">
            <Spinner size={13} />
            {t("testDataLoading")}
          </chakra.div>
        )}

        {specs && (
          <FormSection>
            <FieldLabel as="div">{t("testDataColumnsTitle")}</FieldLabel>
            <chakra.div display="flex" flexDirection="column" gap="2">
              {specs.map((spec, i) => (
                <chakra.div key={spec.column} display="flex" alignItems="center" gap="2" flexWrap="wrap">
                  <Tooltip label={`${spec.column} (${spec.dataType})`} focusableWrapper>
                    <chakra.span
                      flex="0 0 200px"
                      fontSize="sm"
                      fontFamily="mono"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                    >
                      {spec.column}
                      <chakra.span color="app.textMuted" ml="1.5" fontSize="2xs">
                        {spec.dataType}
                      </chakra.span>
                    </chakra.span>
                  </Tooltip>
                  <Select
                    minW="180px"
                    value={spec.strategy}
                    onChange={(e) => updateSpec(i, { strategy: e.target.value as GenStrategy })}
                    disabled={running}
                    aria-label={t("testDataStrategyAria", { column: spec.column })}
                  >
                    {strategyOptions(spec).map((s) => (
                      <option key={s} value={s}>
                        {t(STRATEGY_LABEL_KEYS[s])}
                      </option>
                    ))}
                  </Select>
                  {spec.strategy === "fixed" && (
                    <Input
                      css={{ width: "140px" }}
                      value={spec.fixedValue}
                      onChange={(e) => updateSpec(i, { fixedValue: e.target.value })}
                      disabled={running}
                      placeholder={t("testDataFixedValue")}
                      aria-label={t("testDataFixedValue")}
                    />
                  )}
                  {spec.strategy === "serial" && (
                    <Tooltip label={t("testDataSerialStart")} focusableWrapper={running}>
                      <Input
                        type="number"
                        css={{ width: "100px" }}
                        value={String(spec.serialStart)}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) updateSpec(i, { serialStart: Math.floor(n) });
                        }}
                        disabled={running}
                        aria-label={t("testDataSerialStart")}
                      />
                    </Tooltip>
                  )}
                  {spec.strategy === "randomString" && (
                    <Tooltip label={t("testDataLength")} focusableWrapper={running}>
                      <Input
                        type="number"
                        min={1}
                        css={{ width: "90px" }}
                        value={String(spec.length)}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n >= 1) updateSpec(i, { length: Math.floor(n) });
                        }}
                        disabled={running}
                        aria-label={t("testDataLength")}
                      />
                    </Tooltip>
                  )}
                  {spec.strategy === "randomNumber" && (
                    <>
                      <Tooltip label={t("testDataMin")} focusableWrapper={running}>
                        <Input
                          type="number"
                          css={{ width: "100px" }}
                          value={String(spec.min)}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n)) updateSpec(i, { min: n });
                          }}
                          disabled={running}
                          aria-label={t("testDataMin")}
                        />
                      </Tooltip>
                      <Tooltip label={t("testDataMax")} focusableWrapper={running}>
                        <Input
                          type="number"
                          css={{ width: "100px" }}
                          value={String(spec.max)}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n)) updateSpec(i, { max: n });
                          }}
                          disabled={running}
                          aria-label={t("testDataMax")}
                        />
                      </Tooltip>
                    </>
                  )}
                  {spec.nullable && spec.strategy !== "omit" && (
                    <chakra.label display="inline-flex" alignItems="center" gap="1" fontSize="xs" color="app.textMuted">
                      {t("testDataNullRate")}
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        css={{ width: "72px" }}
                        value={String(Math.round(spec.nullRate * 100))}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) {
                            updateSpec(i, { nullRate: Math.min(100, Math.max(0, n)) / 100 });
                          }
                        }}
                        disabled={running}
                        aria-label={t("testDataNullRateAria", { column: spec.column })}
                      />
                    </chakra.label>
                  )}
                  {aiMode && isAiEligible(spec) && (
                    <Input
                      css={{ width: "200px" }}
                      value={hints[spec.column] ?? ""}
                      maxLength={TEST_DATA_HINT_MAX}
                      onChange={(e) => setHints((prev) => ({ ...prev, [spec.column]: e.target.value }))}
                      disabled={running || aiRunning}
                      placeholder={t("testDataAiHintPlaceholder")}
                      aria-label={t("testDataAiHintAria", { column: spec.column })}
                    />
                  )}
                  {spec.strategy === "fkRef" && (
                    <chakra.span fontSize="2xs" color="app.textMuted">
                      {t("testDataFkSource", {
                        table: spec.fkTable ?? "",
                        column: spec.fkColumn ?? "",
                        count: spec.choices.length,
                      })}
                    </chakra.span>
                  )}
                </chakra.div>
              ))}
            </chakra.div>
          </FormSection>
        )}

        {aiMode && specs && (
          <FormSection data-testid="testdata-ai-panel">
            <chakra.p fontSize="xs" color="app.textMuted" m={0}>
              {t("testDataAiHint")}
            </chakra.p>
            {aiContext && aiContext.columns.length === 0 && (
              <Callout tone="warning" role="status">
                {t("testDataAiNoTarget")}
              </Callout>
            )}
            {aiSendsLine && (
              <chakra.span color="app.textMuted" fontSize="xs" data-testid="testdata-ai-sends">
                {aiSendsLine}
              </chakra.span>
            )}
            {aiState.kind === "running" && (
              <Flex align="center" gap="2" fontSize="sm" wrap="wrap">
                <AiStreamProgress stream={stream} previewText={false} waitingLabel={t("testDataAiRunning")} />
                <Button type="button" variant="secondary" size="sm" onClick={stream.cancel}>
                  {t("testDataAiCancel")}
                </Button>
              </Flex>
            )}
            <AiUsageNote event={stream.done} />
            {aiState.kind === "raw" && (
              <Flex direction="column" gap="1">
                <ErrorNote role="alert">{t("testDataAiParseError")}</ErrorNote>
                <CodePreview wrap maxH="160px">
                  {aiState.raw}
                </CodePreview>
              </Flex>
            )}
            {aiState.kind === "error" &&
              (aiState.refused ? (
                <Callout tone="warning" role="alert">
                  {t("testDataAiRefused", { message: aiState.message })}
                </Callout>
              ) : (
                <ErrorNote role="alert">{t("testDataAiError", { message: aiState.message })}</ErrorNote>
              ))}
            {aiState.kind === "cancelled" && (
              <Callout tone="info" role="status">
                {t("testDataAiCancelled")}
              </Callout>
            )}
            {uniqueInfo.composite.length > 0 && (
              <Callout tone="warning" role="status">
                {t("testDataAiWarnComposite", {
                  columns: uniqueInfo.composite.map((c) => `(${c.join(", ")})`).join(" / "),
                })}
              </Callout>
            )}
            {plan && (aiState.kind === "raw" || aiState.kind === "error" || aiState.kind === "cancelled") && (
              <Callout tone="info" role="status">
                {t("testDataAiKeepingPlan")}
              </Callout>
            )}
            {plan && aiState.kind === "idle" && (
              <Callout tone="success" role="status">
                {t("testDataAiPlanReady", { count: Object.keys(plan.columns).length })}
              </Callout>
            )}
            {plan?.warnings.map((w) => (
              <Callout key={w.code} tone="warning" role="status">
                {t(
                  w.code === "unknownColumn"
                    ? "testDataAiWarnUnknown"
                    : w.code === "unusableChoices"
                      ? "testDataAiWarnUnusable"
                      : "testDataAiWarnMisaligned",
                  { columns: w.columns.join(", ") },
                )}
              </Callout>
            ))}
            {plan && plan.rules.length > 0 && (
              <chakra.div fontSize="xs" color="app.textMuted">
                {plan.rules.map((r) => (
                  <chakra.div key={r.columns.join("|")}>
                    {t("testDataAiRule", { columns: r.columns.join(", "), description: r.description })}
                  </chakra.div>
                ))}
              </chakra.div>
            )}
            {!plan && aiState.kind === "idle" && (
              <Callout tone="info" role="status">
                {t("testDataAiNeedPlan")}
              </Callout>
            )}
          </FormSection>
        )}

        {fkEmptyColumns.length > 0 && (
          <chakra.div fontSize="xs" color="app.status.warning">
            {t("testDataFkEmpty", { columns: fkEmptyColumns.map((s) => s.column).join(", ") })}
          </chakra.div>
        )}

        {specs && insertColumns.length === 0 && (
          <ErrorNote>{t("testDataNoColumns")}</ErrorNote>
        )}

        {specs && previewRows.length > 0 && (
          <FormSection>
            <FieldLabel as="div">{t("testDataPreviewTitle", { count: previewRows.length })}</FieldLabel>
            <chakra.div
              overflow="auto"
              maxH="200px"
              border="1px solid"
              borderColor="app.border"
              borderRadius="md"
            >
              <chakra.table
                borderCollapse="collapse"
                fontSize="sm"
                width="max-content"
                minW="100%"
                css={{
                  "& th, & td": {
                    border: "1px solid var(--border)",
                    py: "1",
                    px: "2",
                    textAlign: "left",
                    whiteSpace: "nowrap",
                    maxWidth: "240px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                  "& th": { background: "var(--bg-toolbar)", position: "sticky", top: 0 },
                }}
              >
                <thead>
                  <tr>
                    {insertColumns.map((s) => (
                      <th key={s.column}>{s.column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((v, ci) => (
                        <td key={ci}>
                          {v === null ? (
                            <chakra.span color="app.textMuted">NULL</chakra.span>
                          ) : (
                            String(v)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </chakra.table>
            </chakra.div>
          </FormSection>
        )}

        {running && (
          <chakra.div role="status" aria-live="polite" display="inline-flex" alignItems="center" gap="1.5" color="app.textMuted">
            <Spinner size={13} />
            {t("testDataRunningStatus", { count: rowCount })}
          </chakra.div>
        )}
        {runError && <ErrorNote>{runError}</ErrorNote>}
      </ModalBody>

      <ModalFooter>
        {aiMode && (
          <Button type="button" variant="secondary" onClick={() => void generateWithAi()} disabled={!canAiGenerate}>
            {plan ? t("testDataAiRegenerate") : t("testDataAiGenerate")}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose} disabled={running}>
          {t("testDataClose")}
        </Button>
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={running}
          onClick={handleRun}
          disabled={insertDisabled}
        >
          {running ? t("testDataRunning") : t("testDataRun")}
        </LoadingButton>
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}
