import { type ComponentProps, useState } from "react";
import { Input } from "./ui";

/** 文字列を整数にする。空・数値でない・安全整数を超える入力は `null`。 */
export function parseDraftInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
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
}

/**
 * 数値入力欄 (#1534)。入力中の文字列はローカル state に保持し、確定 (blur /
 * Enter) のときだけ整数化 → clamp → `onCommit` する。
 *
 * 1 打鍵ごとに clamp / 既定値化すると、空欄にした瞬間に値が戻って打ち直した数字が
 * 連結される (「5」→「27」→「5000300」) ので、数値入力はこの部品に揃える。
 * 入力が空・不正のときは何も書き込まず、確定済みの値の表示へ戻す。確定後は常に
 * `value` の表示へ戻すので、親側で clamp されて値が変わらなかった場合も、欄が
 * 入力途中の値 (例: 上限超過の 30) のまま残らない。
 */
export function DraftNumberInput({ value, onCommit, min, max, onBlur, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const parsed = parseDraftInt(draft);
    setDraft(null);
    if (parsed === null) return;
    onCommit(clampDraftInt(parsed, min, max));
  };

  return (
    <Input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
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
