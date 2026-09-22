'use strict';
/*  Cake SMP Console – backend (Node 18.15+)
 *  - Sign-in with email + password, then a 6-digit code sent to the admin's Gmail
 *  - Live console: tails logs/latest.log and runs commands over RCON
 *  - Files (text editor), plugins list, players, activity log
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* reported when a mail is sent */ }
let SftpClient = null;
try { SftpClient = require('ssh2-sftp-client'); } catch { /* reported when used */ }

const cfg = JSON.parse(fs.readFileSync(process.env.CAKE_CONFIG || path.join(__dirname, 'config.json'), 'utf8'));
const PORT = Number(cfg.port) || 8080;
const HOST = cfg.host || '127.0.0.1';
const STORAGE = (cfg.storage || 'local').toLowerCase();   // 'local' reads the Minecraft folder off this machine's disk; 'sftp' reads it over SFTP (e.g. a Folium-hosted server)
const ROOT = path.resolve(cfg.minecraftDir || '.');
let ROOT_REAL = ROOT;
try { ROOT_REAL = fs.realpathSync(ROOT); } catch { /* folder may not exist yet */ }
const LOG_FILE = path.resolve(ROOT, cfg.logFile || 'logs/latest.log');
const SFTP_ROOT = (() => { let r = path.posix.normalize('/' + String((cfg.sftp && cfg.sftp.root) || '/').replace(/\\/g, '/')); return r !== '/' ? r.replace(/\/+$/, '') : r; })();
const SFTP_LOG = path.posix.normalize(SFTP_ROOT + '/' + String(cfg.logFile || 'logs/latest.log').replace(/^\/+/, ''));
const ACTIVITY_FILE = path.join(__dirname, 'activity.log');
const SESSION_TTL = 12 * 3600 * 1000;
const CODE_TTL = 10 * 60 * 1000;
const MB = 1024 * 1024;

/* ───────────── small helpers ───────────── */
const secret = crypto.randomBytes(32);
const hmac = (s) => crypto.createHmac('sha256', secret).update(String(s)).digest();
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function verifyPassword(pw, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return safeEq(derived, Buffer.from(hash, 'hex'));
}

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const maskEmail = (e) => { const [u, d] = String(e).split('@'); return u[0] + '•'.repeat(Math.max(3, u.length - 1)) + '@' + d; };

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 2 * MB) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(httpErr(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpErr(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}

const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((p) => p[0]));
const clientIp = (req) => (cfg.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  return ++h.n > max;
}

/* ───────────── activity log ───────────── */
let activity = [];
try {
  activity = fs.readFileSync(ACTIVITY_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-200).map((l) => JSON.parse(l));
} catch { /* first run */ }
function audit(type, detail, ip) {
  const entry = { t: Date.now(), type, detail: String(detail || '').slice(0, 200), ip: ip || '' };
  activity.push(entry); if (activity.length > 200) activity.shift();
  fsp.appendFile(ACTIVITY_FILE, JSON.stringify(entry) + '\n').catch(() => {});
}

/* ───────────── sign-in: password → emailed code → session ───────────── */
const pending = new Map();   // id -> { codeHash, expires, attempts, sends, lastSent }
const sessions = new Map();  // token -> { expires }

let transporter = null;
async function sendCodeMail(code) {
  if (cfg.printCodeToConsole) { console.log(`[dev] verification code: ${code}`); return; }
  if (!nodemailer) throw new Error('nodemailer is not installed – run "npm install"');
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure !== false,
      auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
    });
  }
  const name = cfg.serverName || 'Cake SMP';
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;background:#0a0d13;padding:32px">
  <div style="max-width:420px;margin:auto;background:#131924;border:1px solid #2b3850;border-radius:16px;padding:28px;color:#e8edf7;text-align:center">
    <div style="font-size:34px">🍰</div>
    <h2 style="margin:8px 0 4px">${name} console</h2>
    <p style="color:#8a96ad;margin:0 0 20px">Use this code to finish signing in.</p>
    <div style="font:700 34px/1 Consolas,monospace;letter-spacing:10px;background:#0e121a;border:1px solid #212b3d;border-radius:12px;padding:18px 0 18px 10px">${code}</div>
    <p style="color:#8a96ad;font-size:13px;margin:20px 0 0">It expires in 10 minutes. If this wasn't you, change your password.</p>
  </div></div>`;
  await transporter.sendMail({
    from: `"${name}" <${cfg.smtp.user}>`, to: cfg.admin.email,
    subject: `${code} is your ${name} console code`,
    text: `Your ${name} console code is ${code}. It expires in 10 minutes.`, html,
  });
}

async function issueCode(p) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await sendCodeMail(code);
  p.codeHash = hmac(p.id + ':' + code);
  p.expires = Date.now() + CODE_TTL; p.attempts = 0; p.sends++; p.lastSent = Date.now();
}

function newSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + SESSION_TTL });
  res.setHeader('Set-Cookie', `cake_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${cfg.secureCookies ? '; Secure' : ''}`);
}
function getSession(req) {
  const t = parseCookies(req).cake_session;
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(t); return null; }
  return { token: t, ...s };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now - 60000) pending.delete(k);
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60000).unref();

/* ───────────── RCON (persistent connection, so the server log isn't spammed) ───────────── */
function rconPacket(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + b.length);
  out.writeInt32LE(10 + b.length, 0); out.writeInt32LE(id, 4); out.writeInt32LE(type, 8); b.copy(out, 12);
  return out;
}

class Rcon {
  constructor(o) { this.o = o; this.sock = null; this.buf = Buffer.alloc(0); this.ready = false; this.connecting = null; this.pending = null; this.chain = Promise.resolve(); this.nextId = 2; }

  connect() {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const s = net.connect(this.o.port, this.o.host);
      let done = false;
      const fail = (e) => { if (done) return; done = true; this.connecting = null; s.destroy(); reject(e); };
      s.setTimeout(6000, () => fail(new Error('RCON connection timed out')));
      s.on('error', (e) => { fail(e); this.drop(e); });
      s.on('close', () => { fail(new Error('RCON connection closed')); this.drop(); });
      s.on('connect', () => s.write(rconPacket(1, 3, this.o.password)));
      s.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        while (this.buf.length >= 4) {
          const len = this.buf.readInt32LE(0);
          if (this.buf.length < len + 4) break;
          const id = this.buf.readInt32LE(4), type = this.buf.readInt32LE(8);
          const body = this.buf.toString('utf8', 12, 4 + len - 2);
          this.buf = this.buf.subarray(4 + len);
          if (!this.ready) {
            if (id === -1) return fail(new Error('RCON password rejected – check rcon.password in config.json'));
            if (type === 2) { done = true; this.ready = true; this.sock = s; this.connecting = null; s.setTimeout(0); s.setKeepAlive(true, 15000); resolve(); }
          } else this.onPacket(id, body);
        }
      });
    });
    return this.connecting;
  }

  onPacket(id, body) {
    const p = this.pending;
    if (!p) return;
    if (id === p.id) p.parts.push(body);
    else if (id === p.id + 1) p.finish();        // marker reply → the command's reply is complete
  }

  drop(err) {
    this.ready = false; this.sock = null; this.buf = Buffer.alloc(0);
    if (this.pending) this.pending.fail(err || new Error('RCON connection lost'));
  }

  exec(cmd) {
    const run = () => this.run(cmd);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async run(cmd) {
    await this.connect();
    const id = this.nextId; this.nextId = this.nextId > 1e9 ? 2 : this.nextId + 2;
    return new Promise((resolve, reject) => {
      const parts = [];
      const timer = setTimeout(() => { this.pending = null; reject(new Error('RCON timed out')); }, 8000);
      this.pending = {
        id, parts,
        finish: () => { clearTimeout(timer); this.pending = null; resolve(parts.join('')); },
        fail: (e) => { clearTimeout(timer); this.pending = null; reject(e); },
      };
      this.sock.write(rconPacket(id, 2, cmd));
      this.sock.write(rconPacket(id + 1, 0, ''));
    });
  }
}
const rcon = new Rcon(cfg.rcon || {});

/* ───────────── SFTP (one persistent connection, queued like RCON above) ─────────────
 * Used instead of the local disk when "storage": "sftp" – e.g. a Folium-hosted server,
 * where this console runs somewhere else and only has SFTP access to the files. */
class Sftp {
  constructor(o) { this.o = o || {}; this.client = null; this.connecting = null; this.chain = Promise.resolve(); }
  ensure() {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    if (!SftpClient) return Promise.reject(new Error('ssh2-sftp-client is not installed – run "npm install"'));
    if (!this.o.host || !this.o.username) return Promise.reject(new Error('Set sftp.host, sftp.username and sftp.password in config.json'));
    const c = new SftpClient();
    this.connecting = c.connect({
      host: this.o.host, port: this.o.port || 22, username: this.o.username, password: this.o.password,
      readyTimeout: 10000,
    }).then(() => {
      this.client = c; this.connecting = null;
      const drop = () => this.drop(); c.on('end', drop); c.on('close', drop); c.on('error', drop);
      return c;
    }).catch((e) => { this.connecting = null; throw new Error('SFTP connection failed: ' + e.message); });
    return this.connecting;
  }
  drop() { const c = this.client; this.client = null; if (c) c.end().catch(() => {}); }
  run(fn) {
    const p = this.chain.then(async () => {
      const c = await this.ensure();
      try { return await fn(c); }
      catch (e) { if (/closed|not connected|ECONNRESET|EPIPE/i.test(e.message || '')) this.drop(); throw e; }
    });
    this.chain = p.catch(() => {});
    return p;
  }
}
const sftp = new Sftp(cfg.sftp || {});
async function sftpReadRange(remotePath, start, len) {
  if (len <= 0) return '';
  const buf = await sftp.run((c) => c.get(remotePath, undefined, { readStreamOptions: { start, end: start + len - 1 } }));
  return buf.toString('utf8');
}
async function sftpSize(remotePath) { return (await sftp.run((c) => c.stat(remotePath))).size; }

/* ───────────── live log (tail latest.log) ───────────── */
const ring = [];
const clients = new Set();
let logPos = 0, logRest = '';

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const c of clients) sse(c, event, data); }
function pushLines(lines, live) {
  if (!lines.length) return;
  ring.push(...lines); if (ring.length > 500) ring.splice(0, ring.length - 500);
  if (live) broadcast('log', lines);
}

async function localReadRange(start, len) {
  const fh = await fsp.open(LOG_FILE, 'r');
  try { const buf = Buffer.alloc(len); await fh.read(buf, 0, len, start); return buf.toString('utf8'); } finally { await fh.close(); }
}
const readRange = (start, len) => (STORAGE === 'sftp' ? sftpReadRange(SFTP_LOG, start, len) : localReadRange(start, len));
const logSize = async () => (STORAGE === 'sftp' ? sftpSize(SFTP_LOG) : (await fsp.stat(LOG_FILE)).size);

async function initLog() {
  try {
    const size = await logSize();
    const start = Math.max(0, size - 96 * 1024);
    const lines = (await readRange(start, size - start)).split(/\r?\n/);
    if (start > 0) lines.shift();
    logPos = size;
    pushLines(lines.filter(Boolean).slice(-300), false);
  } catch { /* log not there yet */ }
}
async function pollLog() {
  try {
    const size = await logSize();
    if (size < logPos) { logPos = 0; logRest = ''; }              // rotated
    if (size - logPos > 4 * MB) logPos = size - MB;                // skip a huge burst
    if (size > logPos) {
      const text = logRest + await readRange(logPos, size - logPos);
      logPos = size;
      const parts = text.split(/\r?\n/);
      logRest = parts.pop();
      pushLines(parts.filter(Boolean), true);
    }
  } catch { /* ignore until the file exists, or a transient SFTP hiccup */ }
}

/* ───────────── stats + players ───────────── */
const live = { online: false, players: { online: 0, max: 0, names: [] } };
let lastCpu = os.cpus().map((c) => ({ ...c.times }));
let disk = { used: 0, total: 0 }, diskAt = 0;

function cpuPercent() {
  const now = os.cpus().map((c) => ({ ...c.times }));
  let idle = 0, total = 0;
  now.forEach((t, i) => { const p = lastCpu[i]; for (const k in t) total += t[k] - p[k]; idle += t.idle - p.idle; });
  lastCpu = now;
  return total ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}
async function snapshot() {
  if (STORAGE !== 'sftp' && Date.now() - diskAt > 30000) {   // disk usage isn't exposed over plain SFTP, so this only applies locally
    diskAt = Date.now();
    try { const s = await fsp.statfs(ROOT_REAL); disk = { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize }; } catch { /* keep old */ }
  }
  return {
    online: live.online, players: live.players,
    cpu: cpuPercent(), cpuCores: os.cpus().length,
    memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(),
    diskUsed: disk.used, diskTotal: disk.total,
  };
}
async function pollPlayers() {
  try {
    const out = await rcon.exec('list');
    const m = /There are (\d+) of a max of (\d+) players online:?\s*(.*)/is.exec(out.replace(/§./g, ''));
    live.online = true;
    live.players = m ? { online: +m[1], max: +m[2], names: m[3].split(',').map((s) => s.trim()).filter(Boolean) } : { online: 0, max: 0, names: [] };
  } catch {
    live.online = false; live.players = { online: 0, max: 0, names: [] };
  }
}

/* ───────────── files (local disk, or over SFTP when storage is "sftp") ───────────── */
async function resolveSafe(rel) {
  const norm = path.posix.normalize('/' + String(rel || '').replace(/\\/g, '/'));
  const target = path.resolve(ROOT, '.' + norm);
  const inside = (p) => p === ROOT_REAL || p.startsWith(ROOT_REAL + path.sep);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) throw httpErr(400, 'Path is outside the server folder');
  let probe = target;
  for (;;) {                                                     // resolve symlinks of the nearest existing parent
    try { if (!inside(await fsp.realpath(probe))) throw httpErr(400, 'Path is outside the server folder'); break; }
    catch (e) { if (e.status) throw e; const up = path.dirname(probe); if (up === probe) break; probe = up; }
  }
  return { abs: target, rel: norm };
}
function sftpResolve(rel) {
  const norm = path.posix.normalize('/' + String(rel || '').replace(/\\/g, '/'));
  const full = SFTP_ROOT === '/' ? norm : path.posix.normalize(SFTP_ROOT + norm);
  return { full, rel: norm };
}
function sftpFail(e, fallback) {
  if (/no such file|not exist/i.test(e.message || '')) throw httpErr(404, 'Not found');
  throw httpErr(502, fallback + ': ' + e.message);
}

async function listDir(relDir) {
  if (STORAGE === 'sftp') {
    const { full, rel } = sftpResolve(relDir);
    let list;
    try { list = await sftp.run((c) => c.list(full)); } catch (e) { sftpFail(e, 'Could not list that folder over SFTP'); }
    const entries = list.slice(0, 1500)
      .map((e) => ({ name: e.name, dir: e.type === 'd', size: e.size, mtime: e.modifyTime || Date.now() }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { rel, entries };
  }
  const { abs, rel } = await resolveSafe(relDir);
  let list;
  try { list = await fsp.readdir(abs, { withFileTypes: true }); } catch { throw httpErr(404, 'Folder not found'); }
  const entries = (await Promise.all(list.slice(0, 1500).map(async (d) => {
    try { const st = await fsp.stat(path.join(abs, d.name)); return { name: d.name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; } catch { return null; }
  }))).filter(Boolean).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { rel, entries };
}

async function readTextFile(relPath) {
  if (STORAGE === 'sftp') {
    const { full, rel } = sftpResolve(relPath);
    let st;
    try { st = await sftp.run((c) => c.stat(full)); } catch (e) { sftpFail(e, 'Could not read that file over SFTP'); }
    if (st.isDirectory) throw httpErr(400, 'Not a file');
    if (st.size > MB) throw httpErr(413, 'File is larger than 1 MB – edit it on the server instead.');
    const buf = await sftp.run((c) => c.get(full));
    if (buf.subarray(0, 8000).includes(0)) throw httpErr(415, 'Binary files cannot be edited here.');
    return { rel, content: buf.toString('utf8'), size: st.size };
  }
  const { abs, rel } = await resolveSafe(relPath);
  let st; try { st = await fsp.stat(abs); } catch { throw httpErr(404, 'File not found'); }
  if (!st.isFile()) throw httpErr(400, 'Not a file');
  if (st.size > MB) throw httpErr(413, 'File is larger than 1 MB – edit it on the server instead.');
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) throw httpErr(415, 'Binary files cannot be edited here.');
  return { rel, content: buf.toString('utf8'), size: st.size };
}

async function writeTextFile(relPath, content) {
  if (STORAGE === 'sftp') {
    const { full, rel } = sftpResolve(relPath);
    if (full === SFTP_ROOT) throw httpErr(400, 'Pick a file name.');
    try { await sftp.run((c) => c.mkdir(path.posix.dirname(full), true)); } catch { /* likely already exists */ }
    try { await sftp.run((c) => c.put(Buffer.from(content, 'utf8'), full)); } catch (e) { sftpFail(e, 'Could not save that file over SFTP'); }
    return rel;
  }
  const { abs, rel } = await resolveSafe(relPath);
  if (abs === ROOT) throw httpErr(400, 'Pick a file name.');
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return rel;
}

async function listPlugins() {
  if (STORAGE === 'sftp') {
    let list;
    try { list = await listDir('/plugins'); } catch { return []; }
    return list.entries.filter((e) => !e.dir && /\.jar(\.disabled)?$/i.test(e.name))
      .map((e) => ({ name: e.name, size: e.size, mtime: e.mtime, disabled: /\.disabled$/i.test(e.name) }));
  }
  try {
    const dir = path.join(ROOT, 'plugins');
    return (await Promise.all((await fsp.readdir(dir)).filter((n) => /\.jar(\.disabled)?$/i.test(n)).map(async (n) => {
      const st = await fsp.stat(path.join(dir, n));
      return { name: n, size: st.size, mtime: st.mtimeMs, disabled: /\.disabled$/i.test(n) };
    }))).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

/* ───────────── HTTP ───────────── */
function setHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
}

const server = http.createServer(async (req, res) => {
  try {
    setHeaders(res);
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const method = req.method;
    const ip = clientIp(req);

    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = await fsp.readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (!p.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }

    if (method !== 'GET' && req.headers.origin) {                // basic CSRF guard
      let ok = false;
      try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* bad origin */ }
      if (!ok) return json(res, 403, { error: 'Blocked cross-site request' });
    }

    /* ---- public: sign-in ---- */
    if (method === 'POST' && p === '/api/login') {
      if (limited('login:' + ip, 8, 15 * 60000)) return json(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const okEmail = safeEq(hmac(email), hmac(String(cfg.admin.email).toLowerCase()));
      const okPw = verifyPassword(String(b.password || ''), cfg.admin.passwordHash);
      if (!(okEmail && okPw)) { audit('login_failed', email.slice(0, 60), ip); return json(res, 401, { error: 'Wrong email or password.' }); }
      const entry = { id: crypto.randomBytes(24).toString('hex'), sends: 0, lastSent: 0, expires: Date.now() + CODE_TTL, attempts: 0, ip };
      try { await issueCode(entry); }
      catch (e) { console.error('Could not send the verification email:', e.message); return json(res, 502, { error: 'Could not send the verification email. Check the smtp settings in config.json.' }); }
      pending.set(entry.id, entry);
      audit('code_sent', 'Verification code emailed', ip);
      return json(res, 200, { pending: entry.id, email: maskEmail(cfg.admin.email) });
    }
    if (method === 'POST' && p === '/api/resend') {
      const b = await readBody(req);
      const e = pending.get(String(b.pending || ''));
      if (!e) return json(res, 400, { error: 'Sign-in expired. Start again.', expired: true });
      const wait = Math.ceil((30000 - (Date.now() - e.lastSent)) / 1000);
      if (wait > 0) return json(res, 429, { error: `Wait ${wait}s before requesting another code.`, wait });
      if (e.sends >= 3) { pending.delete(e.id); return json(res, 429, { error: 'Too many codes requested. Sign in again.', expired: true }); }
      try { await issueCode(e); } catch (err) { console.error('Mail error:', err.message); return json(res, 502, { error: 'Could not send the verification email.' }); }
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/verify') {
      if (limited('verify:' + ip, 20, 15 * 60000)) return json(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
      const b = await readBody(req);
      const e = pending.get(String(b.pending || ''));
      if (!e || e.expires < Date.now()) { if (e) pending.delete(e.id); return json(res, 400, { error: 'That code expired. Sign in again.', expired: true }); }
      if (++e.attempts > 5) { pending.delete(e.id); audit('code_locked', 'Too many wrong codes', ip); return json(res, 429, { error: 'Too many wrong codes. Sign in again.', expired: true }); }
      const code = String(b.code || '').replace(/\D/g, '');
      if (!safeEq(hmac(e.id + ':' + code), e.codeHash)) { audit('code_failed', 'Wrong verification code', ip); return json(res, 401, { error: `Wrong code. ${5 - e.attempts} tries left.` }); }
      pending.delete(e.id);
      newSession(res);
      audit('login', 'Signed in', ip);
      return json(res, 200, { ok: true });
    }

    /* ---- everything below needs a session ---- */
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: 'Not signed in' });

    if (method === 'GET' && p === '/api/session') return json(res, 200, { email: maskEmail(cfg.admin.email) });
    if (method === 'GET' && p === '/api/info') return json(res, 200, { name: cfg.serverName || 'Cake SMP', address: cfg.publicAddress || '', email: maskEmail(cfg.admin.email), canStart: !!cfg.startCommand, canRestart: !!cfg.restartCommand, storage: STORAGE });
    if (method === 'POST' && p === '/api/logout') {
      sessions.delete(sess.token); audit('logout', 'Signed out', ip);
      res.setHeader('Set-Cookie', 'cake_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      sse(res, 'history', ring);
      sse(res, 'stats', await snapshot());
      clients.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 25000);
      req.on('close', () => { clearInterval(hb); clients.delete(res); });
      return;
    }

    if (method === 'POST' && p === '/api/command') {
      const b = await readBody(req);
      const cmd = String(b.command || '').replace(/[\r\n]+/g, ' ').trim().replace(/^\/+/, '');
      if (!cmd || cmd.length > 1000) return json(res, 400, { error: 'Enter a command (max 1000 characters).' });
      audit('command', cmd, ip);
      try { return json(res, 200, { output: await rcon.exec(cmd) }); }
      catch (e) { return json(res, 502, { error: 'Server did not answer over RCON: ' + e.message }); }
    }

    if (method === 'POST' && p === '/api/power') {
      const { action } = await readBody(req);
      audit('power', String(action), ip);
      const launch = (command) => { spawn(command, { shell: true, cwd: ROOT, detached: true, stdio: 'ignore' }).unref(); };
      if (action === 'stop') {
        try { await rcon.exec('stop'); return json(res, 200, { message: 'Stop signal sent. The server is saving and shutting down.' }); }
        catch (e) { return json(res, 502, { error: 'Could not reach the server: ' + e.message }); }
      }
      if (action === 'start') {
        if (!cfg.startCommand) return json(res, 400, { error: 'Set "startCommand" in config.json to enable Start.' });
        launch(cfg.startCommand); return json(res, 200, { message: 'Start command launched.' });
      }
      if (action === 'restart') {
        if (!cfg.restartCommand) return json(res, 400, { error: 'Set "restartCommand" in config.json to enable Restart.' });
        launch(cfg.restartCommand); return json(res, 200, { message: 'Restart command launched.' });
      }
      return json(res, 400, { error: 'Unknown action' });
    }

    if (method === 'GET' && p === '/api/files') {
      const { rel, entries } = await listDir(url.searchParams.get('path'));
      return json(res, 200, { path: rel, entries });
    }
    if (method === 'GET' && p === '/api/file') {
      const { rel, content, size } = await readTextFile(url.searchParams.get('path'));
      return json(res, 200, { path: rel, content, size });
    }
    if (method === 'PUT' && p === '/api/file') {
      const b = await readBody(req);
      if (typeof b.content !== 'string' || b.content.length > MB) return json(res, 400, { error: 'Content must be text under 1 MB.' });
      const rel = await writeTextFile(b.path, b.content);
      audit('file_saved', rel, ip);
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && p === '/api/plugins') return json(res, 200, { plugins: await listPlugins() });
    if (method === 'GET' && p === '/api/activity') return json(res, 200, { entries: activity.slice().reverse() });

    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    return json(res, 500, { error: 'Server error' });
  }
});

/* ───────────── start ───────────── */
(async () => {
  await initLog();
  setInterval(pollLog, 400);
  setInterval(async () => { if (clients.size) broadcast('stats', await snapshot()); }, 2000);
  setInterval(pollPlayers, 5000);
  pollPlayers();
  server.listen(PORT, HOST, () => {
    console.log(`\n  🍰  ${cfg.serverName || 'Cake SMP'} console → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (STORAGE === 'sftp') {
      console.log(`      Files & log over SFTP: ${cfg.sftp?.username || '?'}@${cfg.sftp?.host || '?'}:${cfg.sftp?.port || 22}`);
      if (!SftpClient) console.log('      ! ssh2-sftp-client is missing – run "npm install" first, or files/log cannot be read');
      if (!cfg.sftp?.host || String(cfg.sftp.host).startsWith('CHANGE_ME')) console.log('      ! Set sftp.host, sftp.username and sftp.password in config.json (Folium panel → Settings → Launch SFTP)');
    } else {
      console.log(`      Minecraft folder: ${ROOT}`);
    }
    if (!cfg.printCodeToConsole && !nodemailer) console.log('      ! nodemailer is missing – run "npm install" first, otherwise the verification email cannot be sent');
    if (String(cfg.rcon?.password || '').startsWith('CHANGE_ME')) console.log('      ! Set rcon.password in config.json (same as rcon.password in server.properties)');
    if (!cfg.printCodeToConsole && String(cfg.smtp?.pass || '').startsWith('PASTE_')) console.log('      ! Set smtp.pass (Gmail app password) in config.json or sign-in emails cannot be sent');
    if (HOST !== '127.0.0.1' && !cfg.secureCookies) console.log('      ! Exposed on the network without HTTPS – put it behind an HTTPS reverse proxy and set "secureCookies": true');
    console.log('');
  });
})();
