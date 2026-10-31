import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";

import {
  api,
  type ConnectionProfile,
  type SandboxRecord,
  type SandboxSchemaDiffResult,
  type SandboxTableDiffResult,
  type SyncStatement,
} from "../api/tauri";
import { useT } from "../i18n";
import {
  bulkSandboxResolutions,
  sandboxKeySignature,
  sandboxSkipKeys,
  unresolvedSandboxConflicts,
  type SandboxConflictResolution,
} from "../sandbox";
import { useConfirm } from "./ConfirmDialog";
import { DataRowDiffTable } from "./DataRowDiffTable";
import { Icon, ICON_SIZES } from "./Icon";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Callout } from "./Callout";
import { ErrorNote, FieldLabel } from "./modalForm";
import { TableDiffDetail } from "./SchemaDiffDetail";
import { Tooltip } from "./Tooltip";
import { Button, Checkbox, Radio } from "./ui";
import { ListboxSelect } from "./ListboxSelect";

interface Props {
  sandbox: SandboxRecord;
  sandboxSessionId: string;
  /** 現在開いている (サンドボックス以外の) 接続。元 DB との突き合わせ・書き戻し
   *  先の候補として提示する — 新規にセッションを張り直さず、ユーザが既に開いて
   *  いる接続をそのまま使う。 */
  openConnections: { sessionId: string; profile: ConnectionProfile }[];
  /** 作成元の接続を開く。作成元のプロファイルが残っているときだけ渡す。 */
  onOpenSource?: () => void;
  onClose: () => void;
}

interface TableState {
  diff: SandboxTableDiffResult | null;
  loading: boolean;
  error: string | null;
  resolutions: Record<string, SandboxConflictResolution>;
}

/**
 * サンドボックスの変更を確認し、元 DB へ書き戻すモーダル (#747)。
 *
 * データ/スキーマの差分計算はバックエンドの `sandbox_table_diff` /
 * `sandbox_schema_diff` (`db::sandbox::detect_conflicts` 等) が担い、SQL の
 * 生成・適用は既存の Diff/Sync コマンド (`generateSyncSql` /
 * `generateDataSyncSql` / `applySyncSql`、`SchemaCompareView` と全く同じ IPC) を
 * そのまま流用する。書き戻しに成功したテーブルは `sandboxAdvanceBase` で base を
 * 進め、次回以降の差分計算が「もう一致した行」を偽の競合として出し続けないように
 * する。
 */
export function SandboxReviewModal({
  sandbox,
  sandboxSessionId,
  openConnections,
  onOpenSource,
  onClose,
}: Props) {
  const t = useT();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { confirm: confirmTyped, dialog: typedConfirmDialog } = useConfirm();

  const candidates = useMemo(
    () => openConnections.filter((c) => c.profile.driver === sandbox.source_driver),
    [openConnections, sandbox.source_driver],
  );
  const [targetSessionId, setTargetSessionId] = useState<string | null>(() => {
    const preferred = candidates.find((c) => c.profile.id === sandbox.source_profile_id);
    return (preferred ?? candidates[0])?.sessionId ?? null;
  });
  const targetProfile = candidates.find((c) => c.sessionId === targetSessionId)?.profile ?? null;
  // 「元の接続を開く」で接続が増えたら、その接続を書き戻し先に選ぶ。
  useEffect(() => {
    if (targetSessionId === null && candidates.length > 0) {
      const preferred = candidates.find((c) => c.profile.id === sandbox.source_profile_id);
      setTargetSessionId((preferred ?? candidates[0]).sessionId);
    }
  }, [candidates, targetSessionId, sandbox.source_profile_id]);

  const [allowDestructive, setAllowDestructive] = useState(false);
  const [allowDelete, setAllowDelete] = useState(false);

  const [schema, setSchema] = useState<SandboxSchemaDiffResult | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const [tables, setTables] = useState<Record<string, TableState>>({});

  const [combined, setCombined] = useState<{ statements: SyncStatement[]; warnings: string[] } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [resettingTable, setResettingTable] = useState<string | null>(null);

  // 読み込みの世代。対象接続の切替・再読み込みで進め、古い世代の応答は捨てる
  // (捨てないと旧接続の差分が state を上書きし、別接続へ誤って適用されうる)。
  const loadGenRef = useRef(0);

  const loadSchema = useCallback(
    async (gen: number) => {
      setSchemaLoading(true);
      setSchemaError(null);
      try {
        const result = await api.sandboxSchemaDiff({
          sandboxId: sandbox.id,
          sandboxSessionId,
          sourceSessionId: targetSessionId,
        });
        if (gen !== loadGenRef.current) return;
        setSchema(result);
      } catch (e) {
        if (gen !== loadGenRef.current) return;
        setSchemaError(String(e));
        setSchema(null);
      } finally {
        if (gen === loadGenRef.current) setSchemaLoading(false);
      }
    },
    [sandbox.id, sandboxSessionId, targetSessionId],
  );

  const loadTable = useCallback(
    async (table: string, gen: number) => {
      setTables((prev) => ({
        ...prev,
        [table]: {
          diff: prev[table]?.diff ?? null,
          loading: true,
          error: null,
          resolutions: prev[table]?.resolutions ?? {},
        },
      }));
      try {
        const diff = await api.sandboxTableDiff({
          sandboxId: sandbox.id,
          sandboxSessionId,
          table,
          sourceSessionId: targetSessionId,
        });
        if (gen !== loadGenRef.current) {
          // 古い世代の差分はバックエンドに保持されたままなので解放して捨てる。
          void api.releaseDataDiffs([diff.desired_diff_id]).catch(() => {});
          return;
        }
        setTables((prev) => ({
          ...prev,
          [table]: { diff, loading: false, error: null, resolutions: prev[table]?.resolutions ?? {} },
        }));
      } catch (e) {
        if (gen !== loadGenRef.current) return;
        setTables((prev) => ({
          ...prev,
          [table]: {
            diff: null,
            loading: false,
            error: String(e),
            resolutions: prev[table]?.resolutions ?? {},
          },
        }));
      }
    },
    [sandbox.id, sandboxSessionId, targetSessionId],
  );

  // バックエンドに保持されている差分 ID (#1259)。再読み込みと画面を閉じたときに解放する。
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const releaseHeldDiffs = useCallback(() => {
    const ids = Object.values(tablesRef.current)
      .map((st) => st.diff?.desired_diff_id)
      .filter((id): id is string => !!id);
    if (ids.length > 0) void api.releaseDataDiffs(ids).catch(() => {});
  }, []);
  useEffect(() => releaseHeldDiffs, [releaseHeldDiffs]);

  const loadAll = useCallback(() => {
    releaseHeldDiffs();
    setCombined(null);
    setApplyResult(null);
    setOpError(null);
    loadGenRef.current += 1;
    const gen = loadGenRef.current;
    void loadSchema(gen);
    for (const table of sandbox.tables) void loadTable(table, gen);
  }, [loadSchema, loadTable, sandbox.tables, releaseHeldDiffs]);

  // `loadAll`'s identity already changes whenever `targetSessionId` does
  // (transitively, via `loadSchema`/`loadTable`), so depending on just
  // `loadAll` here re-runs on every relevant change without a duplicate
  // dependency list.
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const setResolution = (table: string, key: string, resolution: SandboxConflictResolution) => {
    setTables((prev) => ({
      ...prev,
      [table]: { ...prev[table], resolutions: { ...prev[table]?.resolutions, [key]: resolution } },
    }));
    setCombined(null);
  };

  // 競合の一括解決 (#1625)。`table` を渡せばその表だけ、省略なら全表の競合にまとめて適用する。
  // 個別の選択は一括の後でも変えられる。全件上書きは元 DB 側の変更を捨てるので確認する。
  const resolveAll = async (resolution: SandboxConflictResolution, table?: string) => {
    if (resolution === "overwrite") {
      const ok = await confirm({
        title: t("sandboxReviewBulkOverwriteTitle"),
        message: t("sandboxReviewBulkOverwriteMessage"),
        confirmLabel: t("sandboxReviewOverwrite"),
        tone: "warning",
      });
      if (!ok) return;
    }
    setTables((prev) => {
      const next = { ...prev };
      for (const [name, st] of Object.entries(prev)) {
        if (table !== undefined && name !== table) continue;
        if (!st.diff || st.diff.conflicts.length === 0) continue;
        next[name] = {
          ...st,
          resolutions: bulkSandboxResolutions(st.diff.conflicts, st.resolutions, resolution),
        };
      }
      return next;
    });
    setCombined(null);
  };

  const totalConflicts = useMemo(
    () => Object.values(tables).reduce((n, st) => n + (st.diff?.conflicts.length ?? 0), 0),
    [tables],
  );

  // 1 表を base スナップショットへ戻す (#1539)。確認のうえ実行し、完了後は差分を再読込する。
  const resetTable = async (table: string) => {
    const ok = await confirm({
      title: t("sandboxResetConfirmTitle", { table }),
      message: t("sandboxResetConfirmMessage", { table }),
      tone: "danger",
    });
    if (!ok) return;
    setResettingTable(table);
    setOpError(null);
    try {
      const r = await api.sandboxResetTable({ sandboxId: sandbox.id, sandboxSessionId, table });
      loadAll();
      setApplyResult(t("sandboxResetDone", { table, rows: r.restored_rows }));
    } catch (e) {
      setOpError(String(e));
    } finally {
      setResettingTable(null);
    }
  };

  const unresolvedCount = useMemo(() => {
    let n = 0;
    for (const st of Object.values(tables)) {
      if (st.diff) n += unresolvedSandboxConflicts(st.diff.conflicts, st.resolutions).length;
    }
    return n;
  }, [tables]);

  const loading =
    schemaLoading ||
    Object.values(tables).some((st) => st.loading) ||
    Object.keys(tables).length < sandbox.tables.length;

  const generate = useCallback(async () => {
    if (!schema) return;
    setGenerating(true);
    setOpError(null);
    setApplyResult(null);
    try {
      const schemaPlan = await api.generateSyncSql(schema.desired, allowDestructive);
      const statements: SyncStatement[] = [...schemaPlan.statements];
      const warnings: string[] = [...schemaPlan.warnings];
      for (const table of sandbox.tables) {
        const st = tables[table];
        if (!st?.diff || st.diff.desired.rows.length === 0) continue;
        // 差分はバックエンドが保持している (`desired_diff_id`)。競合「スキップ」の除外キー
        // だけを送り、絞り込みと SQL 描画は Rust 側で行う (#1259)。
        const skipKeys = sandboxSkipKeys(st.diff.conflicts, st.resolutions);
        const plan = await api.generateDataSyncSql(st.diff.desired_diff_id, allowDelete, skipKeys);
        statements.push(...plan.statements);
        warnings.push(...plan.warnings);
      }
      setCombined({ statements, warnings });
    } catch (e) {
      setOpError(String(e));
    } finally {
      setGenerating(false);
    }
  }, [schema, allowDestructive, allowDelete, tables, sandbox.tables]);

  // 破壊的な文を含む、または削除を許可して適用するとき、フッターを破壊的パターンに切り替える。
  const destructiveApply =
    !!combined &&
    combined.statements.length > 0 &&
    (allowDelete || combined.statements.some((s) => s.destructive));
  const applyDisabled = !combined || combined.statements.length === 0 || !targetSessionId;
  const applyLabel = t("sandboxApplyTitle", { count: combined?.statements.length ?? 0 });

  const apply = useCallback(async () => {
    if (!combined || combined.statements.length === 0 || !targetSessionId || !targetProfile) return;
    const destructiveCount = combined.statements.filter((s) => s.destructive).length;
    // 実際に書き戻す行があり、競合検出に失敗したテーブルだけを注意対象にする。
    const failedCheckTables = sandbox.tables.filter((tb) => {
      const d = tables[tb]?.diff;
      return !!d?.source_error && d.desired.rows.length > 0;
    });
    const ok = await confirm({
      title: t("sandboxApplyTitle", { count: combined.statements.length }),
      message: (
        <>
          <chakra.p margin={0}>
            {t("sandboxApplyConfirm", {
              count: combined.statements.length,
              name: targetProfile.name,
              destructive: destructiveCount,
            })}
          </chakra.p>
          {failedCheckTables.length > 0 && (
            <chakra.p margin={0} mt="2" color="app.textWarning">
              {t("sandboxApplySourceErrorNote", { tables: failedCheckTables.join(", ") })}
            </chakra.p>
          )}
        </>
      ),
      tone: destructiveCount > 0 ? "danger" : "warning",
    });
    if (!ok) return;
    if (targetProfile.is_production) {
      if (destructiveCount > 0) {
        const typedOk = await confirmTyped({
          title: t("sandboxApplyTypedConfirmTitle"),
          message: t("sandboxApplyTypedConfirmBody", {
            name: targetProfile.name,
            destructive: destructiveCount,
          }),
          confirmLabel: t("sandboxApplyTypedConfirmOk"),
          tone: "danger",
          typedConfirmation: targetProfile.name,
        });
        if (!typedOk) return;
      } else {
        const prodOk = await confirm({
          title: t("productionConfirmTitle"),
          message: t("sandboxApplyProductionConfirm", { name: targetProfile.name }),
          tone: "warning",
        });
        if (!prodOk) return;
      }
    }

    setApplying(true);
    setOpError(null);
    setApplyResult(null);
    try {
      await api.applySyncSql({
        sessionId: targetSessionId,
        database: sandbox.source_database,
        statements: combined.statements.map((s) => s.sql),
      });
      // Advance the base for every table whose data diff was actually
      // written back, so the next review doesn't show phantom conflicts for
      // rows that are now in sync (see `sandboxAdvanceBase`'s doc).
      // 元 DB への書き込みはもう済んでいるので、base 更新が一部の表で失敗しても
      // 適用ボタンを残さない (同じ文の再適用で INSERT の重複・ALTER の再実行になる)。
      // 失敗した表を集め、最後に差分を再読込して結果を知らせる。
      const advanceFailures: { table: string; error: string }[] = [];
      for (const table of sandbox.tables) {
        const st = tables[table];
        if (!st?.diff || st.diff.desired.rows.length === 0) continue;
        const skipKeys = sandboxSkipKeys(st.diff.conflicts, st.resolutions);
        try {
          await api.sandboxAdvanceBase({
            sandboxId: sandbox.id,
            sandboxSessionId,
            table,
            diffId: st.diff.desired_diff_id,
            skipKeys,
            allowDelete,
          });
        } catch (e) {
          advanceFailures.push({ table, error: String(e) });
        }
      }
      const count = combined.statements.length;
      setCombined(null);
      // `loadAll` は結果表示を消すので、先に呼んでから結果を設定する。
      loadAll();
      if (advanceFailures.length > 0) {
        setOpError(
          t("sandboxApplyBaseAdvanceFailed", {
            count,
            tables: advanceFailures.map((f) => f.table).join(", "),
            error: advanceFailures[0].error,
          }),
        );
      } else {
        setApplyResult(t("sandboxApplyDone", { count }));
      }
    } catch (e) {
      setOpError(String(e));
    } finally {
      setApplying(false);
    }
  }, [
    combined,
    targetSessionId,
    targetProfile,
    sandbox,
    tables,
    allowDelete,
    sandboxSessionId,
    confirm,
    confirmTyped,
    t,
    loadAll,
  ]);

  return (
    <Modal
      // no-submit: 本番への変更適用。差分の確認を飛ばしてキーで適用させない
      width="880px"
      onClose={onClose}
      closeOnInteractOutside={!applying}
      closeOnEscape={!applying}
    >
      <ModalHeader onClose={onClose} closeLabel={t("sandboxReviewClose")} closeDisabled={applying}>
        {t("sandboxReviewTitle", { name: sandbox.name })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <Callout tone="info" role="note" fontSize="xs">
          {t("sandboxReviewLimitationNote")}
        </Callout>

        <chakra.div display="flex" alignItems="center" gap="2.5" flexWrap="wrap">
          <FieldLabel htmlFor="sandbox-review-target">{t("sandboxReviewTarget")}</FieldLabel>
          {candidates.length > 0 ? (
            <ListboxSelect
              id="sandbox-review-target"
              value={targetSessionId ?? ""}
              options={candidates.map((c) => ({ value: c.sessionId, label: c.profile.name }))}
              onChange={(v) => setTargetSessionId(v || null)}
            />
          ) : (
            <>
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("sandboxReviewNoTarget")}
              </chakra.span>
              {onOpenSource && (
                <Button type="button" size="sm" variant="secondary" onClick={onOpenSource}>
                  {t("sandboxReviewOpenSource")}
                </Button>
              )}
            </>
          )}
        </chakra.div>

        {loading && (
          <chakra.div fontSize="sm" color="app.textSecondary">
            {t("sandboxReviewLoading")}
          </chakra.div>
        )}
        {schemaError && <ErrorNote>{schemaError}</ErrorNote>}

        {schema && schema.desired.tables.some((tb) => tb.status !== "same") && (
          <chakra.div fontSize="sm">
            <chakra.strong>{t("sandboxReviewSchemaChanges")}</chakra.strong>
            <chakra.div mt="1.5" display="flex" flexDirection="column" gap="4">
              {schema.desired.tables
                .filter((tb) => tb.status !== "same")
                .map((tb) => (
                  <TableDiffDetail
                    key={tb.name}
                    table={tb}
                    sourceName={t("sandboxReviewSandboxSide")}
                    targetName={t("sandboxReviewBaseSide")}
                    // 比べている相手は元の DB の今の値ではなく、作成時 (最後の書き戻し時) のスナップショット。
                    targetTitle={t("sandboxReviewColChange")}
                    statements={[]}
                    planReady={false}
                    showSql={false}
                    t={t}
                  />
                ))}
            </chakra.div>
            <chakra.label
              display="inline-flex"
              alignItems="center"
              gap="1.5"
              fontSize="sm"
              mt="1.5"
              cursor="pointer"
            >
              <Checkbox
                checked={allowDestructive}
                onChange={(e) => {
                  setAllowDestructive(e.target.checked);
                  // 生成済みの文は生成時のフラグ固定なので破棄して再生成を促す。
                  setCombined(null);
                }}
              />
              {t("schemaCompareAllowDestructive")}
            </chakra.label>
          </chakra.div>
        )}
        {schema?.source_error && (
          <Callout tone="warning" role="alert">
            {t("sandboxReviewSchemaSourceError", { error: schema.source_error })}
          </Callout>
        )}
        {schema && schema.external_changed_tables.length > 0 && (
          <Callout tone="warning" role="alert">
            {t("sandboxReviewSchemaExternalWarning", {
              tables: schema.external_changed_tables.join(", "),
            })}
          </Callout>
        )}

        {totalConflicts > 1 && (
          <chakra.div display="flex" alignItems="center" gap="2" flexWrap="wrap" fontSize="sm">
            <chakra.span fontWeight={600}>
              {t("sandboxReviewBulkTitle", { count: totalConflicts })}
            </chakra.span>
            <Button type="button" size="sm" variant="secondary" onClick={() => void resolveAll("overwrite")}>
              {t("sandboxReviewBulkOverwrite")}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => void resolveAll("skip")}>
              {t("sandboxReviewBulkSkip")}
            </Button>
          </chakra.div>
        )}

        {sandbox.tables.map((table) => {
          const st = tables[table];
          if (!st || st.loading) return null;
          if (st.error)
            return (
              <ErrorNote key={table}>
                {table}: {st.error}
              </ErrorNote>
            );
          if (!st.diff) return null;
          const hasChanges = st.diff.desired.rows.length > 0;
          if (!hasChanges && st.diff.conflicts.length === 0) return null;
          return (
            <chakra.div key={table} border="1px solid" borderColor="app.border" borderRadius="md" p="2.5">
              <chakra.div
                display="flex"
                alignItems="center"
                gap="2"
                fontFamily="mono"
                fontSize="sm"
                fontWeight={600}
              >
                {table}
                <div style={{ flex: 1 }} />
                <Tooltip
                  label={t("sandboxResetTableHint")}
                  focusableWrapper={applying || resettingTable !== null}
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void resetTable(table)}
                    disabled={applying || resettingTable !== null}
                  >
                    {t("sandboxResetTable")}
                  </Button>
                </Tooltip>
              </chakra.div>
              {hasChanges && (
                <chakra.div mt="2">
                  {/* 行の差分もスナップショットとの比較。元の DB 側の今の値は「競合」として別に出す。 */}
                  <DataRowDiffTable diff={st.diff.desired} changeTitle={t("sandboxReviewColChange")} />
                  {st.diff.desired.truncated && (
                    <chakra.p m={0} mt="1" textStyle="caption">
                      {t("sandboxReviewTruncated")}
                    </chakra.p>
                  )}
                </chakra.div>
              )}
              {st.diff.source_error && (
                <Callout tone="warning" role="alert" mt="1.5">
                  {t("sandboxReviewSourceError", { error: st.diff.source_error })}
                </Callout>
              )}
              {!st.diff.source_checked && !st.diff.source_error && (
                <chakra.div fontSize="xs" color="app.textMuted" mt="1">
                  {t("sandboxReviewConflictsUnchecked")}
                </chakra.div>
              )}
              {st.diff.conflicts.length > 0 && (
                <chakra.div mt="2" display="flex" flexDirection="column" gap="1.5">
                  <chakra.div display="flex" alignItems="center" gap="2" flexWrap="wrap">
                    <chakra.strong fontSize="xs" color="app.textWarning">
                      {t("sandboxReviewConflictsTitle", { count: st.diff.conflicts.length })}
                    </chakra.strong>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={t("sandboxReviewTableOverwriteAria", { table })}
                      onClick={() => void resolveAll("overwrite", table)}
                    >
                      {t("sandboxReviewTableOverwrite")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={t("sandboxReviewTableSkipAria", { table })}
                      onClick={() => void resolveAll("skip", table)}
                    >
                      {t("sandboxReviewTableSkip")}
                    </Button>
                  </chakra.div>
                  {/* 行ごとに flex で並べると主キーの文字幅で列がずれるので、親の grid で列を揃える
                      (各行は display="contents" で子要素を親のセルに流し込む)。 */}
                  <chakra.div
                    display="grid"
                    gridTemplateColumns="auto minmax(0, 1fr) auto auto"
                    alignItems="center"
                    columnGap="2.5"
                    rowGap="1"
                  >
                    {st.diff.conflicts.map((c) => {
                      const keySig = sandboxKeySignature(c.key);
                      const resolution = st.resolutions[keySig];
                      return (
                        <chakra.div key={keySig} display="contents" fontSize="xs">
                          <chakra.code>{c.key.map((v) => String(v)).join(", ")}</chakra.code>
                          <chakra.span color="app.textMuted">
                            {t("sandboxReviewExternalValue")}:{" "}
                            {c.external_row
                              ? c.external_row.map((v) => String(v)).join(", ")
                              : t("sandboxReviewExternalDeleted")}
                          </chakra.span>
                          <chakra.label display="inline-flex" alignItems="center" gap="1" cursor="pointer">
                            <Radio
                              name={`sandbox-conflict-${table}-${keySig}`}
                              checked={resolution === "overwrite"}
                              onChange={() => setResolution(table, keySig, "overwrite")}
                            />
                            {t("sandboxReviewOverwrite")}
                          </chakra.label>
                          <chakra.label display="inline-flex" alignItems="center" gap="1" cursor="pointer">
                            <Radio
                              name={`sandbox-conflict-${table}-${keySig}`}
                              checked={resolution === "skip"}
                              onChange={() => setResolution(table, keySig, "skip")}
                            />
                            {t("sandboxReviewSkip")}
                          </chakra.label>
                        </chakra.div>
                      );
                    })}
                  </chakra.div>
                </chakra.div>
              )}
            </chakra.div>
          );
        })}

        {!loading &&
          Object.values(tables).every(
            (st) => !st.diff || (st.diff.desired.rows.length === 0 && st.diff.conflicts.length === 0),
          ) &&
          schema &&
          !schema.desired.tables.some((tb) => tb.status !== "same") && (
            <chakra.div fontSize="sm" color="app.textMuted">
              {t("sandboxReviewNoChanges")}
            </chakra.div>
          )}

        <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" cursor="pointer">
          <Checkbox
            checked={allowDelete}
            onChange={(e) => {
              setAllowDelete(e.target.checked);
              // 生成済みの文は生成時のフラグ固定なので破棄して再生成を促す。
              setCombined(null);
            }}
          />
          {t("sandboxReviewAllowDelete")}
        </chakra.label>

        {unresolvedCount > 0 && (
          <Callout tone="warning" role="alert">
            {t("sandboxReviewUnresolvedConflicts", { count: unresolvedCount })}
          </Callout>
        )}

        {opError && <ErrorNote>{opError}</ErrorNote>}
        {applyResult && (
          <Callout tone="success" role="status">
            {applyResult}
          </Callout>
        )}

        {combined && (
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <chakra.strong fontSize="sm">
              {t("sandboxReviewGeneratedTitle", { count: combined.statements.length })}
            </chakra.strong>
            {combined.statements.length === 0 ? (
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("schemaCompareNoStatements")}
              </chakra.span>
            ) : (
              <chakra.div
                maxH="220px"
                overflowY="auto"
                border="1px solid"
                borderColor="app.border"
                borderRadius="md"
                p="2"
              >
                {combined.statements.map((s, i) => (
                  <chakra.code
                    key={i}
                    display="block"
                    fontSize="xs"
                    whiteSpace="pre-wrap"
                    wordBreak="break-word"
                    color={s.destructive ? "app.textError" : "app.text"}
                    mb="1"
                  >
                    {s.sql}
                  </chakra.code>
                ))}
              </chakra.div>
            )}
            {combined.warnings.length > 0 && (
              <chakra.ul fontSize="xs" color="app.textMuted" paddingLeft="4.5" margin={0}>
                {combined.warnings.map((w, i) => (
                  <chakra.li key={i}>{w}</chakra.li>
                ))}
              </chakra.ul>
            )}
          </chakra.div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={loadAll} disabled={loading || applying}>
          <Icon name="refresh" size={ICON_SIZES.sm} />
          {t("sandboxReviewRefresh")}
        </Button>
        <LoadingButton
          loading={generating}
          onClick={generate}
          disabled={loading || !targetSessionId || unresolvedCount > 0}
        >
          {t("sandboxReviewGenerate")}
        </LoadingButton>
        {/* 破壊的な文 (DROP / DELETE 等) を含む適用は、確認ダイアログと同じ破壊的パターン
            (適用 = dangerOutline を左、閉じる = primary を右) にする。 */}
        {destructiveApply ? (
          <>
            <LoadingButton
              pressable
              variant="dangerOutline"
              loading={applying}
              onClick={apply}
              disabled={applyDisabled}
            >
              {applyLabel}
            </LoadingButton>
            <div style={{ flex: 1 }} />
            <Button type="button" variant="primary" onClick={onClose} disabled={applying}>
              {t("sandboxReviewClose")}
            </Button>
          </>
        ) : (
          <>
            <div style={{ flex: 1 }} />
            <Button type="button" variant="secondary" onClick={onClose} disabled={applying}>
              {t("sandboxReviewClose")}
            </Button>
            <LoadingButton
              pressable
              variant="primary"
              loading={applying}
              onClick={apply}
              disabled={applyDisabled}
            >
              {applyLabel}
            </LoadingButton>
          </>
        )}
      </ModalFooter>
      {confirmDialog}
      {typedConfirmDialog}
    </Modal>
  );
}
