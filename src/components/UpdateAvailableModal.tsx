import { chakra, Flex } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { BrandLockup } from "../brand";
import { useT } from "../i18n";
import { transitions, variants } from "../motion";
import type { AvailableUpdate, InstallProgress } from "../updater";
import {
  displayVersion,
  formatDownloadProgress,
  releaseNoteHighlights,
  truncateReleaseNotes,
} from "../updaterFormat";
import { Icon } from "./Icon";
import { ErrorNote } from "./modalForm";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { prefersStaticMotion } from "./revealOrigin";
import { DeterminateProgressBar, StreamProgressBar } from "./StreamProgressBar";
import { Button } from "./ui";
import { VersionPill } from "./VersionPill";
import { NoteBlock, WhatsNewModal } from "./WhatsNewModal";

/** 更新フローの段階。confirm = 確認、downloading = ダウンロード中、applying = 適用中 (再起動待ち)、failed = 失敗。 */
export type UpdatePhase = "confirm" | "downloading" | "applying" | "failed";

interface Props {
  update: AvailableUpdate;
  phase: UpdatePhase;
  progress: InstallProgress | null;
  error: string | null;
  /** 起動時チェック (#1631) のときだけ「このバージョンは見送る」を出す。 */
  rememberSkip: boolean;
  /** 「ダウンロードして再起動」/「再試行」。 */
  onStart: () => void;
  /** Esc / × / 「後で」/「バックグラウンドで続行」(段階によって意味が変わる。呼び出し側が解釈する)。 */
  onClose: () => void;
  onSkip: () => void;
}

const MotionPane = motion.div;

/**
 * アプリ内更新の「確認 → ダウンロード → 再起動」を 1 枚で見せるモーダル (#2297)。適用後の
 * `WhatsNewModal` と同じ語彙 (BrandLockup・バージョンピル・ヒーローの罫線) で、現行版 → 新版のピルと
 * リリースノート冒頭のハイライトを見せる。承認後は同じモーダル内で確定進捗バー (合計不明なら不定バー) →
 * 適用中へクロスフェードし、失敗時はモーダル内に `ErrorNote` と再試行を出す (進行中トースト自体を持たない)。
 * 副作用 (ダウンロード・skip の保存) は持たず、段階と進捗は呼び出し側 (`updatePrompt.tsx`) が渡す。
 */
export function UpdateAvailableModal({
  update,
  phase,
  progress,
  error,
  rememberSkip,
  onStart,
  onClose,
  onSkip,
}: Props) {
  const t = useT();
  const reducedConfig = useReducedMotion() ?? false;
  const still = reducedConfig || prefersStaticMotion();
  const [showNotes, setShowNotes] = useState(false);
  const { blocks, hasMore } = releaseNoteHighlights(update.body);
  const hasNotes = truncateReleaseNotes(update.body) !== "";
  const busy = phase === "downloading" || phase === "applying";
  // クロスフェードの単位。downloading と applying は同じ面 (進捗) のまま文言だけ変える。
  const pane = phase === "failed" ? "failed" : phase === "confirm" ? "confirm" : "progress";

  return (
    <>
      <Modal
        width="520px"
        onClose={onClose}
        // 主アクションは確認 / 失敗のときだけ。ダウンロード中は確定する操作が無い。
        onSubmit={busy ? undefined : onStart}
        closeOnInteractOutside={false}
      >
        <ModalHeader onClose={onClose} closeLabel={t("whatsNewClose")}>
          {t("updateAvailableTitle")}
        </ModalHeader>
        <ModalBody display="flex" flexDirection="column" gap="4" py="0" px="0">
          <Flex
            direction="column"
            align="center"
            gap="2.5"
            py="5"
            px="4"
            css={{ backgroundImage: "var(--hero-halo)", backgroundRepeat: "no-repeat" }}
          >
            <BrandLockup markSize={44} wordSize="var(--text-xl)" gap="3" animate={!still} />
            <Flex align="center" gap="2" wrap="wrap" justify="center">
              <VersionPill version={displayVersion(update.currentVersion)} current testId="update-current" />
              <chakra.span aria-hidden color="app.textMuted" display="inline-flex">
                <Icon name="chevron-right" />
              </chakra.span>
              <VersionPill version={displayVersion(update.version)} testId="update-next" />
            </Flex>
            <chakra.div
              aria-hidden
              alignSelf="stretch"
              height="2px"
              borderRadius="pill"
              css={{ background: "var(--hero-rule)", display: "var(--hero-rule-display)" }}
            />
          </Flex>
          <chakra.div px="4" pb="4">
            <AnimatePresence mode="wait" initial={false}>
              <MotionPane
                key={pane}
                variants={variants.fade}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={still ? { duration: 0 } : transitions.fade}
              >
                {pane === "confirm" && (
                  <Flex direction="column" gap="3">
                    {blocks.length > 0 && (
                      <Flex direction="column" gap="2" data-testid="update-highlights">
                        <chakra.span textStyle="overline">{t("updateHighlights")}</chakra.span>
                        {blocks.map((b, i) => (
                          <NoteBlock key={`${i}-${b.kind}`} block={b} />
                        ))}
                      </Flex>
                    )}
                    {rememberSkip && (
                      <chakra.p color="app.textMuted" fontSize="sm">
                        {t("updateLaterSkipNote")}
                      </chakra.p>
                    )}
                    {hasNotes && (
                      <chakra.div>
                        <Button type="button" onClick={() => setShowNotes(true)}>
                          <Icon name="sparkles" />
                          {t("updateViewWhatsNew")}
                          {hasMore ? " …" : ""}
                        </Button>
                      </chakra.div>
                    )}
                  </Flex>
                )}
                {pane === "progress" && (
                  <Flex direction="column" gap="2" role="status" data-testid="update-progress">
                    {progress?.percent != null && phase === "downloading" ? (
                      <DeterminateProgressBar value={progress.percent / 100} />
                    ) : (
                      <StreamProgressBar active />
                    )}
                    <chakra.p color="app.textSecondary" fontSize="sm" data-testid="update-progress-text">
                      {phase === "applying"
                        ? t("updateApplying")
                        : ((progress ? formatDownloadProgress(progress, t) : null) ??
                          t("updateDownloadingStarted"))}
                    </chakra.p>
                  </Flex>
                )}
                {pane === "failed" && (
                  <ErrorNote data-testid="update-error">
                    {t("updateFailed", { error: error ?? "" })}
                  </ErrorNote>
                )}
              </MotionPane>
            </AnimatePresence>
          </chakra.div>
        </ModalBody>
        <ModalFooter>
          {phase === "confirm" && rememberSkip && (
            <Button type="button" onClick={onSkip}>
              {t("updateSkipVersion")}
            </Button>
          )}
          <div style={{ flex: 1 }} />
          {busy ? (
            <Button type="button" variant="primary" autoFocus onClick={onClose}>
              {t("updateInBackground")}
            </Button>
          ) : (
            <>
              <Button type="button" onClick={onClose}>
                {t("updateLater")}
              </Button>
              <Button type="button" variant="primary" onClick={onStart}>
                {phase === "failed" ? t("updateRetry") : t("updateDownloadAndRestart")}
              </Button>
            </>
          )}
        </ModalFooter>
      </Modal>
      <AnimatePresence>
        {showNotes && (
          <WhatsNewModal
            version={update.version}
            currentVersion={update.currentVersion}
            notes={update.body}
            onClose={() => setShowNotes(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
