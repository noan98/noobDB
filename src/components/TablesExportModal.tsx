import { useEffect, useRef, useState } from "react";
import { DeterminateProgressBar } from "./StreamProgressBar";
import { chakra } from "@chakra-ui/react";
import { open } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import { api, listenExportStream, type ExportFormat } from "../api/tauri";
import { useT } from "../i18n";
import { useSettings } from "../settings";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Input, Radio } from "./ui";
import { resolveExportMasks } from "./exportMasking";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { useToast } from "./Toast";
import { qualifiedTableSql } from "./sqlDialect";
import { batchExportFileName, batchTimestamp } from "./batchTables";
import { loadTablesExportPrefs, saveTablesExportPrefs, tablesExportScope } from "../inputMemory";

const FORMATS: ExportFormat[] = ["csv", "json", "ndjson", "markdown", "sql", "xlsx"];

const FORMAT_LABEL_KEYS = {
  csv: "exportFormatCsv",
  json: "exportFormatJson",
  ndjson: "exportFormatNdjson",
  markdown: "exportFormatMarkdown",
  sql: "exportFormatSql",
  xlsx: "exportFormatXlsx",
} as const;

interface Props {
  sessionId: string;
  driver: string;
  database: string;
  tables: string[];
  /** 接続プロファイル ID。前回の形式・保存先・マスク・DDL 同梱を接続 × DB ごとに記憶する (#1631)。 */
  profileId?: string;
  onClose: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "running"; index: number; table: string; rows: number }
  | { kind: "error"; failures: { table: string; error: string }[] };

type OneResult = { ok: true; rows: number } | { ok: false; error: string } | { ok: "cancelled" };

/**
 * スキーマツリーで複数選択したテーブルを、テーブルごとに 1 ファイルでまとめて書き出す (#1399)。
 * 新しい IPC は持たず、既存の `export_query_stream` (SELECT のみ・read_only でも可) を
 * テーブルの数だけ順に呼ぶ。進捗は「n / N テーブル目 + 行数」、キャンセルは実行中のストリームを
 * 止めて残りを打ち切る。失敗したテーブルがあっても残りは続け、最後にまとめて表示する。
 */
export function TablesExportModal({ sessionId, driver, database, tables, profileId, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const settings = useSettings();
  const memoryScope = tablesExportScope(profileId, database);
  const [remembered] = useState(() => (profileId ? loadTablesExportPrefs(memoryScope) : null));
  const [format, setFormat] = useState<ExportFormat>(remembered?.format ?? "csv");
  // 前回の保存先があればそれを初期値にし、ダウンロードフォルダの既定で上書きしない。
  const [dir, setDir] = useState(remembered?.dir ?? "");
  // 単発の ExportModal と同じ設定 (exportMaskPresets) をテーブルごとの列名に当てて masks を作る。
  const [maskEnabled, setMaskEnabled] = useState(remembered?.maskEnabled ?? false);
  // SQL 形式で各ファイルの先頭に CREATE TABLE 文を含める (#1539)。
  const [includeDdl, setIncludeDdl] = useState(remembered?.includeDdl ?? false);
  // xlsx のとき、全テーブルを 1 つのブックの別シートへまとめる (#1624)。
  const [singleWorkbook, setSingleWorkbook] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const streamIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);
  const disposedRef = useRef(false);
  const userEditedDirRef = useRef(!!remembered?.dir);
  const isRunning = status.kind === "running";
  const workbookMode = format === "xlsx" && singleWorkbook && tables.length > 1;

  // 既定の保存先は OS のダウンロードフォルダ (`ExportModal` と同じ)。取得できなければ空のまま。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await downloadDir();
        if (!cancelled && !userEditedDirRef.current && typeof d === "string") setDir(d);
      } catch {
        // ダウンロードフォルダが解決できない環境ではユーザに選んでもらう。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // アンマウント時は、実行中のストリームを止めて購読を外す。
  useEffect(() => {
    // StrictMode (開発時) はクリーンアップ後に再マウントされるので、フラグを戻す。
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      cancelledRef.current = true;
      const sid = streamIdRef.current;
      if (sid) {
        void api.cancelStream(sid).catch(() => {
          /* すでに終わっている */
        });
      }
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: t("batchExportPickDir") });
      if (typeof selected === "string" && selected) {
        userEditedDirRef.current = true;
        setDir(selected);
      }
    } catch (e) {
      toast.error(t("batchExportError", { error: String(e) }));
    }
  };

  /** 列名はテーブルごとに違うので、書き出す直前に定義を取ってマスクのプリセットを解決する。 */
  const resolveMasks = async (table: string) => {
    if (!maskEnabled) return null;
    const cols = await api.describeTable(sessionId, database, table);
    const resolved = resolveExportMasks(
      cols.map((c) => c.name),
      settings.exportMaskPresets,
      {},
    );
    return resolved.length > 0 ? resolved : null;
  };

  /**
   * 1 回のストリーム書き出しを走らせ、完了 / 失敗 / キャンセルのどれかで解決する。`start` が
   * バックエンドの書き出しコマンドを呼ぶ (テーブルごと 1 ファイル / 1 ブックの両方で共通)。
   * `start` が false を返したら (準備中にキャンセルされた) ストリームを始めずに終える。
   */
  const runStream = async (
    label: string,
    index: number,
    start: (streamId: string) => Promise<boolean>,
  ): Promise<OneResult> => {
    const streamId = `export_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    streamIdRef.current = streamId;
    let settle: (r: OneResult) => void = () => {};
    const done = new Promise<OneResult>((resolve) => {
      settle = resolve;
    });
    const unlisten = await listenExportStream(streamId, {
      onProgress: (e) => setStatus({ kind: "running", index, table: label, rows: e.rows }),
      onDone: (e) => settle({ ok: true, rows: e.rows }),
      onError: (e) => settle({ ok: false, error: e.message }),
      onCancelled: () => settle({ ok: "cancelled" }),
    });
    unlistenRef.current = unlisten;
    if (disposedRef.current) {
      unlisten();
      return { ok: "cancelled" };
    }
    try {
      // 準備 (マスク解決の describe など) の待機中にキャンセルされたら、ストリームを始めずに終える
      // (この時点ではバックエンドにストリームが無く cancelStream が効かない)。
      if (cancelledRef.current || disposedRef.current || !(await start(streamId))) {
        settle({ ok: "cancelled" });
      } else if (cancelledRef.current || disposedRef.current) {
        // 起動の IPC を待つ間にキャンセルされると、その時点では取消が空振りしうる。
        // 戻ってきた時点で登録済みなので、もう一度取消を送る。
        await api.cancelStream(streamId).catch(() => undefined);
      }
    } catch (e) {
      settle({ ok: false, error: String(e) });
    }
    const result = await done;
    unlisten();
    unlistenRef.current = null;
    streamIdRef.current = null;
    return result;
  };

  /** 1 テーブルを 1 ファイルへ書き出す。 */
  const exportOne = (table: string, path: string, index: number): Promise<OneResult> =>
    runStream(table, index, async (streamId) => {
      // 取得に失敗したときはマスクできないまま書き出さず、そのテーブルを失敗にする (throw)。
      const masks = await resolveMasks(table);
      if (cancelledRef.current || disposedRef.current) return false;
      await api.exportQueryStream({
        sessionId,
        streamId,
        sql: qualifiedTableSql(driver, database, table),
        database,
        format,
        path,
        initialBatch: Math.max(1, settings.defaultDisplayCount),
        chunkSize: Math.max(1, settings.streamPrefetchSize),
        // 大量出力が途中で打ち切られないよう、エクスポートにはタイムアウトを掛けない。
        queryTimeoutSecs: null,
        table: format === "sql" ? table : null,
        batchSize: null,
        masks,
        includeDdl: format === "sql" && includeDdl,
      });
      return true;
    });

  /** 選んだ全テーブルを 1 つの xlsx ブック (テーブルごとに 1 シート) へ書き出す (#1624)。 */
  const exportWorkbook = (path: string): Promise<OneResult> =>
    runStream(t("batchExportWorkbookLabel", { count: tables.length }), 0, async (streamId) => {
      const sheets = [];
      for (const table of tables) {
        sheets.push({
          name: table,
          sql: qualifiedTableSql(driver, database, table),
          masks: await resolveMasks(table),
        });
        if (cancelledRef.current || disposedRef.current) return false;
      }
      await api.exportTablesXlsx({
        sessionId,
        streamId,
        database,
        sheets,
        path,
        initialBatch: Math.max(1, settings.defaultDisplayCount),
        chunkSize: Math.max(1, settings.streamPrefetchSize),
      });
      return true;
    });

  const handleExport = async () => {
    if (isRunning || !dir.trim()) return;
    cancelledRef.current = false;
    // 次回の初期値にするため、形式・保存先・マスク・DDL 同梱を覚える (秘密情報は含まない, #1631)。
    if (profileId) saveTablesExportPrefs(memoryScope, { format, dir: dir.trim(), maskEnabled, includeDdl });
    const used = new Set<string>();
    // 保存先の既存ファイルを上書きしないよう、この実行の日時をファイル名に付ける。
    const stamp = batchTimestamp();
    const failures: { table: string; error: string }[] = [];
    let written = 0;
    if (workbookMode) {
      // 1 ブックにまとめる: 1 回の書き出しで全テーブルが成功か失敗かになる。
      const label = t("batchExportWorkbookLabel", { count: tables.length });
      setStatus({ kind: "running", index: 0, table: label, rows: 0 });
      let result: OneResult;
      try {
        const path = await join(dir, batchExportFileName(database, format, used, stamp));
        result = await exportWorkbook(path);
      } catch (e) {
        result = { ok: false, error: String(e) };
      }
      if (result.ok === true) written = tables.length;
      else if (result.ok === false) failures.push({ table: label, error: result.error });
    } else {
      for (let i = 0; i < tables.length; i++) {
        if (cancelledRef.current || disposedRef.current) break;
        const table = tables[i] as string;
        setStatus({ kind: "running", index: i, table, rows: 0 });
        let result: OneResult;
        try {
          const path = await join(dir, batchExportFileName(table, format, used, stamp));
          result = await exportOne(table, path, i);
        } catch (e) {
          result = { ok: false, error: String(e) };
        }
        if (result.ok === true) written += 1;
        else if (result.ok === false) failures.push({ table, error: result.error });
        else break;
      }
    }
    if (disposedRef.current) return;
    if (cancelledRef.current) {
      setStatus({ kind: "idle" });
      toast.info(t("batchExportCancelled", { done: written, count: tables.length }));
      return;
    }
    if (failures.length > 0) {
      setStatus({ kind: "error", failures });
      toast.error(t("batchExportPartial", { done: written, count: tables.length, failed: failures.length }));
      return;
    }
    // 完了トーストから保存先をすぐ開ける (#1631)。開けなかったときは理由をエラートーストで知らせる。
    toast.notify({
      message: t("batchExportDone", { count: written, dir }),
      tone: "success",
      action: {
        label: t("batchExportOpenDir"),
        onAction: () => {
          api
            .revealInFileManager(dir)
            .catch((e) => toast.error(t("batchExportOpenDirFailed", { error: String(e) })));
        },
      },
    });
    onClose();
  };

  const handleCancelRun = async () => {
    cancelledRef.current = true;
    const sid = streamIdRef.current;
    if (sid) await api.cancelStream(sid).catch(() => undefined);
  };

  return (
    <Modal
      onSubmit={handleExport}
      submitDisabled={isRunning || !dir.trim()}
      width="560px"
      onClose={onClose}
      closeOnInteractOutside={!isRunning}
      closeOnEscape={!isRunning}
    >
      <ModalHeader onClose={onClose} closeLabel={t("exportClose")} closeDisabled={isRunning}>
        {t("batchExportTitle", { count: tables.length })}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight={1.5}>
          {t(workbookMode ? "batchExportNoteWorkbook" : "batchExportNote", { database })}
        </chakra.div>
        <chakra.div
          fontSize="sm"
          color="app.text"
          wordBreak="break-all"
          maxH="6rem"
          overflowY="auto"
          data-testid="batch-export-tables"
        >
          {tables.join(", ")}
        </chakra.div>

        <FormSection>
          <FieldLabel as="div">{t("exportFormat")}</FieldLabel>
          <chakra.div role="radiogroup" aria-label={t("exportFormat")} display="flex" flexWrap="wrap" gap="2">
            {FORMATS.map((fmt) => (
              <chakra.label
                key={fmt}
                display="inline-flex"
                alignItems="center"
                gap="1.5"
                py="1.5"
                px="3"
                border="1px solid"
                borderColor={format === fmt ? "app.accent" : "app.border"}
                borderRadius="md"
                fontSize="md"
                cursor="pointer"
                bg={format === fmt ? "app.rowHover" : "app.surface"}
                userSelect="none"
              >
                <Radio
                  name="batch-export-format"
                  value={fmt}
                  checked={format === fmt}
                  onChange={() => setFormat(fmt)}
                  disabled={isRunning}
                  m={0}
                />
                <span>{t(FORMAT_LABEL_KEYS[fmt])}</span>
              </chakra.label>
            ))}
          </chakra.div>
        </FormSection>

        {format === "sql" && (
          <FormSection>
            <chakra.label
              display="inline-flex"
              alignItems="center"
              gap="2"
              cursor="pointer"
              userSelect="none"
              fontSize="md"
            >
              <Checkbox
                checked={includeDdl}
                onChange={(e) => setIncludeDdl(e.target.checked)}
                disabled={isRunning}
              />
              <span>{t("exportSqlIncludeDdl")}</span>
            </chakra.label>
            <chakra.div textStyle="caption">{t("exportSqlIncludeDdlHint")}</chakra.div>
          </FormSection>
        )}

        {format === "xlsx" && tables.length > 1 && (
          <FormSection>
            <chakra.label
              display="inline-flex"
              alignItems="center"
              gap="2"
              cursor="pointer"
              userSelect="none"
              fontSize="md"
            >
              <Checkbox
                checked={singleWorkbook}
                onChange={(e) => setSingleWorkbook(e.target.checked)}
                disabled={isRunning}
              />
              <span>{t("batchExportSingleWorkbook")}</span>
            </chakra.label>
            <chakra.div textStyle="caption">{t("batchExportSingleWorkbookHint")}</chakra.div>
          </FormSection>
        )}

        <FormSection>
          <FieldLabel as="div">{t("exportMasking")}</FieldLabel>
          <chakra.label
            display="inline-flex"
            alignItems="center"
            gap="2"
            cursor="pointer"
            userSelect="none"
            fontSize="md"
          >
            <Checkbox
              checked={maskEnabled}
              onChange={(e) => setMaskEnabled(e.target.checked)}
              disabled={isRunning}
            />
            <span>{t("exportMaskingEnable")}</span>
          </chakra.label>
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="batch-export-dir">{t("batchExportDir")}</FieldLabel>
          <PathRow>
            <Input
              id="batch-export-dir"
              flex="1"
              minW={0}
              type="text"
              value={dir}
              onChange={(e) => {
                userEditedDirRef.current = true;
                setDir(e.target.value);
              }}
              placeholder={t("batchExportDirPlaceholder")}
              disabled={isRunning}
            />
            <Button type="button" onClick={handleBrowse} disabled={isRunning}>
              {t("exportBrowse")}
            </Button>
          </PathRow>
        </FormSection>

        {status.kind === "running" && (
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <DeterminateProgressBar value={tables.length > 0 ? status.index / tables.length : 0} />
            <chakra.div fontSize="sm" color="app.text" role="status" fontWeight={500}>
              {workbookMode
                ? t("batchExportWorkbookProgress", { count: tables.length, rows: status.rows })
                : t("batchExportProgress", {
                    index: status.index + 1,
                    count: tables.length,
                    table: status.table,
                    rows: status.rows,
                  })}
            </chakra.div>
          </chakra.div>
        )}
        {status.kind === "error" && (
          <ErrorNote>
            {status.failures.map((f) => (
              <chakra.div key={f.table} wordBreak="break-all">
                {t("batchExportFailedItem", { table: f.table, error: f.error })}
              </chakra.div>
            ))}
          </ErrorNote>
        )}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        {isRunning ? (
          <Button type="button" variant="secondary" onClick={() => void handleCancelRun()}>
            {t("batchExportCancelRun")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("exportCancel")}
          </Button>
        )}
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={isRunning}
          onClick={() => void handleExport()}
          disabled={isRunning || !dir.trim()}
        >
          {isRunning ? t("exportSaving") : t("exportExecute")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
