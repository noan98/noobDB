import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { LogicalRelation, LogicalRelationInput } from "../api/tauri";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import {
  type LogicalRelationCandidate,
  type SuggestTable,
  relationInput,
  relationKey,
  suggestLogicalRelations,
} from "../logicalRelations";
import { Callout } from "./Callout";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { ListboxSelect } from "./ListboxSelect";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Skeleton } from "./Skeleton";
import { useToast } from "./Toast";
import { Button, Checkbox } from "./ui";

/**
 * 論理リレーション (仮想 FK, #2356) の管理ダイアログ。FK 制約を張っていない DB で、`user_id` のような
 * 命名規約だけで表されている関係を、アプリ側にだけ登録する (DB には何も書かない)。登録したものは
 * FK ジャンプ・関連行・ER 図・JOIN 補完・クエリビルダが宣言済み FK と同じように使う。
 * 「候補を推定」は列名 (`<名前>_id` / `<名前>Id`) と表名・主キー・型の一致から候補を出し、
 * 利用者がチェックしたものだけを登録する。
 */
interface Props {
  sessionId: string;
  database: string;
  /** 登録・削除に成功したとき (キャッシュの取り直しを親に任せる)。 */
  onChanged?: (database: string) => void;
  onClose: () => void;
}

interface Loaded {
  tables: SuggestTable[];
  relations: LogicalRelation[];
  /** FK 制約として宣言済みの (子テーブル, 列)。推定で重複して提案しないために使う。 */
  declared: { table: string; column: string }[];
}

interface PairRow {
  id: number;
  column: string;
  referencedColumn: string;
}

const describe = (r: LogicalRelationInput) =>
  `${r.table} (${r.columns.join(", ")}) → ${r.referenced_table} (${r.referenced_columns.join(", ")})`;

export function LogicalRelationsModal({ sessionId, database, onChanged, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const closeRef = useRef<HTMLButtonElement>(null);

  const [childTable, setChildTable] = useState("");
  const [parentTable, setParentTable] = useState("");
  const nextId = useRef(1);
  const [pairs, setPairs] = useState<PairRow[]>([{ id: 0, column: "", referencedColumn: "" }]);

  const [candidates, setCandidates] = useState<LogicalRelationCandidate[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [described, relations, fks] = await Promise.all([
        api.describeDatabase(sessionId, database),
        api.listLogicalRelations(sessionId, database),
        api.foreignKeys(sessionId, database),
      ]);
      if (cancelled) return;
      setLoaded({
        tables: described.map((tb) => ({ name: tb.name, columns: tb.columns })),
        relations,
        declared: fks.filter((f) => !f.logical).map((f) => ({ table: f.table, column: f.column })),
      });
    })().catch((e) => {
      if (!cancelled) setLoadError(String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database]);

  const tableOptions = useMemo(() => (loaded?.tables ?? []).map((tb) => ({ value: tb.name })), [loaded]);
  const columnsOf = useCallback(
    (table: string) =>
      (loaded?.tables.find((tb) => tb.name === table)?.columns ?? []).map((c) => ({ value: c.name })),
    [loaded],
  );

  const manual: LogicalRelationInput | null =
    childTable !== "" &&
    parentTable !== "" &&
    pairs.length > 0 &&
    pairs.every((p) => p.column !== "" && p.referencedColumn !== "") &&
    new Set(pairs.map((p) => p.column)).size === pairs.length
      ? {
          table: childTable,
          columns: pairs.map((p) => p.column),
          referenced_table: parentTable,
          referenced_columns: pairs.map((p) => p.referencedColumn),
        }
      : null;
  const registered = useMemo(() => new Set((loaded?.relations ?? []).map(relationKey)), [loaded]);
  const manualDuplicate = manual !== null && registered.has(relationKey(manual));

  const save = async (inputs: LogicalRelationInput[]): Promise<boolean> => {
    if (busy || inputs.length === 0) return false;
    setBusy(true);
    try {
      const relations = await api.saveLogicalRelations(sessionId, database, inputs.map(relationInput));
      onChanged?.(database);
      if (!mountedRef.current) return true;
      setLoaded((l) => (l ? { ...l, relations } : l));
      toast.success(t("logicalRelSaved", { count: inputs.length }));
      return true;
    } catch (e) {
      toast.error(t("logicalRelSaveError", { error: String(e) }));
      return false;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const remove = async (r: LogicalRelation) => {
    if (busy) return;
    setBusy(true);
    try {
      const relations = await api.deleteLogicalRelation(sessionId, database, relationInput(r));
      if (mountedRef.current) setLoaded((l) => (l ? { ...l, relations } : l));
      onChanged?.(database);
    } catch (e) {
      toast.error(t("logicalRelDeleteError", { error: String(e) }));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const addManual = async () => {
    if (!manual || manualDuplicate) return;
    if (await save([manual])) {
      setChildTable("");
      setParentTable("");
      setPairs([{ id: nextId.current++, column: "", referencedColumn: "" }]);
    }
  };

  const suggest = () => {
    if (!loaded) return;
    const found = suggestLogicalRelations(loaded.tables, [
      ...loaded.declared,
      ...loaded.relations.flatMap((r) => r.columns.map((column) => ({ table: r.table, column }))),
    ]);
    setCandidates(found);
    setChecked(new Set(found.filter((c) => c.via === "exact").map(relationKey)));
  };

  const registerChecked = async () => {
    const picked = (candidates ?? []).filter((c) => checked.has(relationKey(c)));
    if (await save(picked)) {
      const done = new Set(picked.map(relationKey));
      setCandidates((cs) => (cs ?? []).filter((c) => !done.has(relationKey(c))));
      setChecked(new Set());
    }
  };

  const updatePair = (id: number, patch: Partial<PairRow>) =>
    setPairs((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const pickedCount = (candidates ?? []).filter((c) => checked.has(relationKey(c))).length;
  const loading = loaded === null && loadError === null;

  return (
    <Modal
      // no-submit: 登録は各セクションのボタンで個別に行う管理画面で、確定する主アクションが無い (閉じるのみ)
      width="720px"
      onClose={onClose}
      initialFocusEl={() => closeRef.current}
    >
      <ModalHeader onClose={onClose} closeLabel={t("logicalRelClose")}>
        {t("logicalRelTitle", { database })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <Callout tone="info">{t("logicalRelNote")}</Callout>
        {loadError && <ErrorNote>{t("logicalRelLoadError", { error: loadError })}</ErrorNote>}
        {loading && (
          <chakra.div
            role="status"
            aria-label={t("spinnerLoadingAria")}
            display="flex"
            flexDirection="column"
            gap="2"
          >
            {[60, 45, 52].map((w, i) => (
              <Skeleton
                key={i}
                style={{ width: `${w}%`, height: "var(--space-6)", borderRadius: "var(--radius-md)" }}
              />
            ))}
          </chakra.div>
        )}

        {loaded && (
          <>
            <FormSection>
              <FieldLabel as="div">{t("logicalRelRegistered")}</FieldLabel>
              {loaded.relations.length === 0 ? (
                <EmptyState compact icon="link" title={t("logicalRelEmpty")} />
              ) : (
                <Flex direction="column" gap="1" role="list" aria-label={t("logicalRelRegistered")}>
                  {loaded.relations.map((r) => (
                    <Flex
                      key={relationKey(r)}
                      role="listitem"
                      align="center"
                      gap="2"
                      py="1"
                      px="2"
                      border="1px solid"
                      borderColor="app.border"
                      borderRadius="md"
                    >
                      <chakra.span flex="1" minW={0} fontFamily="mono" fontSize="sm" wordBreak="break-all">
                        {describe(r)}
                      </chakra.span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t("logicalRelDelete", { relation: describe(r) })}
                        onClick={() => void remove(r)}
                      >
                        <Icon name="trash" size={ICON_SIZES.sm} />
                      </Button>
                    </Flex>
                  ))}
                </Flex>
              )}
            </FormSection>

            <FormSection>
              <Flex align="center" gap="2">
                <FieldLabel as="div">{t("logicalRelSuggestTitle")}</FieldLabel>
                <div style={{ flex: 1 }} />
                <Button type="button" variant="secondary" size="sm" onClick={suggest} disabled={busy}>
                  <Icon name="search" size={ICON_SIZES.sm} />
                  <chakra.span marginLeft="1.5">{t("logicalRelSuggest")}</chakra.span>
                </Button>
              </Flex>
              {candidates !== null &&
                (candidates.length === 0 ? (
                  <chakra.span textStyle="caption">{t("logicalRelNoCandidates")}</chakra.span>
                ) : (
                  <>
                    <Flex direction="column" gap="1" role="list" aria-label={t("logicalRelSuggestTitle")}>
                      {candidates.map((c) => {
                        const key = relationKey(c);
                        return (
                          <chakra.label
                            key={key}
                            role="listitem"
                            display="flex"
                            alignItems="center"
                            gap="2"
                            py="1"
                            px="2"
                            cursor="pointer"
                          >
                            <Checkbox
                              checked={checked.has(key)}
                              disabled={busy}
                              aria-label={t("logicalRelPick", { relation: describe(c) })}
                              onChange={(e) =>
                                setChecked((s) => {
                                  const next = new Set(s);
                                  if (e.target.checked) next.add(key);
                                  else next.delete(key);
                                  return next;
                                })
                              }
                            />
                            <chakra.span
                              flex="1"
                              minW={0}
                              fontFamily="mono"
                              fontSize="sm"
                              wordBreak="break-all"
                            >
                              {describe(c)}
                            </chakra.span>
                            {c.via === "suffix" && (
                              <chakra.span textStyle="caption">{t("logicalRelViaSuffix")}</chakra.span>
                            )}
                          </chakra.label>
                        );
                      })}
                    </Flex>
                    <Flex>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={busy || pickedCount === 0}
                        onClick={() => void registerChecked()}
                      >
                        {t("logicalRelRegisterPicked", { count: pickedCount })}
                      </Button>
                    </Flex>
                  </>
                ))}
            </FormSection>

            <FormSection>
              <FieldLabel as="div">{t("logicalRelManualTitle")}</FieldLabel>
              <Flex gap="2" align="center" flexWrap="wrap">
                <chakra.span fontSize="sm" color="app.textMuted">
                  {t("logicalRelChild")}
                </chakra.span>
                <ListboxSelect
                  ariaLabel={t("logicalRelChild")}
                  value={childTable}
                  placeholder={t("logicalRelPickTable")}
                  options={tableOptions}
                  onChange={(v) => {
                    setChildTable(v);
                    setPairs((ps) => ps.map((p) => ({ ...p, column: "" })));
                  }}
                  css={{ minWidth: "180px" }}
                />
                <chakra.span fontSize="sm" color="app.textMuted">
                  {t("logicalRelParent")}
                </chakra.span>
                <ListboxSelect
                  ariaLabel={t("logicalRelParent")}
                  value={parentTable}
                  placeholder={t("logicalRelPickTable")}
                  options={tableOptions}
                  onChange={(v) => {
                    setParentTable(v);
                    setPairs((ps) => ps.map((p) => ({ ...p, referencedColumn: "" })));
                  }}
                  css={{ minWidth: "180px" }}
                />
              </Flex>
              {pairs.map((p, i) => (
                <Flex key={p.id} gap="2" align="center">
                  <ListboxSelect
                    ariaLabel={t("logicalRelChildColumn")}
                    value={p.column}
                    placeholder={t("logicalRelPickColumn")}
                    options={columnsOf(childTable)}
                    disabled={childTable === ""}
                    onChange={(v) => updatePair(p.id, { column: v })}
                    css={{ minWidth: "160px" }}
                  />
                  <chakra.span aria-hidden color="app.textMuted">
                    →
                  </chakra.span>
                  <ListboxSelect
                    ariaLabel={t("logicalRelParentColumn")}
                    value={p.referencedColumn}
                    placeholder={t("logicalRelPickColumn")}
                    options={columnsOf(parentTable)}
                    disabled={parentTable === ""}
                    onChange={(v) => updatePair(p.id, { referencedColumn: v })}
                    css={{ minWidth: "160px" }}
                  />
                  {pairs.length > 1 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("logicalRelRemovePair")}
                      onClick={() => setPairs((ps) => ps.filter((x) => x.id !== p.id))}
                    >
                      <Icon name="trash" size={ICON_SIZES.sm} />
                    </Button>
                  )}
                  {i === pairs.length - 1 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("logicalRelAddPair")}
                      onClick={() =>
                        setPairs((ps) => [...ps, { id: nextId.current++, column: "", referencedColumn: "" }])
                      }
                    >
                      <Icon name="plus" size={ICON_SIZES.sm} />
                    </Button>
                  )}
                </Flex>
              ))}
              <Flex align="center" gap="2">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={busy || manual === null || manualDuplicate}
                  onClick={() => void addManual()}
                >
                  {t("logicalRelAdd")}
                </Button>
                {manualDuplicate && <chakra.span textStyle="caption">{t("logicalRelDuplicate")}</chakra.span>}
              </Flex>
            </FormSection>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="primary" ref={closeRef} onClick={onClose}>
          {t("logicalRelClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
