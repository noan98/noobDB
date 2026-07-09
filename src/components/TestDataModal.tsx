import { useEffect, useMemo, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api, type CellValue, type TableColumnInfo } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, Select } from "./ui";
import { Spinner } from "./Spinner";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";
import {
  activeSpecs,
  buildFkSelectSql,
  buildTestDataInsertStatements,
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
 * 投入は既存 IPC の `run_query_transaction` (all-or-nothing) のみで行い、
 * バックエンドの変更はない。読み取り専用セッションはバックエンドが拒否する
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
const FK_CANDIDATE_LIMIT = 1000;
const INSERT_BATCH_SIZE = 100;

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
  const { confirm, dialog: confirmDialog } = useConfirm();

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
    (async () => {
      try {
        const cols: TableColumnInfo[] = await api.describeTable(sessionId, database, table);
        const inferred = cols.map(inferColumnSpec);
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

  // プレビュー: 先頭 PREVIEW_ROWS 行。実投入と同じシード/設定で生成するため、
  // 先頭行はプレビューと完全に一致する (generateRows は決定論的)。
  const previewRows = useMemo(() => {
    if (!specs || insertColumns.length === 0) return [];
    return generateRows(specs, Math.min(PREVIEW_ROWS, Math.max(rowCount, 1)), seed);
  }, [specs, insertColumns.length, rowCount, seed]);

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

  const handleRun = async () => {
    if (!specs || !rowCountValid || insertColumns.length === 0 || running) return;
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
      const rows = generateRows(specs, rowCount, seed);
      const statements = buildTestDataInsertStatements(
        driver,
        database,
        table,
        insertColumns.map((s) => s.column),
        rows,
        INSERT_BATCH_SIZE,
      );
      const result = await api.runQueryTransaction(sessionId, statements, database);
      toast.success(t("testDataSuccess", { count: rowCount, table, ms: result.elapsed_ms }));
      onInserted();
      onClose();
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
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
                  <chakra.span
                    flex="0 0 200px"
                    fontSize="sm"
                    fontFamily="mono"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    title={`${spec.column} (${spec.dataType})`}
                  >
                    {spec.column}
                    <chakra.span color="app.textMuted" ml="1.5" fontSize="2xs">
                      {spec.dataType}
                    </chakra.span>
                  </chakra.span>
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
                    <Input
                      type="number"
                      css={{ width: "100px" }}
                      value={String(spec.serialStart)}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) updateSpec(i, { serialStart: Math.floor(n) });
                      }}
                      disabled={running}
                      title={t("testDataSerialStart")}
                      aria-label={t("testDataSerialStart")}
                    />
                  )}
                  {spec.strategy === "randomString" && (
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
                      title={t("testDataLength")}
                      aria-label={t("testDataLength")}
                    />
                  )}
                  {spec.strategy === "randomNumber" && (
                    <>
                      <Input
                        type="number"
                        css={{ width: "100px" }}
                        value={String(spec.min)}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) updateSpec(i, { min: n });
                        }}
                        disabled={running}
                        title={t("testDataMin")}
                        aria-label={t("testDataMin")}
                      />
                      <Input
                        type="number"
                        css={{ width: "100px" }}
                        value={String(spec.max)}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) updateSpec(i, { max: n });
                        }}
                        disabled={running}
                        title={t("testDataMax")}
                        aria-label={t("testDataMax")}
                      />
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
          disabled={running || !specs || !rowCountValid || insertColumns.length === 0}
        >
          {running ? t("testDataRunning") : t("testDataRun")}
        </LoadingButton>
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}
