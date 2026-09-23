import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { CellValue } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { copyToClipboard } from "./clipboard";
import { Icon, ICON_SIZES } from "./Icon";
import { JsonTreeView } from "./JsonTreeView";
import { parseJsonLossless, serializeJson, formatJsonLossless } from "./jsonTree";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { useToast } from "./Toast";
import { Button, Switch } from "./ui";
import { Segmented } from "./Segmented";
import { Tooltip } from "./Tooltip";
import { FieldError } from "./modalForm";

interface Props {
  /** Column name, shown in the modal header. */
  columnName: string;
  /** Raw cell value to display in full. */
  value: CellValue;
  /** True for binary columns — the value is a hex string shown with a 0x prefix. */
  isBinary?: boolean;
  /**
   * 大きな TEXT / JSON 値の編集を許可する (#556)。`onSave` と併せて指定したときだけ
   * 編集モードへ入れる。読み取り専用セッション・PK 欠如・BLOB 列では呼び出し側が
   * false を渡す。
   */
  editable?: boolean;
  /** 列が JSON 種別か。整形/最小化と JSON バリデーションを有効化する。 */
  isJson?: boolean;
  /**
   * 編集値のバリデーション (結果列インデックスは呼び出し側で束ねる)。問題があれば
   * i18n キーを返す。NOT NULL 制約・型チェックは既存のセル編集と同じ規約に従う。
   */
  validate?: (value: string) => I18nKey | null;
  /** この行・列に既にある保留中編集の生値 (あれば編集の初期値に使う)。 */
  pendingValue?: string | null;
  /**
   * 編集を確定する。生の入力文字列を渡し (NULL は `"NULL"` キーワード)、呼び出し側が
   * 既存のセル編集 (pending edit) として書き戻す。
   */
  onSave?: (value: string) => void;
  onClose: () => void;
  /**
   * 接続ドライバ。JSON ツリービューで方言別の SQL 抽出式 / WHERE 条件を生成する
   * のに使う (#1026)。未指定なら SQL のコピー導線を出さない。
   */
  driver?: string;
}

type JsonViewMode = "tree" | "text";

/**
 * Parse an object/array JSON document losslessly, or null when it isn't one.
 * `JSON.parse` would round 64-bit integers beyond `Number.MAX_SAFE_INTEGER`,
 * so the pretty view, the tree view and the edit-mode Format/Minify all go
 * through `jsonTree.ts`, which keeps every number's original text (#1026).
 */
function tryParseJsonDocument(s: string) {
  const trimmed = s.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  return parseJsonLossless(trimmed);
}

/** Whether a string parses as JSON (used to gate saving a JSON edit). */
function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export function CellValueViewer({
  columnName,
  value,
  isBinary,
  editable,
  isJson,
  validate,
  pendingValue,
  onSave,
  onClose,
  driver,
}: Props) {
  const t = useT();
  const toast = useToast();
  const isNull = value === null || value === undefined;
  const raw = isNull ? "" : isBinary ? `0x${String(value)}` : String(value);

  const canEdit = !!editable && !!onSave && !isBinary;

  // JSON values are pretty-printed by default with a toggle back to raw text,
  // and shown as a collapsible tree by default (#1026) with a toggle to text.
  const jsonDoc = useMemo(
    () => (isNull || isBinary ? null : tryParseJsonDocument(String(value))),
    [value, isNull, isBinary],
  );
  const formattedJson = useMemo(() => (jsonDoc ? serializeJson(jsonDoc, 2) : null), [jsonDoc]);
  const canFormat = formattedJson !== null;
  const [pretty, setPretty] = useState(canFormat);
  const [viewMode, setViewMode] = useState<JsonViewMode>("tree");
  const showTree = canFormat && viewMode === "tree";
  const display = pretty && formattedJson !== null ? formattedJson : raw;

  // 編集状態。`onSave` が無いビューアでは常に閲覧専用。保留中編集があれば編集
  // モードで開く。`nullDraft` が真なら本文を無視して SQL NULL を書き戻す。
  const hasPending = pendingValue !== undefined && pendingValue !== null;
  const pendingIsNull = hasPending && /^null$/i.test(pendingValue!.trim());
  const seedText = hasPending && !pendingIsNull ? pendingValue! : (formattedJson ?? raw);
  const [editing, setEditing] = useState(canEdit && hasPending);
  const [draft, setDraft] = useState(seedText);
  const [nullDraft, setNullDraft] = useState(pendingIsNull || (hasPending ? false : isNull));

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    const ok = await copyToClipboard(display);
    if (!ok) {
      toast.error(t("clipboardCopyFailed"));
      return;
    }
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const startEditing = () => {
    setDraft(seedText);
    setNullDraft(pendingIsNull || (hasPending ? false : isNull));
    setEditing(true);
  };

  // 保存前バリデーション。NULL なら NOT NULL 制約のみ確認。JSON 列は妥当な JSON を
  // 必須にし (#556 受け入れ条件)、それ以外は既存のセル編集と同じ型バリデーションを通す。
  const validationError: I18nKey | null = (() => {
    if (!editing) return null;
    if (isJson && !nullDraft) return isValidJson(draft) ? null : "cellViewerInvalidJson";
    return validate ? validate(nullDraft ? "NULL" : draft) : null;
  })();

  const reformatJson = (minify: boolean) => {
    // ロスレス整形: 丸めた数値を編集バッファへ書き戻さない (#1026)。
    const next = formatJsonLossless(draft, minify ? undefined : 2);
    if (next === null) {
      toast.error(t("cellViewerInvalidJson"));
      return;
    }
    setDraft(next);
  };

  const handleSave = () => {
    if (!onSave || validationError) return;
    onSave(nullDraft ? "NULL" : draft);
    onClose();
  };

  return (
    <Modal
      width="820px"
      onClose={onClose}
      // 編集中だけ Cmd/Ctrl+Enter で保存 (#1114)。閲覧中は確定操作が無い。
      onSubmit={editing ? handleSave : undefined}
      submitDisabled={!!validationError}
    >
      <ModalHeader
        onClose={onClose}
        closeLabel={t("cellViewerClose")}
        titleProps={{
          title: columnName,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "mono",
        }}
      >
        {columnName}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="2">
        {editing ? (
          <>
            <chakra.textarea
              autoFocus
              value={nullDraft ? "" : draft}
              disabled={nullDraft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              m={0}
              flex="1"
              minH="220px"
              maxH="60vh"
              overflow="auto"
              resize="vertical"
              py="2.5"
              px="3"
              fontFamily="mono"
              fontSize="sm"
              lineHeight={1.5}
              color="app.text"
              bg="app.bgInput"
              border="1px solid"
              borderColor={validationError ? semanticColorToken("danger", "text") : "app.border"}
              borderRadius="md"
              _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
            />
            {validationError && (
              <FieldError display="block">{t(validationError)}</FieldError>
            )}
          </>
        ) : isNull ? (
          <chakra.div fontStyle="italic" color="app.textMuted">
            {t("resultNull")}
          </chakra.div>
        ) : showTree && jsonDoc ? (
          <JsonTreeView root={jsonDoc} columnName={columnName} driver={driver} />
        ) : display === "" ? (
          <chakra.div fontStyle="italic" color="app.textMuted">
            {t("cellViewerEmpty")}
          </chakra.div>
        ) : (
          <chakra.pre
            m={0}
            flex="1"
            minH="80px"
            maxH="60vh"
            overflow="auto"
            py="2.5" px="3"
            fontFamily="mono"
            fontSize="sm"
            lineHeight={1.5}
            whiteSpace="pre-wrap"
            wordBreak="break-word"
            color="app.text"
            bg="app.bgInput"
            border="1px solid"
            borderColor="app.border"
            borderRadius="md"
          >
            {display}
          </chakra.pre>
        )}
      </ModalBody>

      <ModalFooter>
        {editing ? (
          <>
            <chakra.span fontSize="sm" color="app.text">
              <Switch
                checked={nullDraft}
                onChange={setNullDraft}
                size="sm"
                label={t("cellViewerSetNull")}
              />
            </chakra.span>
            {isJson && !nullDraft && (
              <>
                <Button type="button" onClick={() => reformatJson(false)}>
                  {t("cellViewerFormat")}
                </Button>
                <Button type="button" onClick={() => reformatJson(true)}>
                  {t("cellViewerMinify")}
                </Button>
              </>
            )}
            <chakra.div flex="1" />
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("cellViewerCancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleSave}
              disabled={!!validationError}
            >
              {t("cellViewerSave")}
            </Button>
          </>
        ) : (
          <>
            {canFormat && (
              <Segmented<JsonViewMode>
                value={viewMode}
                onChange={setViewMode}
                ariaLabel={t("cellViewerViewMode")}
                options={[
                  { value: "tree", label: t("cellViewerViewTree"), icon: "list" },
                  { value: "text", label: t("cellViewerViewText"), icon: "text" },
                ]}
              />
            )}
            {canFormat && !showTree && (
              <chakra.span fontSize="sm" color="app.text">
                <Switch
                  checked={pretty}
                  onChange={setPretty}
                  size="sm"
                  label={t("cellViewerFormatJson")}
                />
              </chakra.span>
            )}
            <chakra.div flex="1" />
            <Tooltip label={copied ? t("gridCopied") : t("cellViewerCopy")} focusableWrapper={isNull}>
              <chakra.button
                type="button"
                onClick={handleCopy}
                disabled={isNull}
                aria-label={copied ? t("gridCopied") : t("cellViewerCopy")}
                display="inline-flex"
                alignItems="center"
                justifyContent="center"
                w="34px"
                h="34px"
                p={0}
                color="app.textMuted"
                bg="app.bgInput"
                border="1px solid"
                borderColor="app.border"
                borderRadius="md"
                cursor="pointer"
                transitionProperty="color, background, border-color"
                transitionDuration="var(--dur-fast)"
                transitionTimingFunction="var(--ease)"
                _hover={{ color: "app.text", bg: "app.hover" }}
                _disabled={{ opacity: 0.35, cursor: "not-allowed" }}
              >
                <Icon name={copied ? "check" : "copy"} size={ICON_SIZES.md} />
              </chakra.button>
            </Tooltip>
            {canEdit ? (
              <Button type="button" variant="primary" onClick={startEditing}>
                {t("cellViewerEdit")}
              </Button>
            ) : (
              // 読み取り専用時は「閉じる」がフッター唯一のアクションのため、
              // 規約表の「キャンセル/閉じる = secondary」の例外として primary を
              // 許容する (theme.ts の buttonRecipe コメント参照。#720)。
              <Button type="button" variant="primary" onClick={onClose}>
                {t("cellViewerClose")}
              </Button>
            )}
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
