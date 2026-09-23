import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  listenImportStream,
  type ColumnMapping,
  type CsvPreview,
  type DriverKind,
  type ImportConflictMode,
  type ImportErrorMode,
  type ImportFormat,
  type ImportOptions,
  type NewColumnType,
  type SkippedRowInfo,
  type TableColumnInfo,
} from "../api/tauri";
import { chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { transitions } from "../motion";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Input, PressableButton, Select, Switch } from "./ui";
import { Spinner } from "./Spinner";
import { LoadingButton } from "./LoadingButton";
import {
  CodePreview,
  ErrorNote,
  FieldError,
  FieldLabel,
  FormSection,
  PathRow,
} from "./modalForm";
import {
  defaultKeyColumns,
  pruneKeyColumns,
  toggleKeyColumn,
  validateConflictKeys,
} from "./importConflict";
import {
  buildColumnDrafts,
  mergeColumnDrafts,
  newColumnTypeCellKind,
  newColumnTypeOptions,
  newTableRequest,
  suggestTableName,
  validateNewTable,
  type NewColumnDraft,
  type NewTableError,
} from "./newTableInference";
import { cellKindIcon } from "./cellTypeMeta";
import type { I18nKey } from "../i18n";
import { copyToClipboard } from "./clipboard";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

interface Props {
  sessionId: string;
  database: string;
  /**
   * Destination table. `null` opens the modal in "create a new table from the
   * file" mode (#985) with no existing table to switch back to.
   */
  table: string | null;
  /** Session driver — drives the new-table type options and DDL preview (#985). */
  driver: DriverKind;
  onClose: () => void;
  /**
   * Called after a successful import so the caller can refresh the grid.
   * `created` is true when the import created `table` (#985), so the caller
   * can also refresh the schema tree.
   */
  onImported: (table: string, created: boolean) => void;
  /**
   * Pre-selected file path. When the modal is opened by dropping a
   * `.csv` onto the window, the path is filled in up front so the preview
   * loads immediately without the user re-picking the file.
   */
  initialPath?: string;
}

type DelimiterChoice = "," | "\t" | ";";
type NullMode = "none" | "empty" | "custom";

type Status =
  | { kind: "idle" }
  | { kind: "importing"; inserted: number; total: number }
  // Skip-mode completion carrying the rows that were dropped (#687).
  | { kind: "done"; inserted: number; skipped: SkippedRowInfo[] }
  | { kind: "error"; message: string };

const ENCODINGS = ["utf-8", "shift_jis", "euc-jp", "utf-16le", "windows-1252"];

/** 新規テーブルの列型 → 表示ラベルの i18n キー (#985)。 */
const TYPE_LABEL_KEYS: Record<NewColumnType, I18nKey> = {
  integer: "importTypeInteger",
  bigint: "importTypeBigint",
  decimal: "importTypeDecimal",
  double: "importTypeDouble",
  boolean: "importTypeBoolean",
  date: "importTypeDate",
  datetime: "importTypeDatetime",
  text: "importTypeText",
};

/** Guesses the import format from a file path's extension. */
function formatFromPath(path: string): ImportFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) return "ndjson";
  if (lower.endsWith(".json")) return "json";
  return "csv";
}

function newStreamId(): string {
  return `import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

// The backend CSV parser operates on single bytes, so the quote character must
// be exactly one ASCII character. Reject empty, multi-character, and multi-byte
// (e.g. `「` or emoji) input before it reaches the server.
function isValidSingleByteChar(s: string): boolean {
  return s.length === 1 && s.charCodeAt(0) < 128;
}

/**
 * Auto-pairs destination columns with CSV fields: by header name when a header
 * row is present and at least one name matches, otherwise positionally. Columns
 * with no candidate map to `null` (skipped).
 */
function autoMap(
  tableCols: TableColumnInfo[],
  headers: string[],
  hasHeader: boolean,
): Record<string, number | null> {
  const byName = tableCols.map((c) =>
    headers.findIndex((h) => norm(h) === norm(c.name)),
  );
  const anyName = byName.some((i) => i >= 0);
  const m: Record<string, number | null> = {};
  tableCols.forEach((c, i) => {
    if (hasHeader && anyName) {
      m[c.name] = byName[i] >= 0 ? byName[i] : null;
    } else {
      m[c.name] = i < headers.length ? i : null;
    }
  });
  return m;
}

export function ImportModal({
  sessionId,
  database,
  table,
  driver,
  onClose,
  onImported,
  initialPath,
}: Props) {
  const t = useT();
  const toast = useToast();
  const [path, setPath] = useState(initialPath ?? "");
  // ファイルから新規テーブルを作成するモード (#985)。対象テーブルが無い
  // (DB のコンテキストメニューから開いた) ときは常にこのモード。
  const [createNew, setCreateNew] = useState(table === null);
  const [newTableName, setNewTableName] = useState(() =>
    initialPath ? suggestTableName(initialPath) : "",
  );
  // ユーザがテーブル名を編集したら、ファイルを選び直しても上書きしない。
  const [tableNameEdited, setTableNameEdited] = useState(false);
  const [drafts, setDrafts] = useState<NewColumnDraft[] | null>(null);
  const [ddl, setDdl] = useState<string | null>(null);
  const [ddlError, setDdlError] = useState<string | null>(null);
  // 新規テーブル作成付きの取り込みが成功した後は、同じ名前で再実行しても
  // 「既に存在する」エラーになるだけなので実行ボタンを止める。
  const [created, setCreated] = useState(false);
  const [format, setFormat] = useState<ImportFormat>(
    initialPath ? formatFromPath(initialPath) : "csv",
  );
  const [encoding, setEncoding] = useState("utf-8");
  const [delimiter, setDelimiter] = useState<DelimiterChoice>(",");
  const [quote, setQuote] = useState('"');
  const [hasHeader, setHasHeader] = useState(true);
  const [nullMode, setNullMode] = useState<NullMode>("empty");
  const [nullCustom, setNullCustom] = useState("NULL");
  const [errorMode, setErrorMode] = useState<ImportErrorMode>("abort");
  // 既存キーの扱い (#972)。`keyColumns` が null の間は「未操作」とみなし、
  // マッピング済みの主キー列を既定のキーとして使う。
  const [conflictMode, setConflictMode] = useState<ImportConflictMode>("insert");
  const [keyColumns, setKeyColumns] = useState<string[] | null>(null);

  const [tableColumns, setTableColumns] = useState<TableColumnInfo[] | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const streamIdRef = useRef<string | null>(null);
  // Set on unmount so an in-flight `listenImportStream` (awaited in
  // handleImport) can tell its registration arrived too late and must
  // self-unlisten — the unmount cleanup has already run by then.
  const disposedRef = useRef(false);

  const importing = status.kind === "importing";
  const isCsv = format === "csv";
  // The quote character only matters for CSV; JSON/NDJSON ignore it, so don't
  // let a stale invalid quote block the JSON preview/import.
  const quoteValid = !isCsv || isValidSingleByteChar(quote);

  const nullToken = nullMode === "none" ? null : nullMode === "empty" ? "" : nullCustom;
  const buildOptions = useCallback((): ImportOptions => {
    return { format, delimiter, quote, hasHeader, nullToken, encoding, errorMode };
  }, [format, delimiter, quote, hasHeader, nullToken, encoding, errorMode]);

  // Fetch destination columns once for the mapping UI (existing-table mode only).
  useEffect(() => {
    if (table === null) return;
    let cancelled = false;
    api
      .describeTable(sessionId, database, table)
      .then((cols) => {
        if (!cancelled) setTableColumns(cols);
      })
      .catch((e) => {
        if (!cancelled) setPreviewError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table]);

  // Reload the preview whenever the file or parsing options change.
  useEffect(() => {
    if (!path) {
      setPreview(null);
      return;
    }
    // An invalid quote would make the backend parser misbehave; skip the
    // preview fetch until it is corrected (the field shows its own error).
    if (!quoteValid) return;
    let cancelled = false;
    setLoadingPreview(true);
    setPreviewError(null);
    api
      .parseCsvPreview(path, buildOptions())
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        // JSON/NDJSON always expose named fields, so map by name regardless of
        // the (CSV-only) header toggle.
        if (tableColumns) setMapping(autoMap(tableColumns, p.headers, isCsv ? hasHeader : true));
      })
      .catch((e) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
    // buildOptions captures every parsing option; tableColumns drives auto-map.
  }, [path, buildOptions, tableColumns, hasHeader, quoteValid]);

  // 新規テーブルの列の下書き (名前の提案 + 型推論) をプレビューから作る (#985)。
  // NULL トークンはバックエンドと同じ規則で推論前に適用する (空セルを NULL に
  // しない設定なら、空セルを含む数値列は文字列になる)。
  const namedFields = isCsv ? hasHeader : true;
  useEffect(() => {
    if (!preview) {
      setDrafts(null);
      return;
    }
    const next = buildColumnDrafts(preview, nullToken, driver, namedFields);
    setDrafts((prev) => mergeColumnDrafts(prev, next));
  }, [preview, nullToken, driver, namedFields]);

  // ファイル名からテーブル名を提案する (ユーザが編集するまで)。
  useEffect(() => {
    if (!tableNameEdited && path) setNewTableName(suggestTableName(path));
  }, [path, tableNameEdited]);

  const newTableError: NewTableError =
    createNew && drafts ? validateNewTable(driver, newTableName, drafts) : null;
  const newTable = useMemo(
    () => (createNew && drafts ? newTableRequest(drafts) : null),
    [createNew, drafts],
  );

  // 実行される CREATE TABLE をバックエンドの生成関数から取ってきて見せる
  // (プレビュー = 実際に流れる DDL)。検証エラーがある間は取りに行かない。
  useEffect(() => {
    if (!createNew || !newTable || newTableError) {
      setDdl(null);
      setDdlError(null);
      return;
    }
    let cancelled = false;
    api
      .previewCreateTableDdl(driver, newTableName, newTable.columns)
      .then((sql) => {
        if (cancelled) return;
        setDdl(sql);
        setDdlError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setDdl(null);
        setDdlError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [createNew, newTable, newTableError, driver, newTableName]);

  const updateDraft = useCallback((index: number, patch: Partial<NewColumnDraft>) => {
    setDrafts((prev) =>
      prev ? prev.map((d, i) => (i === index ? { ...d, ...patch } : d)) : prev,
    );
  }, []);

  const newTableErrorText = (err: NewTableError): string | null => {
    if (!err) return null;
    switch (err.kind) {
      case "tableNameRequired":
        return t("importNewTableNameRequired");
      case "nameWhitespace":
        return t("importNewTableNameWhitespace", { name: err.name });
      case "nameTooLong":
        return t("importNewTableNameTooLong", { name: err.name, limit: err.limit });
      case "noColumns":
        return t("importNewTableNoColumns");
      case "columnNameRequired":
        return t("importNewTableColumnNameRequired");
      case "duplicateColumn":
        return t("importNewTableDuplicateColumn", { name: err.name });
    }
  };

  // Detach the event listener on unmount.
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  const handleBrowse = async () => {
    const selected = await open({
      multiple: false,
      title: t("importPickFileTitle"),
      filters: [
        { name: t("importFileFilterData"), extensions: ["csv", "tsv", "txt", "json", "ndjson", "jsonl"] },
        { name: "CSV", extensions: ["csv", "tsv", "txt"] },
        { name: "JSON / NDJSON", extensions: ["json", "ndjson", "jsonl"] },
      ],
    });
    if (typeof selected === "string" && selected) {
      setPath(selected);
      // Auto-select the format from the extension; the user can still override.
      setFormat(formatFromPath(selected));
      setStatus({ kind: "idle" });
    }
  };

  const csvColumnLabel = useCallback(
    (index: number): string => {
      // JSON/NDJSON always have named fields; CSV only when the header toggle is on.
      const named = isCsv ? hasHeader : true;
      if (named && preview?.headers[index]) {
        return `${index + 1}. ${preview.headers[index]}`;
      }
      return t("importColumnNumbered", { n: index + 1 });
    },
    [isCsv, hasHeader, preview, t],
  );

  const mappingEntries = useMemo<ColumnMapping[]>(() => {
    return Object.entries(mapping)
      .filter(([, idx]) => idx !== null && idx !== undefined)
      .map(([column, idx]) => ({ column, csvIndex: idx as number }));
  }, [mapping]);

  const mappedColumns = useMemo(() => mappingEntries.map((m) => m.column), [mappingEntries]);
  const effectiveKeyColumns = useMemo(
    () =>
      keyColumns === null
        ? defaultKeyColumns(tableColumns ?? [], mappedColumns)
        : pruneKeyColumns(keyColumns, mappedColumns),
    [keyColumns, tableColumns, mappedColumns],
  );
  const conflictError = createNew
    ? null
    : validateConflictKeys(conflictMode, effectiveKeyColumns, mappedColumns);

  // 取り込み先と列マッピング。新規テーブルモードでは下書きから作る (#985)。
  const targetTable = createNew ? newTableName : (table ?? "");
  const effectiveMapping = newTable ? newTable.mapping : mappingEntries;
  const canImport =
    !!path &&
    effectiveMapping.length > 0 &&
    quoteValid &&
    conflictError === null &&
    (!createNew || (newTable !== null && newTableError === null && !created));

  const handleImport = async () => {
    if (!canImport) return;
    const importTable = targetTable;
    const creating = createNew;
    const streamId = newStreamId();
    streamIdRef.current = streamId;
    setStatus({ kind: "importing", inserted: 0, total: 0 });

    if (unlistenRef.current) unlistenRef.current();
    const unlisten = await listenImportStream(streamId, {
      onStarted: (e) => setStatus({ kind: "importing", inserted: 0, total: e.total }),
      onProgress: (e) =>
        setStatus({ kind: "importing", inserted: e.inserted, total: e.total }),
      onDone: (e) => {
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }
        if (e.skipped.length > 0) {
          // Skip mode dropped some rows — keep the modal open to show them.
          toast.info(t("importSkippedSummary", { inserted: e.inserted, skipped: e.skipped.length }));
          setStatus({ kind: "done", inserted: e.inserted, skipped: e.skipped });
        } else {
          toast.success(t("importSuccess", { inserted: e.inserted, ms: e.elapsedMs }));
          setStatus({ kind: "idle" });
        }
        if (creating) {
          setCreated(true);
          toast.success(t("importNewTableCreated", { table: importTable }));
        }
        onImported(importTable, creating);
        // 新規テーブルを作った取り込みが完全に成功したら閉じる (同名での再実行は
        // 「既に存在する」エラーになるだけ)。スキップ行があるときは一覧を見せる。
        if (creating && e.skipped.length === 0) onClose();
      },
      onError: (e) => {
        // Enrich an abort-mode failure with the pinpointed record/line (#687).
        const message =
          e.record != null
            ? e.line != null
              ? t("importErrorAtRecordLine", { error: e.error, record: e.record, line: e.line })
              : t("importErrorAtRecord", { error: e.error, record: e.record })
            : e.error;
        setStatus({ kind: "error", message });
        toast.error(message);
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }
      },
    });
    // The modal may have unmounted while the listener was attaching; its
    // cleanup already ran, so register nothing and drop the listener here.
    if (disposedRef.current) {
      unlisten();
      return;
    }
    unlistenRef.current = unlisten;

    try {
      await api.importCsv({
        sessionId,
        streamId,
        database,
        table: importTable,
        path,
        // 作ったばかりの空テーブルに UPSERT の意味は無いので INSERT 固定。
        options: creating
          ? { ...buildOptions(), conflictMode: "insert", keyColumns: [] }
          : { ...buildOptions(), conflictMode, keyColumns: effectiveKeyColumns },
        mapping: effectiveMapping,
        createTable: newTable?.columns ?? null,
      });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    }
  };

  const copySkipped = useCallback(
    async (skipped: SkippedRowInfo[]) => {
      const text = skipped
        .map((s) =>
          s.line != null
            ? t("importSkippedRowLine", { record: s.record, line: s.line, reason: s.reason })
            : t("importSkippedRow", { record: s.record, reason: s.reason }),
        )
        .join("\n");
      if (await copyToClipboard(text)) toast.success(t("importSkippedCopied"));
    },
    [toast, t],
  );

  const handleCancelImport = async () => {
    const sid = streamIdRef.current;
    // In skip mode each chunk auto-commits, so a cancel can leave rows already
    // persisted; `deliveredRows` reports how many so the message can say so
    // (abort mode rolls back and reports 0). #687 review follow-up.
    let committed = 0;
    if (sid) {
      try {
        committed = (await api.cancelStream(sid)).deliveredRows;
      } catch {
        /* best-effort */
      }
    }
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setStatus({
      kind: "error",
      message:
        committed > 0
          ? t("importCancelledPartial", { count: committed })
          : t("importCancelled"),
    });
  };

  const percent =
    status.kind === "importing" && status.total > 0
      ? Math.min(100, Math.round((status.inserted / status.total) * 100))
      : 0;

  return (
    <Modal
      width="680px"
      onClose={onClose}
      closeOnInteractOutside={!importing}
      closeOnEscape={!importing}
    >
      <ModalHeader onClose={onClose} closeLabel={t("importClose")} closeDisabled={importing}>
        {createNew ? t("importNewTableTitle") : t("importTitle", { table: table ?? "" })}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <FormSection>
          <FieldLabel htmlFor="import-path">{t("importFile")}</FieldLabel>
          <PathRow>
            <Input
              id="import-path"
              flex="1"
              minW={0}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("importFilePlaceholder")}
              disabled={importing}
            />
            <Button type="button" onClick={handleBrowse} disabled={importing}>
              {t("importBrowse")}
            </Button>
          </PathRow>
        </FormSection>

        <FormSection flexDirection="row" flexWrap="wrap" gap="3.5" alignItems="flex-end">
          <chakra.div display="flex" flexDirection="row" alignItems="center" gap="1.5">
            <Switch
              checked={createNew}
              onChange={setCreateNew}
              // 既存テーブルが無い (DB から開いた) ときは切り替え先が無い。
              disabled={importing || table === null}
              label={t("importCreateNewTable")}
            />
          </chakra.div>
          {createNew && (
            <chakra.div display="flex" flexDirection="column" gap="1.5" flex="1" minW="200px">
              <FieldLabel htmlFor="import-new-table-name">{t("importNewTableName")}</FieldLabel>
              <Input
                id="import-new-table-name"
                type="text"
                value={newTableName}
                onChange={(e) => {
                  setTableNameEdited(true);
                  setNewTableName(e.target.value);
                  setCreated(false);
                }}
                disabled={importing}
                aria-invalid={
                  newTableError?.kind === "tableNameRequired" ||
                  (newTableError?.kind === "nameWhitespace" && newTableError.name === newTableName) ||
                  (newTableError?.kind === "nameTooLong" && newTableError.name === newTableName)
                }
              />
            </chakra.div>
          )}
        </FormSection>

        <FormSection flexDirection="row" flexWrap="wrap" gap="3.5" alignItems="flex-end">
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <FieldLabel htmlFor="import-format">{t("importFormat")}</FieldLabel>
            <Select
              id="import-format"
              minW="140px"
              value={format}
              onChange={(e) => setFormat(e.target.value as ImportFormat)}
              disabled={importing}
            >
              <option value="csv">{t("importFormatCsv")}</option>
              <option value="json">{t("importFormatJson")}</option>
              <option value="ndjson">{t("importFormatNdjson")}</option>
            </Select>
          </chakra.div>

          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <FieldLabel htmlFor="import-encoding">{t("importEncoding")}</FieldLabel>
            <Select
              id="import-encoding"
              minW="140px"
              value={encoding}
              onChange={(e) => setEncoding(e.target.value)}
              disabled={importing}
            >
              {ENCODINGS.map((enc) => (
                <option key={enc} value={enc}>
                  {enc}
                </option>
              ))}
            </Select>
          </chakra.div>

          {isCsv && (
            <chakra.div display="flex" flexDirection="column" gap="1.5">
              <FieldLabel htmlFor="import-delimiter">{t("importDelimiter")}</FieldLabel>
              <Select
                id="import-delimiter"
                minW="140px"
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value as DelimiterChoice)}
                disabled={importing}
              >
                <option value=",">{t("importDelimiterComma")}</option>
                <option value={"\t"}>{t("importDelimiterTab")}</option>
                <option value=";">{t("importDelimiterSemicolon")}</option>
              </Select>
            </chakra.div>
          )}

          {isCsv && (
            <chakra.div display="flex" flexDirection="column" gap="1.5">
              <FieldLabel htmlFor="import-quote">{t("importQuote")}</FieldLabel>
              <Input
                id="import-quote"
                css={{ width: "64px" }}
                type="text"
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
                disabled={importing}
                aria-invalid={!quoteValid}
                aria-describedby={quoteValid ? undefined : "import-quote-error"}
              />
            </chakra.div>
          )}

          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <FieldLabel htmlFor="import-null">{t("importNull")}</FieldLabel>
            <Select
              id="import-null"
              minW="140px"
              value={nullMode}
              onChange={(e) => setNullMode(e.target.value as NullMode)}
              disabled={importing}
            >
              <option value="empty">{t("importNullEmpty")}</option>
              <option value="custom">{t("importNullCustom")}</option>
              <option value="none">{t("importNullNone")}</option>
            </Select>
            {nullMode === "custom" && (
              <Input
                css={{ width: "64px" }}
                type="text"
                value={nullCustom}
                onChange={(e) => setNullCustom(e.target.value)}
                disabled={importing}
                aria-label={t("importNullCustom")}
              />
            )}
          </chakra.div>

          {isCsv && (
            <chakra.div display="flex" flexDirection="row" alignItems="center" gap="1.5">
              <Switch
                checked={hasHeader}
                onChange={setHasHeader}
                disabled={importing}
                label={t("importHasHeader")}
              />
            </chakra.div>
          )}

          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <FieldLabel htmlFor="import-error-mode">{t("importErrorMode")}</FieldLabel>
            <Select
              id="import-error-mode"
              minW="150px"
              value={errorMode}
              onChange={(e) => setErrorMode(e.target.value as ImportErrorMode)}
              disabled={importing}
            >
              <option value="abort">{t("importErrorModeAbort")}</option>
              <option value="skip">{t("importErrorModeSkip")}</option>
            </Select>
          </chakra.div>

          {!createNew && (
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <FieldLabel htmlFor="import-conflict-mode">{t("importConflictMode")}</FieldLabel>
            <Select
              id="import-conflict-mode"
              minW="150px"
              value={conflictMode}
              onChange={(e) => setConflictMode(e.target.value as ImportConflictMode)}
              disabled={importing}
            >
              <option value="insert">{t("importConflictModeInsert")}</option>
              <option value="skip">{t("importConflictModeSkip")}</option>
              <option value="update">{t("importConflictModeUpdate")}</option>
            </Select>
          </chakra.div>
          )}
        </FormSection>

        {errorMode === "skip" && (
          <chakra.div fontSize="xs" color="app.textMuted">
            {t("importErrorModeSkipHint")}
          </chakra.div>
        )}

        {!isCsv && (
          <chakra.div fontSize="xs" color="app.textMuted">
            {t("importJsonHelp")}
          </chakra.div>
        )}

        {!quoteValid && (
          <ErrorNote id="import-quote-error">
            {t("importQuote")}: {t("importQuoteInvalid")}
          </ErrorNote>
        )}
        {previewError && <ErrorNote>{previewError}</ErrorNote>}
        {loadingPreview && (
          <chakra.div display="inline-flex" alignItems="center" gap="1.5" color="app.textMuted">
            <Spinner size={13} />
            {t("importLoadingPreview")}
          </chakra.div>
        )}

        {createNew && preview && drafts && (
          <FormSection>
            <FieldLabel as="div">{t("importNewTableColumns")}</FieldLabel>
            <chakra.div
              display="grid"
              gridTemplateColumns="repeat(auto-fill, minmax(300px, 1fr))"
              gap="2"
            >
              {drafts.map((d, i) => (
                <chakra.div key={d.csvIndex} display="flex" alignItems="center" gap="1.5">
                  <Checkbox
                    checked={d.include}
                    onChange={() => updateDraft(i, { include: !d.include })}
                    disabled={importing}
                    aria-label={t("importNewTableInclude", { name: d.name })}
                  />
                  <Tooltip label={csvColumnLabel(d.csvIndex)}>
                    <chakra.span color="app.textMuted" display="inline-flex">
                      <Icon name={cellKindIcon(newColumnTypeCellKind(d.type))} />
                    </chakra.span>
                  </Tooltip>
                  <Input
                    flex="1"
                    minW={0}
                    type="text"
                    fontFamily="mono"
                    value={d.name}
                    onChange={(e) => updateDraft(i, { name: e.target.value })}
                    disabled={importing || !d.include}
                    aria-label={t("importNewTableColumnName", { n: d.csvIndex + 1 })}
                  />
                  <Select
                    flex="0 0 42%"
                    minW={0}
                    value={d.type}
                    onChange={(e) => updateDraft(i, { type: e.target.value as NewColumnType })}
                    disabled={importing || !d.include}
                    aria-label={t("importNewTableColumnType", { name: d.name })}
                  >
                    {newColumnTypeOptions(driver).map((ty) => (
                      <option key={ty} value={ty}>
                        {ty === d.inferredType
                          ? t(TYPE_LABEL_KEYS[ty])
                          : `${t(TYPE_LABEL_KEYS[ty])} (${t("importNewTableInferred", {
                              type: t(TYPE_LABEL_KEYS[d.inferredType]),
                            })})`}
                      </option>
                    ))}
                  </Select>
                </chakra.div>
              ))}
            </chakra.div>
            <chakra.div fontSize="xs" color="app.textMuted">
              {t("importNewTableHint")}
            </chakra.div>
            {newTableError && <FieldError>{newTableErrorText(newTableError)}</FieldError>}
          </FormSection>
        )}

        {createNew && (ddl || ddlError) && (
          <FormSection>
            <FieldLabel as="div">{t("importNewTableDdl")}</FieldLabel>
            {ddl && (
              <CodePreview maxH="160px" data-testid="import-new-table-ddl">
                {ddl}
              </CodePreview>
            )}
            {ddlError && <ErrorNote>{ddlError}</ErrorNote>}
            {errorMode === "abort" && (
              <chakra.div fontSize="xs" color="app.textMuted">
                {t("importNewTableAbortHint")}
              </chakra.div>
            )}
          </FormSection>
        )}

        {!createNew && preview && tableColumns && (
          <FormSection>
            <FieldLabel as="div">{t("importMappingTitle")}</FieldLabel>
            <chakra.div
              display="grid"
              gridTemplateColumns="repeat(auto-fill, minmax(280px, 1fr))"
              gap="2"
            >
              {tableColumns.map((col) => (
                <chakra.div
                  display="flex"
                  alignItems="center"
                  gap="2"
                  key={col.name}
                >
                  <Tooltip label={col.data_type}>
                    <chakra.span
                      flex="0 0 40%"
                      fontSize="md"
                      fontFamily="mono"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                    >
                      {col.name}
                      {col.key === "PRI" && (
                        <Tooltip label={t("colPkTitle")}>
                          <chakra.span
                            fontSize="xs"
                            ml="1"
                            color="app.cell.date"
                          >
                            <Icon name="key" />
                          </chakra.span>
                        </Tooltip>
                      )}
                    </chakra.span>
                  </Tooltip>
                  <Select
                    flex="1"
                    minW={0}
                    value={mapping[col.name] ?? ""}
                    onChange={(e) =>
                      setMapping((prev) => ({
                        ...prev,
                        [col.name]: e.target.value === "" ? null : Number(e.target.value),
                      }))
                    }
                    disabled={importing}
                  >
                    <option value="">{t("importSkipColumn")}</option>
                    {preview.headers.map((_, idx) => (
                      <option key={idx} value={idx}>
                        {csvColumnLabel(idx)}
                      </option>
                    ))}
                  </Select>
                </chakra.div>
              ))}
            </chakra.div>
          </FormSection>
        )}

        {!createNew && conflictMode !== "insert" && preview && tableColumns && (
          <FormSection>
            <FieldLabel as="div">{t("importConflictKeys")}</FieldLabel>
            <chakra.div display="flex" flexWrap="wrap" gap="3">
              {mappedColumns.length === 0 && (
                <chakra.span fontSize="xs" color="app.textMuted">
                  {t("importConflictNoMapped")}
                </chakra.span>
              )}
              {mappedColumns.map((col) => (
                <chakra.label
                  key={col}
                  display="flex"
                  alignItems="center"
                  gap="1"
                  fontSize="sm"
                  fontFamily="mono"
                >
                  <Checkbox
                    checked={effectiveKeyColumns.includes(col)}
                    onChange={() =>
                      setKeyColumns(toggleKeyColumn(effectiveKeyColumns, col, mappedColumns))
                    }
                    disabled={importing}
                  />
                  {col}
                </chakra.label>
              ))}
            </chakra.div>
            <chakra.div fontSize="xs" color="app.textMuted">
              {t("importConflictKeysHint")}
            </chakra.div>
            {conflictError === "keysRequired" && (
              <FieldError>{t("importConflictKeysRequired")}</FieldError>
            )}
            {conflictError === "keyNotMapped" && (
              <FieldError>{t("importConflictKeyNotMapped")}</FieldError>
            )}
          </FormSection>
        )}

        {preview && preview.rows.length > 0 && (
          <FormSection>
            <FieldLabel as="div">
              {t("importPreviewTitle")}
              {preview.truncated && (
                <chakra.span color="app.textMuted"> {t("importPreviewTruncated")}</chakra.span>
              )}
            </FieldLabel>
            <chakra.div
              overflow="auto"
              maxH="220px"
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
                    py: "1", px: "2",
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
                    {preview.headers.map((h, idx) => (
                      <th key={idx}>{(isCsv ? hasHeader : true) ? h : csvColumnLabel(idx)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 10).map((row, ri) => (
                    <tr key={ri}>
                      {preview.headers.map((_, ci) => (
                        <td key={ci}>{row[ci] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </chakra.table>
            </chakra.div>
          </FormSection>
        )}

        {status.kind === "importing" && (
          <chakra.div
            role="status"
            aria-live="polite"
            display="flex"
            flexDirection="column"
            gap="1.5"
          >
            <chakra.div h="8px" borderRadius="sm" bg="app.surfaceMuted" overflow="hidden">
              <motion.div
                style={{ height: "100%", background: "var(--accent)" }}
                animate={{ width: `${percent}%` }}
                transition={transitions.progress}
              />
            </chakra.div>
            <chakra.div fontSize="sm" color="app.textMuted">
              {t("importProgress", { inserted: status.inserted, total: status.total })}
            </chakra.div>
          </chakra.div>
        )}
        {status.kind === "done" && (
          <chakra.div display="flex" flexDirection="column" gap="2">
            <chakra.div
              display="flex"
              alignItems="center"
              justifyContent="space-between"
              gap="3"
            >
              <chakra.span fontSize="sm" fontWeight={500}>
                {t("importSkippedSummary", {
                  inserted: status.inserted,
                  skipped: status.skipped.length,
                })}
              </chakra.span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void copySkipped(status.skipped)}
              >
                {t("importSkippedCopy")}
              </Button>
            </chakra.div>
            <chakra.div
              maxH="180px"
              overflowY="auto"
              border="1px solid"
              borderColor="app.border"
              borderRadius="sm"
              fontSize="xs"
              fontFamily="var(--font-mono)"
            >
              {status.skipped.map((s, i) => (
                <chakra.div
                  key={`${s.record}-${i}`}
                  px="2"
                  py="1"
                  borderBottom={i < status.skipped.length - 1 ? "1px solid" : undefined}
                  borderColor="app.border"
                >
                  {s.line != null
                    ? t("importSkippedRowLine", { record: s.record, line: s.line, reason: s.reason })
                    : t("importSkippedRow", { record: s.record, reason: s.reason })}
                </chakra.div>
              ))}
            </chakra.div>
          </chakra.div>
        )}
        {status.kind === "error" && <ErrorNote>{status.message}</ErrorNote>}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        {importing ? (
          <PressableButton type="button" variant="warning" onClick={handleCancelImport}>{t("importStop")}</PressableButton>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>{t("importClose")}</Button>
        )}
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={importing}
          onClick={handleImport}
          disabled={importing || !canImport}
        >
          {importing ? t("importImporting") : t("importExecute")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
