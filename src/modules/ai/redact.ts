/** Returns a copy of `value` without any key listed in `fields` (case-insensitive), at any depth. */
export function redactValue(value: unknown, fields: string[], depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  const set = new Set(fields.map((f) => f.toLowerCase()));
  const walk = (v: unknown, d: number): unknown => {
    if (d > 12 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (set.has(k.toLowerCase())) continue;
      out[k] = walk(x, d + 1);
    }
    return out;
  };
  return walk(value, depth);
}

/** Keeps tool output within a size budget, trimming long arrays item-wise so the JSON stays valid. */
export function shrink(value: unknown, max: number): string {
  const s = JSON.stringify(value);
  if (s === undefined) return 'null';
  if (s.length <= max) return s;
  if (Array.isArray(value)) {
    let n = value.length;
    while (n > 1 && JSON.stringify(value.slice(0, n)).length > max - 150) n = Math.floor(n / 2);
    return JSON.stringify({ _note: `Showing ${n} of ${value.length} items (output truncated)`, items: value.slice(0, n) });
  }
  return `${s.slice(0, max)}…[truncated ${s.length - max} characters]`;
}
