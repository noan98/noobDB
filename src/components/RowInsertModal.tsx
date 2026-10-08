import { useEffect, useId, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { Column, TableColumnInfo } from "../api/tauri";
import {
  isEmptyInsertValue,
  type PendingInsertRow,
  type PendingInsertValue,
} from "./cellEdit";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, PressableButton, Select } from "./ui";
import { boolOptions, resolveTypedEditor } from "./typedEditor";
import { insertDefaultHint, insertFunctionChips, stripNonInsertableSeed } from "./insertDefaults";
import { insertFunctionSql } from "./sqlDialect";
import { Tooltip } from "./Tooltip";
import { useValuePicker, ValueDatalist, type ValueLookup } from "./useValuePicker";
import { FK_CANDIDATE_LIMIT, type PickerKind } from "./valuePicker";

/**
 * 結果グリッドからの行追加で、新規行の各カラム値を入力するモーダル。確定すると
 * 入力済みカラムだけを持つ PendingInsertRow を返す (空欄は INSERT に含めず DB 既定値)。
 * 値の SQL リテラル化は Apply 時に cellEdit の literalFromInput が行う。
 *
 * スマート値ピッカー (#1067): `tableColumns` と `lookup` が渡されると、FK 列には
 * 参照先の既存値、ENUM / SET / CHECK 列には許可値を `<datalist>` の候補として
 * 出す。候補は入力補助にすぎず (自由入力可)、確定値は従来どおりこのフォームの
 * 文字列として PendingInsertRow に載るだけ。候補が取れない列はテキスト入力のまま。
 *
 * 既定値・自動採番・関数値の支援 (#1357): 自動採番列 / DEFAULT 式を持つ列は、空欄の
 * ままだと DB が値を決めることを入力欄の下に明示する。型に合う関数 (`CURRENT_TIMESTAMP`
 * / `NOW()` / UUID など) はチップで入れられ、チップで選んだ値だけが式として確定する
 * (入力欄に打った文字列は従来どおり引用される)。
 */
interface Props {
  table: string;
  columns: Column[];
  /**
   * 既存行の値を種にフォームを開くときの初期値 (行の複製、#820)。
   * 列インデックスをキーにした文字列値で、`onConfirm` が返す形式と同じ
   * `PendingInsertRow`。未指定 (通常の「行を追加」) なら従来どおり空欄で開く。
   */
  initialValues?: PendingInsertRow;
  onConfirm: (row: PendingInsertRow) => void;
  onCancel: () => void;
  /** 値ピッカー用: ドライバ ("mysql" | "postgres" | ...)。 */
  driver?: string;
  /** 値ピッカー用: テーブルのデータベース (PostgreSQL ではスキーマ)。 */
  database?: string | null;
  /** 値ピッカー用: `describe_table` の列メタ (FK 参照先・型定義)。 */
  tableColumns?: TableColumnInfo[] | null;
  /** 値ピッカー用: 読み取り専用の候補取得。未指定ならピッカー無効。 */
  lookup?: ValueLookup;
}

/**
 * 行追加セルの表示文字列。関数値は、そのドライバの式 (`insertFunctionSql`、引用されない)
 * をそのまま見せる。
 */
function cellText(v: PendingInsertValue | undefined, driver: string): string {
  if (v === undefined) return "";
  return typeof v === "string" ? v : (insertFunctionSql(driver, v.fn) ?? "");
}

/** 初期値 (複製の種) の文字列。種は文字列だけだが、型上は関数値も含み得るため文字列のみ採る。 */
function seedText(v: PendingInsertValue | undefined): string {
  return typeof v === "string" ? v : "";
}

export function RowInsertModal({
  table,
  columns,
  initialValues,
  onConfirm,
  onCancel,
  driver = "mysql",
  database = null,
  tableColumns = null,
  lookup,
}: Props) {
  const t = useT();
  // 複製の種から、DB が決める列 (自動採番・生成列) の値は外しておく (#1357)。
  const [values, setValues] = useState<PendingInsertRow>(() =>
    stripNonInsertableSeed(driver, initialValues ?? {}, columns, tableColumns ?? []),
  );
  // 先頭列は入力でもセレクタでもあり得るので、コールバック ref で要素を保持する。
  const firstRef = useRef<HTMLElement | null>(null);
  const setFirstRef = (el: HTMLElement | null) => {
    firstRef.current = el;
  };
  const listIdBase = useId();
  const picker = useValuePicker({ driver, database, table, columns: tableColumns, lookup });
  // フォーカス中の列の候補を (再) 取得する。FK は入力に応じて前方一致で絞る。
  const [focused, setFocused] = useState<number | null>(null);
  const focusedName = focused === null ? null : (columns[focused]?.name ?? null);
  // 複製 (#820) の種の値のままなら絞り込まずに候補を出し、打ち替え始めたら前方一致で絞る。
  // 関数値 (チップで選んだ式) は絞り込みの対象にしない。
  const focusedRaw = focused === null ? "" : seedText(values[focused]);
  const focusedValue =
    focused !== null && focusedRaw === seedText(initialValues?.[focused]) ? "" : focusedRaw;
  useEffect(() => {
    if (focusedName !== null) picker.request(focusedName, focusedValue);
  }, [picker, focusedName, focusedValue]);

  const badgeLabel = (kind: PickerKind, name: string): string => {
    if (kind === "fk") {
      const meta = tableColumns?.find((m) => m.name === name);
      return t("valuePickerFk", {
        target: `${meta?.referenced_table ?? ""}.${meta?.referenced_column ?? ""}`,
      });
    }
    return kind === "enum"
      ? t("valuePickerEnum")
      : kind === "set"
        ? t("valuePickerSet")
        : t("valuePickerCheck");
  };
  const badgeTitle = (kind: PickerKind, name: string): string => {
    if (kind === "fk") {
      const meta = tableColumns?.find((m) => m.name === name);
      return t("valuePickerTitleFk", {
        target: `${meta?.referenced_table ?? ""}.${meta?.referenced_column ?? ""}`,
        limit: FK_CANDIDATE_LIMIT,
      });
    }
    return t("valuePickerTitleAllowed");
  };

  const submit = () => {
    const row: PendingInsertRow = {};
    for (const [k, v] of Object.entries(values)) {
      if (!isEmptyInsertValue(v)) row[Number(k)] = v;
    }
    onConfirm(row);
  };

  return (
    <Modal onSubmit={submit} width="560px" onClose={onCancel} initialFocusEl={() => firstRef.current}>
      <ModalHeader onClose={onCancel} closeLabel={t("createTableClose")}>
        {t("rowOpsInsertTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="2">
        <chakra.p fontSize="xs" color="app.textMuted">
          {t("rowOpsInsertHint")}
        </chakra.p>
        {columns.map((c, i) => {
          const pickerKind = picker.kindOf(c.name);
          const pickerValues = picker.candidates(c.name);
          const listId = `${listIdBase}-${i}`;
          const cell = values[i];
          const cur = cellText(cell, driver);
          const activeFn = typeof cell === "object" ? cell.fn : null;
          // 真偽値だけセレクタにする。日付系はネイティブ入力だと明示的な NULL
          // (ヒント文の "null" 入力) を表現できないため、テキスト入力のままにする。
          // 種別は初期値で決め、入力中に切り替わらないようにする。
          const boolStart = seedText(initialValues?.[i]);
          // 初期値がどの選択肢にも一致しない ("TRUE" など) 場合は値を失わないようテキスト入力。
          const typed =
            resolveTypedEditor(c.type_name, boolStart)?.control === "bool" &&
            (boolStart === "" || boolOptions(boolStart).includes(boolStart));
          // 既定値 / 自動採番 (空欄なら DB に任せる) の明示と、型に合う関数値チップ (#1357)。
          const meta = tableColumns?.find((m) => m.name === c.name);
          const hint = meta && tableColumns ? insertDefaultHint(driver, meta, tableColumns) : null;
          // 生成列は値を入れられないので入力欄を無効化し、関数チップも出さない。
          const generated = hint?.kind === "generated";
          const chips = generated
            ? []
            : insertFunctionChips(driver, c.type_name, meta?.data_type);
          const hintText =
            hint?.kind === "auto"
              ? t("rowOpsInsertAutoHint")
              : hint?.kind === "default"
                ? t("rowOpsInsertDefaultHint", { expr: hint.expr })
                : hint?.kind === "generated"
                  ? t("rowOpsInsertGeneratedHint")
                  : null;
          const placeholder =
            hint?.kind === "auto"
              ? t("rowOpsInsertAutoPlaceholder")
              : hint?.kind === "default"
                ? t("rowOpsInsertDefaultPlaceholder", { expr: hint.expr })
                : undefined;
          return (
            <Flex key={c.name} direction="column" gap="1">
              <Flex align="center" gap="2.5">
                <Tooltip label={`${c.name} (${c.type_name})`}>
                  <chakra.label
                    minW="160px"
                    fontSize="sm"
                    fontFamily="mono"
                    color="app.text"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                  >
                    {c.name}
                    <chakra.span color="app.textMuted" ml="1.5" fontSize="2xs">
                      {c.type_name}
                    </chakra.span>
                  </chakra.label>
                </Tooltip>
                {typed ? (
                  <Select
                    ref={i === 0 ? setFirstRef : undefined}
                    value={cur}
                    disabled={generated}
                    aria-label={c.name}
                    onFocus={() => setFocused(i)}
                    onChange={(e) => setValues((prev) => ({ ...prev, [i]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submit();
                    }}
                    flex="1"
                  >
                    <option value="">{t("rowOpsInsertDefaultOption")}</option>
                    {boolOptions(boolStart).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    ref={i === 0 ? setFirstRef : undefined}
                    value={cur}
                    disabled={generated}
                    placeholder={placeholder}
                    list={pickerValues.length > 0 ? listId : undefined}
                    onFocus={() => setFocused(i)}
                    onChange={(e) => setValues((prev) => ({ ...prev, [i]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submit();
                    }}
                    flex="1"
                  />
                )}
                <ValueDatalist id={listId} values={pickerValues} />
                {pickerKind && (
                  <Tooltip label={badgeTitle(pickerKind, c.name)}>
                    <chakra.span
                      flexShrink={0}
                      maxW="140px"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                      fontSize="2xs"
                      fontFamily="mono"
                      color="app.textMuted"
                      borderWidth="1px"
                      borderColor="app.border"
                      borderRadius="sm"
                      px="1"
                      data-testid={`value-picker-badge-${c.name}`}
                    >
                      {badgeLabel(pickerKind, c.name)}
                    </chakra.span>
                  </Tooltip>
                )}
              </Flex>
              {(hintText !== null || chips.length > 0) && (
                <Flex
                  align="center"
                  wrap="wrap"
                  gap="2.5"
                  data-testid={`insert-affordance-${c.name}`}
                >
                  {/* 入力欄の位置 (ラベル幅ぶん) を空けて、説明と関数チップを入力欄の下に揃える。 */}
                  <chakra.span minW="160px" flexShrink={0} aria-hidden="true" />
                  {hintText !== null && (
                    <chakra.span
                      fontSize="2xs"
                      color="app.textMuted"
                      data-testid={`insert-default-hint-${c.name}`}
                    >
                      {hintText}
                    </chakra.span>
                  )}
                  {chips.map((chip) => {
                    const active = activeFn === chip.fn;
                    const sql = insertFunctionSql(driver, chip.fn) ?? "";
                    const tip =
                      chip.fn === "uuid" && driver === "postgres"
                        ? `${t("rowOpsInsertFnTitle", { sql })} ${t("rowOpsInsertFnPg13")}`
                        : t("rowOpsInsertFnTitle", { sql });
                    return (
                      <Tooltip key={chip.fn} label={tip}>
                        <Button
                          type="button"
                          size="sm"
                          variant={active ? "primary" : "secondary"}
                          aria-pressed={active}
                          fontFamily="mono"
                          fontSize="2xs"
                          data-testid={`insert-fn-${c.name}-${chip.fn}`}
                          onClick={() =>
                            setValues((prev) => ({ ...prev, [i]: active ? "" : { fn: chip.fn } }))
                          }
                        >
                          {sql}
                        </Button>
                      </Tooltip>
                    );
                  })}
                  {activeFn !== null && (
                    <chakra.span fontSize="2xs" color="app.textMuted">
                      {t("rowOpsInsertFnActive")}
                    </chakra.span>
                  )}
                </Flex>
              )}
            </Flex>
          );
        })}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("createTableClose")}
        </Button>
        <PressableButton type="button" variant="primary" onClick={submit}>
          {t("rowOpsInsertAdd")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
