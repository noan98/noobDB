import { createContext, useContext } from "react";
import { Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { Segmented, type SegmentedOption } from "./Segmented";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

/**
 * 結果パネルが表示している内容の種類。グリッド (素の結果表) / ピボット
 * (クロス集計) / チャート (可視化) / JSON (行オブジェクトの配列、#1113) の 4 択で、
 * `App` のタブ状態 (`showPivot` / `showChart` / `showJson`) と 1 対 1 に対応する。
 */
export type ResultViewKind = "grid" | "pivot" | "chart" | "json";

const VIEWS: {
  kind: ResultViewKind;
  icon: IconName;
  labelKey: "gridViewLabel" | "pivotShow" | "chartShow" | "resultViewJson";
}[] = [
  { kind: "grid", icon: "table", labelKey: "gridViewLabel" },
  { kind: "pivot", icon: "pivot", labelKey: "pivotShow" },
  { kind: "chart", icon: "chart", labelKey: "chartShow" },
  { kind: "json", icon: "braces", labelKey: "resultViewJson" },
];

/**
 * 結果パネルの「EXPLAIN」導線 (#1113)。EXPLAIN は同じ結果の別の見え方ではなく
 * 「元の SQL の実行計画を取る」操作 (専用の EXPLAIN タブが開く) なので、排他の
 * 表示切替 (radiogroup) には混ぜず、切替の隣に独立したボタンとして出す。
 *
 * グリッド / ピボット / チャート / JSON の各ツールバーが `ResultViewSwitch` を
 * 描画するため、ハンドラは各ビューの props を経由せずコンテキストで配る
 * (`App.tsx` が結果ペインを包む)。未提供 (EXPLAIN できない結果) ならボタンを出さない。
 */
export const ResultExplainContext = createContext<(() => void) | null>(null);

type Props = {
  /** 現在表示中のビュー。押下済みセグメントとして強調される。 */
  value: ResultViewKind;
  /** セグメント選択時のコールバック。同じビューを選んだときは呼ばれない。 */
  onChange: (view: ResultViewKind) => void;
};

/**
 * 結果パネルの表示切替セグメントボタン (グリッド / ピボット / チャート / JSON)。
 *
 * 以前はグリッドのツールバーに「ピボット」「チャート」の 2 つの独立したボタンが
 * あり、押すとそのビューへ切り替わる一方向の導線だった (戻るときは各ビュー側の
 * 「テーブル」ボタン)。現在どのビューを見ているかがボタン自身からは読めず、往路と
 * 復路で操作する場所も違ったため、**排他セグメント**へ寄せて「今どれを見て
 * いるか」と「どれへ切り替えられるか」を 1 か所で示す。
 *
 * グリッド (`ResultGrid`) / ピボット (`PivotView`) / チャート (`ChartView`) /
 * JSON (`ResultJsonView`) はそれぞれ自前のツールバーを持つため、このセグメントは
 * **各ツールバーの先頭**に置く。結果パネルに専用の行を足さないので、縦の場所を
 * 消費しない。
 *
 * 見た目・a11y (`role="radiogroup"` + `layoutId` スプリング付きサム・ローミング
 * フォーカス) は共有プリミティブ `Segmented` (#975) に委譲している。
 */
export function ResultViewSwitch({ value, onChange }: Props) {
  const t = useT();
  const onExplain = useContext(ResultExplainContext);
  const options: SegmentedOption<ResultViewKind>[] = VIEWS.map((v) => ({
    value: v.kind,
    label: t(v.labelKey),
    icon: v.icon,
  }));

  const segmented = (
    <Segmented
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={t("resultViewSwitchAria")}
    />
  );
  if (!onExplain) return segmented;
  return (
    <Flex align="center" gap="1.5" flexShrink={0}>
      {segmented}
      <Tooltip label={t("resultExplainTitle")}>
        <Button type="button" variant="ghost" size="sm" onClick={onExplain}>
          <Icon name="explain" size={ICON_SIZES.sm} />
          {t("resultExplain")}
        </Button>
      </Tooltip>
    </Flex>
  );
}
