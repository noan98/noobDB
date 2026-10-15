import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  listenImportStream,
  type DriverKind,
  type ImportDoneEvent,
  type ImportOptions,
} from "../api/tauri";
import { useT } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Callout } from "./Callout";
import { ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Checkbox, Input, PressableButton } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { Spinner } from "./Spinner";
import { DeterminateProgressBar } from "./StreamProgressBar";
import { useToast } from "./Toast";
import {
  buildColumnDrafts,
  mergeColumnDrafts,
  type NewColumnDraft,
  type NewTableError,
} from "./newTableInference";
import {
  buildSheetRequests,
  checkSheetPlan,
  sheetImportOptions,
  suggestSheetTableName,
  type SheetIssue,
  type SheetPlanEntry,
} from "./importSheets";

/**
 * xlsx の複数シートを、シートごとに別の新規テーブルへ一括で取り込む (#1623)。
 *
 * 開くとブックの各シートの先頭行を読み、列名と型を推論して下書きを作る (`ImportModal` の
 * 新規テーブルと同じ推論)。シートごとに取り込むか・テーブル名を決め、実行は
 * `import_xlsx_sheets` 1 回。型や列名を細かく直したいシートは、`ImportModal` でシートを
 * 選んで単独で取り込む。判定の純ロジックは `importSheets.ts`。
 */
interface Props {
  sessionId: string;
  database: string;
  driver: DriverKind;
  path: string;
  /** `ImportModal` で選んでいた形式・ヘッダー・NULL トークン・エラーモードなどの共通オプション。 */
  options: ImportOptions;
  sheets: string[];
  onClose: () => void;
  /** 取り込みが完了した (少なくとも 1 テーブルが作られた) とき。作られたテーブル名を渡す。 */
  onImported: (tables: string[]) => void;
}

interface SheetState {
  sheet: string;
  include: boolean;
  tableName: string;
  drafts: NewColumnDraft[];
  rowCount: number;
  truncated: boolean;
  error: string | null;
}

type Status =
  | { kind: "idle" }
  | { kind: "importing"; index: number; inserted: number; total: number }
  | { kind: "done"; event: ImportDoneEvent }
  | { kind: "error"; message: string };

function newStreamId(): string {
  return `import_sheets_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ImportSheetsModal({
  sessionId,
  database,
  driver,
  path,
  options,
  sheets,
  onClose,
  onImported,
}: Props) {
  const t = useT();
  const toast = useToast();
  const [items, setItems] = useState<SheetState[] | null>(null);
  const [existingTables, setExistingTables] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const importing = status.kind === "importing";

  const nullToken = options.nullToken ?? null;
  // シートごとの読み込み: 先頭行 (プレビュー) から列名と型を推論する。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [tables, previews] = await Promise.all([
        api.listTables(sessionId, database).catch(() => [] as string[]),
        Promise.all(
          sheets.map((sheet) =>
            api
              .parseCsvPreview(path, { ...options, sheet, nullToken: null, errorMode: "abort" })
              .then((preview) => ({ sheet, preview, error: null as string | null }))
              .catch((e) => ({ sheet, preview: null, error: String(e) })),
          ),
        ),
      ]);
      if (cancelled) return;
      setExistingTables(tables);
      const used = new Set(tables.map((x) => x.toLowerCase()));
      const next: SheetState[] = previews.map(({ sheet, preview, error }) => {
        const tableName = suggestSheetTableName(sheet, used);
        used.add(tableName.toLowerCase());
        const drafts = preview
          ? mergeColumnDrafts(null, buildColumnDrafts(preview, nullToken, driver, options.hasHeader, true))
          : [];
        return {
          sheet,
          include: preview !== null && drafts.length > 0,
          tableName,
          drafts,
          rowCount: preview?.rows.length ?? 0,
          truncated: preview?.truncated ?? false,
          error,
        };
      });
      setItems(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, driver, path, options, sheets, nullToken]);

  useEffect(() => {
    return () => {
      disposedRef.current = true;
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  const entries = useMemo<SheetPlanEntry[]>(
    () =>
      (items ?? []).map((s) => ({
        sheet: s.sheet,
        include: s.include,
        tableName: s.tableName,
        drafts: s.drafts,
      })),
    [items],
  );
  const issues = useMemo(
    () => checkSheetPlan(driver, entries, existingTables),
    [driver, entries, existingTables],
  );
  const selected = entries.filter((e) => e.include).length;
  const canImport = items !== null && selected > 0 && issues.every((i) => i === null) && !importing;

  const update = (index: number, patch: Partial<SheetState>) =>
    setItems((prev) => (prev ? prev.map((s, i) => (i === index ? { ...s, ...patch } : s)) : prev));

  const issueText = (issue: SheetIssue): string => {
    if (issue.kind === "exists") return t("importSheetsTableExists", { table: issue.name });
    if (issue.kind === "duplicate") return t("importSheetsTableDuplicate", { table: issue.name });
    return tableErrorText(issue.error);
  };
  const tableErrorText = (err: NonNullable<NewTableError>): string => {
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

  const handleImport = async () => {
    if (!canImport) return;
    const requests = buildSheetRequests(entries);
    const streamId = newStreamId();
    streamIdRef.current = streamId;
    setStatus({ kind: "importing", index: 0, inserted: 0, total: 0 });
    if (unlistenRef.current) unlistenRef.current();
    // `started` はシートごとに届く。何枚目かはその回数で分かる。
    let startedCount = 0;
    const unlisten = await listenImportStream(streamId, {
      onStarted: (e) => {
        startedCount += 1;
        setStatus({ kind: "importing", index: startedCount, inserted: 0, total: e.total });
      },
      onProgress: (e) =>
        setStatus({ kind: "importing", index: startedCount, inserted: e.inserted, total: e.total }),
      onDone: (e) => {
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }
        setStatus({ kind: "done", event: e });
        toast.success(t("importSheetsDone", { sheets: e.sheets.length, inserted: e.inserted }));
        onImported(e.sheets.map((s) => s.table));
      },
      onError: (e) => {
        setStatus({ kind: "error", message: e.error });
        toast.error(e.error);
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }
        // 失敗したシートより前のシートは取り込み済みなので、ツリーの更新を促す。
        if (e.committed) onImported(requests.map((r) => r.table));
      },
    });
    if (disposedRef.current) {
      unlisten();
      return;
    }
    unlistenRef.current = unlisten;
    try {
      await api.importXlsxSheets({
        sessionId,
        streamId,
        database,
        path,
        options: sheetImportOptions(options),
        sheets: requests,
      });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    }
  };

  const handleCancel = useCallback(async () => {
    const sid = streamIdRef.current;
    if (sid) {
      try {
        await api.cancelStream(sid);
      } catch {
        /* best-effort */
      }
    }
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setStatus({ kind: "error", message: t("importSheetsCancelled") });
  }, [t]);

  const percent =
    status.kind === "importing" && status.total > 0
      ? Math.min(100, Math.round((status.inserted / status.total) * 100))
      : 0;

  return (
    <Modal
      onSubmit={handleImport}
      submitDisabled={!canImport}
      width="680px"
      onClose={onClose}
      closeOnInteractOutside={!importing}
      closeOnEscape={!importing}
    >
      <ModalHeader onClose={onClose} closeLabel={t("importClose")} closeDisabled={importing}>
        {t("importSheetsTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div textStyle="caption">{t("importSheetsIntro", { database })}</chakra.div>
        {items === null && (
          <chakra.div display="flex" alignItems="center" gap="2">
            <Spinner size={14} />
            <chakra.span textStyle="caption">{t("importSheetsLoading")}</chakra.span>
          </chakra.div>
        )}
        {items && (
          <FormSection>
            <FieldLabel as="div">{t("importSheetsList")}</FieldLabel>
            <chakra.div display="flex" flexDirection="column" gap="2">
              {items.map((s, i) => {
                const issue = issues[i];
                return (
                  <chakra.div key={s.sheet} display="flex" flexDirection="column" gap="1">
                    <chakra.div display="flex" alignItems="center" gap="2">
                      <Checkbox
                        checked={s.include}
                        onChange={() => update(i, { include: !s.include })}
                        disabled={importing || s.error !== null || s.drafts.length === 0}
                        aria-label={t("importSheetsInclude", { sheet: s.sheet })}
                      />
                      <chakra.span
                        flex="0 0 30%"
                        minW={0}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {s.sheet}
                      </chakra.span>
                      <Input
                        flex="1"
                        minW={0}
                        type="text"
                        fontFamily="mono"
                        value={s.tableName}
                        onChange={(e) => update(i, { tableName: e.target.value })}
                        disabled={importing || !s.include}
                        aria-label={t("importSheetsTableName", { sheet: s.sheet })}
                        aria-invalid={issue !== null}
                      />
                      <chakra.span textStyle="caption" flex="0 0 auto">
                        {t("importSheetsShape", { columns: s.drafts.length, rows: s.rowCount })}
                        {s.truncated ? "+" : ""}
                      </chakra.span>
                    </chakra.div>
                    {s.error && <FieldError>{s.error}</FieldError>}
                    {!s.error && s.drafts.length === 0 && (
                      <chakra.span textStyle="caption">{t("importSheetsEmpty")}</chakra.span>
                    )}
                    {issue && <FieldError>{issueText(issue)}</FieldError>}
                  </chakra.div>
                );
              })}
            </chakra.div>
            <chakra.div textStyle="caption">{t("importSheetsHint")}</chakra.div>
          </FormSection>
        )}
        {status.kind === "importing" && (
          <chakra.div role="status" aria-live="polite" display="flex" flexDirection="column" gap="1.5">
            <DeterminateProgressBar value={percent / 100} />
            <chakra.div textStyle="caption">
              {t("importSheetsProgress", {
                index: status.index,
                count: selected,
                inserted: status.inserted,
                total: status.total,
              })}
            </chakra.div>
          </chakra.div>
        )}
        {status.kind === "done" && (
          <chakra.div display="flex" flexDirection="column" gap="2" data-testid="import-sheets-result">
            <Callout tone={status.event.skippedTotal > 0 ? "warning" : "success"} role="status">
              {t("importSheetsDone", { sheets: status.event.sheets.length, inserted: status.event.inserted })}
              {status.event.skippedTotal > 0
                ? ` ${t("importSheetsSkipped", { skipped: status.event.skippedTotal })}`
                : ""}
            </Callout>
            <chakra.ul listStyleType="disc" pl="4" m="0" textStyle="caption">
              {status.event.sheets.map((r) => (
                <li key={r.sheet}>
                  {t("importSheetsResultRow", {
                    sheet: r.sheet,
                    table: r.table,
                    inserted: r.inserted,
                    skipped: r.skippedTotal,
                  })}
                </li>
              ))}
            </chakra.ul>
          </chakra.div>
        )}
        {status.kind === "error" && <ErrorNote>{status.message}</ErrorNote>}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        {importing ? (
          <PressableButton type="button" variant="warning" onClick={() => void handleCancel()}>
            {t("importStop")}
          </PressableButton>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("importClose")}
          </Button>
        )}
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={importing}
          onClick={() => void handleImport()}
          disabled={!canImport || status.kind === "done"}
        >
          {importing ? t("importImporting") : t("importSheetsExecute", { count: selected })}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
