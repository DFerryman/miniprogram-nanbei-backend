import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMerge, diffFields, same } from '../shared/merge.ts';

const KEYS = ['title', 'tags', 'cover', 'weight'] as const;
type Doc = { title: string; tags: string[]; cover: { src: string; width: number } | null; weight: number };
const base: Doc = { title: '原', tags: ['a'], cover: { src: 'x', width: 1 }, weight: 0 };

test('只有一方修改的字段自动合并，双方改成不同值的字段标为冲突', () => {
  const mine: Doc = { ...base, title: '我的', weight: 5 };
  const theirs: Doc = { ...base, title: '他们的', tags: ['a', 'b'], weight: 5 };
  const fields = diffFields(base, mine, theirs, KEYS);
  assert.deepEqual(Object.fromEntries(fields.map((f) => [f.key, f.state])), { title: 'conflict', tags: 'theirs', cover: 'unchanged', weight: 'same' });
  assert.deepEqual(applyMerge(fields, mine, theirs), { ...base, title: '我的', tags: ['a', 'b'], weight: 5 });
  assert.deepEqual(applyMerge(fields, mine, theirs, { title: 'theirs' }).title, '他们的');
});

test('对象字段比较与键顺序无关', () => {
  assert.ok(same({ src: 'x', width: 1 }, { width: 1, src: 'x' }));
  const reordered: Doc = { ...base, cover: { width: 1, src: 'x' } as Doc['cover'] };
  assert.equal(diffFields(base, reordered, base, KEYS).find((f) => f.key === 'cover')!.state, 'unchanged');
});

test('重复提交自己的保存（响应丢失后重试）得到冲突时，所有字段都相同，无需用户处理', () => {
  const mine: Doc = { ...base, title: '新' };
  const fields = diffFields(base, mine, mine, KEYS);
  assert.ok(fields.every((f) => f.state === 'unchanged' || f.state === 'same'));
});
