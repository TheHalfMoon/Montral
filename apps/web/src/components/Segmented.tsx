import { useRef, type CSSProperties } from "react";

export type Segment<V extends string | number> = {
  value: V;
  label: string;
  /** shown but not choosable (e.g. not on this plan); `title` explains why */
  locked?: boolean;
  title?: string;
};

/**
 * Segmented choice (the `.seg` pill group) as a real radio group: one tab stop, arrow keys move and select, Home/End
 * jump, and screen readers hear "Role, radio group, Admin, 2 of 2, checked". Locked options stay reachable so their
 * reason can be read, but cannot be chosen.
 */
export default function Segmented<V extends string | number>({ value, options, onChange, label, disabled = false, style }: {
  value: V;
  options: Segment<V>[];
  onChange: (v: V) => void;
  /** the group's accessible name (usually the visible field label) */
  label: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const current = options.findIndex((o) => o.value === value);
  const focusAt = (i: number) => ref.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[i]?.focus();
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.locked || disabled) return;
    if (o.value !== value) onChange(o.value);
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = options.length;
    let j: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + n) % n;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = n - 1;
    if (j === null) return;
    e.preventDefault();
    focusAt(j);
    choose(j);
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} ref={ref} style={style}>
      {options.map((o, i) => {
        const on = i === current;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={o.locked || disabled || undefined}
            // one tab stop: the chosen option, or the first when nothing matches (e.g. a custom interval)
            tabIndex={on || (current < 0 && i === 0) ? 0 : -1}
            title={o.title}
            className={`${on ? "on" : ""}${o.locked ? " locked" : ""}`}
            onClick={() => choose(i)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
