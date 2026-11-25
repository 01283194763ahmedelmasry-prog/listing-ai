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

const cool = {}; // model -> time until which it is skipped after a 429/503
// One vision call per generation (max 2 attempts: second goes to the next model in the chain). Returns '' on failure so the flow continues.
async function analyzeImage(image) {
  const ask = `Look at this product photo as an e-commerce expert. Reply with ONLY a JSON object (no markdown) with keys: product_type (what the product is, e.g. smartphone, headphones, phone case; decide from its overall shape, screen, camera, buttons), name (brand and model if visible, including any printed text on the product or box. Text like "6 inch" on a phone is its screen size; empty string if not visible), visible_text (array of text strings you can read on the image), specs (array of specs visible or evident from the image: colors, screen shape, design, ports, accessories included), notes (one short line). Only report what is actually visible. Do not guess brand, model or numeric specs that are not shown.`;
  const vdeadline = Date.now() + 30000;
  for (const m of MODELS) { // one attempt per model (fallback on unavailable/quota), first success wins
    if ((cool[m] || 0) > Date.now()) continue;
    if (Date.now() > vdeadline) break;
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ contents: [{ parts: [{ text: ask }, { inline_data: { mime_type: image.mime, data: image.data } }] }], generationConfig: { responseMimeType: 'application/json' } }),
      });
      if (!r.ok) { if (r.status === 429 || r.status === 503 || r.status === 404) cool[m] = Date.now() + 60000; console.log('vision', m, r.status, (await r.text()).slice(0, 120)); continue; }
      const j = await r.json();
      const t = j.candidates[0].content.parts.map((p) => p.text || '').join('');
      const mm = /\{[\s\S]*\}/.exec(t); const a = JSON.parse(mm ? mm[0] : t);
      const L = (v) => (Array.isArray(v) ? v.join(', ') : String(v || '')).slice(0, 600);
      return [a.product_type && 'Product type: ' + L(a.product_type), a.name && 'Name/model seen: ' + L(a.name), a.visible_text && L(a.visible_text) && 'Text visible on image: ' + L(a.visible_text), a.specs && L(a.specs) && 'Visible specs: ' + L(a.specs), a.notes && 'Notes: ' + L(a.notes)].filter(Boolean).join('\n');
    } catch (e) { console.log('vision error', m, String(e.message).slice(0, 200)); }
  }
  return '';
}

async function generate({ name, details, lang, outLang, image }) {
  let analysis = '';
  if (image) analysis = await analyzeImage(image);
  if (analysis && !name) name = (/^Name\/model seen: (.+)$/m.exec(analysis) || [])[1] || (/^Product type: (.+)$/m.exec(analysis) || [])[1] || 'Product in the attached photo';
  const L = OUT_LANGS[outLang] || (lang === 'en' ? 'English' : 'Arabic');
  const prompt = `You are an expert e-commerce SEO copywriter and market researcher.
Product: ${name}
Seller details: ${details || '(none)'}
${analysis ? `Photo analysis (from the uploaded image, trustworthy for what is visible):\n${analysis}\nUse the photo analysis as the product name and details when the seller's name/details are empty or thin, and merge it with the seller's details when both exist (seller text wins on conflicts). The listing must name the actual product type, brand/model and visible specs/text from the image. Do not write generic filler.\n` : ''}${GROUND ? 'STEP 1: Use Google Search to research this product: real specs and facts, how top-ranking listings and competitors title and describe it, and what keywords buyers search for in the target market (Egypt / Arabic-speaking buyers when writing Arabic).\nSTEP 2: ' : ''}Write the listing in ${L} using SEO best practice for the market of that language and the seller details. Never invent specs that were not given; if unsure, leave them out.
Return ONLY a JSON object (no markdown fence) with keys: titles (3 SEO titles), description, bullets (5), keywords (10, ordered by search relevance), ads (2 short ready-to-post ads), research_notes (3 short lines on the SEO approach used).`;
  const parts = [{ text: prompt }];
  if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  // Search grounding cannot be combined with responseMimeType=json, so JSON is requested in the prompt and parsed below.
  let r;
  const deadline = Date.now() + 55000; // total server-side budget for the text generation
  outer: for (const m of MODELS) {
    if ((cool[m] || 0) > Date.now() && m !== MODELS[MODELS.length - 1]) continue;
    for (let a = 0; a < 2; a++) {
      if (Date.now() > deadline) break outer;
      try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ contents: [{ parts }], ...(GROUND ? { tools: [{ google_search: {} }] } : { generationConfig: { responseMimeType: 'application/json' } }) }),
      }); } catch (e) { console.log('gemini', m, 'fetch', String(e.message).slice(0, 100)); r = null; await sleep(500); continue; }
      if (r.ok) break outer;
      const st = r.status;
      if (st === 429 || st === 503) cool[m] = Date.now() + 60000;
      console.log('gemini', m, st, (await r.text()).slice(0, 120));
      if (st !== 503) break; // 429 = quota: retrying the same model is pointless // hard failure (404 retired model, 400 bad request): next model
      await sleep(1500 * (a + 1)); // demand spike: wait and retry the same model
    }
  }
  if (!r || !r.ok) throw new Error('gemini ' + (r ? r.status : 'timeout'));
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
      if (inp.image && (typeof inp.image.data !== 'string' || !/^image\//.test(String(inp.image.mime)))) delete inp.image;
      if (!inp.name && !inp.image) return send(res, 400, { error: 'name_required' });
      // Record what customers search for (owner reviews these in the admin panel). Never block or fail the request on this.
      const rowId = sb('/rest/v1/searches', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: p.id, email: p.email, name: inp.name || '(from image)', details: inp.details, out_lang: String(inp.outLang || inp.lang || '').slice(0, 10), has_image: !!inp.image }) }).then((r) => r.json()).then((a) => (a && a[0] ? a[0].id : null)).catch(() => null);
      // Never charge for a failed generation: only check here, consume after a successful result.
      if (!p.active && p.free_used >= FREE) return send(res, 402, { error: 'free_tries_over' });
      try {
        const out = await generate(inp);
        if (!out || (!out.titles && !out.description && !out.raw)) throw new Error('empty_result');
        const left = await (await sb('/rest/v1/rpc/consume_try', { method: 'POST', body: JSON.stringify({ uid: p.id, free_limit: FREE }) })).json();
        rowId.then((id) => id && sb('/rest/v1/searches?id=eq.' + id, { method: 'PATCH', body: JSON.stringify({ result: out }) })).catch(() => {});
        return send(res, 200, { result: out, left: left < 0 ? 0 : left === 9999 ? null : left });
      } catch (e) { console.error('generate failed', String(e.message).slice(0, 200)); throw e; }
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
    // Customer: own past generations ("بحوثي السابقة"). GET /api/my-searches, needs the customer's login token.
 if (req.url === '/api/my-searches' && req.method === 'GET') {
 const p = await user(req);
 if (!p) return send(res, 401, { error: 'login_required' });
 const r = await sb('/rest/v1/searches?select=id,created_at,name,details,out_lang,has_image,result&user_id=eq.' + p.id + '&order=created_at.desc&limit=100');
 if (!r.ok) return send(res, 502, { error: 'history_unavailable' });
 return send(res, 200, { searches: await r.json() });
 }
 // Owner-only: recent customer searches for the admin panel. POST /api/admin/searches {token, limit?}
    if (req.url === '/api/admin/searches' && req.method === 'POST') {
      const b = await body(req);
      if (!ADMIN || b.token !== ADMIN) return send(res, 403, { error: 'forbidden' });
      const lim = Math.min(Math.max(Number(b.limit) || 50, 1), 200);
      const r = await sb('/rest/v1/searches?select=created_at,email,name,details,out_lang,has_image&order=created_at.desc&limit=' + lim);
      if (!r.ok) return send(res, 502, { error: 'searches_unavailable' });
      return send(res, 200, { searches: await r.json() });
    }
    const u = req.url.split('?')[0].split('#')[0];
    const f = path.join('public', u === '/' ? 'index.html' : path.normalize(u).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
    res.writeHead(404); res.end('not found');
  } catch (e) { if (!res.headersSent) send(res, e.code === 400 || e.code === 413 ? e.code : 500, { error: String(e.message) }); }
}).listen(PORT, () => console.log('http://localhost:' + PORT));
