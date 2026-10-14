import { useCallback } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type CellBlobProbe, type CellValue, type Column } from "../api/tauri";
import { useT } from "../i18n";
import { useToast } from "./Toast";
import {
  MAX_BLOB_BYTES,
  blobFileName,
  blobKeyParts,
  bytesToHex,
  formatBlobSize,
  type BlobKeyPart,
} from "./blobIo";

/**
 * BLOB セルのファイル入出力を有効にするための、結果グリッドへの入力 (#1148)。
 * `onWrite` が無いとき (読み取り専用・編集不可) は保存だけが使える。
 */
export interface BlobIoConfig {
  sessionId: string;
  /**
   * ファイルから読んだ内容 (16 進) でセルを書き換える。確認・UPDATE 実行・グリッド
   * 反映は呼び出し側 (App) が行い、実行したら true を返す。
   */
  onWrite?: (rowIdx: number, colIdx: number, hex: string) => Promise<boolean>;
}

export interface CellBlobHandlers {
  /** サイズと種別だけを取得する (本体は転送しない。NULL は null)。 */
  probe: () => Promise<CellBlobProbe | null>;
  /** 生バイトを取得する (NULL セルは reject。先に `probe` で確認する)。 */
  fetchBytes: () => Promise<Uint8Array>;
  /** ファイルへ保存する (DB → ファイルはバックエンド内で完結し、BLOB は IPC を通らない)。 */
  save: () => Promise<void>;
  /** ファイルから読み込んで書き戻す。書き戻せない状況では undefined。 */
  load?: () => Promise<void>;
  /**
   * この列の BLOB を、指定した複数行ぶんまとめてフォルダへ保存する (#1539)。ファイル名は
   * 主キー由来で、フォルダ選択・件数の通知までここで行う。主キーで引けない行は飛ばす。
   */
  saveMany?: (rowIndices: number[]) => Promise<void>;
}

interface Input {
  config: BlobIoConfig | undefined;
  database: string | null | undefined;
  table: string | null | undefined;
  columns: Column[];
  rows: CellValue[][];
  pkIndices: number[] | undefined;
  isBinaryColumn: (colIdx: number) => boolean;
}

/**
 * セルごとの BLOB 入出力ハンドラを返す。主キーで行を引けないセル (キー無し・キーが
 * NULL/バイナリ) や、バイナリでない列には undefined を返して導線ごと出さない。
 */
export function useCellBlobIo({
  config,
  database,
  table,
  columns,
  rows,
  pkIndices,
  isBinaryColumn,
}: Input): (rowIdx: number, colIdx: number) => CellBlobHandlers | undefined {
  const t = useT();
  const toast = useToast();

  return useCallback(
    (rowIdx, colIdx) => {
      if (!config || !table || !isBinaryColumn(colIdx)) return undefined;
      const row = rows[rowIdx];
      const col = columns[colIdx];
      if (!row || !col) return undefined;
      const key = blobKeyParts(columns, row, pkIndices ?? [], isBinaryColumn);
      if (!key) return undefined;

      const probe = () => api.probeCellBlob(config.sessionId, database ?? null, table, col.name, key);
      const fetchBytes = () => api.fetchCellBytes(config.sessionId, database ?? null, table, col.name, key);

      const saveToFile = async () => {
        try {
          const info = await probe();
          if (info === null) {
            toast.error(t("blobIsNull"));
            return;
          }
          const path = await save({ defaultPath: blobFileName(col.name, info.ext) });
          if (typeof path !== "string" || !path) return;
          const size = await api.saveCellToFile(
            config.sessionId,
            database ?? null,
            table,
            col.name,
            key,
            path,
          );
          toast.success(t("blobSaved", { size: formatBlobSize(size), path }));
        } catch (e) {
          toast.error(t("blobSaveFailed", { error: String(e) }));
        }
      };

      const saveMany = async (rowIndices: number[]) => {
        try {
          const keys: BlobKeyPart[][] = [];
          let noKey = 0;
          for (const r of rowIndices) {
            const k = rows[r] ? blobKeyParts(columns, rows[r], pkIndices ?? [], isBinaryColumn) : null;
            if (k) keys.push(k);
            else noKey += 1;
          }
          if (keys.length === 0) {
            toast.error(t("blobFolderNoKeys"));
            return;
          }
          const folder = await open({
            directory: true,
            multiple: false,
            title: t("blobFolderPickTitle"),
          });
          if (typeof folder !== "string" || !folder) return;
          const res = await api.saveCellsToFolder(
            config.sessionId,
            database ?? null,
            table,
            col.name,
            keys,
            folder,
          );
          const skipped = res.skippedNull + res.skippedTooLarge + noKey;
          const summary = t("blobFolderSaved", {
            saved: res.saved,
            size: formatBlobSize(res.totalBytes),
            skipped,
            failed: res.failed,
            folder,
          });
          if (res.failed > 0) {
            toast.error(`${summary} ${t("blobFolderFirstError", { error: res.errors[0]?.error ?? "" })}`);
          } else {
            toast.success(summary);
          }
        } catch (e) {
          toast.error(t("blobSaveFailed", { error: String(e) }));
        }
      };

      const onWrite = config.onWrite;
      const loadFromFile = onWrite
        ? async () => {
            try {
              const path = await open({ multiple: false, title: t("blobLoadPickTitle") });
              if (typeof path !== "string" || !path) return;
              const bytes = await api.readBinaryFile(path);
              if (bytes.length > MAX_BLOB_BYTES) throw new Error("too large");
              await onWrite(rowIdx, colIdx, bytesToHex(bytes));
            } catch (e) {
              toast.error(t("blobLoadFailed", { error: String(e) }));
            }
          }
        : undefined;

      return { probe, fetchBytes, save: saveToFile, load: loadFromFile, saveMany };
    },
    [config, database, table, columns, rows, pkIndices, isBinaryColumn, t, toast],
  );
}
