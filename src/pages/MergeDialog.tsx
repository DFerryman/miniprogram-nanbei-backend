import { useState, type ReactNode } from 'react';
import type { FieldMerge } from '../../shared/merge.ts';

export interface FieldDef {
  key: string;
  label: string;
  render?: (value: unknown) => ReactNode;
}

const STATE_TEXT = {
  mine: '只有你修改了，保留你的修改',
  theirs: '只有对方修改了，采用最新内容',
  same: '双方改成了相同的内容',
  conflict: '双方都修改了，请选择',
  unchanged: '',
};

export function plain(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="muted">（空）</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">（空）</span>;
    if (value.every((v) => typeof v === 'string')) return value.join('，');
    return `${value.length} 项`;
  }
  if (typeof value === 'object') return <code className="small">{JSON.stringify(value).slice(0, 160)}</code>;
  return String(value);
}

/**
 * 保存冲突时的合并界面：列出加载后双方改过的字段。只有一方改过的自动合并，
 * 双方都改过的由用户选择。合并结果只写回表单，仍需用户确认后再保存。
 */
export function MergeDialog({ title, subtitle, fields, defs, onApply, onDiscardMine, onCancel }: {
  title: string;
  subtitle?: ReactNode;
  fields: FieldMerge[];
  defs: FieldDef[];
  onApply: (choice: Record<string, 'mine' | 'theirs'>) => void;
  onDiscardMine: () => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<Record<string, 'mine' | 'theirs'>>({});
  const changed = fields.filter((f) => f.state !== 'unchanged');
  const conflicts = changed.filter((f) => f.state === 'conflict').length;
  const def = (key: string) => defs.find((d) => d.key === key) || { key, label: key };

  return (
    <div className="modal-mask merge-mask">
      <div className="modal merge-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
        </div>
        {subtitle && <div className="muted small">{subtitle}</div>}
        <p className="small">
          {conflicts
            ? `有 ${conflicts} 个字段双方都修改了，请逐项选择保留哪一份。其他字段已自动合并。`
            : '没有字段被双方同时修改，可以直接合并。'}
          合并结果会填回表单，检查无误后再点「保存」。
        </p>
        <div className="merge-table">
          {changed.map((f) => {
            const d = def(f.key);
            const show = d.render || plain;
            const pick = choice[f.key] ?? 'mine';
            return (
              <div key={f.key} className={`merge-row ${f.state}`}>
                <div className="merge-field">
                  <strong>{d.label}</strong>
                  <span className="muted small">{STATE_TEXT[f.state]}</span>
                </div>
                {f.state === 'conflict' ? (
                  <div className="merge-options">
                    <label className={pick === 'mine' ? 'on' : ''}>
                      <input type="radio" name={`m-${f.key}`} checked={pick === 'mine'} onChange={() => setChoice({ ...choice, [f.key]: 'mine' })} />
                      <span className="small muted">我的修改</span>
                      <div>{show(f.mine)}</div>
                    </label>
                    <label className={pick === 'theirs' ? 'on' : ''}>
                      <input type="radio" name={`m-${f.key}`} checked={pick === 'theirs'} onChange={() => setChoice({ ...choice, [f.key]: 'theirs' })} />
                      <span className="small muted">最新内容（对方保存的）</span>
                      <div>{show(f.theirs)}</div>
                    </label>
                    <details className="small">
                      <summary>你打开页面时的内容</summary>
                      <div>{show(f.base)}</div>
                    </details>
                  </div>
                ) : (
                  <div className="merge-value">{show(f.state === 'mine' ? f.mine : f.theirs)}</div>
                )}
              </div>
            );
          })}
          {!changed.length && <p className="muted small">内容没有差异。</p>}
        </div>
        <div className="actions">
          <button type="button" className="btn ghost danger" onClick={() => { if (confirm('放弃你的全部修改，改为显示最新内容？')) onDiscardMine(); }}>
            放弃我的修改
          </button>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onCancel}>稍后处理</button>
          <button type="button" className="btn" onClick={() => onApply(choice)}>合并到表单</button>
        </div>
      </div>
    </div>
  );
}
