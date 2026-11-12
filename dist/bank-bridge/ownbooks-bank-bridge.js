#!/usr/bin/env node
/* =====================================================================
   OwnBooks Bank Bridge — runs on YOUR computer only (127.0.0.1).
   - Holds your bank-connection keys in a private file in your home folder.
   - Fetches transactions from Plaid or SimpleFIN and hands them to the
     OwnBooks app on this computer. Nothing is stored on any OwnBooks server
     (there isn't one). No dependencies: needs Node.js 18+.
   Run:  node ownbooks-bank-bridge.js     then open http://127.0.0.1:8765
   ===================================================================== */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const VERSION = '1.0.0';
const PORT = +process.env.OWNBOOKS_PORT || 8765;
const DATA = process.env.OWNBOOKS_BRIDGE_FILE || path.join(os.homedir(), '.ownbooks-bridge.json');
const PLAID_HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const PLAID_OVERRIDE = process.env.OWNBOOKS_PLAID_HOST || ''; // for testing only
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

if (typeof fetch !== 'function') { console.error('Node.js 18 or newer is required (https://nodejs.org).'); process.exit(1); }

/* ---------- private local state ---------- */
function load() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch { return { key: crypto.randomBytes(24).toString('hex'), plaid: { env: 'sandbox' }, items: {} }; }
}
let st = load();
function persist() { fs.writeFileSync(DATA, JSON.stringify(st, null, 1), { mode: 0o600 }); try { fs.chmodSync(DATA, 0o600); } catch { } }
persist();

/* ---------- encrypted vault for bank usernames & passwords ----------
   AES-256-GCM, key derived from YOUR master password with scrypt. The master
   password is never written to disk; it is held in memory and auto-locks. */
const bankLogin = require('./bank-login.js');
let vaultKey = null, lockTimer = null;
const LOCK_MINUTES = 30;
function touchVault() { clearTimeout(lockTimer); lockTimer = setTimeout(() => { vaultKey = null; }, LOCK_MINUTES * 60e3); }
function enc(text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', vaultKey, iv); const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]); return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }; }
function dec(o) { const d = crypto.createDecipheriv('aes-256-gcm', vaultKey, Buffer.from(o.iv, 'base64')); d.setAuthTag(Buffer.from(o.tag, 'base64')); return Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8'); }
const derive = (pass, salt) => crypto.scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
function needVault() { if (!vaultKey) { const e = new Error('Your bank logins are locked. Enter your OwnBooks master password.'); e.code = 'VAULT_LOCKED'; throw e; } touchVault(); }
const hint = u => u ? (u.length > 4 ? '•••' + u.slice(-3) : '•••') : '';
function publicProfiles() { return Object.entries(st.profiles || {}).map(([id, p]) => ({ id, name: p.name, loginUrl: p.loginUrl, userHint: p.userHint || '', hasPassword: !!p.pwd, steps: (p.recipe || []).length, headless: !!p.headless, lastRun: p.lastRun || '', lastResult: p.lastResult || '' })); }

/* ---------- find the app file to serve ---------- */
function appFile() {
  for (const p of [path.join(__dirname, 'OwnBooks.html'), path.join(__dirname, '..', 'OwnBooks.html'), path.join(__dirname, '..', 'dist', 'OwnBooks.html')]) if (fs.existsSync(p)) return p;
  return null;
}

/* ---------- providers ---------- */
async function plaid(ep, body) {
  const c = st.plaid || {}; if (!c.clientId || !c.secret) throw new Error('Plaid keys are not set yet. Enter your Plaid client ID and secret in OwnBooks → Banking → Bank connections.');
  const host = PLAID_OVERRIDE || PLAID_HOSTS[c.env] || PLAID_HOSTS.sandbox;
  const r = await fetch(host + ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: c.clientId, secret: c.secret, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.display_message || j.error_message || j.error_code || `Plaid error ${r.status}`); e.code = j.error_code; throw e; }
  return j;
}
const plaidAcct = a => ({ id: a.account_id, name: a.official_name || a.name, mask: a.mask || '', type: a.type, subtype: a.subtype, balance: a.balances?.current ?? null, currency: a.balances?.iso_currency_code || '' });
const plaidTx = t => ({ provider: 'plaid', id: t.transaction_id, accountId: t.account_id, date: t.date, desc: t.merchant_name || t.name || '', memo: t.merchant_name && t.name !== t.merchant_name ? t.name : '', amount: -Number(t.amount), pending: !!t.pending });

function sfinSplit(accessUrl) {
  const u = new URL(accessUrl); const auth = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64');
  u.username = ''; u.password = ''; return { base: u.toString().replace(/\/$/, ''), auth };
}
async function sfinAccounts(item, startDate, balancesOnly) {
  const { base, auth } = sfinSplit(item.accessUrl); const q = new URLSearchParams();
  if (startDate) q.set('start-date', String(Math.floor(new Date(startDate + 'T00:00:00Z') / 1000)));
  if (balancesOnly) q.set('balances-only', '1');
  const r = await fetch(`${base}/accounts?${q}`, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`SimpleFIN error ${r.status}${r.status === 403 ? ' (access revoked — reconnect)' : ''}`);
  return r.json();
}
const sfinDate = s => new Date(Number(s) * 1000).toISOString().slice(0, 10);

/* ---------- API ---------- */
const routes = {
  'GET /status': async () => ({
    ok: true, bankLogin: bankLogin.available(), vault: { exists: !!st.vault, unlocked: !!vaultKey }, profiles: publicProfiles(), version: VERSION, dataFile: DATA, plaidConfigured: !!(st.plaid?.clientId && st.plaid?.secret), plaidEnv: st.plaid?.env || 'sandbox', redirectUri: st.plaid?.redirectUri || '',
    browserProfile: bankLogin.PROFILE_DIR,
    items: Object.entries(st.items).map(([id, it]) => ({ id, provider: it.provider, institution: it.institution || '', created: it.created }))
  }),
  'POST /config/plaid': async b => {
    st.plaid = { clientId: (b.clientId || st.plaid?.clientId || '').trim(), secret: (b.secret || st.plaid?.secret || '').trim(), env: b.env === 'production' ? 'production' : 'sandbox', redirectUri: (b.redirectUri || '').trim() };
    persist(); return { ok: true };
  },
  'POST /plaid/link-token': async b => {
    const body = { user: { client_user_id: 'ownbooks-local-' + st.key.slice(0, 8) }, client_name: 'OwnBooks', country_codes: ['CA', 'US'], language: 'en' };
    if (st.plaid.redirectUri) body.redirect_uri = st.plaid.redirectUri;
    if (b.itemId) { const it = st.items[b.itemId]; if (!it) throw new Error('Unknown connection'); body.access_token = it.accessToken; } // update / re-login mode
    else { body.products = ['transactions']; body.transactions = { days_requested: 730 }; }
    const j = await plaid('/link/token/create', body); return { link_token: j.link_token };
  },
  'POST /plaid/exchange': async b => {
    const j = await plaid('/item/public_token/exchange', { public_token: b.public_token });
    st.items[j.item_id] = { provider: 'plaid', accessToken: j.access_token, institution: b.institution || 'Bank', created: new Date().toISOString() }; persist();
    const a = await plaid('/accounts/get', { access_token: j.access_token });
    return { itemId: j.item_id, accounts: a.accounts.map(plaidAcct) };
  },
  'POST /simplefin/claim': async b => {
    let claimUrl; try { claimUrl = Buffer.from(String(b.setupToken || '').trim(), 'base64').toString('utf8'); new URL(claimUrl); } catch { throw new Error('That is not a valid SimpleFIN setup token.'); }
    const r = await fetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
    if (!r.ok) throw new Error(`Could not claim token (${r.status}). Tokens can only be used once — create a new one.`);
    const accessUrl = (await r.text()).trim(); const id = 'sfin_' + crypto.createHash('sha256').update(accessUrl).digest('hex').slice(0, 16);
    st.items[id] = { provider: 'simplefin', accessUrl, institution: b.institution || 'SimpleFIN', created: new Date().toISOString() }; persist();
    return { itemId: id };
  },
  'POST /accounts': async b => {
    const it = st.items[b.itemId]; if (!it) throw new Error('Unknown connection');
    if (it.provider === 'plaid') return { accounts: (await plaid('/accounts/get', { access_token: it.accessToken })).accounts.map(plaidAcct) };
    const j = await sfinAccounts(it, null, true);
    return { accounts: (j.accounts || []).map(a => ({ id: a.id, name: a.name, mask: '', type: '', subtype: '', institution: a.org?.name || '', balance: a.balance != null ? Number(a.balance) : null, currency: a.currency || '' })), errors: j.errors || [] };
  },
  'POST /sync': async b => {
    const it = st.items[b.itemId]; if (!it) throw new Error('Unknown connection');
    if (it.provider === 'plaid') {
      let cursor = b.cursor || '', added = [], modified = [], removed = [], more = true, guard = 0;
      while (more && guard++ < 50) {
        const j = await plaid('/transactions/sync', { access_token: it.accessToken, cursor: cursor || undefined, count: 500 });
        added.push(...j.added.map(plaidTx)); modified.push(...j.modified.map(plaidTx)); removed.push(...j.removed.map(r => 'plaid:' + r.transaction_id));
        cursor = j.next_cursor; more = j.has_more;
      }
      return { added, modified, removed, cursor };
    }
    const j = await sfinAccounts(it, b.startDate || null, false); const added = [];
    for (const a of j.accounts || []) for (const t of a.transactions || []) added.push({ provider: 'sfin', id: t.id, accountId: a.id, date: sfinDate(t.transacted_at || t.posted), desc: t.payee || t.description || '', memo: t.payee && t.description !== t.payee ? t.description : (t.memo || ''), amount: Number(t.amount), pending: !!t.pending || t.posted === 0 });
    return { added, modified: [], removed: [], cursor: '', errors: j.errors || [] };
  },
  'POST /vault/unlock': async b => {
    const pass = String(b.passphrase || '');
    if (!st.vault) {
      if (pass.length < 8) throw new Error('Choose a master password of at least 8 characters.');
      const salt = crypto.randomBytes(16); vaultKey = derive(pass, salt); st.vault = { salt: salt.toString('base64'), check: enc('ownbooks-vault') }; persist(); touchVault(); return { ok: true, created: true };
    }
    const key = derive(pass, Buffer.from(st.vault.salt, 'base64')); const prev = vaultKey; vaultKey = key;
    try { if (dec(st.vault.check) !== 'ownbooks-vault') throw 0; } catch { vaultKey = prev; await new Promise(r => setTimeout(r, 1200)); throw new Error('That master password is not right.'); }
    touchVault(); return { ok: true };
  },
  'POST /vault/lock': async () => { vaultKey = null; return { ok: true }; },
  'POST /vault/reset': async () => { st.vault = null; vaultKey = null; for (const p of Object.values(st.profiles || {})) { delete p.pwd; delete p.user; p.userHint = ''; } persist(); return { ok: true }; },
  'POST /profiles/save': async b => {
    needVault(); st.profiles = st.profiles || {};
    const id = b.id && st.profiles[b.id] ? b.id : 'bank_' + crypto.randomBytes(6).toString('hex'); const p = st.profiles[id] || { created: new Date().toISOString() };
    let u; try { u = new URL(String(b.loginUrl || '').trim()); } catch { throw new Error('Enter the full web address of your bank\'s sign-in page (starting with https://).'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('The sign-in address must start with https://');
    p.name = String(b.name || u.hostname).trim(); p.loginUrl = u.toString(); p.headless = !!b.headless;
    if (b.username) { p.user = enc(b.username); p.userHint = hint(String(b.username)); }
    if (b.password) p.pwd = enc(b.password);
    if (b.selectors) p.selectors = b.selectors;
    if (!p.user || !p.pwd) throw new Error('Enter both your username and password.');
    st.profiles[id] = p; persist(); return { id };
  },
  'POST /profiles/delete': async b => { if (st.profiles) delete st.profiles[b.id]; persist(); return { ok: true }; },
  'POST /profiles/forget-steps': async b => { const p = st.profiles?.[b.id]; if (p) { p.recipe = []; persist(); } return { ok: true }; },
  'POST /bank-login/start': async b => {
    needVault(); const p = st.profiles?.[b.id]; if (!p) throw new Error('Unknown bank login');
    const creds = { username: dec(p.user), password: dec(p.pwd) };
    p.lastRun = new Date().toISOString(); persist();
    return bankLogin.start(b.id, p, creds, { teach: !!b.teach }, { saveRecipe: async steps => { p.recipe = steps; persist(); } });
  },
  'GET /bank-login/job': async b => { const j = bankLogin.getJob(b.id); if (!j) throw new Error('Unknown job'); const p = st.profiles?.[j.profileId]; if (p && j.state !== 'running' && j.state !== 'waiting' && p.lastResult !== j.message) { p.lastResult = j.message; persist(); } return j; },
  'POST /bank-login/stop': async b => bankLogin.stop(b.id),
  'POST /remove': async b => {
    const it = st.items[b.itemId]; if (!it) return { ok: true };
    if (it.provider === 'plaid') { try { await plaid('/item/remove', { access_token: it.accessToken }); } catch (e) { console.warn('Plaid remove:', e.message); } }
    delete st.items[b.itemId]; persist(); return { ok: true };
  }
};

/* ---------- server ---------- */
function send(res, code, obj, headers = {}) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); }
const server = http.createServer(async (req, res) => {
  // DNS-rebinding protection: only answer requests addressed to this machine.
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) { res.writeHead(403); return res.end('Forbidden host'); }
  const origin = req.headers.origin; const self = `http://${req.headers.host}`;
  const cors = origin && origin !== self ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'content-type,x-ownbooks-key', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Private-Network': 'true' } : {};
  const url = new URL(req.url, self);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  // Serve the app itself (so Plaid Link runs on a proper http://localhost origin).
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/oauth')) {
    const f = appFile(); if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Put OwnBooks.html next to this bridge (or in the parent folder).'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return fs.createReadStream(f).pipe(res);
  }
  // Pairing: only the page served by this bridge (same origin) may read the key automatically.
  if (req.method === 'GET' && url.pathname === '/pair') {
    const sameOrigin = (!origin || origin === self) && (req.headers['sec-fetch-site'] ? req.headers['sec-fetch-site'] === 'same-origin' : true);
    return sameOrigin ? send(res, 200, { key: st.key }) : send(res, 403, { error: 'Pairing is only allowed from the app opened at ' + self }, cors);
  }
  const fn = routes[`${req.method} ${url.pathname}`];
  if (!fn) return send(res, 404, { error: 'Not found' }, cors);
  const k = req.headers['x-ownbooks-key'] || '';
  if (k.length !== st.key.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(st.key))) return send(res, 401, { error: 'Bridge key missing or wrong. Paste the key shown in the bridge window into OwnBooks.' }, cors);
  let body = {};
  if (req.method === 'POST') { let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) return send(res, 413, { error: 'Too large' }, cors); } try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'Bad JSON' }, cors); } }
  if (req.method === 'GET') body = Object.fromEntries(url.searchParams);
  try { send(res, 200, await fn(body), cors); }
  catch (e) { console.error(`[${new Date().toLocaleTimeString()}] ${url.pathname}:`, e.message); send(res, 502, { error: e.message, code: e.code || '' }, cors); }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  OwnBooks Bank Bridge ${VERSION} is running — only reachable from this computer.\n`);
  console.log(`  Open your books:   http://127.0.0.1:${PORT}`);
  console.log(`  Bridge key:        ${st.key}   (only needed if you open OwnBooks.html another way)`);
  console.log(`  Private key file:  ${DATA}\n`);
  console.log('  Leave this window open while syncing. Close it (Ctrl+C) any time — your books stay in the app.\n');
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use — the bridge may already be running.` : e.message); process.exit(1); });
