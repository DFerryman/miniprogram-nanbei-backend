// 字段级三方合并：base 为打开页面时加载的版本，mine 为当前表单，theirs 为云端最新版本。
// 只有一方修改的字段自动采用该方；双方改成不同值的字段标为冲突，由用户逐项选择。

export type FieldState = 'unchanged' | 'mine' | 'theirs' | 'same' | 'conflict';

export interface FieldMerge<K extends string = string> {
  key: K;
  state: FieldState;
  base: unknown;
  mine: unknown;
  theirs: unknown;
}

/** 键顺序无关的比较，避免对象字段顺序不同被误判为修改。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
  });
}

export function same(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export function diffFields<T extends object, K extends keyof T & string>(base: T, mine: T, theirs: T, keys: readonly K[]): FieldMerge<K>[] {
  return keys.map((key) => {
    const b = base[key];
    const m = mine[key];
    const t = theirs[key];
    const mineChanged = !same(b, m);
    const theirsChanged = !same(b, t);
    let state: FieldState = 'unchanged';
    if (mineChanged && theirsChanged) state = same(m, t) ? 'same' : 'conflict';
    else if (mineChanged) state = 'mine';
    else if (theirsChanged) state = 'theirs';
    return { key, state, base: b, mine: m, theirs: t };
  });
}

/**
 * 按选择生成合并结果：未冲突字段自动合并，冲突字段按 choice 取值（默认保留我的修改）。
 * 以 theirs 为底，保证结果中不包含 keys 以外的过期字段。
 */
export function applyMerge<T extends object, K extends keyof T & string>(
  fields: FieldMerge<K>[],
  mine: T,
  theirs: T,
  choice: Partial<Record<K, 'mine' | 'theirs'>> = {},
): T {
  const out = { ...theirs };
  for (const f of fields) {
    const pick = f.state === 'mine' || (f.state === 'conflict' && (choice[f.key] ?? 'mine') === 'mine');
    out[f.key] = (pick ? mine[f.key] : theirs[f.key]) as T[K];
  }
  return out;
}
