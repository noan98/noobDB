import { useEffect, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { DangerFinding, DangerKind } from "../dangerousSql";
import { typedConfirmMatches } from "../typeToConfirm";
import { semanticColorToken } from "../semanticColors";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input } from "./ui";

interface Props {
  findings: DangerFinding[];
  isProduction: boolean;
  /**
   * True when the dialog was opened solely because the production connection
   * requires approval for any data-modifying statement (not because a specific
   * destructive pattern was detected). Drives a generic message when `findings`
   * is empty.
   */
  writeApproval?: boolean;
  /**
   * When set, this is an irreversible DROP/TRUNCATE on a production
   * connection: the confirm button stays disabled until the user types this
   * text exactly (the table name when it could be resolved unambiguously,
   * otherwise `TYPE_TO_CONFIRM_FALLBACK`). Null/undefined skips the extra
   * gate — non-production connections keep the existing one-click confirm.
   * A UI safety net only (#675), not backend-enforced.
   */
  typedConfirmTarget?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const KIND_LABEL_KEYS: Record<DangerKind, Parameters<ReturnType<typeof useT>>[0]> = {
  deleteNoWhere: "dangerousKindDeleteNoWhere",
  updateNoWhere: "dangerousKindUpdateNoWhere",
  drop: "dangerousKindDrop",
  truncate: "dangerousKindTruncate",
};

export function DangerousQueryDialog({
  findings,
  isProduction,
  writeApproval,
  typedConfirmTarget,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT();
  // Default focus to Cancel so a stray Enter doesn't run the query — unless a
  // typed confirmation is required, in which case the user needs to type
  // into the input anyway, so focus starts there.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const typedInputRef = useRef<HTMLInputElement>(null);
  const [typedValue, setTypedValue] = useState("");
  const requiresTyped = !!typedConfirmTarget;
  const typedMatches = !requiresTyped || typedConfirmMatches(typedValue, typedConfirmTarget);
  // 同一インスタンスを使い回す呼び出し側でも、対象が変わったら前回入力を
  // 持ち越さない (安全網の入力欄が汚染されないようにする)。
  useEffect(() => {
    setTypedValue("");
  }, [typedConfirmTarget]);

  return (
    <Modal
      width="520px"
      onClose={onCancel}
      initialFocusEl={() => (requiresTyped ? typedInputRef.current : cancelRef.current)}
    >
      <ModalHeader onClose={onCancel} closeLabel={t("dangerousCancel")}>
        {t("dangerousTitle")}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="3">
        {isProduction && (
          // 意味色「danger」の淡色バナー (#664)。以前はボタン専用の
          // `app.dangerBg`/`app.dangerFg` (ライト/ダーク 2 値のみでテーマ
          // プリセットに追従しない) をベタ塗り背景に転用していた。バナー用途は
          // 本来 subtle/border/text の組み合わせ (PreviewGrid のドライラン
          // バナーと同じパターン) が用意されており、全テーマプリセットで AA を
          // 満たすことを検証済みなのでこちらに揃える。
          <chakra.div
            py="2" px="2.5"
            borderRadius="md"
            borderLeft="3px solid"
            borderLeftColor={semanticColorToken("danger", "border")}
            fontWeight={600}
            color={semanticColorToken("danger", "text")}
            bg={semanticColorToken("danger", "subtle")}
          >
            {t("dangerousProductionNote")}
          </chakra.div>
        )}
        {findings.length > 0 ? (
          <>
            <chakra.p m={0} color="app.text">
              {t("dangerousIntro")}
            </chakra.p>
            <chakra.ul
              m={0}
              p={0}
              listStyleType="none"
              display="flex"
              flexDirection="column"
              gap="2"
            >
              {findings.map((f, idx) => (
                <chakra.li
                  key={idx}
                  display="flex"
                  flexDirection="column"
                  gap="0.5"
                  py="2" px="2.5"
                  border="1px solid"
                  borderColor="app.border"
                  borderLeft="3px solid"
                  borderLeftColor={semanticColorToken("danger", "solid")}
                  borderRadius="md"
                  bg="app.toolbar"
                >
                  <chakra.span fontWeight={600} color="app.text">
                    {t(KIND_LABEL_KEYS[f.kind])}
                  </chakra.span>
                  <chakra.span fontSize="sm" color="app.textMuted" fontFamily="mono">
                    {f.target
                      ? t("dangerousTargetTable", { target: f.target })
                      : t("dangerousTargetUnknown")}
                  </chakra.span>
                </chakra.li>
              ))}
            </chakra.ul>
          </>
        ) : (
          <chakra.p m={0} color="app.text">
            {t(writeApproval ? "dangerousWriteApprovalIntro" : "dangerousIntro")}
          </chakra.p>
        )}
        {requiresTyped && (
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <chakra.label
              htmlFor="dangerous-type-confirm-input"
              fontSize="sm"
              fontWeight={600}
              color="app.text"
            >
              {t("typeToConfirmLabel", { target: typedConfirmTarget })}
            </chakra.label>
            <Input
              id="dangerous-type-confirm-input"
              ref={typedInputRef}
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={typedConfirmTarget}
              autoComplete="off"
              spellCheck={false}
            />
          </chakra.div>
        )}
      </ModalBody>

      {/*
        安全側優先レイアウト: 不可逆な「実行」は非強調で左側に置き、安全な
        「キャンセル」を強調色 (primary) で右側 + デフォルトフォーカスにする。
        HIG 各種ガイドラインに倣い、破壊的アクションを視覚的に優位にしない。
        実行側はベタ塗りにせず dangerOutline (枠線 + 危険色文字) にすることで、
        非強調のまま「これは破壊的操作である」ことを色でも伝える。
      */}
      <ModalFooter>
        <Button
          type="button"
          variant="dangerOutline"
          onClick={onConfirm}
          disabled={requiresTyped && !typedMatches}
        >
          {t("dangerousConfirm")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button ref={cancelRef} type="button" variant="primary" onClick={onCancel}>
          {t("dangerousCancel")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
