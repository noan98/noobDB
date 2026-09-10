import { useCallback, useEffect, useMemo, useState } from "react";
import { chakra } from "@chakra-ui/react";

import {
  api,
  type ConnectionProfile,
  type DiffStatus,
  type SandboxRecord,
  type SandboxSchemaDiffResult,
  type SandboxTableDiffResult,
  type SyncStatement,
} from "../api/tauri";
import { useT } from "../i18n";
import {
  sandboxKeySignature,
  sandboxSkipKeys,
  unresolvedSandboxConflicts,
  type SandboxConflictResolution,
} from "../sandbox";
import { useConfirm } from "./ConfirmDialog";
import { statusColors } from "./diffStatusColors";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote } from "./modalForm";
import { Button, Checkbox, Radio, Select } from "./ui";

interface Props {
  sandbox: SandboxRecord;
  sandboxSessionId: string;
  /** 現在開いている (サンドボックス以外の) 接続。元 DB との突き合わせ・書き戻し
   *  先の候補として提示する — 新規にセッションを張り直さず、ユーザが既に開いて
   *  いる接続をそのまま使う。 */
  openConnections: { sessionId: string; profile: ConnectionProfile }[];
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
export function SandboxReviewModal({ sandbox, sandboxSessionId, openConnections, onClose }: Props) {
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

  const [allowDestructive, setAllowDestructive] = useState(false);
  const [allowDelete, setAllowDelete] = useState(false);

  const [schema, setSchema] = useState<SandboxSchemaDiffResult | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const [tables, setTables] = useState<Record<string, TableState>>({});

  const [combined, setCombined] = useState<{ statements: SyncStatement[]; warnings: string[] } | null>(
    null,
  );
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const loadSchema = useCallback(async () => {
    setSchemaLoading(true);
    setSchemaError(null);
    try {
      const result = await api.sandboxSchemaDiff({
        sandboxId: sandbox.id,
        sandboxSessionId,
        sourceSessionId: targetSessionId,
      });
      setSchema(result);
    } catch (e) {
      setSchemaError(String(e));
      setSchema(null);
    } finally {
      setSchemaLoading(false);
    }
  }, [sandbox.id, sandboxSessionId, targetSessionId]);

  const loadTable = useCallback(
    async (table: string) => {
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
        setTables((prev) => ({
          ...prev,
          [table]: { diff, loading: false, error: null, resolutions: prev[table]?.resolutions ?? {} },
        }));
      } catch (e) {
        setTables((prev) => ({
          ...prev,
          [table]: { diff: null, loading: false, error: String(e), resolutions: prev[table]?.resolutions ?? {} },
        }));
      }
    },
    [sandbox.id, sandboxSessionId, targetSessionId],
  );

  const loadAll = useCallback(() => {
    setCombined(null);
    setApplyResult(null);
    setOpError(null);
    void loadSchema();
    for (const table of sandbox.tables) void loadTable(table);
  }, [loadSchema, loadTable, sandbox.tables]);

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

  const unresolvedCount = useMemo(() => {
    let n = 0;
    for (const st of Object.values(tables)) {
      if (st.diff) n += unresolvedSandboxConflicts(st.diff.conflicts, st.resolutions).length;
    }
    return n;
  }, [tables]);

  const loading =
    schemaLoading || Object.values(tables).some((st) => st.loading) ||
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
        const skipKeys = sandboxSkipKeys(st.diff.conflicts, st.resolutions);
        const filtered =
          skipKeys.length > 0
            ? await api.filterSandboxDataDiff(st.diff.desired, skipKeys)
            : st.diff.desired;
        const plan = await api.generateDataSyncSql(filtered, allowDelete);
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

  const apply = useCallback(async () => {
    if (!combined || combined.statements.length === 0 || !targetSessionId || !targetProfile) return;
    const destructiveCount = combined.statements.filter((s) => s.destructive).length;
    const ok = await confirm({
      title: t("sandboxApplyTitle", { count: combined.statements.length }),
      message: t("sandboxApplyConfirm", {
        count: combined.statements.length,
        name: targetProfile.name,
        destructive: destructiveCount,
      }),
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
      for (const table of sandbox.tables) {
        const st = tables[table];
        if (!st?.diff || st.diff.desired.rows.length === 0) continue;
        const skipKeys = sandboxSkipKeys(st.diff.conflicts, st.resolutions);
        const filtered =
          skipKeys.length > 0
            ? await api.filterSandboxDataDiff(st.diff.desired, skipKeys)
            : st.diff.desired;
        await api.sandboxAdvanceBase({
          sandboxId: sandbox.id,
          sandboxSessionId,
          table,
          applied: filtered,
          allowDelete,
        });
      }
      setApplyResult(t("sandboxApplyDone", { count: combined.statements.length }));
      setCombined(null);
      loadAll();
    } catch (e) {
      setOpError(String(e));
    } finally {
      setApplying(false);
    }
  }, [combined, targetSessionId, targetProfile, sandbox, tables, allowDelete, sandboxSessionId, confirm, confirmTyped, t, loadAll]);

  return (
    <Modal width="720px" onClose={onClose} closeOnInteractOutside={!applying} closeOnEscape={!applying}>
      <ModalHeader onClose={onClose} closeLabel={t("sandboxReviewClose")} closeDisabled={applying}>
        {t("sandboxReviewTitle", { name: sandbox.name })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div
          fontSize="xs"
          color="app.textMuted"
          lineHeight={1.5}
          bg="app.bgMuted"
          border="1px solid"
          borderColor="app.border"
          borderRadius="md"
          p="2.5"
        >
          {t("sandboxReviewLimitationNote")}
        </chakra.div>

        <chakra.div display="flex" alignItems="center" gap="2.5" flexWrap="wrap">
          <chakra.label fontSize="sm" color="app.textSecondary" htmlFor="sandbox-review-target">
            {t("sandboxReviewTarget")}
          </chakra.label>
          {candidates.length > 0 ? (
            <Select
              id="sandbox-review-target"
              value={targetSessionId ?? ""}
              onChange={(e) => setTargetSessionId(e.target.value || null)}
            >
              {candidates.map((c) => (
                <option key={c.sessionId} value={c.sessionId}>
                  {c.profile.name}
                </option>
              ))}
            </Select>
          ) : (
            <chakra.span fontSize="sm" color="app.textMuted">
              {t("sandboxReviewNoTarget")}
            </chakra.span>
          )}
        </chakra.div>

        {loading && <chakra.div fontSize="sm" color="app.textSecondary">{t("sandboxReviewLoading")}</chakra.div>}
        {schemaError && <ErrorNote>{schemaError}</ErrorNote>}

        {schema && schema.desired.tables.some((tb) => tb.status !== "same") && (
          <chakra.div fontSize="sm">
            <chakra.strong>{t("sandboxReviewSchemaChanges")}</chakra.strong>
            {/* `DiffStatus` の色語彙は `diffStatusColors.ts` の `statusColors`
                (semanticColors 経由、#664) を `SchemaCompareView` と共有し、状態色を
                二重管理しない (#1008)。左端の 3px スパインも同ビューのテーブル/
                カラム差分行と同じ手法。 */}
            <chakra.ul margin="4px 0 0" paddingLeft="0" listStyleType="none" display="flex" flexDirection="column" gap="1">
              {schema.desired.tables
                .filter((tb) => tb.status !== "same")
                .map((tb) => {
                  const { color } = statusColors(tb.status);
                  return (
                    <chakra.li
                      key={tb.name}
                      display="flex"
                      alignItems="center"
                      gap="2"
                      py="0.5"
                      pl="2"
                      borderLeftWidth="3px"
                      borderLeftColor={color}
                    >
                      <chakra.span color={color} fontWeight={600} whiteSpace="nowrap">
                        {schemaStatusLabel(tb.status, t)}
                      </chakra.span>
                      <chakra.span fontFamily="mono">{tb.name}</chakra.span>
                    </chakra.li>
                  );
                })}
            </chakra.ul>
            <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" mt="1.5" cursor="pointer">
              <Checkbox checked={allowDestructive} onChange={(e) => setAllowDestructive(e.target.checked)} />
              {t("schemaCompareAllowDestructive")}
            </chakra.label>
          </chakra.div>
        )}
        {schema && schema.external_changed_tables.length > 0 && (
          <chakra.div fontSize="sm" color="app.textError">
            {t("sandboxReviewSchemaExternalWarning", {
              tables: schema.external_changed_tables.join(", "),
            })}
          </chakra.div>
        )}

        {sandbox.tables.map((table) => {
          const st = tables[table];
          if (!st || st.loading) return null;
          if (st.error) return <ErrorNote key={table}>{table}: {st.error}</ErrorNote>;
          if (!st.diff) return null;
          const counts = { source_only: 0, target_only: 0, different: 0 };
          for (const r of st.diff.desired.rows) counts[r.status] += 1;
          const hasChanges = st.diff.desired.rows.length > 0;
          if (!hasChanges && st.diff.conflicts.length === 0) return null;
          return (
            <chakra.div
              key={table}
              border="1px solid"
              borderColor="app.border"
              borderRadius="md"
              p="2.5"
            >
              <chakra.div display="flex" alignItems="center" gap="2" fontFamily="mono" fontSize="sm" fontWeight={600}>
                {table}
              </chakra.div>
              {hasChanges && (
                <chakra.div fontSize="xs" color="app.textMuted" mt="1">
                  {t("schemaCompareDataInserts")}: {counts.source_only} / {t("schemaCompareDataUpdates")}: {counts.different} /{" "}
                  {t("schemaCompareDataDeletes")}: {counts.target_only}
                  {st.diff.desired.truncated && ` (${t("sandboxReviewTruncated")})`}
                </chakra.div>
              )}
              {!st.diff.source_checked && (
                <chakra.div fontSize="xs" color="app.textMuted" mt="1">
                  {t("sandboxReviewConflictsUnchecked")}
                </chakra.div>
              )}
              {st.diff.conflicts.length > 0 && (
                <chakra.div mt="2" display="flex" flexDirection="column" gap="1.5">
                  <chakra.strong fontSize="xs" color="app.textError">
                    {t("sandboxReviewConflictsTitle", { count: st.diff.conflicts.length })}
                  </chakra.strong>
                  {st.diff.conflicts.map((c) => {
                    const keySig = sandboxKeySignature(c.key);
                    const resolution = st.resolutions[keySig];
                    return (
                      <chakra.div
                        key={keySig}
                        display="flex"
                        alignItems="center"
                        gap="2.5"
                        fontSize="xs"
                        flexWrap="wrap"
                      >
                        <chakra.code>{c.key.map((v) => String(v)).join(", ")}</chakra.code>
                        <chakra.span color="app.textMuted">
                          {t("sandboxReviewExternalValue")}:{" "}
                          {c.external_row ? c.external_row.map((v) => String(v)).join(", ") : t("sandboxReviewExternalDeleted")}
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
              )}
            </chakra.div>
          );
        })}

        {!loading &&
          Object.values(tables).every((st) => !st.diff || (st.diff.desired.rows.length === 0 && st.diff.conflicts.length === 0)) &&
          schema &&
          !schema.desired.tables.some((tb) => tb.status !== "same") && (
            <chakra.div fontSize="sm" color="app.textMuted">
              {t("sandboxReviewNoChanges")}
            </chakra.div>
          )}

        <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" cursor="pointer">
          <Checkbox checked={allowDelete} onChange={(e) => setAllowDelete(e.target.checked)} />
          {t("schemaCompareAllowDelete")}
        </chakra.label>

        {unresolvedCount > 0 && (
          <chakra.div fontSize="sm" color="app.textError">
            {t("sandboxReviewUnresolvedConflicts", { count: unresolvedCount })}
          </chakra.div>
        )}

        {opError && <ErrorNote>{opError}</ErrorNote>}
        {applyResult && (
          <chakra.div fontSize="sm" color="app.status.success">
            {applyResult}
          </chakra.div>
        )}

        {combined && (
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <chakra.strong fontSize="sm">
              {t("sandboxReviewGeneratedTitle", { count: combined.statements.length })}
            </chakra.strong>
            {combined.statements.length === 0 ? (
              <chakra.span fontSize="sm" color="app.textMuted">{t("schemaCompareNoStatements")}</chakra.span>
            ) : (
              <chakra.div maxH="220px" overflowY="auto" border="1px solid" borderColor="app.border" borderRadius="md" p="2">
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
              <chakra.ul fontSize="xs" color="app.textMuted" paddingLeft="18px" margin={0}>
                {combined.warnings.map((w, i) => (
                  <chakra.li key={i}>{w}</chakra.li>
                ))}
              </chakra.ul>
            )}
          </chakra.div>
        )}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose} disabled={applying}>
          {t("sandboxReviewClose")}
        </Button>
        <Button type="button" onClick={loadAll} disabled={loading || applying}>
          {t("sandboxReviewRefresh")}
        </Button>
        <LoadingButton
          loading={generating}
          onClick={generate}
          disabled={loading || !targetSessionId || unresolvedCount > 0}
        >
          {t("sandboxReviewGenerate")}
        </LoadingButton>
        <LoadingButton
          pressable
          variant="primary"
          loading={applying}
          onClick={apply}
          disabled={!combined || combined.statements.length === 0 || !targetSessionId}
        >
          {t("sandboxApplyTitle", { count: combined?.statements.length ?? 0 })}
        </LoadingButton>
      </ModalFooter>
      {confirmDialog}
      {typedConfirmDialog}
    </Modal>
  );
}

function schemaStatusLabel(status: DiffStatus, t: ReturnType<typeof useT>): string {
  switch (status) {
    case "source_only":
      return t("schemaCompareStatusSourceOnly");
    case "target_only":
      return t("schemaCompareStatusTargetOnly");
    case "different":
      return t("schemaCompareStatusDifferent");
    case "same":
      return t("schemaCompareStatusSame");
  }
}
