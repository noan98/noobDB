import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { api, type DriverKind, type TableColumnInfo } from "../api/tauri";
import {
  buildAlterPlan,
  type AlterStatement,
  type ExistingColumnBaseline,
  type ExistingColumnEdit,
  type IndexDef,
  type NewColumn,
  type UnsupportedChange,
} from "./alterTable";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Input, PressableButton, Switch } from "./ui";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

/**
 * 既存テーブルの列編集ダイアログ (#794)。`describeTable` で現状の列を取得し、
 * 列の追加 / 変更 / 削除 / リネームとインデックス作成を 1 つのフォームで組み立てて
 * SQL をプレビューする。DDL 生成の純ロジックは `alterTable.ts` (方言別テスト付き)、
 * UI 構成は `CreateTableModal` と同じ流儀。read_only セッションでは実行ボタンを
 * 無効化する (バックエンドも write を拒否する)。実行そのものは呼び出し側 (App) が
 * `run_query_transaction` を通し、危険操作確認 (typedConfirmation) もそこで挟む —
 * `onRun` には (SQL 文字列ではなく) 生成済みの `AlterStatement[]` をそのまま渡し、
 * 破壊的判定 (`DROP COLUMN` を含むか) は各文の `destructive` フラグを見て行う
 * (SQL テキストの正規表現マッチには依存しない)。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string;
  table: string;
  readOnly: boolean;
  onRun: (statements: AlterStatement[]) => void;
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

/** `added`/`indexes` 行のローカル state に付ける安定 id。React key 用のみで
 *  `buildAlterPlan` へ渡す前に取り除く (フォーム行の並び替えは無いが、削除で
 *  配列インデックスがズレたときに入力途中の行の React state — IME 変換中の
 *  文字列や focus など — が別の行へ取り違えられないようにする)。 */
interface AddedColumnRow extends NewColumn {
  id: string;
}
interface IndexRow extends IndexDef {
  id: string;
}

function emptyNewColumn(driver: DriverKind): NewColumn {
  return { name: "", type: driver === "sqlite" ? "TEXT" : "VARCHAR(255)", notNull: false, defaultValue: "" };
}

function emptyIndex(): IndexDef {
  return { name: "", columns: [], unique: false };
}

export function AlterTableModal({ sessionId, driver, database, table, readOnly, onRun, onSendToEditor, onClose }: Props) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<ExistingColumnBaseline[]>([]);
  const [existing, setExisting] = useState<ExistingColumnEdit[]>([]);
  const [added, setAdded] = useState<AddedColumnRow[]>([]);
  const [indexes, setIndexes] = useState<IndexRow[]>([]);
  // `added`/`indexes` 行の React key を配列インデックスに頼らないための採番。
  const rowIdCounter = useRef(0);
  const nextRowId = () => `row${++rowIdCounter.current}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .describeTable(sessionId, database, table)
      .then((cols: TableColumnInfo[]) => {
        if (cancelled) return;
        const base: ExistingColumnBaseline[] = cols.map((c) => ({
          name: c.name,
          type: c.data_type,
          notNull: !c.nullable,
          defaultValue: c.default ?? "",
          extra: c.extra,
        }));
        setBaseline(base);
        setExisting(
          base.map((b) => ({
            original: b.name,
            drop: false,
            name: b.name,
            type: b.type,
            notNull: b.notNull,
            defaultValue: b.defaultValue,
          })),
        );
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table]);

  const setExistingAt = (i: number, patch: Partial<ExistingColumnEdit>) =>
    setExisting((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  // `existing[i].drop` を外側のクロージャから読まず、setState の関数更新内で
  // 反転させる (setExistingAt と同じ流儀に統一。連続クリックや古いレンダの
  // クロージャから stale な値を反転させてしまう余地をなくす)。
  const toggleDrop = (i: number) =>
    setExisting((rows) => rows.map((r, idx) => (idx === i ? { ...r, drop: !r.drop } : r)));

  const setAddedAt = (i: number, patch: Partial<NewColumn>) =>
    setAdded((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addNewColumn = () =>
    setAdded((rows) => [...rows, { id: nextRowId(), ...emptyNewColumn(driver) }]);
  const removeNewColumn = (i: number) => setAdded((rows) => rows.filter((_, idx) => idx !== i));

  const setIndexAt = (i: number, patch: Partial<IndexDef>) =>
    setIndexes((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addIndex = () => setIndexes((rows) => [...rows, { id: nextRowId(), ...emptyIndex() }]);
  const removeIndex = (i: number) => setIndexes((rows) => rows.filter((_, idx) => idx !== i));
  const toggleIndexColumn = (i: number, col: string) =>
    setIndexes((rows) =>
      rows.map((r, idx) => {
        if (idx !== i) return r;
        const has = r.columns.includes(col);
        return { ...r, columns: has ? r.columns.filter((c) => c !== col) : [...r.columns, col] };
      }),
    );

  // インデックスの列選択肢: 削除予定でない既存列 (リネーム後の名前) + 名前が
  // 入力済みの新規列。既存列をリネームせず新規列が同名を再利用するような
  // 縁のケースで重複しうるため `Set` で去重する。
  const availableColumns = useMemo(() => {
    const kept = existing.filter((e) => !e.drop).map((e) => e.name.trim() || e.original);
    const addedNames = added.map((c) => c.name.trim()).filter((n) => n.length > 0);
    return [...new Set([...kept, ...addedNames])];
  }, [existing, added]);

  const plan = useMemo(
    () =>
      buildAlterPlan(driver, {
        database,
        table,
        baseline,
        existing,
        // id は React key 専用のローカル state なので、純ロジックへ渡す前に取り除く。
        added: added.map((r) => ({ name: r.name, type: r.type, notNull: r.notNull, defaultValue: r.defaultValue })),
        indexes: indexes.map((r) => ({ name: r.name, columns: r.columns, unique: r.unique })),
      }),
    [driver, database, table, baseline, existing, added, indexes],
  );
  const statements = plan.statements;
  const unsupported = plan.unsupported;
  const valid = statements.length > 0;

  const sqlPreview = statements.map((s: AlterStatement) => s.sql).join("\n");

  return (
    <Modal width="880px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("createTableClose")}>
        {t("alterTableTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {loading && <chakra.span fontSize="sm" color="app.textMuted">{t("alterTableLoading")}</chakra.span>}
        {loadError && (
          <chakra.span fontSize="sm" color="app.dangerFg">
            {t("alterTableLoadError", { error: loadError })}
          </chakra.span>
        )}

        {!loading && !loadError && (
          <>
            <chakra.div display="flex" flexDirection="column" gap="1.5">
              <chakra.span fontSize="xs" fontWeight="600" color="app.textMuted">
                {t("alterTableExistingSection")}
              </chakra.span>
              {driver === "mysql" && (
                <chakra.span fontSize="xs" color="app.textMuted">
                  {t("alterTableMysqlExtraNote")}
                </chakra.span>
              )}
              <chakra.div
                display="grid"
                gridTemplateColumns="1.1fr 1.1fr 1.3fr auto auto 1.2fr auto"
                gap="1.5"
                fontSize="xs"
                color="app.textMuted"
                px="0.5"
              >
                <span>{t("createTableColName")}</span>
                <span>{t("alterTableNewName")}</span>
                <span>{t("createTableColType")}</span>
                <span>{t("createTableColNotNull")}</span>
                <span />
                <span>{t("createTableColDefault")}</span>
                <span />
              </chakra.div>
              {existing.map((row, i) => (
                <chakra.div
                  key={row.original}
                  display="grid"
                  gridTemplateColumns="1.1fr 1.1fr 1.3fr auto auto 1.2fr auto"
                  gap="1.5"
                  alignItems="center"
                  opacity={row.drop ? 0.5 : 1}
                >
                  <chakra.span fontSize="sm" fontFamily="mono" color="app.text" title={row.original}>
                    {row.original}
                  </chakra.span>
                  <Input
                    value={row.name}
                    onChange={(e) => setExistingAt(i, { name: e.target.value })}
                    disabled={row.drop}
                  />
                  <Input
                    value={row.type}
                    onChange={(e) => setExistingAt(i, { type: e.target.value })}
                    disabled={row.drop}
                  />
                  <Switch
                    checked={row.notNull}
                    onChange={() => setExistingAt(i, { notNull: !row.notNull })}
                    disabled={row.drop}
                    aria-label={t("alterTableNotNullAria", { column: row.original })}
                  />
                  <span />
                  <Input
                    value={row.defaultValue}
                    onChange={(e) => setExistingAt(i, { defaultValue: e.target.value })}
                    placeholder={t("createTableColDefault")}
                    disabled={row.drop}
                  />
                  <Tooltip label={row.drop ? t("alterTableKeep") : t("alterTableDrop")}>
                    <chakra.button
                      type="button"
                      onClick={() => toggleDrop(i)}
                      aria-label={row.drop ? t("alterTableKeep") : t("alterTableDrop")}
                      color={row.drop ? "app.dangerFg" : "app.textMuted"}
                      _hover={{ color: "app.dangerFg" }}
                      px="1"
                    >
                      <Icon name={row.drop ? "undo" : "close"} />
                    </chakra.button>
                  </Tooltip>
                </chakra.div>
              ))}
            </chakra.div>

            <chakra.div display="flex" flexDirection="column" gap="1.5">
              <chakra.span fontSize="xs" fontWeight="600" color="app.textMuted">
                {t("alterTableAddedSection")}
              </chakra.span>
              {added.map((c, i) => (
                <chakra.div
                  key={c.id}
                  display="grid"
                  gridTemplateColumns="1.3fr 1.3fr auto 1.2fr auto"
                  gap="1.5"
                  alignItems="center"
                >
                  <Input value={c.name} onChange={(e) => setAddedAt(i, { name: e.target.value })} placeholder="column" />
                  <Input value={c.type} onChange={(e) => setAddedAt(i, { type: e.target.value })} />
                  <Switch
                    checked={c.notNull}
                    onChange={() => setAddedAt(i, { notNull: !c.notNull })}
                    aria-label={t("alterTableNotNullNewAria", { n: i + 1 })}
                  />
                  <Input
                    value={c.defaultValue}
                    onChange={(e) => setAddedAt(i, { defaultValue: e.target.value })}
                    placeholder={t("createTableColDefault")}
                  />
                  <chakra.button
                    type="button"
                    onClick={() => removeNewColumn(i)}
                    aria-label={t("createTableRemoveCol")}
                    color="app.textMuted"
                    _hover={{ color: "app.dangerFg" }}
                    px="1"
                  >
                    <Icon name="close" />
                  </chakra.button>
                </chakra.div>
              ))}
              <Flex>
                <Button type="button" variant="secondary" size="sm" onClick={addNewColumn}>
                  <Icon name="plus" /> {t("createTableAddCol")}
                </Button>
              </Flex>
            </chakra.div>

            <chakra.div display="flex" flexDirection="column" gap="1.5">
              <chakra.span fontSize="xs" fontWeight="600" color="app.textMuted">
                {t("indexesLabel")}
              </chakra.span>
              {indexes.map((idx, i) => (
                <chakra.div
                  key={idx.id}
                  display="flex"
                  flexDirection="column"
                  gap="1.5"
                  p="2"
                  borderWidth="1px"
                  borderColor="app.border"
                  borderRadius="8px"
                >
                  <Flex gap="1.5" align="center">
                    <Input
                      value={idx.name}
                      onChange={(e) => setIndexAt(i, { name: e.target.value })}
                      placeholder={t("alterTableIndexNamePlaceholder")}
                      flex="1"
                    />
                    <Switch
                      checked={idx.unique}
                      onChange={() => setIndexAt(i, { unique: !idx.unique })}
                      label={t("createTableColUnique")}
                    />
                    <chakra.button
                      type="button"
                      onClick={() => removeIndex(i)}
                      aria-label={t("alterTableRemoveIndex")}
                      color="app.textMuted"
                      _hover={{ color: "app.dangerFg" }}
                      px="1"
                    >
                      <Icon name="close" />
                    </chakra.button>
                  </Flex>
                  <Flex gap="3" wrap="wrap">
                    {availableColumns.length === 0 && (
                      <chakra.span fontSize="xs" color="app.textMuted">
                        {t("treeNoColumns")}
                      </chakra.span>
                    )}
                    {availableColumns.map((col) => (
                      <chakra.label key={col} display="flex" alignItems="center" gap="1" fontSize="sm">
                        <Checkbox
                          checked={idx.columns.includes(col)}
                          onChange={() => toggleIndexColumn(i, col)}
                        />
                        {col}
                      </chakra.label>
                    ))}
                  </Flex>
                </chakra.div>
              ))}
              <Flex>
                <Button type="button" variant="secondary" size="sm" onClick={addIndex} disabled={availableColumns.length === 0}>
                  <Icon name="plus" /> {t("alterTableAddIndex")}
                </Button>
              </Flex>
            </chakra.div>

            {unsupported.length > 0 && (
              <chakra.div display="flex" flexDirection="column" gap="1" p="2" borderWidth="1px" borderColor="app.border" borderRadius="8px">
                <Flex align="center" gap="1.5" color="app.textSecondary" fontSize="sm" fontWeight="600">
                  <Icon name="warning" />
                  {t("alterTableUnsupportedTitle")}
                </Flex>
                {unsupported.map((u: UnsupportedChange) => (
                  <chakra.span key={u.column} fontSize="xs" color="app.textMuted">
                    {t("alterTableUnsupportedSqlite", { column: u.column })}
                  </chakra.span>
                ))}
              </chakra.div>
            )}

            <chakra.div display="flex" flexDirection="column" gap="1">
              <chakra.span fontSize="xs" color="app.textMuted">
                {t("alterTablePreview")}
              </chakra.span>
              <chakra.pre
                fontFamily="mono"
                fontSize="sm"
                bg="app.surface"
                borderWidth="1px"
                borderColor="app.border"
                borderRadius="8px"
                p="2.5"
                overflowX="auto"
                whiteSpace="pre"
                color="app.text"
                minH="60px"
              >
                {sqlPreview || t("alterTablePreviewEmpty")}
              </chakra.pre>
            </chakra.div>
            {readOnly && (
              <chakra.span fontSize="xs" color="app.dangerFg">{t("alterTableReadOnly")}</chakra.span>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("createTableClose")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          type="button"
          variant="secondary"
          disabled={!valid}
          onClick={() => onSendToEditor(sqlPreview)}
        >
          {t("createTableToEditor")}
        </Button>
        <PressableButton
          type="button"
          variant="primary"
          disabled={!valid || readOnly}
          onClick={() => onRun(statements)}
        >
          {t("alterTableRun")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
