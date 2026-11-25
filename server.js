// Zero-dependency Node server: static site + /api/generate (Gemini) with a free-tries gate.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env','utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const KEY = process.env.GEMINI_API_KEY;
const GROUND = process.env.GROUNDING === 'on'; // needs paid-tier Gemini billing
// Model chain: Google retires older models for new API keys (2.5 returns 404 "no longer available to new users"),
// so keep several current fallbacks and retry 503/429 (demand spikes) before moving on.
const MODELS = [...new Set([process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3-flash'])];
const FREE = Number(process.env.FREE_TRIES || 3);
const ADMIN = process.env.ADMIN_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);
const SB = process.env.SUPABASE_URL, SBK = process.env.SUPABASE_SERVICE_KEY, SBA = process.env.SUPABASE_ANON_KEY;
const sb = (p, o = {}) => fetch(SB + p, { ...o, headers: { apikey: SBK, ...(SBK && !SBK.startsWith('sb_') ? { Authorization: 'Bearer ' + SBK } : {}), 'Content-Type': 'application/json', ...(o.headers || {}) } });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT_LANGS = { ar: 'Arabic', en: 'English', fr: 'French', es: 'Spanish', de: 'German', tr: 'Turkish', it: 'Italian', pt: 'Portuguese' };

// Verify the Supabase session token sent by the browser and load the profile.
async function user(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return null;
  const r = await fetch(SB + '/auth/v1/user', { headers: { apikey: SBA, Authorization: 'Bearer ' + t } });
  if (!r.ok) return null;
  const au = await r.json();
  let p = (await (await sb(`/rest/v1/profiles?id=eq.${au.id}&select=*`)).json())[0];
  if (!p) { await sb('/rest/v1/profiles', { method: 'POST', body: JSON.stringify({ id: au.id, email: au.email }) }); p = { id: au.id, email: au.email, free_used: 0, plan: null, plan_until: null }; }
  p.active = !!(p.plan && p.plan_until && new Date(p.plan_until) > new Date());
  return p;
}
const meInfo = (p) => ({ email: p.email, ref: p.id.slice(0, 8).toUpperCase(), active: p.active, plan: p.active ? p.plan : null,
  daysLeft: p.active ? Math.ceil((new Date(p.plan_until) - Date.now()) / 864e5) : 0, planUntil: p.plan_until, left: p.active ? null : Math.max(0, FREE - p.free_used) });
// Safe JSON body reader: never throws inside an event handler (that used to crash the whole process), caps size at ~9MB (photo as base64).
const body = (req) => new Promise((resolve, reject) => { let b = '', n = 0, dead = false;
  req.on('data', (c) => { n += c.length; if (n > 9e6) { dead = true; reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); } else b += c; });
  req.on('end', () => { if (dead) return; try { const v = JSON.parse(b || '{}'); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { reject(Object.assign(new Error('bad_json'), { code: 400 })); } });
  req.on('error', () => { if (!dead) reject(Object.assign(new Error('bad_request'), { code: 400 })); }); });
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function generate({ name, details, lang, outLang, image }) {
  const L = OUT_LANGS[outLang] || (lang === 'en' ? 'English' : 'Arabic');
  const prompt = `You are an expert e-commerce SEO copywriter and market researcher.
Product: ${name}
Seller details: ${details}
${GROUND ? 'STEP 1: Use Google Search to research this product: real specs and facts, how top-ranking listings and competitors title and describe it, and what keywords buyers search for in the target market (Egypt / Arabic-speaking buyers when writing Arabic).\nSTEP 2: ' : ''}Write the listing in ${L} using SEO best practice for the market of that language and the seller details. Never invent specs that were not given; if unsure, leave them out.
Return ONLY a JSON object (no markdown fence) with keys: titles (3 SEO titles), description, bullets (5), keywords (10, ordered by search relevance), ads (2 short ready-to-post ads), research_notes (3 short lines on the SEO approach used).`;
  const parts = [{ text: prompt }];
  if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  // Search grounding cannot be combined with responseMimeType=json, so JSON is requested in the prompt and parsed below.
  let r;
  outer: for (const m of MODELS) {
    for (let a = 0; a < 3; a++) {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents: [{ parts }], ...(GROUND ? { tools: [{ google_search: {} }] } : { generationConfig: { responseMimeType: 'application/json' } }) }),
      });
      if (r.ok) break outer;
      const st = r.status;
      console.log('gemini', m, st, (await r.text()).slice(0, 300));
      if (st !== 503 && st !== 429) break; // hard failure (404 retired model, 400 bad request): next model
      await sleep(1500 * (a + 1)); // demand spike: wait and retry the same model
    }
  }
  if (!r.ok) throw new Error('gemini ' + r.status);
  const j = await r.json();
  const c = j.candidates[0];
  const text = c.content.parts.map((p) => p.text || '').join('');
  // Parse defensively; internal fields (research_notes, sources, searches) are never sent to the customer.
  let out;
  try { const m = /\{[\s\S]*\}/.exec(text); out = JSON.parse(m ? m[0] : text); } catch { out = { raw: text }; }
  if (!out || typeof out !== 'object' || Array.isArray(out)) out = { raw: text };
  delete out.research_notes; delete out.sources; delete out.searches;
  return out;
}

http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/visit' && req.method === 'POST') {
      const r = await sb('/rest/v1/rpc/increment_visit', { method: 'POST', body: '{}' });
      if (!r.ok) return send(res, 503, { error: 'counter_unavailable' });
      return send(res, 200, { visits: await r.json() });
    }
    if (req.url === '/api/me') { const p = await user(req); return p ? send(res, 200, meInfo(p)) : send(res, 401, { error: 'login_required' }); }
    if (req.url === '/api/generate' && req.method === 'POST') {
      const p = await user(req);
      if (!p) return send(res, 401, { error: 'login_required' });
      const inp = await body(req); // parse and validate BEFORE using up a free try
      inp.name = String(inp.name || '').trim().slice(0, 300); inp.details = String(inp.details || '').trim().slice(0, 3000);
      if (!inp.name) return send(res, 400, { error: 'name_required' });
      if (inp.image && (typeof inp.image.data !== 'string' || !/^image\//.test(String(inp.image.mime)))) delete inp.image;
      const left = await (await sb('/rest/v1/rpc/consume_try', { method: 'POST', body: JSON.stringify({ uid: p.id, free_limit: FREE }) })).json();
      if (left < 0) return send(res, 402, { error: 'free_tries_over' });
      try { const out = await generate(inp); return send(res, 200, { result: out, left: left === 9999 ? null : left }); }
      catch (e) { await sb('/rest/v1/rpc/refund_try', { method: 'POST', body: JSON.stringify({ uid: p.id }) }); throw e; }
    }
    // Which Gemini models this key can actually use (names only, no secrets).
    if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (req.url === '/api/models') {
      if (!ADMIN || req.headers['x-admin-token'] !== ADMIN) return send(res, 403, { error: 'forbidden' });
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': KEY } });
      const j = await r.json();
      if (!r.ok) return send(res, 502, { error: 'list_failed', status: r.status, detail: JSON.stringify(j).slice(0, 300) });
      return send(res, 200, (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name));
    }
    if (req.url === '/api/config') return send(res, 200, {
      whatsapp: process.env.WHATSAPP_NUMBER || 'WHATSAPP_NUMBER_PLACEHOLDER', // digits only, e.g. 2012XXXXXXXX
      paypal: process.env.PAYPAL_USERNAME || 'PAYPAL_USERNAME_PLACEHOLDER',
      orange: process.env.ORANGE_CASH_NUMBER || 'ORANGE_CASH_NUMBER_PLACEHOLDER',
      binance: process.env.BINANCE_PAY_ID || 'BINANCE_ID_PLACEHOLDER',
      plans: { monthly: 25, yearly: 228 }, supabaseUrl: SB, supabaseAnon: SBA });
    // Manual activation after you verify a payment: POST /api/admin/activate {token, email, plan}. Extends from current end date if still active.
    if (req.url === '/api/admin/activate' && req.method === 'POST') {
      const b = await body(req);
      if (!ADMIN || b.token !== ADMIN) return send(res, 403, { error: 'forbidden' });
      if (b.plan !== 'monthly' && b.plan !== 'yearly') return send(res, 400, { error: 'bad_plan' });
      const em = String(b.email || '').trim();
      if (!em) return send(res, 404, { error: 'user_not_found' });
      let p = (await (await sb(`/rest/v1/profiles?email=eq.${encodeURIComponent(em)}&select=*`)).json())[0];
      if (!p && em !== em.toLowerCase()) p = (await (await sb(`/rest/v1/profiles?email=eq.${encodeURIComponent(em.toLowerCase())}&select=*`)).json())[0];
      if (!p) return send(res, 404, { error: 'user_not_found' });
      const start = p.plan_until && new Date(p.plan_until) > new Date() ? new Date(p.plan_until) : new Date();
      const until = new Date(start.getTime() + (b.plan === 'yearly' ? 365 : 30) * 864e5).toISOString();
      await sb(`/rest/v1/profiles?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify({ plan: b.plan, plan_until: until }) });
      return send(res, 200, { ok: true, until });
    }
    const u = req.url.split('?')[0].split('#')[0];
    const f = path.join('public', u === '/' ? 'index.html' : path.normalize(u).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
    res.writeHead(404); res.end('not found');
  } catch (e) { if (!res.headersSent) send(res, e.code === 400 || e.code === 413 ? e.code : 500, { error: String(e.message) }); }
}).listen(PORT, () => console.log('http://localhost:' + PORT));
