import { useCallback, useEffect, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type SkippedProfile } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { Button } from "./ui";

/** 一覧に出す件数の上限。それ以上は「ほか n 件」とまとめる。 */
const MAX_LISTED = 5;

/**
 * `profiles.json` から読み込めず一覧に出なかったプロファイルの警告帯 (#1614)。
 *
 * 解釈できない要素や対応外ドライバのプロファイルは、これまで無言で読み飛ばされ、利用者には
 * 「プロファイルが突然消えた」ように見えた。件数と理由 (秘密は含めない) を出し、UI から
 * 選べないそれらを 1 件ずつ削除できるようにする。1 件も無ければ何も描画しない。
 * `refreshKey` が変わる (= プロファイル一覧を読み直した) たびに取り直す。
 */
export function SkippedProfilesNotice({
  refreshKey,
  onChanged,
}: {
  refreshKey: unknown;
  onChanged: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [skipped, setSkipped] = useState<SkippedProfile[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey は再取得のトリガ (effect 内では参照しない)
  useEffect(() => {
    let cancelled = false;
    api
      .listSkippedProfiles()
      .then((list) => {
        if (!cancelled) setSkipped(list);
      })
      .catch((e) => {
        // 補助情報の取得失敗でサイドバーを塞がない。
        console.warn(e);
        if (!cancelled) setSkipped([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const remove = useCallback(
    async (s: SkippedProfile) => {
      const label = s.name ?? s.id ?? t("skippedProfileUnnamed");
      const ok = await confirm({
        title: t("skippedProfileDeleteTitle"),
        message: t("skippedProfileDeleteBody", { name: label }),
        confirmLabel: t("skippedProfileDelete"),
        tone: "danger",
      });
      if (!ok) return;
      try {
        if (s.kind === "unsupported_driver" && s.id) {
          await api.deleteProfile(s.id);
        } else {
          await api.deleteSkippedProfile(s.index, s.id);
        }
        toast.success(t("skippedProfileDeleted", { name: label }));
        onChanged();
      } catch (e) {
        toast.error(t("skippedProfileDeleteFailed", { error: String(e) }));
      }
    },
    [confirm, onChanged, t, toast],
  );

  if (skipped.length === 0) return null;
  const listed = skipped.slice(0, MAX_LISTED);
  return (
    <>
      <Callout
        tone="warning"
        role="status"
        title={t("skippedProfilesTitle", { count: skipped.length })}
        data-testid="skipped-profiles-notice"
        mx="2"
        mt="2"
      >
        <chakra.div display="flex" flexDirection="column" gap="1.5">
          <span>{t("skippedProfilesHint")}</span>
          {listed.map((s) => (
            <Flex key={`${s.kind}:${s.index}:${s.id ?? ""}`} align="center" gap="2">
              <chakra.span flex="1" minW={0} textStyle="caption" wordBreak="break-word">
                {[s.name ?? s.id ?? t("skippedProfileUnnamed"), s.driver].filter(Boolean).join(" · ")}
                {" — "}
                {s.reason}
              </chakra.span>
              <Button type="button" size="sm" variant="dangerOutline" onClick={() => void remove(s)}>
                {t("skippedProfileDelete")}
              </Button>
            </Flex>
          ))}
          {skipped.length > listed.length && (
            <chakra.span textStyle="caption">
              {t("skippedProfilesMore", { count: skipped.length - listed.length })}
            </chakra.span>
          )}
        </chakra.div>
      </Callout>
      {dialog}
    </>
  );
}
