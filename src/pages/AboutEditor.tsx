import { useEffect, useMemo, useRef, useState } from 'react';
import { collectFileIds, paragraphs, studio as normalizeStudio } from '../../shared/normalize.ts';
import { CONTACT_LABELS, CONTACT_TYPES, type Contact, type ContactType, type Studio, type StudioSection } from '../../shared/types.ts';
import { api, errorText } from '../lib/api.ts';
import { displayUrl, extOf, fileName, probe, upload, uniqueBase, useMediaUrls } from '../lib/media.ts';
import { navigate } from '../lib/router.ts';
import { AboutPage } from '../preview/Pages.tsx';
import { Phone } from '../preview/Phone.tsx';

const DIR = 'studio/profile';

interface Form {
  name: string;
  nameEn: string;
  slogan: string;
  cover: Studio['cover'];
  intro: string; // 每行一段
  sections: { title: string; body: string; items: string }[];
  address: string;
  hours: string;
  lat: string;
  lng: string;
  locName: string;
  contacts: Contact[];
}

const EMPTY: Form = {
  name: '', nameEn: '', slogan: '', cover: null, intro: '', sections: [], address: '', hours: '',
  lat: '', lng: '', locName: '', contacts: [],
};

function toForm(s: Studio | null): Form {
  if (!s) return EMPTY;
  return {
    name: s.name,
    nameEn: s.nameEn,
    slogan: s.slogan,
    cover: s.cover,
    intro: s.intro.join('\n'),
    sections: s.sections.map((x) => ({ title: x.title, body: x.body, items: x.items.join('\n') })),
    address: s.address,
    hours: s.hours,
    lat: s.location ? String(s.location.latitude) : '',
    lng: s.location ? String(s.location.longitude) : '',
    locName: s.location?.name || '',
    contacts: s.contacts,
  };
}

function toStudio(f: Form): Studio {
  return normalizeStudio({
    name: f.name,
    nameEn: f.nameEn,
    slogan: f.slogan,
    cover: f.cover,
    intro: paragraphs(f.intro),
    sections: f.sections.map((s): StudioSection => ({
      title: s.title,
      body: s.body,
      items: s.items.split('\n').map((t) => t.trim()).filter(Boolean),
    })),
    address: f.address,
    hours: f.hours,
    location: f.lat && f.lng ? { latitude: f.lat, longitude: f.lng, name: f.locName } : null,
    contacts: f.contacts,
  });
}

function blankContact(type: ContactType): Contact {
  return { type, label: '', value: '', qrcode: '', appId: '', path: '', corpId: '', url: '' };
}

const VALUE_HINT: Record<ContactType, string> = {
  phone: '电话号码，点击直接拨打',
  wechat: '微信号，可复制；建议同时上传二维码',
  wecom: '可选：显示在面板中的文字',
  xiaohongshu: '账号名或主页链接',
  douyin: '抖音号',
  weibo: '微博账号',
  email: '邮箱地址',
  link: '链接地址',
};

function ImagePicker({ value, onChange, label, onUploaded }: {
  value: string;
  label: string;
  onChange: (fileId: string, info?: { width: number; height: number; color?: string }) => void;
  onUploaded: (fileId: string) => void;
}) {
  useMediaUrls();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const url = displayUrl(value);
  async function pick(file: File) {
    setBusy(true);
    try {
      const info = await probe(file);
      if (info.type !== 'image') throw new Error('请选择图片');
      const fileId = await upload(`${DIR}/${fileName(uniqueBase(), extOf(file))}`, file);
      onUploaded(fileId);
      onChange(fileId, { width: info.width, height: info.height, color: info.color });
    } catch (err) {
      alert(`上传失败：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="image-picker">
      <div className="image-picker-box" onClick={() => input.current?.click()}>
        {url ? <img src={url} alt="" /> : <span className="muted small">{busy ? '上传中…' : `上传${label}`}</span>}
      </div>
      <div className="image-picker-actions">
        <button type="button" className="btn small ghost" disabled={busy} onClick={() => input.current?.click()}>{busy ? '上传中…' : value ? '更换' : '上传'}</button>
        {value && <button type="button" className="btn small ghost danger" onClick={() => onChange('')}>移除</button>}
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) pick(f);
        e.target.value = '';
      }} />
    </div>
  );
}

export function AboutEditor() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [saved, setSaved] = useState<Studio | null>(null);
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sessionUploads = useRef(new Set<string>());

  const load = () => {
    setLoading(true);
    setLoadError('');
    api.studio()
      .then(({ studio }) => {
        setSaved(studio);
        setExists(!!studio);
        setForm(toForm(studio));
      })
      .catch((err) => setLoadError(errorText(err)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const studio = useMemo(() => toStudio(form), [form]);
  const dirty = useMemo(() => JSON.stringify(toStudio(toForm(saved))) !== JSON.stringify(studio), [saved, studio]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setContact = (i: number, patch: Partial<Contact>) =>
    set('contacts', form.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const setSection = (i: number, patch: Partial<Form['sections'][number]>) =>
    set('sections', form.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const moveIn = <T,>(list: T[], from: number, to: number): T[] => {
    if (to < 0 || to >= list.length) return list;
    const next = [...list];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    return next;
  };

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    setError('');
    setNotice('');
    if (!studio.name) {
      setError('请填写工作室名称');
      return;
    }
    if ((form.lat || form.lng) && !studio.location) {
      setError('经纬度无效：纬度 -90 ~ 90，经度 -180 ~ 180');
      return;
    }
    setSaving(true);
    try {
      const before = saved;
      const r = await api.saveStudio(studio);
      // 清理被替换掉的、由后台上传到 studio/ 目录的旧图片
      const now = collectFileIds(r.studio);
      const stale = [...collectFileIds(before), ...sessionUploads.current].filter((f) => !now.has(f) && f.includes(`/${DIR}/`));
      if (stale.length) await api.deleteFiles(stale).catch(() => undefined);
      sessionUploads.current.clear();
      setSaved(r.studio);
      setExists(true);
      setForm(toForm(r.studio));
      setNotice('已保存。小程序「关于」页下拉刷新即可看到最新内容。');
    } catch (err) {
      setError(`保存失败：${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="center muted">加载中…</div>;
  if (loadError) {
    return (
      <div className="center">
        <div className="alert error">工作室信息加载失败：{loadError}</div>
        <button type="button" className="btn ghost" onClick={load}>重试</button>
      </div>
    );
  }

  return (
    <div className="split">
      <section className="main">
        <div className="page-head">
          <div>
            <h2>关于我们</h2>
            <p className="muted">{exists ? `对应 studio 集合中的 profile 文档${saved?.updatedAt ? `，更新于 ${new Date(saved.updatedAt).toLocaleString()}` : ''}` : '当前环境还没有工作室信息，保存后将创建。'}</p>
          </div>
          <div className="actions">
            {dirty && <span className="tag">未保存</span>}
            <button type="button" className="btn" disabled={saving} onClick={() => save()}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
        {notice && <div className="alert ok">{notice}</div>}

        <form className="form" onSubmit={save}>
          <div className="section-head"><h3>基本信息</h3></div>
          <div className="field-row">
            <label className="field grow">
              <span>工作室名称 *</span>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="同时作为「关于」页导航栏标题" />
            </label>
            <label className="field grow">
              <span>英文名</span>
              <input value={form.nameEn} onChange={(e) => set('nameEn', e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>标语</span>
            <input value={form.slogan} onChange={(e) => set('slogan', e.target.value)} />
          </label>
          <div className="field">
            <span>封面图</span>
            <ImagePicker
              label="封面"
              value={form.cover?.src || ''}
              onUploaded={(f) => sessionUploads.current.add(f)}
              onChange={(src, info) => set('cover', src ? { src, width: info?.width || 0, height: info?.height || 0, ...(info?.color ? { color: info.color } : {}) } : null)}
            />
          </div>
          <label className="field">
            <span>介绍</span>
            <textarea rows={5} value={form.intro} onChange={(e) => set('intro', e.target.value)} placeholder="每行一段" />
          </label>

          <div className="section-head">
            <h3>附加板块</h3>
            <button type="button" className="btn small ghost" onClick={() => set('sections', [...form.sections, { title: '', body: '', items: '' }])}>+ 添加板块</button>
          </div>
          {form.sections.map((s, i) => (
            <div key={i} className="panel">
              <div className="field-row">
                <label className="field grow">
                  <span>标题</span>
                  <input value={s.title} onChange={(e) => setSection(i, { title: e.target.value })} placeholder="例如：服务、预约须知" />
                </label>
                <div className="field inline-actions">
                  <button type="button" className="icon-btn" title="上移" onClick={() => set('sections', moveIn(form.sections, i, i - 1))}>↑</button>
                  <button type="button" className="icon-btn" title="下移" onClick={() => set('sections', moveIn(form.sections, i, i + 1))}>↓</button>
                  <button type="button" className="icon-btn danger" title="删除" onClick={() => set('sections', form.sections.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
              <div className="field-row">
                <label className="field grow">
                  <span>正文（每行一段）</span>
                  <textarea rows={3} value={s.body} onChange={(e) => setSection(i, { body: e.target.value })} />
                </label>
                <label className="field grow">
                  <span>标签列表（每行一项）</span>
                  <textarea rows={3} value={s.items} onChange={(e) => setSection(i, { items: e.target.value })} placeholder={'个人写真\n婚礼纪实'} />
                </label>
              </div>
            </div>
          ))}

          <div className="section-head"><h3>地址与营业时间</h3></div>
          <label className="field">
            <span>地址</span>
            <input value={form.address} onChange={(e) => set('address', e.target.value)} />
          </label>
          <label className="field">
            <span>营业时间</span>
            <input value={form.hours} onChange={(e) => set('hours', e.target.value)} placeholder="例如：10:00 – 20:00 · 周一休息" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>纬度</span>
              <input value={form.lat} inputMode="decimal" onChange={(e) => set('lat', e.target.value.trim())} placeholder="31.1886" />
            </label>
            <label className="field">
              <span>经度</span>
              <input value={form.lng} inputMode="decimal" onChange={(e) => set('lng', e.target.value.trim())} placeholder="121.4365" />
            </label>
            <label className="field grow">
              <span>地图上的名称</span>
              <input value={form.locName} onChange={(e) => set('locName', e.target.value)} placeholder="留空则使用工作室名称" />
            </label>
          </div>
          <small className="muted">填写经纬度（GCJ-02，可在腾讯地图坐标拾取器获取）后，点击地址会打开地图；否则点击复制地址。</small>

          <div className="section-head">
            <h3>联系方式（{form.contacts.length}）</h3>
            <select value="" onChange={(e) => e.target.value && set('contacts', [...form.contacts, blankContact(e.target.value as ContactType)])}>
              <option value="">+ 添加联系方式…</option>
              {CONTACT_TYPES.map((t) => <option key={t} value={t}>{CONTACT_LABELS[t]}</option>)}
            </select>
          </div>
          {form.contacts.map((c, i) => (
            <div key={i} className="panel contact-panel">
              <div className="field-row">
                <label className="field">
                  <span>类型</span>
                  <select value={c.type} onChange={(e) => setContact(i, { type: e.target.value as ContactType })}>
                    {CONTACT_TYPES.map((t) => <option key={t} value={t}>{CONTACT_LABELS[t]}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>显示文字</span>
                  <input value={c.label} onChange={(e) => setContact(i, { label: e.target.value })} placeholder={CONTACT_LABELS[c.type]} />
                </label>
                <div className="field inline-actions">
                  <button type="button" className="icon-btn" title="前移" onClick={() => set('contacts', moveIn(form.contacts, i, i - 1))}>←</button>
                  <button type="button" className="icon-btn" title="后移" onClick={() => set('contacts', moveIn(form.contacts, i, i + 1))}>→</button>
                  <button type="button" className="icon-btn danger" title="删除" onClick={() => set('contacts', form.contacts.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
              <label className="field">
                <span>{c.type === 'phone' ? '电话号码' : '账号 / 内容'}</span>
                <input value={c.value} onChange={(e) => setContact(i, { value: e.target.value })} placeholder={VALUE_HINT[c.type]} />
              </label>
              {c.type === 'wecom' && (
                <div className="field-row">
                  <label className="field grow">
                    <span>企业 ID（corpId）</span>
                    <input value={c.corpId} onChange={(e) => setContact(i, { corpId: e.target.value })} />
                  </label>
                  <label className="field grow">
                    <span>客服链接（url）</span>
                    <input value={c.url} onChange={(e) => setContact(i, { url: e.target.value })} placeholder="https://work.weixin.qq.com/kfid/…" />
                  </label>
                </div>
              )}
              {c.type !== 'phone' && c.type !== 'wecom' && (
                <div className="field-row">
                  <label className="field grow">
                    <span>跳转小程序 AppID（可选）</span>
                    <input value={c.appId} onChange={(e) => setContact(i, { appId: e.target.value })} />
                  </label>
                  <label className="field grow">
                    <span>小程序路径（可选）</span>
                    <input value={c.path} onChange={(e) => setContact(i, { path: e.target.value })} />
                  </label>
                </div>
              )}
              {c.type !== 'phone' && (
                <div className="field">
                  <span>二维码（可选）</span>
                  <ImagePicker label="二维码" value={c.qrcode} onUploaded={(f) => sessionUploads.current.add(f)} onChange={(src) => setContact(i, { qrcode: src })} />
                </div>
              )}
              {!(c.value || c.qrcode || c.appId || c.url) && <div className="muted small">需要填写内容、二维码、AppID 或链接中的至少一项，否则小程序中不显示。</div>}
            </div>
          ))}

          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => { setForm(toForm(saved)); setError(''); }} disabled={!dirty}>撤销修改</button>
            <button type="submit" className="btn" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </form>
      </section>

      <aside className="preview-pane">
        <div className="preview-head">
          <strong>「关于」页预览</strong>
          <span className="muted small">点击联系方式图标可查看弹出面板</span>
        </div>
        <Phone title={studio.name || '关于我们'} tab="about" onTab={(t) => t !== 'about' && t !== 'mine' && navigate('/portfolios')}>
          <AboutPage studio={studio} />
        </Phone>
      </aside>
    </div>
  );
}
