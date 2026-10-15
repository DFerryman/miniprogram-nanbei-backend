// 本地联调用的微信云开发 HTTP API 模拟服务（内存数据库 + 内存文件存储）。
// 用法：node scripts/mock-wechat.mjs [端口=8790] [种子数据目录，例如小程序仓库的 database/seed]
// 配合 .dev.vars 中的 ALLOW_INSECURE_LOCALHOST=1，在设置页把接口地址填为 http://127.0.0.1:8790。
// 数据库语句（如 db.collection("x").where({...}).get()）在沙箱中按真实语法执行，可发现拼接错误。
// 测试中可 import { startMock } 在随机端口启动，并用 pause() 让某类请求暂停，构造并发交错。
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

let PORT = 0;
let quiet = false;
const COLLECTIONS = ['portfolios', 'series', 'studio', 'users', 'likes'];
const TOKEN = 'mock_access_token';

const store = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
const files = new Map();

function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    if ('$date' in value) return new Date(value.$date);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

function seedAll(dir) {
  const read = (file, name) => {
    const path = join(dir, file);
    if (!existsSync(path)) return;
    readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).forEach((line) => {
      const doc = revive(JSON.parse(line));
      store[name].set(doc._id, doc);
    });
  };
  read('portfolios.json', 'portfolios');
  read('portfolios-extra.json', 'portfolios');
  read('series.json', 'series');
  read('studio.json', 'studio');
}

class WxErr extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

const SET = Symbol('set');
const IN = Symbol('in');
const EXISTS = Symbol('exists');
const INC = Symbol('inc');

function matches(doc, where) {
  return Object.entries(where || {}).every(([k, v]) => {
    if (v && v[IN]) return v[IN].includes(doc[k]);
    if (v && v[EXISTS] !== undefined) return (k in doc && doc[k] !== undefined) === v[EXISTS];
    return doc[k] === v || (v === null && doc[k] == null);
  });
}

function applyUpdate(doc, data) {
  for (const [k, v] of Object.entries(data)) {
    if (v && v[INC] !== undefined) doc[k] = (typeof doc[k] === 'number' ? doc[k] : 0) + v[INC];
    else if (v && v[SET] !== undefined) doc[k] = structuredClone(v[SET]);
    else if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && doc[k] && typeof doc[k] === 'object') {
      applyUpdate(doc[k], v); // 与云数据库一致：普通对象按字段合并
    } else doc[k] = v;
  }
}

function makeDb() {
  const command = {
    set: (v) => ({ [SET]: v }),
    in: (arr) => ({ [IN]: arr }),
    exists: (flag) => ({ [EXISTS]: !!flag }),
    inc: (n) => ({ [INC]: n }),
  };
  function collection(name) {
    const col = store[name];
    if (!col) throw new WxErr(-502005, `database collection not exists: ${name}`);
    const q = { where: null, orders: [], skip: 0, limit: 10 };
    const list = () => {
      let docs = [...col.values()].filter((d) => matches(d, q.where));
      docs.sort((a, b) => {
        for (const o of q.orders) {
          const x = a[o.f] instanceof Date ? a[o.f].getTime() : a[o.f] ?? 0;
          const y = b[o.f] instanceof Date ? b[o.f].getTime() : b[o.f] ?? 0;
          if (x < y) return o.d === 'desc' ? 1 : -1;
          if (x > y) return o.d === 'desc' ? -1 : 1;
        }
        return 0;
      });
      return docs;
    };
    const api = {
      where(w) { q.where = w; return api; },
      orderBy(f, d) { q.orders.push({ f, d }); return api; },
      skip(n) { q.skip = n; return api; },
      limit(n) {
        if (n > 1000) throw new WxErr(-1, 'limit too large');
        q.limit = n;
        return api;
      },
      get() {
        const all = list();
        return { kind: 'query', data: all.slice(q.skip, q.skip + q.limit), total: all.length, offset: q.skip, limit: q.limit };
      },
      count() { return { kind: 'count', count: list().length }; },
      add({ data }) {
        const docs = Array.isArray(data) ? data : [data];
        const ids = docs.map((d) => {
          const id = d._id || Math.random().toString(36).slice(2);
          if (col.has(id)) throw new WxErr(-502001, `duplicate key: ${id}`);
          col.set(id, { ...structuredClone(d), _id: id });
          return id;
        });
        return { kind: 'add', ids };
      },
      update({ data }) {
        if (!q.where) throw new WxErr(-1, 'update without where is not allowed in this mock');
        const docs = list();
        docs.forEach((d) => applyUpdate(d, data));
        return { kind: 'update', matched: docs.length, modified: docs.length };
      },
      remove() {
        const docs = list();
        docs.forEach((d) => col.delete(d._id));
        return { kind: 'remove', deleted: docs.length };
      },
      doc(id) {
        return {
          update({ data }) {
            const d = col.get(id);
            if (d) applyUpdate(d, data);
            return { kind: 'update', matched: d ? 1 : 0, modified: d ? 1 : 0 };
          },
          remove() {
            const had = col.delete(id);
            return { kind: 'remove', deleted: had ? 1 : 0 };
          },
        };
      },
    };
    return api;
  }
  return { command, collection };
}

function run(query) {
  if (typeof query !== 'string') throw new WxErr(40097, 'invalid query');
  return vm.runInNewContext(query, { db: makeDb(), Date }, { timeout: 200 });
}

function serialize(doc) {
  return JSON.stringify(doc, function (key, value) {
    const raw = this[key];
    return raw instanceof Date ? { $date: raw.toISOString() } : value;
  });
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const handlers = {
  '/tcb/databasequery': (b) => {
    const r = run(b.query);
    return { pager: { Offset: r.offset, Limit: r.limit, Total: r.total }, data: r.data.map(serialize) };
  },
  '/tcb/databaseadd': (b) => ({ id_list: run(b.query).ids }),
  '/tcb/databaseupdate': (b) => {
    const r = run(b.query);
    return { matched: r.matched, modified: r.modified, id: '' };
  },
  '/tcb/databasedelete': (b) => ({ deleted: run(b.query).deleted }),
  '/tcb/databasecount': (b) => ({ count: run(b.query).count }),
  '/tcb/uploadfile': (b) => ({
    url: `http://127.0.0.1:${PORT}/cos`,
    token: 'cos_token',
    authorization: 'cos_signature',
    file_id: `cloud://${b.env}.6d6f-mock-bucket/${b.path}`,
    cos_file_id: `cos_${b.path}`,
  }),
  '/tcb/batchdownloadfile': (b) => ({
    file_list: b.file_list.map(({ fileid }) => {
      const path = fileid.replace(/^cloud:\/\/[^/]+\//, '');
      return files.has(path)
        ? { fileid, download_url: `http://127.0.0.1:${PORT}/files/${path}`, status: 0, errmsg: 'ok' }
        : { fileid, download_url: '', status: 1, errmsg: 'file not found' };
    }),
  }),
  '/tcb/batchdeletefile': (b) => ({
    delete_list: b.fileid_list.map((fileid) => {
      const path = fileid.replace(/^cloud:\/\/[^/]+\//, '');
      const ok = files.delete(path);
      return { fileid, status: ok ? 0 : 1, errmsg: ok ? 'ok' : 'not found' };
    }),
  }),
};

const gates = new Map();

/** 让发往 path 的请求暂停，直到调用返回的 release()。返回对象的 waiting 为已暂停的请求数。 */
function pause(path) {
  const gate = { waiting: 0, resolvers: [], open: false };
  gates.set(path, gate);
  return {
    get waiting() { return gate.waiting; },
    release() {
      gate.open = true;
      gates.delete(path);
      gate.resolvers.splice(0).forEach((r) => r());
    },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
  };
  try {
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const f = files.get(decodeURIComponent(url.pathname.slice('/files/'.length)));
      if (!f) return send(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': f.type || 'application/octet-stream', 'access-control-allow-origin': '*' });
      return res.end(f.data);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': '*' });
      return res.end();
    }
    const raw = await body(req);
    if (url.pathname === '/cos') {
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      if (form.get('Signature') !== 'cos_signature' || form.get('x-cos-security-token') !== 'cos_token') {
        return send(403, '<Error>bad signature</Error>');
      }
      const file = form.get('file');
      files.set(form.get('key'), { data: Buffer.from(await file.arrayBuffer()), type: file.type });
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      return res.end();
    }
    const b = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    if (url.pathname === '/cgi-bin/stable_token') {
      if (!b.appid || !b.secret) return send(200, { errcode: 40125, errmsg: 'invalid appsecret' });
      return send(200, { access_token: TOKEN, expires_in: 7200 });
    }
    const handler = handlers[url.pathname];
    if (!handler) return send(404, { errcode: 404, errmsg: 'not found' });
    const gate = gates.get(url.pathname);
    if (gate && !gate.open) {
      gate.waiting += 1;
      await new Promise((r) => gate.resolvers.push(r));
    }
    if (url.searchParams.get('access_token') !== TOKEN) return send(200, { errcode: 40001, errmsg: 'invalid credential' });
    if (!b.env) return send(200, { errcode: -501000, errmsg: 'env required' });
    const out = handler(b);
    if (!quiet) console.log(url.pathname, (b.query || b.path || '').slice(0, 160));
    return send(200, { errcode: 0, errmsg: 'ok', ...out });
  } catch (err) {
    if (!quiet) console.error(url.pathname, err.message);
    return send(200, { errcode: err.code ?? -1, errmsg: err.message });
  }
});

/** 在指定端口（0 为随机端口）启动模拟服务。 */
export function startMock({ port = 0, seedDir, silent = false } = {}) {
  quiet = silent;
  if (seedDir) seedAll(seedDir);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      PORT = server.address().port;
      resolve({
        port: PORT,
        base: `http://127.0.0.1:${PORT}`,
        store,
        files,
        pause,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMock({ port: Number(process.argv[2] || 8790), seedDir: process.argv[3] })
    .then(({ base }) => console.log(`mock wechat api on ${base}`));
}
