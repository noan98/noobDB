import { useT } from "../i18n";
import { Segmented, type SegmentedOption } from "./Segmented";
import type { IconName } from "./Icon";

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
 * 見た目・a11y (`role="radiogroup"` + `layoutId` スプリング付きサム・ローミング
 * フォーカス) は共有プリミティブ `Segmented` (#975) に委譲している。
 */
export function ResultViewSwitch({ value, onChange }: Props) {
  const t = useT();
  const options: SegmentedOption<ResultViewKind>[] = VIEWS.map((v) => ({
    value: v.kind,
    label: t(v.labelKey),
    icon: v.icon,
  }));

  return (
    <Segmented
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={t("resultViewSwitchAria")}
    />
  );
}
