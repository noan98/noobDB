import { useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import {
  api,
  type IndexInfo,
  type IndexWhatIfOutcome,
  type IndexWhatIfSupport,
  type TableColumnInfo,
} from "../api/tauri";
import { localizedErrorMessage } from "../errorHints";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { extractReferencedTables } from "./investigationBundle";
import {
  buildWhatIfRequest,
  canRunWhatIf,
  toggleWhatIfColumn,
  WHATIF_UNAVAILABLE_KEY,
  whatIfModeSupport,
  type WhatIfFormState,
} from "./indexWhatIf";
import { ListboxSelect } from "./ListboxSelect";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Button, Checkbox, PressableButton, Radio, Textarea } from "./ui";

/**
 * 実行計画のインデックス試算 (#2326)。対象テーブルのインデックスを選んで「無効化した場合」、または
 * 列を選んで「追加した場合」の計画を、本番の構造を変えずに取る。結果は呼び出し側が
 * `PlanCompareModal` で今の計画と並べる。
 *
 * 置き場は Modal: 条件を選んで 1 回試算し、結果の比較へ進むだけの短い作業のため
 * (`.claude/rules/ui-design-system.md` §7.1)。使える方法・ロックの有無・使えない理由は
 * バックエンド (`get_index_whatif_support`) が決め、ここはそれを出し分けるだけ。`read_only` の
 * 拒否とロック確認の強制もバックエンド側で行う。
 */

interface Props {
  sessionId: string;
  driver: string;
  /** 試算の対象の SELECT (EXPLAIN を付けない)。 */
  sql: string;
  /** タブの既定のデータベース / スキーマ。 */
  database: string | null;
  /** 開いた時点で選んでおく表・インデックス (アドバイザの「未使用インデックス」から開くとき)。 */
  initial?: { table: string; index?: string };
  /** SQL を画面で入力させる (アドバイザから開くとき。EXPLAIN タブは今のタブの SQL をそのまま使う)。 */
  editableSql?: boolean;
  onResult: (outcome: IndexWhatIfOutcome, desc: WhatIfDescriptor) => void;
  onClose: () => void;
}

/** 比較画面の見出しに使う、何を試算したか。 */
export interface WhatIfDescriptor {
  action: "disable" | "add";
  table: string;
  index: string;
  columns: string[];
}

export function IndexWhatIfModal({
  sessionId,
  driver,
  sql: initialSql,
  database,
  initial,
  editableSql,
  onResult,
  onClose,
}: Props) {
  const t = useT();
  const [sql, setSql] = useState(initialSql);
  const tables = useMemo(() => {
    const refs = extractReferencedTables(sql, 10, driver).map((r) => ({
      database: r.database ?? database,
      table: r.table,
    }));
    if (initial && !refs.some((r) => r.table === initial.table)) {
      refs.unshift({ database, table: initial.table });
    }
    return refs;
  }, [sql, driver, database, initial]);
  const [tableIdx, setTableIdx] = useState(() =>
    Math.max(0, initial ? tables.findIndex((r) => r.table === initial.table) : 0),
  );
  const target = tables[tableIdx] ?? null;

  const [support, setSupport] = useState<IndexWhatIfSupport | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [tableColumns, setTableColumns] = useState<TableColumnInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<"disable" | "add">("disable");
  const [index, setIndex] = useState(initial?.index ?? "");
  const [columns, setColumns] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getIndexWhatIfSupport(sessionId)
      .then((s) => live && setSupport(s))
      .catch((e) => live && setLoadError(localizedErrorMessage(e, t)));
    return () => {
      live = false;
    };
  }, [sessionId, t]);

  const targetDb = target?.database ?? null;
  const targetTable = target?.table ?? "";
  useEffect(() => {
    if (!targetTable) return;
    let live = true;
    setIndexes([]);
    setTableColumns([]);
    setColumns([]);
    Promise.all([
      api.listIndexes(sessionId, targetDb ?? "", targetTable),
      api.describeTable(sessionId, targetDb ?? "", targetTable),
    ])
      .then(([ix, cols]) => {
        if (!live) return;
        setIndexes(ix);
        setTableColumns(cols);
        setIndex((cur) => (ix.some((i) => i.name === cur && !i.primary) ? cur : ""));
      })
      .catch((e) => live && setLoadError(localizedErrorMessage(e, t)));
    return () => {
      live = false;
    };
  }, [sessionId, targetDb, targetTable, t]);

  const mode = whatIfModeSupport(support, action);
  const form: WhatIfFormState = {
    database: targetDb,
    table: targetTable,
    sql,
    action,
    index,
    columns,
    confirmed,
  };
  const runnable = canRunWhatIf(form, mode) && !running;
  const candidates = indexes.filter((i) => !i.primary);

  const run = async () => {
    if (!mode || !runnable) return;
    setRunning(true);
    setRunError(null);
    try {
      const outcome = await api.runIndexWhatIf(sessionId, buildWhatIfRequest(form, mode));
      onResult(outcome, { action, table: targetTable, index, columns });
    } catch (e) {
      setRunError(localizedErrorMessage(e, t));
      setRunning(false);
    }
  };

  const lockKey = driver === "sqlite" ? "indexWhatIfLockWarningSqlite" : "indexWhatIfLockWarningPostgres";
  return (
    <Modal onSubmit={run} submitDisabled={!runnable} width="620px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("indexWhatIfClose")}>
        {t("indexWhatIfTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.p fontSize="sm" color="app.textSecondary">
          {t("indexWhatIfIntro")}
        </chakra.p>
        {editableSql && (
          <FormSection>
            <FieldLabel htmlFor="index-whatif-sql">{t("indexWhatIfSqlLabel")}</FieldLabel>
            <Textarea
              id="index-whatif-sql"
              value={sql}
              rows={4}
              spellCheck={false}
              placeholder={t("indexWhatIfSqlPlaceholder")}
              onChange={(e) => setSql(e.target.value)}
            />
          </FormSection>
        )}
        {loadError && <ErrorNote>{t("indexWhatIfLoadError", { error: loadError })}</ErrorNote>}
        {tables.length === 0 ? (
          <Callout tone="info">{t("indexWhatIfNoTables")}</Callout>
        ) : (
          <>
            <Flex align="center" gap="2">
              <FieldLabel as="div" minW="110px">
                {t("indexWhatIfTable")}
              </FieldLabel>
              <ListboxSelect
                ariaLabel={t("indexWhatIfTable")}
                value={String(tableIdx)}
                options={tables.map((r, i) => ({
                  value: String(i),
                  label: r.database ? `${r.database}.${r.table}` : r.table,
                }))}
                onChange={(v) => {
                  setTableIdx(Number(v));
                  setConfirmed(false);
                }}
              />
            </Flex>
            <FormSection>
              <Flex gap="4" wrap="wrap">
                {(["disable", "add"] as const).map((a) => (
                  <chakra.label key={a} display="flex" alignItems="center" gap="1.5" fontSize="sm">
                    <Radio
                      name="index-whatif-action"
                      checked={action === a}
                      onChange={() => {
                        setAction(a);
                        setConfirmed(false);
                      }}
                    />
                    {t(a === "disable" ? "indexWhatIfModeDisable" : "indexWhatIfModeAdd")}
                  </chakra.label>
                ))}
              </Flex>
            </FormSection>
            {action === "disable" ? (
              <Flex align="center" gap="2">
                <FieldLabel as="div" minW="110px">
                  {t("indexWhatIfIndexLabel")}
                </FieldLabel>
                {candidates.length === 0 ? (
                  <chakra.span fontSize="sm" color="app.textMuted">
                    {t("indexWhatIfNoIndexes")}
                  </chakra.span>
                ) : (
                  <ListboxSelect
                    ariaLabel={t("indexWhatIfIndexLabel")}
                    value={index}
                    placeholder={t("indexWhatIfIndexPlaceholder")}
                    options={candidates.map((i) => ({
                      value: i.name,
                      label: `${i.name} (${i.columns.join(", ")})`,
                      searchText: i.name,
                    }))}
                    onChange={setIndex}
                  />
                )}
              </Flex>
            ) : (
              <FormSection>
                <FieldLabel as="div">{t("indexWhatIfColumnsLabel")}</FieldLabel>
                <Flex gap="3" wrap="wrap">
                  {tableColumns.map((c) => (
                    <chakra.label key={c.name} display="flex" alignItems="center" gap="1" fontSize="sm">
                      <Checkbox
                        checked={columns.includes(c.name)}
                        onChange={() => setColumns((cur) => toggleWhatIfColumn(cur, c.name))}
                      />
                      {c.name}
                      {columns.includes(c.name) && (
                        <chakra.span textStyle="caption">{columns.indexOf(c.name) + 1}</chakra.span>
                      )}
                    </chakra.label>
                  ))}
                </Flex>
                <chakra.span textStyle="caption">{t("indexWhatIfColumnsHint")}</chakra.span>
              </FormSection>
            )}
            {mode?.method === null && mode.unavailable && (
              <Callout tone="warning" data-testid="index-whatif-unavailable">
                {t(WHATIF_UNAVAILABLE_KEY[mode.unavailable])}
              </Callout>
            )}
            {mode?.method && (
              <Callout tone="info" data-testid="index-whatif-method">
                {t(
                  mode.method === "hypopg"
                    ? "indexWhatIfMethodHypopg"
                    : mode.method === "ignoreIndex"
                      ? "indexWhatIfMethodIgnoreIndex"
                      : "indexWhatIfMethodRollbackDdl",
                )}
              </Callout>
            )}
            {mode?.method && mode.buildsIndex && (
              <Callout tone="warning">{t("indexWhatIfBuildNote")}</Callout>
            )}
            {mode?.method && mode.locksTable && (
              <Callout tone="warning" data-testid="index-whatif-lock">
                {t(lockKey)}
                <chakra.label display="flex" alignItems="center" gap="1.5" fontSize="sm" mt="2">
                  <Checkbox checked={confirmed} onChange={() => setConfirmed((c) => !c)} />
                  {t("indexWhatIfLockConfirm")}
                </chakra.label>
              </Callout>
            )}
            {runError && <ErrorNote>{t("indexWhatIfRunError", { error: runError })}</ErrorNote>}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("indexWhatIfClose")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!runnable} onClick={() => void run()}>
          {running ? t("indexWhatIfRunning") : t("indexWhatIfRun")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
