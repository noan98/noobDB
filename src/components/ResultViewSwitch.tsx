import { useRef } from "react";
import { chakra } from "@chakra-ui/react";

import { useT } from "../i18n";
import { useRovingFocus } from "../keyboardNav";
import { Icon, ICON_SIZES, type IconName } from "./Icon";

/**
 * 結果パネルが表示している内容の種類。グリッド (素の結果表) / ピボット
 * (クロス集計) / チャート (可視化) の 3 択で、`App` のタブ状態
 * (`showPivot` / `showChart`) と 1 対 1 に対応する。
 */
export type ResultViewKind = "grid" | "pivot" | "chart";

const VIEWS: { kind: ResultViewKind; icon: IconName; labelKey: "gridViewLabel" | "pivotShow" | "chartShow" }[] = [
  { kind: "grid", icon: "table", labelKey: "gridViewLabel" },
  { kind: "pivot", icon: "pivot", labelKey: "pivotShow" },
  { kind: "chart", icon: "chart", labelKey: "chartShow" },
];

type Props = {
  /** 現在表示中のビュー。押下済みセグメントとして強調される。 */
  value: ResultViewKind;
  /** セグメント選択時のコールバック。同じビューを選んだときは呼ばれない。 */
  onChange: (view: ResultViewKind) => void;
};

/**
 * 結果パネルの表示切替セグメントボタン (グリッド / ピボット / チャート)。
 *
 * 以前はグリッドのツールバーに「ピボット」「チャート」の 2 つの独立したボタンが
 * あり、押すとそのビューへ切り替わる一方向の導線だった (戻るときは各ビュー側の
 * 「テーブル」ボタン)。現在どのビューを見ているかがボタン自身からは読めず、往路と
 * 復路で操作する場所も違ったため、**3 択の排他セグメント**へ寄せて「今どれを見て
 * いるか」と「どれへ切り替えられるか」を 1 か所で示す。
 *
 * グリッド (`ResultGrid`) / ピボット (`PivotView`) / チャート (`ChartView`) は
 * それぞれ自前のツールバーを持つため、このセグメントは**各ツールバーの先頭**に
 * 置く。結果パネルに専用の行を足さないので、縦の場所を消費しない。
 *
 * a11y: `role="radiogroup"` + `role="radio"` (`aria-checked`) の排他選択として
 * 公開し、左右矢印 / Home / End のフォーカス移動を `useRovingFocus` に委ねる
 * (選択は Enter/Space またはクリック)。未選択セグメントは `tabIndex={-1}` として
 * Tab 移動ではグループ全体を 1 ストップとして扱う。
 */
export function ResultViewSwitch({ value, onChange }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useRovingFocus(ref, "[role=radio]", {
    orientation: "horizontal",
  });

  return (
    <chakra.div
      ref={ref}
      role="radiogroup"
      aria-label={t("resultViewSwitchAria")}
      onKeyDown={onKeyDown}
      display="inline-flex"
      alignItems="stretch"
      flexShrink={0}
      border="1px solid"
      borderColor="app.borderStrong"
      borderRadius="md"
      overflow="hidden"
      bg="app.surface"
    >
      {VIEWS.map((v, i) => {
        const active = v.kind === value;
        const label = t(v.labelKey);
        // ラベルはボタン内にテキストとして常に見えているため、以前の native
        // `title=` は同じ文字列を重ねるだけだった (#884)。共有 `Tooltip` へ
        // 置き換えず、そのまま削除している。
        return (
          <chakra.button
            key={v.kind}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => {
              if (!active) onChange(v.kind);
            }}
            display="inline-flex"
            alignItems="center"
            gap="1"
            py="0.5"
            px="2"
            font="inherit"
            fontSize="xs"
            whiteSpace="nowrap"
            cursor="pointer"
            border="none"
            borderLeft={i > 0 ? "1px solid" : undefined}
            borderLeftColor="app.borderStrong"
            fontWeight={active ? 600 : 400}
            color={active ? "app.text" : "app.textMuted"}
            bg={active ? "color-mix(in srgb, var(--accent) 18%, transparent)" : "transparent"}
            transitionProperty="background, color"
            transitionDuration="var(--dur-fast)"
            transitionTimingFunction="var(--ease)"
            _hover={active ? undefined : { bg: "app.hover", color: "app.text" }}
            _focusVisible={{
              outline: "none",
              boxShadow: "inset 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent)",
            }}
          >
            <Icon name={v.icon} size={ICON_SIZES.sm} />
            {label}
          </chakra.button>
        );
      })}
    </chakra.div>
  );
}
