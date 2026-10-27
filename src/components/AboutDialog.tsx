import { chakra, Flex } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { api, type ProjectLink } from "../api/tauri";
import { useReducedMotionConfig } from "motion/react";
import { BrandLockup } from "../brand";
import { useT } from "../i18n";
import { getCurrentAppVersion } from "../updater";
import { displayVersion } from "../updaterFormat";
import { Icon } from "./Icon";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { useToast } from "./Toast";
import { Button } from "./ui";
import { loadLastWhatsNew } from "../whatsNewStore";
import { WhatsNewModal } from "./WhatsNewModal";
import { AnimatePresence } from "motion/react";

interface Props {
  onClose: () => void;
}

/**
 * 恒久的な「About noobDB」面 (#1770)。ブランドロックアップ + タグライン + バージョン +
 * リポジトリ / ドキュメントリンクを置き、スプラッシュでしか見られなかったシグネチャ・
 * アニメーションを任意に再生できる。リンクは Rust コマンド経由で開く (capabilities を増やさない)。
 * 情報表示のみで、右端の primary は閉じる (単独の「閉じる」)。
 */
export function AboutDialog({ onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  // 再生ごとに BrandMark を作り直し、マウント時アニメを最初から走らせる。
  const [playKey, setPlayKey] = useState(0);
  // 直近に適用した更新のノート (#1864)。あるときだけ「更新内容を見る」を出す。
  const [lastWhatsNew] = useState(loadLastWhatsNew);
  const [showWhatsNew, setShowWhatsNew] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getCurrentAppVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // アニメが再生されない環境 (OS の動きを減らす設定 / hc-* テーマ) では再生ボタンを出さない。
  const reducedMotion = useReducedMotionConfig();
  const highContrast = document.documentElement.getAttribute("data-theme")?.startsWith("hc-") ?? false;
  const canReplay = !reducedMotion && !highContrast;

  const openLink = (target: ProjectLink) => {
    api.openProjectLink(target).catch((e) => toast.error(`${t("aboutOpenFailed")}: ${String(e)}`));
  };

  return (
    <Modal
      // no-submit: 情報表示のみで実行する主アクションが無い (閉じるだけ)
      width="420px"
      onClose={onClose}
    >
      <ModalHeader onClose={onClose} closeLabel={t("aboutClose")}>
        {t("aboutTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" alignItems="center" gap="4" py="6">
        <BrandLockup key={playKey} markSize={56} wordSize="var(--text-xl)" gap="3" animate />
        <chakra.span textStyle="caption">{t("splashTagline")}</chakra.span>
        <chakra.div
          aria-hidden
          alignSelf="stretch"
          height="2px"
          borderRadius="pill"
          css={{ background: "var(--brand-gradient)" }}
        />
        <chakra.span textStyle="numeric" fontSize="sm" color="app.textSecondary" data-testid="about-version">
          {version === undefined ? " " : version ? t("aboutVersion", { version }) : t("aboutVersionUnknown")}
        </chakra.span>
        <Flex gap="2" wrap="wrap" justify="center">
          <Button type="button" onClick={() => openLink("repository")}>
            <Icon name="link" />
            {t("aboutRepository")}
          </Button>
          <Button type="button" onClick={() => openLink("docs")}>
            <Icon name="help" />
            {t("aboutDocs")}
          </Button>
          {lastWhatsNew && version && displayVersion(lastWhatsNew.version) === displayVersion(version) && (
            <Button type="button" onClick={() => setShowWhatsNew(true)}>
              <Icon name="sparkles" />
              {t("aboutWhatsNew")}
            </Button>
          )}
        </Flex>
      </ModalBody>
      <ModalFooter>
        {canReplay && (
          <Button type="button" onClick={() => setPlayKey((k) => k + 1)}>
            <Icon name="play" />
            {t("aboutReplay")}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button type="button" variant="primary" autoFocus onClick={onClose}>
          {t("aboutClose")}
        </Button>
      </ModalFooter>
      <AnimatePresence>
        {showWhatsNew && lastWhatsNew && (
          <WhatsNewModal
            version={lastWhatsNew.version}
            currentVersion={lastWhatsNew.currentVersion}
            notes={lastWhatsNew.body}
            onClose={() => setShowWhatsNew(false)}
          />
        )}
      </AnimatePresence>
    </Modal>
  );
}
