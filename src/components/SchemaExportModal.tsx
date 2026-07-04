import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { save } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import { api, type DriverKind, type ForeignKey, type TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Input, Radio, Switch } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { useToast } from "./Toast";
import { Icon } from "./Icon";
import { copyToClipboard } from "./clipboard";
import { mapLimited } from "./mapLimited";
import {
  buildSchemaMarkdown,
  defaultSchemaFilename,
  expandWithFkRelated,
  type SchemaExportTable,
} from "./schemaExport";

/** プレビュー欄に表示する最大行数 (コピー/保存は全文が対象)。 */
const PREVIEW_LINES = 200;

interface Props {
  sessionId: string;
  database: string;
  driver: DriverKind;
  onClose: () => void;
}

type LoadState =
  | { kind: "loading"; done: number; total: number }
  | { kind: "error"; message: string }
  | { kind: "ready" };

/** 出力対象: DB 全体 / 選択したテーブル。 */
type ExportScope = "all" | "selected";

type SaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

/**
 * DB スキーマを AI 向けの Markdown としてコピー/保存するモーダル。
 * 開いた時点で全テーブルの列詳細を先読みする (`describeTable` を並列 8 で全走査)
 * ため、対象テーブルの選択変更は再取得なしで即プレビューへ反映される。
 */
export function SchemaExportModal({ sessionId, database, driver, onClose }: Props) {
  const t = useT();
  const toast = useToast();

  const [load, setLoad] = useState<LoadState>({ kind: "loading", done: 0, total: 0 });
  const [tables, setTables] = useState<SchemaExportTable[]>([]);
  const [fks, setFks] = useState<ForeignKey[]>([]);

  const [scope, setScope] = useState<ExportScope>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [includeRelated, setIncludeRelated] = useState(true);
  const [filter, setFilter] = useState("");

  const [path, setPath] = useState<string>(() => defaultSchemaFilename(database));
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  // ExportModal と同じガード: ユーザがパスを編集済みなら既定の保存先
  // (ダウンロードフォルダ) の後付けで上書きしない。
  const userEditedPathRef = useRef(false);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  // スキーマ全体 (テーブル一覧 + FK) と全テーブルの列詳細を先読みする。
  // ERDiagramView と同じ取得パターン。テーブル単位の describeTable 失敗は
  // columns: null (出力にプレースホルダ) へ落として続行する。
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading", done: 0, total: 0 });
    (async () => {
      const [overview, foreignKeys] = await Promise.all([
        api.schemaOverview(sessionId, database),
        api.foreignKeys(sessionId, database),
      ]);
      if (cancelled) return;
      setLoad({ kind: "loading", done: 0, total: overview.length });
      const detailed = await mapLimited(overview, 8, async (tb) => {
        let columns: TableColumnInfo[] | null;
        try {
          columns = await api.describeTable(sessionId, database, tb.name);
        } catch {
          columns = null;
        }
        if (!cancelled) {
          setLoad((cur) => (cur.kind === "loading" ? { ...cur, done: cur.done + 1 } : cur));
        }
        return { name: tb.name, columns };
      });
      if (cancelled) return;
      setTables(detailed);
      setFks(foreignKeys);
      setLoad({ kind: "ready" });
    })().catch((e) => {
      if (!cancelled) setLoad({ kind: "error", message: String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database]);

  // 既定の保存先を OS のダウンロードフォルダにする (ExportModal と同じ方針)。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dir = await downloadDir();
        if (cancelled || userEditedPathRef.current) return;
        const full = await join(dir, defaultSchemaFilename(database));
        if (cancelled || userEditedPathRef.current) return;
        setPath(full);
      } catch {
        // ダウンロードフォルダが解決できない環境ではファイル名のままにする。
      }
    })();
    return () => {
      cancelled = true;
    };
    // マウント時に一度だけ実行する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 実効出力集合。選択モードで「FK 関連も含める」が ON なら選択の FK 推移的閉包。
  // null は「DB 全体」(絞り込みなし) を表す。
  const effectiveNames = useMemo<ReadonlySet<string> | null>(() => {
    if (scope === "all") return null;
    const base = [...selected];
    return includeRelated ? expandWithFkRelated(base, fks) : new Set(base);
  }, [scope, selected, includeRelated, fks]);

  const effectiveTables = useMemo(
    () => (effectiveNames === null ? tables : tables.filter((tb) => effectiveNames.has(tb.name))),
    [tables, effectiveNames],
  );

  const markdown = useMemo(() => {
    if (load.kind !== "ready" || effectiveTables.length === 0) return "";
    return buildSchemaMarkdown({ database, driver, tables: effectiveTables, foreignKeys: fks });
  }, [load.kind, effectiveTables, database, driver, fks]);

  const previewLines = useMemo(() => markdown.split("\n"), [markdown]);
  const previewContent =
    previewLines.length > PREVIEW_LINES
      ? previewLines.slice(0, PREVIEW_LINES).join("\n")
      : markdown;
  const previewTruncated = previewLines.length > PREVIEW_LINES;

  const filteredTables = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((tb) => tb.name.toLowerCase().includes(q));
  }, [tables, filter]);

  const toggleTable = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const isSaving = status.kind === "saving";
  const hasOutput = markdown.length > 0;
  const emptySelection = scope === "selected" && selected.size === 0;

  const handleCopy = async () => {
    if (!hasOutput) return;
    const ok = await copyToClipboard(markdown);
    if (!ok) {
      toast.error(t("clipboardCopyFailed"));
      return;
    }
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const handleBrowse = async () => {
    const selectedPath = await save({
      defaultPath: path || defaultSchemaFilename(database),
      title: t("exportPickFileTitle"),
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (typeof selectedPath === "string" && selectedPath) {
      userEditedPathRef.current = true;
      setPath(selectedPath);
    }
  };

  const handleSave = async () => {
    if (!path.trim() || !hasOutput) return;
    setStatus({ kind: "saving" });
    try {
      const bytes = await api.writeBinaryFile(path, new TextEncoder().encode(markdown));
      toast.success(t("exportSuccess", { bytes, path }));
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
      toast.error(t("exportError", { error: String(e) }));
    }
  };

  return (
    <Modal
      width="620px"
      onClose={onClose}
      closeOnInteractOutside={!isSaving}
      closeOnEscape={!isSaving}
    >
      <ModalHeader onClose={onClose} closeLabel={t("exportClose")} closeDisabled={isSaving}>
        {t("schemaExportTitle", { database })}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight={1.5}>
          {t("schemaExportNote")}
        </chakra.div>

        {load.kind === "loading" && (
          <chakra.div fontSize="sm" color="app.textSecondary">
            {t("schemaExportLoading", { done: load.done, total: load.total })}
          </chakra.div>
        )}
        {load.kind === "error" && <ErrorNote>{load.message}</ErrorNote>}
        {load.kind === "ready" && tables.length === 0 && (
          <chakra.div fontSize="sm" color="app.textMuted">
            {t("schemaExportNoTables")}
          </chakra.div>
        )}

        {load.kind === "ready" && tables.length > 0 && (
          <>
            <FormSection>
              <FieldLabel as="div">{t("schemaExportScope")}</FieldLabel>
              <chakra.div
                role="radiogroup"
                aria-label={t("schemaExportScope")}
                display="flex"
                gap="4"
              >
                {(["all", "selected"] as const).map((sc) => (
                  <chakra.label
                    key={sc}
                    display="inline-flex"
                    alignItems="center"
                    gap="1.5"
                    cursor="pointer"
                    userSelect="none"
                  >
                    <Radio
                      name="schema-export-scope"
                      value={sc}
                      checked={scope === sc}
                      onChange={() => setScope(sc)}
                      disabled={isSaving}
                      m={0}
                    />
                    <chakra.span fontSize="md">
                      {sc === "all" ? t("schemaExportScopeAll") : t("schemaExportScopeSelected")}
                    </chakra.span>
                  </chakra.label>
                ))}
              </chakra.div>
            </FormSection>

            {scope === "selected" && (
              <FormSection>
                <chakra.div
                  display="flex"
                  alignItems="flex-start"
                  gap="2"
                  mb="2"
                  cursor={isSaving ? "not-allowed" : "pointer"}
                  userSelect="none"
                  onClick={(e) => {
                    if (isSaving) return;
                    if (e.target instanceof HTMLElement && e.target.closest("button[role=switch]")) {
                      return;
                    }
                    setIncludeRelated((v) => !v);
                  }}
                >
                  <chakra.span mt="0.5" flex="none">
                    <Switch
                      checked={includeRelated}
                      onChange={() => setIncludeRelated((v) => !v)}
                      disabled={isSaving}
                      size="sm"
                    />
                  </chakra.span>
                  <chakra.span display="flex" flexDirection="column" gap="0.5" minW={0}>
                    <chakra.span fontSize="md" color="app.text">
                      {t("schemaExportIncludeRelated")}
                    </chakra.span>
                    <chakra.span fontSize="xs" color="app.textMuted" lineHeight={1.4}>
                      {t("schemaExportIncludeRelatedHint")}
                    </chakra.span>
                  </chakra.span>
                </chakra.div>
                <Input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("schemaExportFilterPlaceholder")}
                  disabled={isSaving}
                  mb="1.5"
                />
                <chakra.div
                  maxH="160px"
                  overflowY="auto"
                  border="1px solid"
                  borderColor="app.border"
                  borderRadius="md"
                  p="1.5"
                  display="flex"
                  flexDirection="column"
                >
                  {filteredTables.map((tb) => {
                    const autoAdded =
                      !selected.has(tb.name) && effectiveNames !== null && effectiveNames.has(tb.name);
                    return (
                      <chakra.label
                        key={tb.name}
                        display="flex"
                        alignItems="center"
                        gap="2"
                        py="0.5"
                        px="1"
                        borderRadius="sm"
                        cursor="pointer"
                        userSelect="none"
                        _hover={{ bg: "app.rowHover" }}
                      >
                        <Checkbox
                          checked={selected.has(tb.name)}
                          onChange={() => toggleTable(tb.name)}
                          disabled={isSaving}
                        />
                        <chakra.span fontSize="sm" fontFamily="mono" minW={0} truncate>
                          {tb.name}
                        </chakra.span>
                        {autoAdded && (
                          <chakra.span
                            flex="none"
                            fontSize="2xs"
                            px="1.5"
                            borderRadius="sm"
                            bg="app.rowHover"
                            color="app.textMuted"
                            title={t("schemaExportAutoAdded")}
                          >
                            FK
                          </chakra.span>
                        )}
                      </chakra.label>
                    );
                  })}
                  {filteredTables.length === 0 && (
                    <chakra.span fontSize="sm" color="app.textMuted" p="1">
                      {t("schemaExportNoFilterMatch")}
                    </chakra.span>
                  )}
                </chakra.div>
                <chakra.div fontSize="xs" color="app.textMuted" mt="1">
                  {emptySelection
                    ? t("schemaExportNoSelection")
                    : t("schemaExportSelectedCount", {
                        selected: selected.size,
                        effective: effectiveTables.length,
                      })}
                </chakra.div>
              </FormSection>
            )}

            <FormSection>
              <chakra.div display="flex" alignItems="center" gap="2">
                <FieldLabel as="div" mb={0}>
                  {t("exportPreview")}
                </FieldLabel>
                <chakra.div flex="1" />
                <chakra.button
                  type="button"
                  onClick={handleCopy}
                  disabled={!hasOutput}
                  title={copied ? t("gridCopied") : t("exportCopyAll")}
                  aria-label={copied ? t("gridCopied") : t("exportCopyAll")}
                  display="inline-flex"
                  alignItems="center"
                  justifyContent="center"
                  gap="1.5"
                  py="1"
                  px="2"
                  color="app.textMuted"
                  bg="app.bgInput"
                  border="1px solid"
                  borderColor="app.border"
                  borderRadius="md"
                  fontSize="xs"
                  cursor="pointer"
                  transitionProperty="color, background, border-color"
                  transitionDuration="var(--dur-fast)"
                  transitionTimingFunction="var(--ease)"
                  _hover={{ color: "app.text", bg: "app.hover" }}
                  _disabled={{ opacity: 0.35, cursor: "not-allowed" }}
                >
                  <Icon name={copied ? "check" : "copy"} size={14} />
                  <span>{copied ? t("gridCopied") : t("exportCopyAll")}</span>
                </chakra.button>
              </chakra.div>
              <chakra.pre
                aria-label={t("exportPreview")}
                m={0}
                maxH="220px"
                overflow="auto"
                p="2.5"
                bg="app.bgInput"
                border="1px solid"
                borderColor="app.border"
                borderRadius="md"
                fontFamily="mono"
                fontSize="xs"
                lineHeight={1.5}
                color="app.text"
                whiteSpace="pre"
              >
                {previewContent ||
                  (emptySelection ? t("schemaExportNoSelection") : t("exportNoData"))}
              </chakra.pre>
              {previewTruncated && (
                <chakra.div fontSize="xs" color="app.textMuted">
                  {t("schemaExportPreviewTruncated", {
                    shown: PREVIEW_LINES,
                    total: previewLines.length,
                  })}
                </chakra.div>
              )}
            </FormSection>

            <FormSection>
              <FieldLabel htmlFor="schema-export-path">{t("exportSavePath")}</FieldLabel>
              <PathRow>
                <Input
                  id="schema-export-path"
                  flex="1"
                  minW={0}
                  type="text"
                  value={path}
                  onChange={(e) => {
                    userEditedPathRef.current = true;
                    setPath(e.target.value);
                  }}
                  placeholder={t("exportSavePathPlaceholder")}
                  disabled={isSaving}
                />
                <Button type="button" onClick={handleBrowse} disabled={isSaving}>
                  {t("exportBrowse")}
                </Button>
              </PathRow>
            </FormSection>
          </>
        )}

        {status.kind === "error" && (
          <ErrorNote>{t("exportError", { error: status.message })}</ErrorNote>
        )}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose} disabled={isSaving}>
          {t("exportCancel")}
        </Button>
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={isSaving}
          onClick={handleSave}
          disabled={isSaving || !path.trim() || !hasOutput}
        >
          {isSaving ? t("exportSaving") : t("exportExecute")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
