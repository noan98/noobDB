import { type ComponentProps, useState } from "react";
import { Input } from "./ui";

/** 文字列を整数にする。空・数値でない・安全整数を超える入力は `null`。 */
export function parseDraftInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 小数も許す版。空・数値でない・非有限は `null`。入力途中の `1.` は 1、`-` / `.` は `null`
 * (後者は確定せず draft として保持される)。
 */
export function parseDraftNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** `min` / `max` で丸める (指定が無い側は無制限)。 */
export function clampDraftInt(n: number, min?: number, max?: number): number {
  let v = n;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

type InputProps = Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "type" | "min" | "max" | "defaultValue"
>;

interface Props extends InputProps {
  /** 確定済みの値 (表示の基準)。 */
  value: number;
  /** blur / Enter で、整数化・clamp 済みの値とともに呼ばれる。 */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  /**
   * 小数を許す。入力途中の `1.` や `-` を欄に残せるよう `type="number"` ではなく
   * `type="text"` + `inputMode="decimal"` で描画する。
   */
  allowDecimal?: boolean;
}

/**
 * 数値入力欄 (#1534)。入力中の文字列はローカル state (draft) に保持する。
 *
 * - 入力が整数として読め、`min`〜`max` の範囲内なら**その場で** `onCommit` する。Modal 内で
 *   欄にフォーカスしたまま Cmd/Ctrl+Enter を押しても、blur の setState 反映前の古い値で
 *   送信されないようにするため。
 * - 空欄・不正・範囲外のあいだは確定せず draft を保持する (空欄にした瞬間に既定値へ
 *   戻って、打ち直した数字が連結する「5」→「27」→「5000300」を防ぐ)。blur / Enter で
 *   整数化 → clamp して確定し、空・不正なら確定済みの値の表示へ戻す。
 * - draft がある間は、入力中に `value` が外から変わっても draft の表示を優先する
 *   (打鍵の途中で欄が書き換わらない)。確定 (blur / Enter) 後は常に `value` の表示へ戻るので、
 *   親側で値が変わらなかった場合も、欄が上限超過の入力値のまま残らない。
 */
export function DraftNumberInput({ value, onCommit, min, max, allowDecimal = false, onBlur, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const parse = allowDecimal ? parseDraftNumber : parseDraftInt;

  const commit = () => {
    if (draft === null) return;
    const parsed = parse(draft);
    setDraft(null);
    if (parsed === null) return;
    onCommit(clampDraftInt(parsed, min, max));
  };

  return (
    <Input
      {...rest}
      {...(allowDecimal ? { type: "text", inputMode: "decimal" as const } : { type: "number", min, max })}
      value={draft ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const parsed = parse(raw);
        if (parsed !== null && clampDraftInt(parsed, min, max) === parsed) onCommit(parsed);
      }}
      onBlur={(e) => {
        commit();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
      }}
    />
  );
}
