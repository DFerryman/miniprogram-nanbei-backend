import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as N from '../shared/normalize.ts';
import * as Q from './query.ts';
import { parseConfig } from './index.ts';

test('字符串字面量经过转义，无法注入语句', () => {
  const evil = '"}).remove();db.collection("users").get({"';
  const q = Q.find('portfolios', { where: { title: evil }, limit: 10 });
  assert.equal(q, `db.collection("portfolios").where({"title":${JSON.stringify(evil)}}).limit(10).get()`);
  assert.equal(Q.lit('a\u2028b'), '"a\\u2028b"');
});

test('更新时对象与数组整体替换，日期为 Date 构造', () => {
  const q = Q.updateById('portfolios', 'p_1', Q.replaceFields({
    title: 't',
    media: [{ type: 'image', src: 'cloud://x' }],
    cover: null,
    updatedAt: Q.date('2026-01-01T00:00:00Z'),
  }));
  assert.equal(
    q,
    'db.collection("portfolios").doc("p_1").update({"data":{"title":"t","media":db.command.set([{"type":"image","src":"cloud://x"}]),"cover":null,"updatedAt":new Date("2026-01-01T00:00:00.000Z")}})',
  );
});

test('作品输入整理', () => {
  const p = N.portfolioInput({
    title: '  山间晨雾 ',
    seriesId: 'bad id!',
    shootDate: '2026-05-12',
    media: [{ src: 'http://insecure' }, { src: 'cloud://env.x/portfolios/p/1.mp4', width: '1920', height: 1080 }],
    status: 'oops',
    weight: '80',
    tags: ['风光', ''],
  });
  assert.equal(p.title, '山间晨雾');
  assert.equal(p.seriesId, null);
  assert.equal(p.status, 'draft');
  assert.equal(p.weight, 80);
  assert.deepEqual(p.tags, ['风光']);
  assert.deepEqual(p.media, [{ type: 'video', src: 'cloud://env.x/portfolios/p/1.mp4', width: 1920, height: 1080 }]);
});

test('读取数据库日期', () => {
  assert.equal(N.toIso({ $date: '2026-09-01T08:00:00.000Z' }), '2026-09-01T08:00:00.000Z');
  assert.equal(N.toIso({ $date: 1756713600000 }), '2025-09-01T08:00:00.000Z');
  assert.equal(N.shootDate({ $date: '2026-05-11T16:00:00.000Z' }), '2026-05-12');
});

test('工作室信息整理', () => {
  const s = N.studio({ name: 'n', intro: '段一\n\n段二', location: { latitude: '31.1', longitude: 121.4 }, contacts: [{ type: 'x', value: 'v' }] });
  assert.deepEqual(s.intro, ['段一', '段二']);
  assert.deepEqual(s.location, { latitude: 31.1, longitude: 121.4, name: '' });
  assert.equal(s.contacts[0].type, 'link');
});

test('连接配置只读取服务端环境变量，并校验白名单', () => {
  const good = {
    WECHAT_API_BASE: 'https://api.weixin.qq.com/',
    CLOUDBASE_ENV_ID: 'cloud1-d4gbua7848fbcecf0',
    WECHAT_APP_ID: 'wx7f54ff074d26489f',
    WECHAT_APP_SECRET: '0123456789abcdef0123456789abcdef',
  };
  assert.equal(parseConfig(good).apiBase, 'https://api.weixin.qq.com');
  assert.equal(parseConfig(good).envId, 'cloud1-d4gbua7848fbcecf0');
  assert.throws(() => parseConfig({ ...good, WECHAT_API_BASE: 'http://x.com' }));
  assert.throws(() => parseConfig({ ...good, WECHAT_API_BASE: 'https://evil.com' }));
  assert.throws(() => parseConfig({ ...good, WECHAT_APP_SECRET: '' }));
  assert.throws(() => parseConfig({ ...good, WECHAT_API_BASE: 'https://api.weixin.qq.com?token=x' }));
  assert.equal(parseConfig({ ...good, WECHAT_API_BASE: 'http://127.0.0.1:8790', ALLOWED_API_HOSTS: '127.0.0.1', ALLOW_INSECURE_LOCALHOST: '1' }).apiBase, 'http://127.0.0.1:8790');
});
