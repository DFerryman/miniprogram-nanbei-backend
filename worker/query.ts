// 微信云开发 HTTP API（tcb/database*）的 query 参数是一段数据库语句字符串，例如
//   db.collection("portfolios").where({status:"published"}).limit(20).get()
// 这里把 JS 值安全地序列化为语句中的字面量：字符串一律经 JSON 转义，
// 只有 Raw 包装的片段（日期、db.command 操作符）原样输出，且只由本文件构造。

class Raw {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
}

export type QueryValue = string | number | boolean | null | undefined | Raw | QueryValue[] | { [key: string]: QueryValue };

export function lit(value: QueryValue): string {
  if (value instanceof Raw) return value.code;
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(lit).join(',')}]`;
  if (typeof value === 'object') {
    const parts = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${str(k)}:${lit(v)}`);
    return `{${parts.join(',')}}`;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return str(value);
}

// JSON 字符串即合法的 JS 字符串字面量；额外转义行分隔符，兼容旧版解析器。
function str(s: string): string {
  return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function date(value: Date | string = new Date()): Raw {
  return new Raw(`new Date(${str(new Date(value).toISOString())})`);
}

/** 整体替换字段（对象、数组不做嵌套合并）。 */
export function set(value: QueryValue): Raw {
  return new Raw(`db.command.set(${lit(value)})`);
}

export function inList(values: string[]): Raw {
  return new Raw(`db.command.in(${lit(values)})`);
}

/** 更新数据：对象和数组字段用 db.command.set 整体替换，避免与旧值合并。 */
export function replaceFields(data: Record<string, QueryValue>): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v !== null && typeof v === 'object' && !(v instanceof Raw) ? set(v) : v;
  }
  return out;
}

export function collection(name: string): string {
  return `db.collection(${str(name)})`;
}

export interface Order {
  field: string;
  dir: 'asc' | 'desc';
}

export function find(name: string, opts: { where?: QueryValue; orderBy?: Order[]; skip?: number; limit: number }): string {
  let q = collection(name);
  if (opts.where) q += `.where(${lit(opts.where)})`;
  for (const o of opts.orderBy || []) q += `.orderBy(${str(o.field)},${str(o.dir)})`;
  if (opts.skip) q += `.skip(${Math.max(0, Math.floor(opts.skip))})`;
  q += `.limit(${Math.max(1, Math.floor(opts.limit))})`;
  return `${q}.get()`;
}

export function byId(name: string, id: string): string {
  return `${collection(name)}.where(${lit({ _id: id })}).limit(1).get()`;
}

export function add(name: string, doc: Record<string, QueryValue>): string {
  return `${collection(name)}.add(${lit({ data: doc })})`;
}

export function updateById(name: string, id: string, data: Record<string, QueryValue>): string {
  return `${collection(name)}.doc(${str(id)}).update(${lit({ data })})`;
}

export function updateWhere(name: string, where: QueryValue, data: Record<string, QueryValue>): string {
  return `${collection(name)}.where(${lit(where)}).update(${lit({ data })})`;
}

export function removeById(name: string, id: string): string {
  return `${collection(name)}.doc(${str(id)}).remove()`;
}

export function count(name: string, where?: QueryValue): string {
  return `${collection(name)}${where ? `.where(${lit(where)})` : ''}.count()`;
}
