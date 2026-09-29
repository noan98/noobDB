import { useCallback } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type CellValue, type Column } from "../api/tauri";
import { useT } from "../i18n";
import { useToast } from "./Toast";
import {
  MAX_BLOB_BYTES,
  blobFileName,
  blobKeyParts,
  detectBlobKindFromHex,
  formatBlobSize,
  hexToBytes,
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
  /** 生バイトを 16 進文字列で取得 (NULL は null)。 */
  fetchHex: () => Promise<string | null>;
  /** ファイルへ保存する。 */
  save: () => Promise<void>;
  /** ファイルから読み込んで書き戻す。書き戻せない状況では undefined。 */
  load?: () => Promise<void>;
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

      const fetchHex = () =>
        api.fetchCellBytes(config.sessionId, database ?? null, table, col.name, key);

      const saveToFile = async () => {
        try {
          const hex = await fetchHex();
          if (hex === null) {
            toast.error(t("blobIsNull"));
            return;
          }
          const bytes = hexToBytes(hex);
          if (!bytes) throw new Error("invalid hex");
          const path = await save({
            defaultPath: blobFileName(col.name, detectBlobKindFromHex(hex)),
          });
          if (typeof path !== "string" || !path) return;
          await api.writeBinaryFile(path, bytes);
          toast.success(t("blobSaved", { size: formatBlobSize(bytes.length), path }));
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
              const hex = await api.readBinaryFile(path);
              if (hex.length / 2 > MAX_BLOB_BYTES) throw new Error("too large");
              await onWrite(rowIdx, colIdx, hex);
            } catch (e) {
              toast.error(t("blobLoadFailed", { error: String(e) }));
            }
          }
        : undefined;

      return { fetchHex, save: saveToFile, load: loadFromFile };
    },
    [config, database, table, columns, rows, pkIndices, isBinaryColumn, t, toast],
  );
}
