import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import {
  api,
  type CellValue,
  type RowMergeBlocker,
  type RowMergeConflictPolicy,
  type RowMergeRequest,
  type RowMergeOutcome,
  type RowMergePreview,
} from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { ImpactTree, type ImpactGroup } from "./ImpactTree";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { blockerMessage, picksToRequest, undoDeclineMessage, type RowMergeTarget } from "./rowMerge";
import { Segmented } from "./Segmented";
import { Spinner } from "./Spinner";
import { SqlPreview } from "./SqlPreview";
import { Button, Radio } from "./ui";

/**
 * 重複レコードのマージ (#2303)。残す行と、列ごとにどの行の値を残すかを選び、子テーブルの参照の付け替え件数
 * (影響ツリー)・子側の一意キーの衝突・実行する SQL を確認してから、1 トランザクションで実行する。
 *
 * プレビューはバックエンド (`preview_row_merge`、読み取りのみ) が DB から行を読み直して計画する。
 * 実行も実行直前に同じ計画を立て直し、衝突があれば何も書かない。破壊的な書き込みなので、確認は
 * 呼び出し側の `onConfirm` (本番 / 書き込み確認の実行ゲート) を通る。
 */
interface Props {
  sessionId: string;
  driver: string;
  database: string;
  table: string;
  target: Pick<RowMergeTarget, "keyColumns" | "keys">;
  readOnly: boolean;
  /** フライトレコーダー有効。指定すると記録して Undo できるようにする。 */
  capture: { rowCap: number | null; retentionDays: number | null } | null;
  /** 実行前の確認 (本番 / 書き込み確認)。false なら実行しない。 */
  onConfirm: (sql: string) => Promise<boolean>;
  onApplied: (outcome: Extract<RowMergeOutcome, { status: "applied" }>) => void;
  onClose: () => void;
}

const MAX_CELL_CHARS = 60;

function cellText(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "NULL";
  const s = String(v);
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
}

export function RowMergeModal({
  sessionId,
  driver,
  database,
  table,
  target,
  readOnly,
  capture,
  onConfirm,
  onApplied,
  onClose,
}: Props) {
  const t = useT();
  const [survivorIdx, setSurvivorIdx] = useState(0);
  // 列名 → 採用元 (表示順の添字)。null は提案値。
  const [overrides, setOverrides] = useState<Record<string, number> | null>(null);
  const [policy, setPolicy] = useState<RowMergeConflictPolicy>("abort");
  const [preview, setPreview] = useState<RowMergePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<RowMergeBlocker[] | null>(null);
  const seq = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 残す行を先頭に、残りを重複行として並べる (プレビューの `rows` の並びと同じ)。
  const order = useMemo(
    () => [survivorIdx, ...target.keys.map((_, i) => i).filter((i) => i !== survivorIdx)],
    [survivorIdx, target.keys],
  );

  const request = useCallback(
    (
      picks: { column: string; fromRow: number }[] | null,
      expected: RowMergeRequest["expected"] = null,
    ): RowMergeRequest => ({
      keyColumns: target.keyColumns,
      survivor: target.keys[order[0] ?? 0] ?? [],
      losers: order.slice(1).map((i) => target.keys[i] ?? []),
      picks,
      conflictPolicy: policy,
      expected,
    }),
    [target, order, policy],
  );

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const picks = overrides
        ? Object.entries(overrides).map(([column, fromRow]) => ({ column, fromRow }))
        : null;
      const p = await api.previewRowMerge({
        sessionId,
        database,
        table,
        request: request(picks),
        rowCap: capture?.rowCap ?? null,
      });
      if (my === seq.current) setPreview(p);
    } catch (e) {
      if (my === seq.current) {
        setPreview(null);
        setError(String(e));
      }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [sessionId, database, table, request, overrides, capture?.rowCap]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickFrom = (column: string, from: number) => {
    // 現在の採用元を土台に、この列だけ差し替える。
    const base: Record<string, number> = overrides ?? {};
    if (!overrides && preview) for (const r of picksToRequest(preview)) base[r.column] = r.fromRow;
    setOverrides({ ...base, [column]: from });
  };

  const blockers = blocked ?? preview?.blockers ?? [];
  const canRun = !!preview && blockers.length === 0 && !loading && !applying && !readOnly;

  const run = async () => {
    if (!preview) return;
    setError(null);
    setBlocked(null);
    if (!(await onConfirm(preview.statements.join(";\n")))) return;
    setApplying(true);
    try {
      const out = await api.applyRowMerge({
        sessionId,
        database,
        table,
        // プレビューで見せた計画を添える。実行の直前に DB が変わっていれば、何も書かれずに `changed` が返る。
        request: request(picksToRequest(preview), {
          statements: preview.statements,
          childRows: preview.children.map((c) => c.rows + c.skipped + c.deleted),
        }),
        capture: capture ? { rowCap: capture.rowCap, retentionDays: capture.retentionDays } : null,
      });
      if (out.status === "applied") {
        onApplied(out);
        onClose();
        return;
      }
      if (out.status === "blocked") setBlocked(out.blockers);
      else if (out.status === "changed") {
        // 先に読み直しを始める (読み込み開始時にエラー表示を消すため)。メッセージはその後に出す。
        void load();
        setError(
          out.statementsChanged && out.expectedRows === out.actualRows
            ? t("rowMergeChangedStatements")
            : t("rowMergeChanged", { expected: out.expectedRows, actual: out.actualRows }),
        );
      } else setError(t("rowMergeRollbackIncomplete"));
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  const groups = useMemo<ImpactGroup[]>(() => {
    if (!preview || preview.children.length === 0) return [];
    return [
      {
        key: "parent",
        origin: { kind: "table", name: table },
        nodes: preview.children.map((c, i) => ({
          key: `${c.schema ?? ""}.${c.table}.${c.constraint}.${i}`,
          kind: "table" as const,
          kindLabel: c.schema ? `${c.schema}` : undefined,
          name: `${c.table}.${c.columns.join(", ")}`,
          outcome: "change" as const,
          meta: [
            t("rowMergeChildRows", { count: c.rows.toLocaleString() }),
            c.skipped > 0 ? t("rowMergeChildSkipped", { count: c.skipped.toLocaleString() }) : null,
            c.deleted > 0 ? t("rowMergeChildDeleted", { count: c.deleted.toLocaleString() }) : null,
            c.onDelete ? `ON DELETE ${c.onDelete}` : null,
            c.selfReference ? t("rowMergeChildSelf") : null,
          ]
            .filter(Boolean)
            .join(" ・ "),
          testId: `row-merge-child-${c.table}`,
        })),
      },
    ];
  }, [preview, table, t]);

  const rowLabel = (pos: number) => (pos === 0 ? t("rowMergeKeep") : t("rowMergeDuplicate", { n: pos }));

  return (
    <Modal
      // no-submit: 破壊的な書き込み。Enter / Cmd+Enter で誤って実行させず、キャンセルが既定
      width="760px"
      onClose={onClose}
      initialFocusEl={() => cancelRef.current}
    >
      <ModalHeader onClose={onClose} closeLabel={t("rowMergeClose")}>
        {t("rowMergeTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.p textStyle="caption">{t("rowMergeIntro")}</chakra.p>
        {readOnly && <Callout tone="warning">{t("rowMergeReadOnly")}</Callout>}
        {loading && !preview && (
          <chakra.div display="flex" alignItems="center" gap="2">
            <Spinner size={14} />
            <chakra.span textStyle="caption">{t("rowMergeLoading")}</chakra.span>
          </chakra.div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        {blockers.length > 0 && (
          <Callout
            tone="danger"
            role="status"
            title={t("rowMergeBlockedTitle")}
            data-testid="row-merge-blockers"
          >
            <chakra.ul m={0} pl="4">
              {blockers.map((b, i) => {
                const m = blockerMessage(b);
                return <li key={`${b.kind}-${i}`}>{t(m.key, m.params)}</li>;
              })}
            </chakra.ul>
          </Callout>
        )}
        {preview && (
          <>
            <FormSection>
              <FieldLabel as="div">{t("rowMergeColumns")}</FieldLabel>
              <chakra.div overflowX="auto" maxH="280px" overflowY="auto" data-testid="row-merge-matrix">
                <chakra.table borderCollapse="collapse" fontSize="sm" width="100%">
                  <thead>
                    <tr>
                      <chakra.th textAlign="left" px="2" py="1" textStyle="caption">
                        {t("rowMergeColumn")}
                      </chakra.th>
                      {order.map((ri, pos) => (
                        <chakra.th key={ri} textAlign="left" px="2" py="1" textStyle="caption">
                          <chakra.label display="inline-flex" alignItems="center" gap="1.5" cursor="pointer">
                            <Radio
                              name="row-merge-survivor"
                              checked={pos === 0}
                              onChange={() => {
                                setSurvivorIdx(ri);
                                setOverrides(null);
                              }}
                              aria-label={t("rowMergePickSurvivor", { n: ri + 1 })}
                            />
                            {t("rowMergeRowN", { n: ri + 1 })} ({rowLabel(pos)})
                          </chakra.label>
                        </chakra.th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.columns.map((c, ci) => (
                      <tr key={c.name}>
                        <chakra.td px="2" py="0.5" fontFamily="mono" whiteSpace="nowrap">
                          {c.name}
                          {c.locked && (
                            <chakra.span textStyle="caption" color="app.textMuted" ml="1">
                              {t("rowMergeLocked")}
                            </chakra.span>
                          )}
                        </chakra.td>
                        {preview.rows.map((row, pos) => {
                          const picked = preview.picks[ci] === pos;
                          return (
                            <chakra.td key={`${c.name}-${pos}`} px="1" py="0.5">
                              <chakra.button
                                type="button"
                                role="radio"
                                aria-checked={picked}
                                disabled={c.locked || applying}
                                onClick={() => pickFrom(c.name, pos)}
                                width="100%"
                                textAlign="left"
                                px="1.5"
                                py="0.5"
                                borderRadius="sm"
                                border="1px solid"
                                borderColor={picked ? "app.accent" : "transparent"}
                                bg={picked ? "app.accentHighlight" : "transparent"}
                                color={row[ci] === null ? "app.textMuted" : "app.text"}
                                fontFamily="mono"
                                cursor={c.locked ? "default" : "pointer"}
                                _hover={c.locked ? undefined : { bg: "app.hover" }}
                                data-testid={`row-merge-cell-${c.name}-${pos}`}
                              >
                                {cellText(row[ci])}
                              </chakra.button>
                            </chakra.td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </chakra.table>
              </chakra.div>
            </FormSection>

            <FormSection>
              <FieldLabel as="div">{t("rowMergeChildren")}</FieldLabel>
              {groups.length === 0 ? (
                <chakra.span textStyle="caption" data-testid="row-merge-no-children">
                  {t("rowMergeNoChildren")}
                </chakra.span>
              ) : (
                <ImpactTree groups={groups} testId="row-merge-tree" />
              )}
            </FormSection>

            {preview.conflicts.length > 0 && (
              <FormSection>
                <Callout tone="warning" title={t("rowMergeConflictTitle")} data-testid="row-merge-conflicts">
                  <chakra.ul m={0} pl="4">
                    {preview.conflicts.map((c) => (
                      <li key={`${c.table}.${c.index}`}>
                        {t("rowMergeConflictLine", {
                          table: c.table,
                          index: c.index,
                          groups: c.groups,
                          rows: c.rows,
                        })}
                      </li>
                    ))}
                  </chakra.ul>
                </Callout>
                <FieldLabel as="div">{t("rowMergePolicy")}</FieldLabel>
                <Segmented
                  ariaLabel={t("rowMergePolicy")}
                  value={policy}
                  onChange={(v) => {
                    setPolicy(v);
                    setBlocked(null);
                  }}
                  options={[
                    { value: "abort", label: t("rowMergePolicyAbort") },
                    { value: "delete_colliding", label: t("rowMergePolicyDelete") },
                    { value: "skip_repoint", label: t("rowMergePolicySkip") },
                  ]}
                />
              </FormSection>
            )}

            {preview.fkEnforced === false && <Callout tone="warning">{t("rowMergeFkOff")}</Callout>}
            {preview.warnings.map((w, i) => (
              <Callout key={`${w.kind}-${i}`} tone="warning">
                {w.kind === "crossDatabaseChild"
                  ? t("rowMergeWarnCrossDb", { table: w.table })
                  : t("rowMergeWarnUnchecked", { table: w.table, index: w.index })}
              </Callout>
            ))}
            {capture && preview.undoDecline && (
              <Callout tone="warning" data-testid="row-merge-undo-decline">
                {(() => {
                  const m = undoDeclineMessage(preview.undoDecline);
                  return t(m.key, m.params);
                })()}
              </Callout>
            )}
            {!capture && <Callout tone="info">{t("rowMergeUndoOff")}</Callout>}

            <FormSection>
              <FieldLabel as="div">{t("rowMergeSql")}</FieldLabel>
              <SqlPreview sql={preview.statements.join(";\n") + ";"} driver={driver} />
            </FormSection>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="dangerOutline" disabled={!canRun} onClick={() => void run()}>
          {applying ? t("rowMergeRunning") : t("rowMergeRun")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button ref={cancelRef} type="button" variant="primary" onClick={onClose} disabled={applying}>
          {t("rowMergeCancel")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
