import type { SchemaDiff, SyncPlan, DiffStatus } from "../api/tauri";

/** レポートの見出し・文言 (i18n は呼び出し側で解決して渡す)。 */
export interface SchemaCompareReportLabels {
  title: string;
  source: string;
  target: string;
  summaryHeading: string;
  statusLabels: Record<DiffStatus, string>;
  tablesHeading: string;
  tableCol: string;
  statusCol: string;
  detailCol: string;
  identical: string;
  /** 非テーブルオブジェクト (ビュー / ルーチン / トリガー / シーケンス) の節 (#1879)。 */
  objectsHeading: string;
  objectCol: string;
  /** オブジェクトの種別ラベル (ビュー など)。 */
  objectKind: (kind: string) => string;
  objectsNotCompared: string;
  objectsIdentical: string;
  planHeading: string;
  planNote: string;
  noStatements: string;
  warningsHeading: string;
  /** 破壊的な文に付ける印。 */
  destructive: string;
}

export interface SchemaCompareReportInput {
  /** 「プロファイル / データベース」の表示名。 */
  source: string;
  target: string;
  diff: SchemaDiff;
  /** 生成済みの同期プラン (スキーマ同期のとき)。無ければ SQL 節を出さない。 */
  plan: SyncPlan | null;
  /** 「同一」のテーブルを表から除くか。 */
  hideSame: boolean;
  labels: SchemaCompareReportLabels;
}

function cell(s: string): string {
  // `\` を先に二重化しないと、既存の `\` が後段の `\|` の区切りを打ち消してしまう。
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** SQL を囲むフェンス。本文に ``` が含まれても閉じないよう、最長の連続バッククォート + 1 にする。 */
function fenceFor(body: string): string {
  let longest = 2;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(longest + 1);
}

/**
 * スキーマ比較の結果 (テーブル差分の要約と、あれば適用前の同期 SQL) を Markdown レポートにする
 * (#1624)。変更レビューの依頼や変更記録にそのまま貼る用途で、DB には何もしない。
 */
export function schemaCompareReportMarkdown(input: SchemaCompareReportInput): string {
  const { diff, plan, labels } = input;
  const counts: Record<DiffStatus, number> = { source_only: 0, target_only: 0, different: 0, same: 0 };
  for (const tbl of diff.tables) counts[tbl.status] += 1;

  const lines: string[] = [`# ${labels.title}`, ""];
  lines.push(`- ${labels.source}: \`${input.source}\``);
  lines.push(`- ${labels.target}: \`${input.target}\``, "");

  lines.push(`## ${labels.summaryHeading}`, "");
  for (const s of ["different", "source_only", "target_only", "same"] as const) {
    lines.push(`- ${labels.statusLabels[s]}: ${counts[s]}`);
  }
  lines.push("");

  const shown = diff.tables.filter((tbl) => !(input.hideSame && tbl.status === "same"));
  lines.push(`## ${labels.tablesHeading}`, "");
  if (shown.length === 0) {
    lines.push(labels.identical, "");
  } else {
    lines.push(`| ${labels.tableCol} | ${labels.statusCol} | ${labels.detailCol} |`, "| --- | --- | --- |");
    for (const tbl of shown) {
      // 片側だけのテーブルは全列が同じ状態なので列名を並べず、差分ありの表だけ列ごとの内容を出す。
      const detail =
        tbl.status === "different"
          ? tbl.columns
              .map(
                (c) =>
                  `${c.name}${c.changed_fields.length ? ` (${c.changed_fields.join(", ")})` : ` [${labels.statusLabels[c.status]}]`}`,
              )
              .join(", ")
          : "";
      lines.push(`| ${cell(tbl.name)} | ${labels.statusLabels[tbl.status]} | ${cell(detail)} |`);
    }
    lines.push("");
  }

  const objects = diff.objects;
  if (objects) {
    lines.push(`## ${labels.objectsHeading}`, "");
    if (!objects.compared) {
      lines.push(labels.objectsNotCompared, "");
    } else {
      const shownObjects = objects.items.filter((o) => !(input.hideSame && o.status === "same"));
      if (shownObjects.length === 0) {
        lines.push(labels.objectsIdentical, "");
      } else {
        lines.push(
          `| ${labels.objectCol} | ${labels.statusCol} | ${labels.detailCol} |`,
          "| --- | --- | --- |",
        );
        for (const o of shownObjects) {
          const name = `${labels.objectKind(o.kind)} ${o.name}${o.signature !== null ? `(${o.signature})` : ""}`;
          lines.push(`| ${cell(name)} | ${labels.statusLabels[o.status]} | ${cell(o.table ?? "")} |`);
        }
        lines.push("");
      }
    }
  }

  if (plan) {
    lines.push(`## ${labels.planHeading}`, "", labels.planNote, "");
    if (plan.statements.length === 0) {
      lines.push(labels.noStatements, "");
    } else {
      const body = plan.statements
        .map(
          (s) => `${s.destructive ? `-- ${labels.destructive}\n` : ""}${s.sql.trimEnd().replace(/;?$/, ";")}`,
        )
        .join("\n");
      const fence = fenceFor(body);
      lines.push(`${fence}sql`, body, fence, "");
    }
    if (plan.warnings.length > 0) {
      lines.push(`### ${labels.warningsHeading}`, "");
      for (const w of plan.warnings) lines.push(`- ${w.replace(/\r?\n/g, " ")}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
