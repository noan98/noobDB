import { useState } from "react";
import { Flex, chakra } from "@chakra-ui/react";

import type { SyncPlan } from "../api/tauri";
import { useT } from "../i18n";
import { copyToClipboard } from "./clipboard";
import { Callout } from "./Callout";
import { CodePreview, ErrorNote } from "./modalForm";
import { Button, Checkbox } from "./ui";
import { useToast } from "./Toast";

/**
 * 環境の差分を基準に揃える同期 SQL のプレビュー (#1625)。
 *
 * **ここでは実行しない。** 生成した SQL を読んでコピーするだけで、適用は利用者が
 * 対象環境に対して別途行う (本番を含む環境へ、確認なしの直接実行経路を作らない)。
 * DELETE は既定で含めず、チェックしたときだけ生成する (データ差分の同期と同じ方針)。
 */
export function BroadcastSyncPanel({
  envName,
  loadPlan,
}: {
  envName: string;
  /** 同期 SQL を取得する。`allowDelete` が偽なら DELETE を含めない。 */
  loadPlan: (allowDelete: boolean) => Promise<SyncPlan>;
}) {
  const t = useT();
  const toast = useToast();
  const [allowDelete, setAllowDelete] = useState(false);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async (withDelete: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setPlan(await loadPlan(withDelete));
    } catch (e) {
      setPlan(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const text = plan
    ? plan.statements.map((s) => (s.sql.trimEnd().endsWith(";") ? s.sql : `${s.sql};`)).join("\n")
    : "";

  return (
    <Flex direction="column" gap="2" px="3" py="2" borderTop="1px solid" borderColor="app.borderSubtle">
      <Flex align="center" gap="3" flexWrap="wrap">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => void generate(allowDelete)}
        >
          {loading ? t("broadcastSyncGenerating") : t("broadcastSyncGenerate")}
        </Button>
        <chakra.label
          display="inline-flex"
          alignItems="center"
          gap="1.5"
          textStyle="caption"
          color="app.textMuted"
        >
          <Checkbox
            checked={allowDelete}
            onChange={(e) => {
              setAllowDelete(e.target.checked);
              if (plan) void generate(e.target.checked);
            }}
          />
          {t("broadcastSyncAllowDelete")}
        </chakra.label>
      </Flex>
      {error && <ErrorNote>{error}</ErrorNote>}
      {plan && (
        <>
          <Callout tone="info" role="status">
            {t("broadcastSyncNotice", { env: envName })}
          </Callout>
          {plan.warnings.map((w) => (
            <Callout key={w} tone="warning">
              {w}
            </Callout>
          ))}
          {plan.statements.length === 0 ? (
            <chakra.p margin={0} textStyle="caption" color="app.textMuted">
              {t("broadcastSyncEmpty")}
            </chakra.p>
          ) : (
            <>
              <CodePreview maxHeight="200px" aria-label={t("broadcastSyncPreviewLabel")}>
                {text}
              </CodePreview>
              <Flex align="center" gap="2">
                <chakra.span textStyle="caption" color="app.textMuted">
                  {t("broadcastSyncCount", { count: plan.statements.length })}
                </chakra.span>
                <chakra.span flex="1" />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void copyToClipboard(text).then((ok) =>
                      ok ? toast.success(t("broadcastSyncCopied")) : toast.error(t("clipboardCopyFailed")),
                    );
                  }}
                >
                  {t("broadcastSyncCopy")}
                </Button>
              </Flex>
            </>
          )}
        </>
      )}
    </Flex>
  );
}
