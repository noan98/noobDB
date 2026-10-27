import { chakra, Flex } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import { BrandLockup } from "../brand";
import { useT } from "../i18n";
import { staggerContainer, variants } from "../motion";
import { displayVersion, parseReleaseNotes, type ReleaseNoteBlock } from "../updaterFormat";
import { Callout } from "./Callout";
import { Icon } from "./Icon";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { prefersStaticMotion } from "./revealOrigin";
import { Button } from "./ui";

const MotionList = chakra(motion.div, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionItem = chakra(motion.div, {}, { forwardProps: ["variants"] });

/** 段数の上限 (firstBatchReveal.ts の FIRST_BATCH_REVEAL_MAX_STEPS と同じ 12 段)。超えた分は遅延なしで即表示。 */
export const WHATS_NEW_MAX_STAGGER_STEPS = 12;

interface Props {
  /** 更新後のバージョン (先頭の `v` は表示時に取り除く)。 */
  version: string;
  /** 更新前のバージョン。 */
  currentVersion?: string;
  /** 更新の `body` (GitHub Releases 由来の簡易 Markdown)。 */
  notes: string | undefined;
  onClose: () => void;
}

/**
 * 更新の「新機能ハイライト」参照面 (#1864)。確認ダイアログに載せていた無装飾の `<pre>` に代わり、
 * ブランドのロックアップ + バージョンチップのヒーローと、整形したノートを順次出現させて見せる。
 * 引用行 (`> `) は要点の帯 (`Callout tone="info"`)。閲覧のみなので右端の primary は「閉じる」。
 */
export function WhatsNewModal({ version, currentVersion, notes, onClose }: Props) {
  const t = useT();
  const reducedConfig = useReducedMotion() ?? false;
  // MotionConfig の reduced-motion は stagger の遅延を打ち消さないので、ハイコントラストも含めて明示的に止める。
  const still = reducedConfig || prefersStaticMotion();
  const blocks = parseReleaseNotes(notes);
  const shown = displayVersion(version);

  return (
    <Modal
      // no-submit: 更新内容を読むだけの参照面で、確定する主アクションが無い (閉じるのみ)
      width="560px"
      onClose={onClose}
    >
      <ModalHeader onClose={onClose} closeLabel={t("whatsNewClose")}>
        {t("whatsNewTitle")}
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
            <chakra.span
              data-testid="whats-new-version"
              textStyle="numeric"
              display="inline-flex"
              alignItems="center"
              gap="1"
              py="0.5"
              px="2"
              borderRadius="pill"
              fontSize="sm"
              fontWeight="semibold"
              color="app.onSolid"
              css={{ background: "var(--brand-gradient)" }}
            >
              <Icon name="sparkles" />v{shown}
            </chakra.span>
            {currentVersion && (
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("whatsNewFrom", { current: displayVersion(currentVersion) })}
              </chakra.span>
            )}
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
          {blocks.length === 0 ? (
            <chakra.p color="app.textMuted" textAlign="center">
              {t("whatsNewEmpty")}
            </chakra.p>
          ) : (
            <MotionList
              display="flex"
              flexDirection="column"
              gap="2"
              variants={staggerContainer(still)}
              initial="initial"
              animate="animate"
            >
              {blocks.map((b, i) => (
                // 段数に上限を付ける: 超えた分は variants を渡さず (= 親の伝播を受けず) 即表示する。
                <MotionItem
                  key={`${i}-${b.kind}`}
                  variants={i < WHATS_NEW_MAX_STAGGER_STEPS ? variants.staggerItem : undefined}
                >
                  <NoteBlock block={b} />
                </MotionItem>
              ))}
            </MotionList>
          )}
        </chakra.div>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="primary" autoFocus onClick={onClose}>
          {t("whatsNewClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function NoteBlock({ block }: { block: ReleaseNoteBlock }) {
  switch (block.kind) {
    case "heading":
      return (
        <chakra.h3 textStyle="heading" fontSize="md" mt="2" mb="0">
          {block.text}
        </chakra.h3>
      );
    case "highlight":
      return <Callout tone="info">{block.text}</Callout>;
    case "bullet":
      return (
        <Flex gap="2" align="flex-start" color="app.textSecondary" fontSize="sm" lineHeight="normal">
          <chakra.span aria-hidden color="app.accent" flex="none">
            ・
          </chakra.span>
          <chakra.span wordBreak="break-word">{block.text}</chakra.span>
        </Flex>
      );
    default:
      return (
        <chakra.p color="app.textSecondary" fontSize="sm" lineHeight="normal" wordBreak="break-word">
          {block.text}
        </chakra.p>
      );
  }
}
