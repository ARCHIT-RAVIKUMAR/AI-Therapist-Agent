require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('Set JWT_SECRET');
const MODEL = process.env.MODEL || 'openai/gpt-oss-20b';
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MAX_USER_MSGS = 60;

/* ---------- Database ----------
   Postgres when DATABASE_URL is set (needed on Vercel), otherwise a local SQLite file. */
let q, init;
if (process.env.DATABASE_URL) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT -> number
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  q = async (sql, p = []) => (await pool.query(sql, p)).rows;
  let ready;
  init = () => ready || (ready = pool.query(`
CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, email TEXT UNIQUE, hash TEXT, guest INTEGER DEFAULT 0, created BIGINT);
CREATE TABLE IF NOT EXISTS sessions(id SERIAL PRIMARY KEY, user_id INTEGER, mood INTEGER, started BIGINT, ended BIGINT, crisis INTEGER DEFAULT 0, summary TEXT);
CREATE TABLE IF NOT EXISTS messages(id SERIAL PRIMARY KEY, session_id INTEGER, role TEXT, content TEXT, ts BIGINT);
`).catch(e => { ready = null; throw e; }));
} else {
  if (process.env.VERCEL) throw new Error('Set DATABASE_URL on Vercel (SQLite cannot persist there)');
  const { DatabaseSync } = require('node:sqlite'); // Node 22.5+
  const sdb = new DatabaseSync('haven.db');
  sdb.exec('PRAGMA journal_mode = WAL;');
  sdb.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, hash TEXT, guest INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mood INTEGER, started INTEGER, ended INTEGER, crisis INTEGER DEFAULT 0, summary TEXT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, role TEXT, content TEXT, ts INTEGER);
`);
  q = async (sql, p = []) => sdb.prepare(sql.replace(/\$\d+/g, '?')).all(...p);
  init = async () => {};
}
const one = async (sql, p) => (await q(sql, p))[0];

/* ---------- Safety ---------- */
const CRISIS = [
  /\b(kill|killing|hurt|harm|cut|cutting|end)\s+(my\s*self|myself|my\s+life)\b/i,
  /\bsuicid/i, /\bself[\s-]?harm/i, /\b(want|wanna|going|need)\s+to\s+die\b/i,
  /\b(don'?t|do not)\s+want\s+to\s+(live|be\s+alive|exist|wake\s+up)\b/i,
  /\bbetter\s+off\s+(dead|without\s+me)\b/i, /\bno\s+reason\s+to\s+live\b/i, /\bend\s+it\s+all\b/i,
  /\btake\s+my\s+own\s+life\b/i, /\boverdos/i, /\bhang\s+myself\b/i,
  /\b(kill|murder|shoot|stab|hurt|harm|poison)\s+(him|her|them|someone|somebody|everyone|my\s+\w+)\b/i,
  /\b(want|going|plan(ning)?)\s+to\s+(kill|hurt|harm)\b/i,
  // Manglish (Malayalam in English letters)
  /\bmari+kk?a?nam\b/i, /\bchaa?kanam\b/i, /\bmarich(u|e)?\s*(pokanam|pokan|mathi)\b/i, /\ba+th?mahath?ya\b/i,
  /\bjeevikk?an?\s+(thalparyam|taalparyam|ishtam|aagraham)\s+illa/i, /\bjeevitham\s+avasan(ippikk?anam|ippikkam)/i,
  // Malayalam script
  /ആത്മഹത്യ|മരിക്കണം|ചാകണം|മരിച്ച\s*പോകണം|ജീവിക്കാൻ\s+(താൽ?പ്പ?ര്യം|ആഗ്രഹം)\s+ഇല്ല|ജീവിതം\s+അവസാനിപ്പിക്/,
  // Hindi / Hinglish
  /आत्महत्या|मरना\s+चाह|जीना\s+नहीं\s+चाह|जीने\s+का\s+मन\s+नहीं|खुद\s+को\s+(खत्म|मार)/,
  /\bmar(na|ne)\s+(chahta|chahti|hai|ka\s+mann?)\b/i, /\bjeene\s+ka\s+(mann?)\s+nahi/i, /\baa?tmahatya\b/i, /\bkhud\s*ko\s+(khatam|maar)/i,
  // Tamil
  /தற்கொலை|சாக\s*வேண்டும்|சாகணும்|உயிரை\s+மாய்/, /\bthatkolai\b/i, /\bsaaga\s*(vendum|venum)\b/i, /\bsaaganum\b/i,
];
const SYS = `You are Haven, a warm supportive-listening companion. You are not a licensed therapist: never claim to be one, never diagnose, never prescribe. Use reflective listening: name and validate feelings, ask at most one gentle open question, suggest small coping ideas only when fitting. Reply in 2-5 short plain sentences, no lists or headings. If the person mentions self-harm, suicide or harming others, respond with calm care, take it seriously, encourage contacting emergency services, a crisis line and a trusted person, and never give methods or encourage harm.`;
const CRISIS_NOTE = `\nNOTE: This person has expressed possible crisis or safety concerns. Prioritize their safety and point gently to the emergency resources shown on screen.`;

const LANGS = {
  auto: 'Reply in the same language and script the person writes in. If they write romanized Malayalam (Manglish) or romanized Hindi (Hinglish), reply in that same romanized, conversational style.',
  en: 'Reply in English only, even if earlier messages in this conversation used another language.',
  ml: 'Reply in Malayalam, using Malayalam script.',
  mng: 'Reply in Manglish: Malayalam written in English letters, in a natural conversational style.',
  hi: 'Reply in Hindi, using Devanagari script.',
  hng: 'Reply in Hinglish: Hindi written in English letters, in a natural conversational style.',
  ta: 'Reply in Tamil, using Tamil script.',
};
// "Auto" is decided here in code, not by the AI: the script of the message, then a small Manglish/Hinglish word check, otherwise English.
const SCRIPTS = [[/[\u0D00-\u0D7F]/, 'ml'], [/[\u0900-\u097F]/, 'hi'], [/[\u0B80-\u0BFF]/, 'ta']];
const MNG = /\b(njan|enikku|enikk|ente|ninakku|ningal|entha|enthaa|aanu|alle|illa|undu|venam|vendaa|vendam|ayyo|chetta|chechi|mone|sheri|pinne|ippo|innu|ennaal|kurachu|othiri|sankadam|vishamam|thonnunnu|cheyyan|parayan|ariyilla|pattunnilla)\b/gi;
const HNG = /\b(mujhe|mera|meri|mere|hai|hain|nahi|nahin|kya|kyun|kyu|bahut|thoda|accha|acha|theek|thik|yaar|bhai|lekin|abhi|samajh|dil|mann|thak|raha|rahi|karna|chahta|chahti)\b/gi;
function effectiveLang(lang, text) {
  if (lang !== 'auto') return lang;
  for (const [re, l] of SCRIPTS) if (re.test(text)) return l;
  const n = re => (text.match(re) || []).length;
  if (n(MNG) >= 2) return 'mng';
  if (n(HNG) >= 2) return 'hng';
  return 'en';
}
const CLASSIFIER = `You are a safety classifier for a mental-health support chat used in India. Messages may be in English, Hindi, Malayalam, Tamil, or romanized mixes such as Manglish and Hinglish (for example "enikku marikkanam", "jeevikkan thalparyam illa", "marichal mathi", "mujhe marna hai", "jeene ka mann nahi").
Decide whether the LATEST message, read in the context of the recent conversation, expresses suicidal thoughts, intent or a plan, self-harm, or intent to harm another person. Be sensitive to indirect expressions: not wanting to wake up, feeling like a burden, wanting everything to end, saying goodbye, giving things away. Do NOT flag ordinary sadness, stress or figures of speech (for example "this exam is killing me").
Return ONLY a JSON object: {"crisis": true} or {"crisis": false}.`;
// Second safety layer: an AI check that understands any language. Fails open to the keyword layer.
async function aiCrisis(ctx, text) {
  try {
    const convo = ctx.map(m => (m.role === 'user' ? 'Person' : 'Haven') + ': ' + m.content).join('\n');
    const r = await Promise.race([
      client.chat.completions.create({
        model: MODEL, max_completion_tokens: 600, reasoning_effort: 'low', response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: CLASSIFIER }, { role: 'user', content: `Recent conversation:\n${convo || '(none)'}\n\nLatest message from the person:\n${text}` }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('classifier timeout')), 5000)),
    ]);
    return JSON.parse(r.choices[0].message.content).crisis === true;
  } catch (e) { console.error('crisis classifier:', e.message); return false; }
}

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }); next(); });
const PUBLIC = path.join(__dirname, 'public'); // absolute path so it also works inside Vercel's function
app.use(express.static(PUBLIC));
app.use('/api', rateLimit({ windowMs: 60_000, max: 60 }));
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.use('/api', h(async (req, res, next) => { await init(); next(); }));

const setCookie = (res, uid) =>
  res.cookie('tok', jwt.sign({ uid }, SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 });

const auth = h(async (req, res, next) => {
  let uid;
  try { uid = jwt.verify(req.cookies.tok, SECRET).uid; } catch { return res.status(401).json({ error: 'Not signed in' }); }
  const u = await one('SELECT id,email,guest FROM users WHERE id=$1', [uid]);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  req.user = u; next();
});
const ownSession = h(async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const s = await one('SELECT * FROM sessions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!s) return res.status(404).json({ error: 'Not found' });
  req.session = s; next();
});
const wipeUserData = async uid => {
  await q('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE user_id=$1)', [uid]);
  await q('DELETE FROM sessions WHERE user_id=$1', [uid]);
  await q('DELETE FROM users WHERE id=$1', [uid]);
};

// If someone signs in or registers while holding a guest cookie, discard that guest's data
const dropGuest = async req => {
  try {
    const { uid } = jwt.verify(req.cookies.tok, SECRET);
    const u = await one('SELECT guest FROM users WHERE id=$1', [uid]);
    if (u && u.guest) await wipeUserData(uid);
  } catch {}
};

app.post('/api/register', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 8) return res.status(400).json({ error: 'Valid email and a password of 8+ characters required.' });
  if (await one('SELECT 1 FROM users WHERE email=$1', [email])) return res.status(409).json({ error: 'That email is already registered.' });
  const u = await one('INSERT INTO users(email,hash,created) VALUES($1,$2,$3) RETURNING id', [email, bcrypt.hashSync(pw, 10), Date.now()]);
  await dropGuest(req); setCookie(res, u.id); res.json({ email, guest: 0 });
}));
app.post('/api/login', h(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE email=$1', [String(req.body.email || '').trim().toLowerCase()]);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) return res.status(401).json({ error: 'Wrong email or password.' });
  await dropGuest(req); setCookie(res, u.id); res.json({ email: u.email, guest: 0 });
}));
app.post('/api/upgrade', auth, h(async (req, res) => {
  if (!req.user.guest) return res.status(400).json({ error: 'You already have an account.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 8) return res.status(400).json({ error: 'Valid email and a password of 8+ characters required.' });
  if (await one('SELECT 1 FROM users WHERE email=$1', [email])) return res.status(409).json({ error: 'That email is already registered. Sign out and sign in instead.' });
  await q('UPDATE users SET email=$1, hash=$2, guest=0 WHERE id=$3', [email, bcrypt.hashSync(pw, 10), req.user.id]);
  res.json({ email, guest: 0 }); // same user id, so every guest session is kept
}));
app.post('/api/guest', h(async (req, res) => {
  const u = await one('INSERT INTO users(guest,created) VALUES(1,$1) RETURNING id', [Date.now()]);
  setCookie(res, u.id); res.json({ email: null, guest: 1 });
}));
app.post('/api/logout', auth, h(async (req, res) => {
  if (req.user.guest) await wipeUserData(req.user.id);
  res.clearCookie('tok').json({ ok: true });
}));
app.delete('/api/account', auth, h(async (req, res) => {
  await wipeUserData(req.user.id);
  res.clearCookie('tok').json({ ok: true });
}));
app.get('/api/me', auth, (req, res) => res.json({ email: req.user.email, guest: req.user.guest }));

app.get('/api/sessions', auth, h(async (req, res) => {
  const rows = await q('SELECT id,mood,started,ended,crisis,summary FROM sessions WHERE user_id=$1 AND ended IS NOT NULL ORDER BY started DESC', [req.user.id]);
  res.json(rows.map(s => ({ ...s, summary: s.summary ? JSON.parse(s.summary) : null })));
}));
app.post('/api/sessions', auth, h(async (req, res) => {
  const mood = Math.min(5, Math.max(1, parseInt(req.body.mood) || 3));
  const s = await one('INSERT INTO sessions(user_id,mood,started) VALUES($1,$2,$3) RETURNING id', [req.user.id, mood, Date.now()]);
  res.json({ id: s.id });
}));
app.get('/api/sessions/:id', auth, ownSession, h(async (req, res) => {
  const s = req.session;
  res.json({ ...s, summary: s.summary ? JSON.parse(s.summary) : null,
    messages: await q('SELECT role,content,ts FROM messages WHERE session_id=$1 ORDER BY id', [s.id]) });
}));
app.delete('/api/sessions/:id', auth, ownSession, h(async (req, res) => {
  await q('DELETE FROM messages WHERE session_id=$1', [req.session.id]);
  await q('DELETE FROM sessions WHERE id=$1', [req.session.id]);
  res.json({ ok: true });
}));

// Chat turn, streamed back as server-sent events
app.post('/api/sessions/:id/messages', auth, ownSession, h(async (req, res) => {
  const s = req.session;
  const lang = LANGS[req.body.lang] ? req.body.lang : 'auto';
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text || s.ended) return res.status(400).json({ error: 'Bad request' });
  const { n } = await one("SELECT COUNT(*) AS n FROM messages WHERE session_id=$1 AND role='user'", [s.id]);
  if (n >= MAX_USER_MSGS) return res.status(429).json({ error: 'This session is long. Please end it and start a new one.' });
  const ctx = (await q('SELECT role,content FROM messages WHERE session_id=$1 ORDER BY id DESC LIMIT 6', [s.id])).reverse();
  let flagged = CRISIS.some(r => r.test(text));
  if (!flagged) flagged = await aiCrisis(ctx, text);
  await q('INSERT INTO messages(session_id,role,content,ts) VALUES($1,$2,$3,$4)', [s.id, 'user', text, Date.now()]);
  if (flagged) { await q('UPDATE sessions SET crisis=1 WHERE id=$1', [s.id]); s.crisis = 1; }

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (flagged) send('crisis', {});

  const history = await q('SELECT role,content FROM messages WHERE session_id=$1 ORDER BY id', [s.id]);
  try {
    let full = '';
    const stream = await client.chat.completions.create({
      model: MODEL, max_completion_tokens: 1200, reasoning_effort: 'low', stream: true,
      messages: [{ role: 'system', content: SYS + '\nLanguage: ' + LANGS[effectiveLang(lang, text)] + (s.crisis ? CRISIS_NOTE : '') }, ...history],
    });
    for await (const chunk of stream) {
      const t = chunk.choices[0]?.delta?.content;
      if (t) { full += t; send('delta', t); }
    }
    await q('INSERT INTO messages(session_id,role,content,ts) VALUES($1,$2,$3,$4)', [s.id, 'assistant', full, Date.now()]);
    send('done', {});
  } catch (e) {
    console.error(e.message);
    send('error', { message: 'I could not reach the AI service. Please try again.' });
  }
  res.end();
}));

app.post('/api/sessions/:id/end', auth, ownSession, h(async (req, res) => {
  const s = req.session;
  const lang = LANGS[req.body.lang] ? req.body.lang : 'auto';
  const msgs = await q('SELECT role,content FROM messages WHERE session_id=$1 ORDER BY id', [s.id]);
  if (!msgs.length) return res.status(400).json({ error: 'Nothing to summarize yet.' });
  const transcript = msgs.map(m => (m.role === 'user' ? 'Person' : 'Haven') + ': ' + m.content).join('\n');
  let summary;
  try {
    const r = await client.chat.completions.create({
      model: MODEL, max_completion_tokens: 2000, reasoning_effort: 'low', response_format: { type: 'json_object' },
      messages: [{ role: 'user', content:
        `${LANGS[effectiveLang(lang, msgs.filter(m => m.role === 'user').map(m => m.content).join(' '))].replace(/^Reply/, 'Write')} Keep the JSON keys in English. Summarize this supportive conversation for the person, in second person, warm, no diagnosis. Return ONLY a JSON object: {"summary":"3-4 sentences","themes":["2-4 short themes"],"mood":"short phrase","copingSteps":["3-5 concrete gentle steps tailored to what they shared"]}${s.crisis ? '\nSafety concerns were raised; include reaching a crisis line or trusted person as one step.' : ''}\n\n${transcript}` }],
    });
    summary = JSON.parse(r.choices[0].message.content);
  } catch {
    summary = { summary: 'Thank you for checking in with yourself today.', themes: [], mood: '', copingSteps: ['Take slow breaths: in for 4, out for 6.', 'Write down one thing that would make tomorrow easier.', 'Reach out to someone you trust.'] };
  }
  await q('UPDATE sessions SET ended=$1, summary=$2 WHERE id=$3', [Date.now(), JSON.stringify(summary), s.id]);
  res.json({ id: s.id, mood: s.mood, started: s.started, crisis: s.crisis, summary });
}));

// Anything that is not an API call gets the app page
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Server error. Please try again.' });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Haven running on http://localhost:' + port));
}
module.exports = app;
