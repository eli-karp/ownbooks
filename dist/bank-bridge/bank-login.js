'use strict';
/* =====================================================================
   OwnBooks — sign in to your bank with your own username & password.
   Runs ONLY on your computer, in a real Chrome/Edge window you can see.
   1. Opens your bank's sign-in page and fills in your saved username/password.
   2. You answer any security question / one-time code the bank asks for.
   3. First time: you show OwnBooks where "Download transactions" is (it records
      the clicks — never what you type). Every time after: it repeats them and
      captures the OFX/QFX/CSV file the bank gives you.
   It uses a dedicated browser profile so the bank remembers this device.
   ===================================================================== */
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

let pw = null;
function lib() {
  if (pw) return pw;
  try { pw = require('playwright-core'); }
  catch (e) { throw new Error('The bank sign-in helper is not installed yet. Close the bridge and start it again while connected to the internet (it installs itself), or run "npm install" in the bank-bridge folder.'); }
  return pw;
}
function available() { try { lib(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } }

const PROFILE_DIR = process.env.OWNBOOKS_BROWSER_PROFILE || path.join(os.homedir(), '.ownbooks-bank-browser');
const DOWNLOADS_DIR = PROFILE_DIR + '-downloads'; // private; each statement file is deleted right after OwnBooks reads it
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function launch(headless) {
  const { chromium } = lib();
  const args = (process.env.OWNBOOKS_BROWSER_ARGS || '').split(' ').filter(Boolean);
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true, mode: 0o700 });
  const base = { headless, acceptDownloads: true, downloadsPath: DOWNLOADS_DIR, viewport: null, args };
  const exe = process.env.OWNBOOKS_CHROME_PATH;
  const tries = exe ? [{ executablePath: exe }] : [{ channel: 'chrome' }, { channel: 'msedge' }, { channel: 'chromium' }];
  let last;
  for (const t of tries) { try { return await chromium.launchPersistentContext(PROFILE_DIR, { ...base, ...t }); } catch (e) { last = e; } }
  const msg = String(last && last.message || '');
  if (/ProcessSingleton|SingletonLock|profile.*in use/i.test(msg)) throw new Error('The OwnBooks bank window is already open. Close it and try again.');
  throw new Error('Could not open Google Chrome or Microsoft Edge on this computer. Install one of them and try again.');
}

/* ---------- script injected into bank pages: on-screen banner + click recorder ---------- */
const INIT = `(() => {
  if (window.__obInit) return; window.__obInit = true;
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const idOk = id => id && !/\\d{4,}|[0-9a-f]{8,}/i.test(id);
  const cssPath = el => { const parts = []; while (el && el.nodeType === 1 && parts.length < 6 && el !== document.body) { let s = el.tagName.toLowerCase();
    if (idOk(el.id)) { parts.unshift(s + '[id="' + el.id.replace(/"/g, '\\\\"') + '"]'); break; }
    const sib = el.parentElement ? [...el.parentElement.children].filter(c => c.tagName === el.tagName) : [];
    if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')'; parts.unshift(s); el = el.parentElement; } return parts.join(' > '); };
  const desc = el => ({ tag: el.tagName.toLowerCase(), id: idOk(el.id) ? el.id : '', name: el.getAttribute('name') || '', aria: el.getAttribute('aria-label') || '',
    text: el.tagName === 'INPUT' ? clean(el.value) : clean(el.innerText || el.title), href: el.tagName === 'A' ? (el.getAttribute('href') || '').split('?')[0].split(';')[0] : '', css: cssPath(el) });
  const sensitive = el => el.type === 'password' || (el.closest('form') && el.closest('form').querySelector('input[type=password]'));
  document.addEventListener('click', e => {
    if (!window.__ownbooksRec || e.target.closest('#__ownbooks_banner')) return;
    const el = e.target.closest('a,button,input[type=button],input[type=submit],input[type=radio],input[type=checkbox],[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=radio],label,li,td') || e.target;
    if (sensitive(el) || (el.tagName === 'INPUT' && !['button', 'submit', 'radio', 'checkbox'].includes(el.type))) return; // never record typing fields
    window.__ownbooksRec({ action: 'click', ...desc(el) });
  }, true);
  document.addEventListener('change', e => { const el = e.target; if (!window.__ownbooksRec || el.tagName !== 'SELECT' || sensitive(el)) return;
    const o = el.options[el.selectedIndex]; window.__ownbooksRec({ action: 'select', ...desc(el), text: '', option: o ? o.text.trim() : '', value: el.value }); }, true);
})();`;
async function banner(page, msg, button) {
  if (!page || page.isClosed()) return;
  await page.evaluate(([m, b]) => {
    let d = document.getElementById('__ownbooks_banner');
    if (!d) { d = document.createElement('div'); d.id = '__ownbooks_banner'; d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#1f6f50;color:#fff;font:15px/1.4 system-ui,sans-serif;padding:10px 16px;box-shadow:0 -2px 10px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center'; (document.body || document.documentElement).appendChild(d); }
    d.innerHTML = ''; const t = document.createElement('span'); t.style.flex = '1'; t.textContent = 'OwnBooks: ' + m; d.appendChild(t);
    if (b) { const btn = document.createElement('button'); btn.textContent = b; btn.style.cssText = 'font:inherit;font-weight:600;background:#fff;color:#1f6f50;border:0;border-radius:8px;padding:8px 14px;cursor:pointer'; btn.onclick = () => window.__ownbooksSignedIn && window.__ownbooksSignedIn(); d.appendChild(btn); }
  }, [msg, button || '']).catch(() => { });
}

/* ---------- element finding ---------- */
async function firstVisible(loc, editable) {
  const n = Math.min(await loc.count().catch(() => 0), 12);
  for (let i = 0; i < n; i++) { const el = loc.nth(i); if (await el.isVisible().catch(() => false) && (!editable || await el.isEditable().catch(() => false))) return el; }
  return null;
}
const USER_SELS = ['input[autocomplete="username"]', 'input[type="email"]', 'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="card" i]', 'input[id*="card" i]',
  'input[name*="client" i]', 'input[id*="client" i]', 'input[name*="login" i]', 'input[id*="login" i]', 'input[name*="access" i]', 'input[type="tel"]', 'input[type="text"]', 'input:not([type])'];
async function findUser(frame, custom) {
  for (const s of custom ? [custom] : USER_SELS) { const el = await firstVisible(frame.locator(s + ':not([name*="search" i]):not([id*="search" i])'), true); if (el) return el; }
  return null;
}
async function typeInto(el, text) {
  await el.click({ timeout: 5000 }).catch(() => { });
  await el.fill('');
  await el.pressSequentially(text, { delay: 40 });
  if ((await el.inputValue().catch(() => text)) !== text) await el.fill(text);
}
async function submit(frame, el, custom) {
  await el.press('Enter').catch(() => { });
  await sleep(2500);
  if (await el.isVisible().catch(() => false) && (await el.inputValue().catch(() => '')) !== '') {
    const btn = custom ? await firstVisible(frame.locator(custom)) : (await firstVisible(frame.locator('button[type=submit], input[type=submit]')) ||
      await firstVisible(frame.getByRole('button', { name: /sign ?in|log ?in|login|continue|next|submit|connexion|se connecter|suivant|continuer/i })));
    if (btn) await btn.click({ timeout: 5000 }).catch(() => { });
  }
}

/* ---------- a sync job ---------- */
const jobs = new Map(); let running = null;
function publicJob(j) { return { id: j.id, profileId: j.profileId, state: j.state, message: j.message, teach: j.teach, files: j.files, log: j.log.slice(-30), learned: j.learned }; }
function getJob(id) { const j = jobs.get(id); return j ? publicJob(j) : null; }
function stop(id) { const j = jobs.get(id); if (j && j.ctx) j.ctx.close().catch(() => { }); return { ok: true }; }

function start(profileId, profile, creds, opts, hooks) {
  if (running && jobs.get(running) && ['running', 'waiting'].includes(jobs.get(running).state)) throw new Error('A bank sign-in window is already open. Finish or close it first.');
  const recipe = profile.recipe || [];
  const job = { id: 'job_' + crypto.randomBytes(5).toString('hex'), profileId, state: 'running', message: 'Opening the bank window…', log: [], files: [], steps: [], recipeEnd: 0,
    teach: !!opts.teach || !recipe.length, loggedIn: false, pendingDl: 0, learned: 0, headless: !!profile.headless && !opts.teach && recipe.length > 0 };
  jobs.set(job.id, job); running = job.id;
  run(job, profile, creds, recipe, hooks).catch(e => { job.state = 'error'; say(job, e.message); })
    .finally(async () => { if (job.ctx) await job.ctx.close().catch(() => { }); if (job.state === 'running' || job.state === 'waiting') job.state = 'done'; creds.password = ''; });
  return publicJob(job);
}
function say(job, m, button) { job.message = m; job.log.push(new Date().toLocaleTimeString() + ' ' + m); job.button = button || ''; banner(job.page, m, job.button); }

async function run(job, profile, creds, recipe, hooks) {
  const ctx = await launch(job.headless); job.ctx = ctx;
  await ctx.exposeBinding('__ownbooksRec', (_src, step) => { if (job.teach && job.loggedIn) job.steps.push(step); });
  await ctx.exposeBinding('__ownbooksSignedIn', () => { if (!job.loggedIn) { job.loggedIn = true; say(job, 'Recording. Go to your account activity and click Download / Export (pick OFX, QFX or CSV). Do it for each account you want. Close this window when you are done.'); } });
  await ctx.addInitScript(INIT);
  const wire = p => { job.page = p; p.on('load', () => banner(p, job.message, job.button)); p.on('download', d => onDownload(job, d)); p.on('close', () => { const ps = ctx.pages(); if (job.page === p && ps.length) job.page = ps[ps.length - 1]; }); };
  ctx.pages().forEach(wire); ctx.on('page', wire);
  const closed = new Promise(r => ctx.on('close', r));
  const page = ctx.pages()[0] || await ctx.newPage(); job.page = page;
  say(job, 'Opening ' + profile.name + '…');
  await page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await autoLogin(job, creds, profile.selectors || {}, recipe);
  creds.password = '';

  if (job.teach) {
    if (!job.loggedIn) say(job, 'Finish signing in (answer any security question or code). When you can see your accounts, click the button →', "I'm signed in — start");
    await closed;
    if (job.recipeEnd) { job.learned = job.recipeEnd; await hooks.saveRecipe(job.steps.slice(0, job.recipeEnd)); }
    job.state = 'done'; job.message = job.files.length ? `Captured ${job.files.length} file(s)` + (job.learned ? ` and learned ${job.learned} steps — next time it's automatic.` : '.') : 'Window closed — no transactions were downloaded.';
    return;
  }
  say(job, 'Signing in… if the bank asks for a security code, enter it in this window. OwnBooks will continue by itself.');
  const ok = await replay(job, recipe);
  await waitDownloads(job);
  if (!ok || !job.files.length) {
    if (job.headless) throw new Error('The bank needed attention (security check or a changed page). Untick "run hidden" and sync again.');
    job.state = 'waiting';
    say(job, "The bank's website changed or needs you. Please download the file yourself (OFX, QFX or CSV), then close this window. Tip: use \"Teach again\" in OwnBooks to update the steps.");
    await closed; job.state = 'done'; job.message = job.files.length ? `Captured ${job.files.length} file(s).` : 'Window closed — nothing downloaded.'; return;
  }
  say(job, `Done — captured ${job.files.length} file(s). Closing…`); await sleep(1500);
  await ctx.close().catch(() => { }); job.state = 'done';
}

async function onDownload(job, d) {
  job.pendingDl++; job.lastDl = Date.now();
  await sleep(400); if (job.teach && job.loggedIn) job.recipeEnd = job.steps.length;
  try {
    const p = await d.path(); const buf = fs.readFileSync(p); const name = d.suggestedFilename();
    try { fs.unlinkSync(p); } catch { }
    if (buf.length > 8e6 || buf.includes(0)) say(job, `"${name}" isn't a CSV, OFX or QFX file. Please choose one of those formats.`, job.button);
    else { job.files.push({ name, text: buf.toString('utf8') }); say(job, `Got "${name}".` + (job.teach ? ' Download other accounts too, or close this window when done.' : ''), job.button); }
  } catch (e) { say(job, 'Download failed: ' + e.message); }
  finally { job.pendingDl--; }
}
async function waitDownloads(job) { const end = Date.now() + 60000; await sleep(3000); while (Date.now() < end && (job.pendingDl > 0 || Date.now() - (job.lastDl || 0) < 2500)) await sleep(500); }

async function autoLogin(job, c, sel, recipe) {
  const t0 = Date.now(); let userDone = false, seenForm = false, nag = false;
  while (Date.now() - t0 < 300000) {
    const page = job.page; if (!page || page.isClosed()) throw new Error('The bank window was closed.');
    if (job.loggedIn) return;
    for (const f of page.frames()) {
      const pass = await firstVisible(f.locator(sel.pass || 'input[type="password"]'), true);
      if (pass) {
        seenForm = true;
        if (!userDone && c.username) { const u = await findUser(f, sel.user); if (u) { const v = await u.inputValue().catch(() => ''); if (!v || (!/[*•]/.test(v) && v !== c.username)) await typeInto(u, c.username); } }
        say(job, 'Signing in…'); await typeInto(pass, c.password); await submit(f, pass, sel.submit); return;
      }
    }
    if (!userDone) for (const f of page.frames()) {
      const u = await findUser(f, sel.user);
      if (u && c.username) { seenForm = true; const v = await u.inputValue().catch(() => ''); if (!/[*•]/.test(v)) await typeInto(u, c.username); userDone = true; say(job, 'Signing in…'); await submit(f, u, sel.submit); break; }
    }
    if (!seenForm && Date.now() - t0 > 15000) {
      if (recipe.length && await findStep(job, recipe, 0, 500)) return; // already signed in (bank remembered us)
      if (!nag) { nag = true; say(job, "Couldn't find the sign-in boxes yet. If this page has a \"Sign in\" button, click it.", job.teach ? "I'm signed in — start" : ''); }
    }
    await sleep(700);
  }
  throw new Error('Timed out waiting for the bank sign-in page.');
}

/* ---------- replay learned steps ---------- */
function locators(f, s) {
  const out = [], t = s.tag || '*';
  if (s.id) out.push(f.locator(`${t}[id="${q(s.id)}"]`));
  if (s.aria) out.push(f.locator(`${t}[aria-label="${q(s.aria)}"]`));
  if (s.name && /^(select|input|button)$/.test(t)) out.push(f.locator(`${t}[name="${q(s.name)}"]`));
  if (s.href && s.href.length > 1 && !/^(#|javascript)/i.test(s.href)) out.push(f.locator(`a[href^="${q(s.href)}"]`));
  if (s.text) {
    out.push(f.locator(t).filter({ hasText: new RegExp('^\\s*' + escRe(s.text) + '\\s*$', 'i') }));
    const words = s.text.replace(/[\d$€£.,*•#()\-]+/g, ' ').trim().split(/\s+/).filter(w => w.length > 1);
    if (words.join('').length >= 4) out.push(f.locator(t).filter({ hasText: new RegExp(words.map(escRe).join('.*'), 'i') }));
  }
  if (s.css) out.push(f.locator(s.css));
  return out;
}
async function locateStep(job, s) {
  const page = job.page; if (!page || page.isClosed()) return null;
  for (const f of page.frames()) for (const l of locators(f, s)) { const el = await firstVisible(l); if (el) return el; }
  return null;
}
async function findStep(job, recipe, i, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ahead = Date.now() - t0 > 8000 ? 3 : 0; // optional steps (e.g. a security prompt) may be skipped
    for (let k = i; k <= Math.min(i + ahead, recipe.length - 1); k++) { const el = await locateStep(job, recipe[k]); if (el) return { idx: k, el }; }
    await sleep(600);
  }
  return null;
}
async function replay(job, recipe) {
  let i = 0;
  while (i < recipe.length) {
    const found = await findStep(job, recipe, i, i === 0 ? (job.headless ? 90000 : 300000) : 45000);
    if (!found) return false;
    if (i === 0) say(job, 'Signed in. Getting your transactions…');
    i = found.idx; const s = recipe[i];
    try {
      if (s.action === 'select') await found.el.selectOption({ label: s.option }).catch(() => found.el.selectOption(s.value));
      else await found.el.click({ timeout: 10000 });
    } catch (e) { return false; }
    await job.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { });
    await sleep(1200); i++;
  }
  return true;
}

module.exports = { available, start, getJob, stop, PROFILE_DIR };
