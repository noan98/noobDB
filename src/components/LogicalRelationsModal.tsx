import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { downloadDir, join } from "@tauri-apps/api/path";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import type { LogicalRelation, LogicalRelationInput, LogicalRelationsImportParse } from "../api/tauri";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import {
  type ImportBlockReason,
  type LogicalRelationCandidate,
  type SuggestTable,
  classifyImport,
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
import { Button, Checkbox, Radio } from "./ui";

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

/** 取り込めない関係を一覧に出す最大件数 (超えた分は件数だけ示す)。 */
const BLOCKED_PREVIEW_LIMIT = 50;

type ImportMode = "add" | "replace";

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

  const [importing, setImporting] = useState<LogicalRelationsImportParse | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>("add");

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

  const classified = useMemo(
    () => (importing && loaded ? classifyImport(importing.relations, loaded.tables, loaded.relations) : null),
    [importing, loaded],
  );

  const describeReason = (reason: ImportBlockReason) =>
    reason.kind === "missingTable"
      ? t("logicalRelImportMissingTable", { table: reason.table })
      : t("logicalRelImportMissingColumn", { table: reason.table, column: reason.column });

  // 登録済みの定義だけを JSON へ書き出す (profile_id・接続情報は Rust 側で落とす)。保存先は保存ダイアログ、
  // 書き込みは既存の `write_text_file` (Rust 経由。fs capability は増やさない)。
  const handleExport = async () => {
    if (!loaded || loaded.relations.length === 0) return;
    try {
      let defaultPath = `noobdb-logical-relations-${database}.json`;
      try {
        defaultPath = await join(await downloadDir(), defaultPath);
      } catch {
        // ダウンロードフォルダが解決できない環境ではファイル名のみで開く。
      }
      const picked = await saveFileDialog({
        defaultPath,
        title: t("logicalRelExport"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      const json = await api.exportLogicalRelations(sessionId, database);
      await api.writeTextFile(picked, json);
      toast.success(t("logicalRelExportSaved", { count: loaded.relations.length, path: picked }));
    } catch (e) {
      toast.error(t("logicalRelExportError", { error: String(e) }));
    }
  };

  // ファイルを選んで読み、接続先のスキーマと照合したプレビューを出す (まだ何も保存しない)。
  const handleImportPick = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: t("logicalRelImport"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      const json = await api.readTextFile(picked);
      const parsed = await api.parseLogicalRelationsImport(json);
      if (!mountedRef.current) return;
      setImportMode("add");
      setImporting(parsed);
    } catch (e) {
      toast.error(t("logicalRelImportError", { error: String(e) }));
    }
  };

  const confirmImport = async () => {
    if (!classified || busy) return;
    const applicable = [...classified.addable, ...classified.existing];
    if (importMode === "add" ? classified.addable.length === 0 : applicable.length === 0) return;
    setBusy(true);
    try {
      const relations =
        importMode === "add"
          ? await api.saveLogicalRelations(sessionId, database, classified.addable.map(relationInput))
          : await api.replaceLogicalRelations(sessionId, database, applicable.map(relationInput));
      onChanged?.(database);
      if (!mountedRef.current) return;
      setLoaded((l) => (l ? { ...l, relations } : l));
      setImporting(null);
      toast.success(
        t("logicalRelImportDone", {
          count: importMode === "add" ? classified.addable.length : applicable.length,
        }),
      );
    } catch (e) {
      toast.error(t("logicalRelImportError", { error: String(e) }));
    } finally {
      if (mountedRef.current) setBusy(false);
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
              <Flex align="center" gap="2">
                <FieldLabel as="div">{t("logicalRelRegistered")}</FieldLabel>
                <div style={{ flex: 1 }} />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || loaded.relations.length === 0}
                  onClick={() => void handleExport()}
                >
                  <Icon name="download" size={ICON_SIZES.sm} />
                  <chakra.span marginLeft="1.5">{t("logicalRelExport")}</chakra.span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleImportPick()}
                >
                  <Icon name="upload" size={ICON_SIZES.sm} />
                  <chakra.span marginLeft="1.5">{t("logicalRelImport")}</chakra.span>
                </Button>
              </Flex>
              {importing && classified && (
                <chakra.div
                  display="flex"
                  flexDirection="column"
                  gap="2"
                  p="3"
                  border="1px solid"
                  borderColor="app.border"
                  borderRadius="md"
                  data-testid="logical-relations-import"
                >
                  <FieldLabel as="div">{t("logicalRelImportPreview")}</FieldLabel>
                  <chakra.p fontSize="sm" color="app.textSecondary">
                    {t("logicalRelImportSummary", {
                      addable: classified.addable.length,
                      existing: classified.existing.length,
                      blocked: classified.blocked.length,
                    })}
                    {importing.duplicate_in_file_count > 0 &&
                      ` ${t("logicalRelImportFileDuplicates", { count: importing.duplicate_in_file_count })}`}
                  </chakra.p>
                  {importing.rejected.length > 0 && (
                    <Callout tone="warning" role="status">
                      {t("logicalRelImportRejected", {
                        count: importing.rejected.length,
                        detail: importing.rejected
                          .slice(0, 3)
                          .map((r) => `#${r.index + 1}: ${r.error}`)
                          .join(" / "),
                      })}
                    </Callout>
                  )}
                  {classified.blocked.length > 0 && (
                    <>
                      <FieldLabel as="div">{t("logicalRelImportBlocked")}</FieldLabel>
                      <Flex direction="column" gap="1" role="list" aria-label={t("logicalRelImportBlocked")}>
                        {classified.blocked.slice(0, BLOCKED_PREVIEW_LIMIT).map((b) => (
                          <Flex key={relationKey(b.relation)} role="listitem" direction="column" px="2">
                            <chakra.span fontFamily="mono" fontSize="sm" wordBreak="break-all">
                              {describe(b.relation)}
                            </chakra.span>
                            <chakra.span textStyle="caption">{describeReason(b.reason)}</chakra.span>
                          </Flex>
                        ))}
                        {classified.blocked.length > BLOCKED_PREVIEW_LIMIT && (
                          <chakra.span textStyle="caption" px="2">
                            {t("logicalRelImportBlockedMore", {
                              count: classified.blocked.length - BLOCKED_PREVIEW_LIMIT,
                            })}
                          </chakra.span>
                        )}
                      </Flex>
                    </>
                  )}
                  <Flex direction="column" gap="1" role="radiogroup" aria-label={t("logicalRelImportMode")}>
                    {(["add", "replace"] as const).map((m) => (
                      <chakra.label key={m} display="flex" alignItems="flex-start" gap="2" cursor="pointer">
                        <Radio
                          name="logical-relations-import-mode"
                          checked={importMode === m}
                          onChange={() => setImportMode(m)}
                          mt="0.75"
                        />
                        <chakra.span display="flex" flexDirection="column">
                          <chakra.span textStyle="subheading">
                            {t(m === "add" ? "logicalRelImportAdd" : "logicalRelImportReplace")}
                          </chakra.span>
                          <chakra.span textStyle="caption">
                            {t(m === "add" ? "logicalRelImportAddDesc" : "logicalRelImportReplaceDesc")}
                          </chakra.span>
                        </chakra.span>
                      </chakra.label>
                    ))}
                  </Flex>
                  {importMode === "replace" && (
                    <Callout tone="warning" role="status">
                      {t("logicalRelImportReplaceWarn", {
                        count: loaded.relations.filter(
                          (r) => !classified.existing.some((e) => relationKey(e) === relationKey(r)),
                        ).length,
                      })}
                    </Callout>
                  )}
                  <Flex align="center" gap="2">
                    <div style={{ flex: 1 }} />
                    <Button type="button" variant="secondary" size="sm" onClick={() => setImporting(null)}>
                      {t("logicalRelImportCancel")}
                    </Button>
                    <Button
                      type="button"
                      variant={importMode === "replace" ? "dangerOutline" : "primary"}
                      size="sm"
                      disabled={
                        busy ||
                        (importMode === "add"
                          ? classified.addable.length === 0
                          : classified.addable.length + classified.existing.length === 0)
                      }
                      onClick={() => void confirmImport()}
                    >
                      {t("logicalRelImportApply")}
                    </Button>
                  </Flex>
                </chakra.div>
              )}
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
