// Zero-dependency Node server: static site + /api/generate (Gemini) with a free-tries gate.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env','utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const KEY = process.env.GEMINI_API_KEY;
const GROUND = process.env.GROUNDING === 'on'; // needs paid-tier Gemini billing
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const FREE = Number(process.env.FREE_TRIES || 3);
const ADMIN = process.env.ADMIN_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);
const SB = process.env.SUPABASE_URL, SBK = process.env.SUPABASE_SERVICE_KEY, SBA = process.env.SUPABASE_ANON_KEY;
const sb = (p, o = {}) => fetch(SB + p, { ...o, headers: { apikey: SBK, Authorization: 'Bearer ' + SBK, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

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
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(JSON.parse(b || '{}'))); });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function generate({ name, details, lang, image }) {
  const L = lang === 'en' ? 'English' : 'Arabic';
  const prompt = `You are an expert e-commerce SEO copywriter and market researcher.
Product: ${name}
Seller details: ${details}
${GROUND ? 'STEP 1: Use Google Search to research this product: real specs and facts, how top-ranking listings and competitors title and describe it, and what keywords buyers search for in the target market (Egypt / Arabic-speaking buyers when writing Arabic).\nSTEP 2: ' : ''}Write the listing in ${L} using SEO best practice for the Egyptian / Arabic-speaking market and the seller details. Never invent specs that were not given; if unsure, leave them out.
Return ONLY a JSON object (no markdown fence) with keys: titles (3 SEO titles), description, bullets (5), keywords (10, ordered by search relevance), ads (2 short ready-to-post ads), research_notes (3 short lines on the SEO approach used).`;
  const parts = [{ text: prompt }];
  if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  // Search grounding cannot be combined with responseMimeType=json, so JSON is requested in the prompt and parsed below.
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({ contents: [{ parts }], ...(GROUND ? { tools: [{ google_search: {} }] } : { generationConfig: { responseMimeType: 'application/json' } }) }),
  });
  if (!r.ok) throw new Error('gemini ' + r.status);
  const j = await r.json();
  const c = j.candidates[0];
  const text = c.content.parts.map((p) => p.text || '').join('');
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('bad_model_output');
  const out = JSON.parse(m[0]);
  out.sources = (c.groundingMetadata?.groundingChunks || []).map((g) => g.web).filter(Boolean).map((w) => ({ title: w.title, url: w.uri })).slice(0, 8);
  out.searches = c.groundingMetadata?.webSearchQueries || [];
  return out;
}

http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/me') { const p = await user(req); return p ? send(res, 200, meInfo(p)) : send(res, 401, { error: 'login_required' }); }
    if (req.url === '/api/generate' && req.method === 'POST') {
      const p = await user(req);
      if (!p) return send(res, 401, { error: 'login_required' });
      const left = await (await sb('/rest/v1/rpc/consume_try', { method: 'POST', body: JSON.stringify({ uid: p.id, free_limit: FREE }) })).json();
      if (left < 0) return send(res, 402, { error: 'free_tries_over' });
      try { const out = await generate(await body(req)); return send(res, 200, { result: out, left: left === 9999 ? null : left }); }
      catch (e) { await sb('/rest/v1/rpc/refund_try', { method: 'POST', body: JSON.stringify({ uid: p.id }) }); throw e; }
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
      const p = (await (await sb(`/rest/v1/profiles?email=eq.${encodeURIComponent(b.email)}&select=*`)).json())[0];
      if (!p) return send(res, 404, { error: 'user_not_found' });
      const start = p.plan_until && new Date(p.plan_until) > new Date() ? new Date(p.plan_until) : new Date();
      const until = new Date(start.getTime() + (b.plan === 'yearly' ? 365 : 30) * 864e5).toISOString();
      await sb(`/rest/v1/profiles?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify({ plan: b.plan, plan_until: until }) });
      return send(res, 200, { ok: true, until });
    }
    const f = path.join('public', req.url === '/' ? 'index.html' : path.normalize(req.url).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
    res.writeHead(404); res.end('not found');
  } catch (e) { send(res, 500, { error: String(e.message) }); }
}).listen(PORT, () => console.log('http://localhost:' + PORT));
