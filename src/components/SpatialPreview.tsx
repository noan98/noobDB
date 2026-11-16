import { useMemo } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { buildShapeModel, parseEwkt } from "./spatial";

interface Props {
  /** セル値 (EWKT)。読めなければ何も描かない。 */
  text: string;
  columnName: string;
}

/**
 * 空間データの形状をオフラインの SVG で描く (#2379)。地図タイルは使わず、座標の目盛りだけを添える。
 * X は右、Y は上が正 (緯度が上)。色は `App.css` の変数 (テーマ追従) だけを使う。
 */
export function SpatialPreview({ text, columnName }: Props) {
  const t = useT();
  const parsed = useMemo(() => parseEwkt(text), [text]);
  const model = useMemo(() => (parsed ? buildShapeModel(parsed.geometry) : null), [parsed]);
  if (!parsed || !model) return null;
  const { plot } = model;
  const fmt = (n: number) => String(Number(n.toPrecision(8)));
  const srid =
    parsed.srid === null ? t("spatialPreviewNoSrid") : t("spatialPreviewSrid", { srid: parsed.srid });
  return (
    <chakra.div display="flex" flexDirection="column" gap="1.5" data-testid="spatial-preview">
      <chakra.div
        bg="app.bgInput"
        border="1px solid"
        borderColor="app.border"
        borderRadius="md"
        p="2"
        color="app.textMuted"
      >
        {model.empty ? (
          <chakra.div textStyle="caption" py="4" textAlign="center">
            {t("spatialPreviewEmpty")}
          </chakra.div>
        ) : (
          <svg
            viewBox={`0 0 ${model.width} ${model.height}`}
            role="img"
            aria-label={t("spatialPreviewAlt", { column: columnName })}
            style={{ width: "100%", maxHeight: "40vh", display: "block" }}
          >
            <title>{t("spatialPreviewAlt", { column: columnName })}</title>
            {/* 目盛りの罫線とラベル。縦軸は上が正。 */}
            {model.xTicks.map((k) => (
              <g key={`x${k.pos}`}>
                <line
                  x1={k.pos}
                  x2={k.pos}
                  y1={plot.y0}
                  y2={plot.y1}
                  stroke="var(--border)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={k.pos}
                  y={plot.y1 + 14}
                  textAnchor="middle"
                  fill="currentColor"
                  style={{ fontSize: "var(--text-2xs)" }}
                >
                  {k.label}
                </text>
              </g>
            ))}
            {model.yTicks.map((k) => (
              <g key={`y${k.pos}`}>
                <line
                  x1={plot.x0}
                  x2={plot.x1}
                  y1={k.pos}
                  y2={k.pos}
                  stroke="var(--border)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={plot.x0 - 6}
                  y={k.pos}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fill="currentColor"
                  style={{ fontSize: "var(--text-2xs)" }}
                >
                  {k.label}
                </text>
              </g>
            ))}
            <rect
              x={plot.x0}
              y={plot.y0}
              width={plot.x1 - plot.x0}
              height={plot.y1 - plot.y0}
              fill="none"
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {model.parts.map((p, i) => {
              const key = `${p.kind}${i}`;
              if (p.kind === "point") {
                return <circle key={key} cx={p.x} cy={p.y} r={4} fill="var(--accent)" />;
              }
              if (p.kind === "line") {
                return (
                  <path
                    key={key}
                    d={p.d}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              }
              return (
                <path
                  key={key}
                  d={p.d}
                  fill="var(--accent)"
                  fillOpacity={0.25}
                  fillRule="evenodd"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
        )}
      </chakra.div>
      {!model.empty && (
        <chakra.div textStyle="caption" data-testid="spatial-preview-meta">
          {t("spatialPreviewMeta", {
            srid,
            minX: fmt(model.bounds.minX),
            maxX: fmt(model.bounds.maxX),
            minY: fmt(model.bounds.minY),
            maxY: fmt(model.bounds.maxY),
          })}
        </chakra.div>
      )}
    </chakra.div>
  );
}
