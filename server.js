'use strict';
/* Free Talk — deployable copy (single Node service: front end + API).
   Built from the approved Free Talk product spec. Starts EMPTY.
   Storage: Postgres when DATABASE_URL is set (single JSONB state row via `pg`),
   otherwise a local file DB (data/db.json) for local smoke tests. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'db.json');
const OWNER_EASYPAISA = process.env.OWNER_EASYPAISA || '03365913165';

/* ---------------- seed data (catalogue only — no users ever ship) ---------------- */
const GIFT_SEED = [
  ['Rose', '🌹', 10], ['Red Heart', '❤️', 15], ['Flower Bouquet', '💐', 25], ['Chocolate', '🍫', 30],
  ['Teddy Bear', '🧸', 40], ['Diamond', '💎', 100], ['Crown', '👑', 150], ['Golden Rose', '🌟', 200],
  ['Crystal Heart', '💖', 120], ['Peacock Feather', '🦚', 90], ['Unicorn Dream', '🦄', 250], ['Phoenix Flame', '🔥', 300],
  ['Rainbow', '🌈', 60], ['Butterfly', '🦋', 35], ['Star', '⭐', 45], ['Moon', '🌙', 55],
  ['Sun', '☀️', 50], ['Pearl Necklace', '📿', 180], ['Ruby Gem', '🔴', 160], ['Sapphire', '🔷', 170],
  ['Golden Mic', '🎤', 220], ['Love Letter', '💌', 20], ['Cake', '🎂', 70], ['Perfume', '🌸', 110], ['Royal Car', '🚗', 500]
].map(([name, emoji, price], i) => ({ id: 'g' + (i + 1), name, emoji, price, animated: price >= 100 }));
const PACKAGE_SEED = [
  { id: 'p1', name: 'Starter Pack', coins: 100, priceRs: 100 },
  { id: 'p2', name: 'Popular Pack', coins: 550, priceRs: 500 },
  { id: 'p3', name: 'Gold Pack', coins: 1200, priceRs: 1000 },
  { id: 'p4', name: 'Legend Pack', coins: 3000, priceRs: 2400 }
];
const BADGE_DEFS = [
  { id: 'complete', name: 'Profile Star', emoji: '⭐', desc: 'Complete your profile (photo, bio, country)', target: 1, metric: 'profileComplete' },
  { id: 'verified', name: 'Verified', emoji: '✅', desc: 'Get your live-selfie verification approved', target: 1, metric: 'verified' },
  { id: 'friend1', name: 'First Friend', emoji: '🤝', desc: 'Make your first friend', target: 1, metric: 'friends' },
  { id: 'friend10', name: 'Social Circle', emoji: '👥', desc: 'Make 10 friends', target: 10, metric: 'friends' },
  { id: 'host1', name: 'Room Host', emoji: '🎙️', desc: 'Create your first room', target: 1, metric: 'roomsHosted' },
  { id: 'talk60', name: 'Voice Star', emoji: '🔊', desc: 'Speak 60 minutes in rooms', target: 60, metric: 'speakMinutes' },
  { id: 'invite5', name: 'Inviter', emoji: '✉️', desc: '5 invited friends actually join', target: 5, metric: 'invitesJoined' },
  { id: 'level5', name: 'Rising Star', emoji: '🏆', desc: 'Reach level 5', target: 5, metric: 'level' }
];

function defaultState() {
  return {
    users: [], sessions: [], otpCodes: [], friendships: [], messages: [], calls: [],
    rooms: [], roomMembers: [], roomMessages: [], roomInvites: [], roomBans: [],
    gifts: JSON.parse(JSON.stringify(GIFT_SEED)), packages: JSON.parse(JSON.stringify(PACKAGE_SEED)),
    ledger: [], giftTxns: [], paymentRequests: [], verifications: [], likes: [],
    posts: [], postLikes: [], postComments: [], reports: [], announcements: [],
    auditLog: [], dailyActivity: [], heartbeats: [],
    settings: {
      xpPresenceRate: 1, xpSpeakingRate: 5, xpInviteRate: 50,
      capPresence: 120, capSpeaking: 300, capInvite: 250,
      rtcProvider: '', rtcAppId: '', easypaisa: OWNER_EASYPAISA
    }
  };
}

/* ---------------- persistence ---------------- */
let state = defaultState();
let pgPool = null;
let saveTimer = null;

async function loadState() {
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pgPool.query('CREATE TABLE IF NOT EXISTS ft_state (id int PRIMARY KEY, data jsonb NOT NULL)');
      const r = await pgPool.query('SELECT data FROM ft_state WHERE id=1');
      if (r.rows.length) state = Object.assign(defaultState(), r.rows[0].data);
      else await pgSaveNow();
      console.log('[db] Postgres connected');
      return;
    } catch (e) {
      console.error('[db] DATABASE_URL set but Postgres unavailable, falling back to file DB:', e.message);
      pgPool = null;
    }
  }
  try {
    if (fs.existsSync(DATA_FILE)) state = Object.assign(defaultState(), JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) { console.error('[db] file load failed, starting empty:', e.message); }
}
async function pgSaveNow() {
  if (!pgPool) return;
  await pgPool.query('INSERT INTO ft_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [JSON.stringify(state)]);
}
function save() {
  if (pgPool) { clearTimeout(saveTimer); saveTimer = setTimeout(() => pgSaveNow().catch(e => console.error('[db] save failed', e.message)), 250); return; }
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(state)); }
  catch (e) { console.error('[db] file save failed', e.message); }
}

/* ---------------- helpers ---------------- */
const uid = p => p + crypto.randomBytes(5).toString('hex');
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
function hashPw(pw, salt) { salt = salt || crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') }; }
function checkPw(pw, salt, hash) { try { return crypto.timingSafeEqual(Buffer.from(crypto.scryptSync(String(pw), salt, 32).toString('hex')), Buffer.from(hash)); } catch { return false; } }
function ageFromDob(dob) { const d = new Date(dob), t = new Date(); let a = t.getFullYear() - d.getFullYear(); const m = t.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--; return a; }

const LEVEL_THRESHOLDS = [
  [0, 1, 'Newcomer'], [100, 2, 'Chatter'], [250, 3, 'Friendly'], [500, 4, 'Socializer'], [900, 5, 'Popular'],
  [1400, 6, 'Star'], [2200, 7, 'Elite'], [3200, 8, 'Master'], [4500, 9, 'Legend'], [6500, 10, 'Free Talk Legend']
];
function levelFromXp(xp, role) {
  if (role === 'admin') return { level: 10, title: 'Free Talk Legend', isTop: true, xp, nextAt: null };
  let cur = LEVEL_THRESHOLDS[0], next = null;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) { if (xp >= LEVEL_THRESHOLDS[i][0]) { cur = LEVEL_THRESHOLDS[i]; next = LEVEL_THRESHOLDS[i + 1] || null; } }
  return { level: cur[1], title: cur[2], isTop: false, xp, nextAt: next ? next[0] : null };
}
const ROOM_TIERS = [[0, 'Starter'], [200, 'Rising'], [600, 'Elite'], [1500, 'Legendary']];
function roomTier(xp) { let t = 'Starter'; for (const [min, name] of ROOM_TIERS) if (xp >= min) t = name; return t; }

function dailyRec(userId) {
  const d = today(); let r = state.dailyActivity.find(x => x.userId === userId && x.date === d);
  if (!r) { r = { userId, date: d, presence: 0, speaking: 0, invite: 0, speakMinutes: 0, presenceMinutes: 0, invitesJoined: 0 }; state.dailyActivity.push(r); }
  return r;
}
function lifetime(userId) { // aggregate speaking minutes / invites for badges
  let speakMinutes = 0, presenceMinutes = 0, invitesJoined = 0;
  for (const r of state.dailyActivity) if (r.userId === userId) { speakMinutes += r.speakMinutes || 0; presenceMinutes += r.presenceMinutes || 0; invitesJoined += r.invitesJoined || 0; }
  return { speakMinutes, presenceMinutes, invitesJoined };
}
/* Award XP with daily caps. kind: 'presence'|'speaking'|'invite'. Returns XP actually granted. */
function awardXp(user, kind, units) {
  if (!user || user.role === 'admin') return 0;
  const s = state.settings, rec = dailyRec(user.id);
  const rate = kind === 'presence' ? s.xpPresenceRate : kind === 'speaking' ? s.xpSpeakingRate : s.xpInviteRate;
  const cap = kind === 'presence' ? s.capPresence : kind === 'speaking' ? s.capSpeaking : s.capInvite;
  const want = Math.floor(units * rate);
  const grant = Math.max(0, Math.min(want, cap - (rec[kind] || 0)));
  if (grant > 0) { rec[kind] += grant; user.xp += grant; }
  return grant;
}
function audit(actor, action, detail) { state.auditLog.unshift({ id: uid('a'), at: now(), actor, action, detail: detail || '' }); state.auditLog = state.auditLog.slice(0, 500); }

function publicUser(u, viewer) {
  if (!u) return null;
  const lv = levelFromXp(u.xp, u.role);
  return {
    id: u.id, ftId: u.ftId, username: u.username, displayName: u.displayName, avatar: u.avatar || '',
    bio: u.bio || '', country: u.country || '', age: u.dob ? ageFromDob(u.dob) : null,
    online: !!u.online, level: lv.level, levelTitle: lv.title, isTop: lv.isTop, xp: u.xp,
    verificationStatus: u.verificationStatus, verified: u.verificationStatus === 'Verified',
    whoCanMessage: u.whoCanMessage || 'friends', whoCanCall: u.whoCanCall || 'friends',
    isOwner: u.role === 'admin', createdAt: u.createdAt
  };
}
function walletOf(userId) {
  let bal = 0; for (const e of state.ledger) if (e.userId === userId) bal += e.delta;
  return bal;
}
function addLedger(userId, delta, type, note, ref) {
  state.ledger.push({ id: uid('l'), at: now(), userId, delta, type, note: note || '', ref: ref || '', balanceAfter: walletOf(userId) + delta });
}
function isFriend(a, b) { return state.friendships.some(f => f.status === 'accepted' && ((f.from === a && f.to === b) || (f.from === b && f.to === a))); }
function isBlocked(a, b) { const u = state.users.find(x => x.id === a); return !!(u && (u.blocked || []).includes(b)); }

/* ---------------- HTTP plumbing ---------------- */
function send(res, code, obj) { const body = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); res.end(body); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) { reject(new Error('Body too large (8 MB limit)')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function authUser(req) {
  const h = req.headers.authorization || ''; const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const sess = state.sessions.find(s => s.token === token);
  if (!sess) return null;
  const u = state.users.find(x => x.id === sess.userId);
  if (!u || u.banned) return null;
  u.online = true; u.lastSeen = now();
  return u;
}
function requireAdmin(req, res) { const u = authUser(req); if (!u) { send(res, 401, { error: 'Login required' }); return null; } if (u.role !== 'admin') { send(res, 403, { error: 'Admin access required' }); return null; } return u; }

/* ---------------- API: auth ---------------- */
async function api(req, res, url) {
  const p = url.pathname; const m = req.method;
  const body = (m === 'POST' || m === 'PATCH') ? await readBody(req) : {};

  if (p === '/api/health') return send(res, 200, { ok: true, users: state.users.length, rooms: state.rooms.length });

  if (p === '/api/auth/request-otp' && m === 'POST') {
    const sim = String(body.sim || '').replace(/\s/g, '');
    if (!/^\+?\d{7,15}$/.test(sim)) return send(res, 400, { error: 'Enter a valid SIM number' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    state.otpCodes = state.otpCodes.filter(o => o.sim !== sim);
    state.otpCodes.push({ sim, codeHash: crypto.createHash('sha256').update(code).digest('hex'), expires: now() + 10 * 60 * 1000 });
    save();
    // Honest by design: no SMS provider is connected, so the code is shown in-app (same as the current app).
    return send(res, 200, { ok: true, code, note: 'No SMS provider is connected yet, so your code is shown here in the app. When an SMS provider is connected, this code will be texted to your SIM instead.', expiresInMinutes: 10 });
  }
  function validOtp(sim, code) {
    const o = state.otpCodes.find(x => x.sim === sim);
    if (!o || o.expires < now()) return false;
    return o.codeHash === crypto.createHash('sha256').update(String(code)).digest('hex');
  }

  if (p === '/api/auth/register' && m === 'POST') {
    const sim = String(body.sim || '').replace(/\s/g, '');
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim();
    if (!/^\+?\d{7,15}$/.test(sim)) return send(res, 400, { error: 'Enter a valid SIM number' });
    if (!validOtp(sim, body.otpCode)) return send(res, 400, { error: 'That OTP code is not correct' });
    if (!body.password || String(body.password).length < 6) return send(res, 400, { error: 'Password must be at least 6 characters' });
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return send(res, 400, { error: 'Username: 3-20 letters, numbers or _ only' });
    if (!displayName) return send(res, 400, { error: 'Display name is required' });
    if (!body.dob || ageFromDob(body.dob) < 13 || ageFromDob(body.dob) > 120) return send(res, 400, { error: 'Enter a valid date of birth (age 13+)' });
    if (state.users.some(u => u.sim === sim)) return send(res, 400, { error: 'This SIM already has an account — one SIM, one account. Please log in.' });
    if (state.users.some(u => u.username === username)) return send(res, 400, { error: 'That username is taken' });
    const isFirst = state.users.length === 0;
    const pw = hashPw(body.password);
    const user = {
      id: uid('u'), ftId: 'FT-' + crypto.randomBytes(3).toString('hex').toUpperCase(), sim, username, displayName,
      passwordHash: pw.hash, passwordSalt: pw.salt, dob: body.dob, country: String(body.country || ''), bio: '', avatar: '',
      role: isFirst ? 'admin' : 'user', xp: isFirst ? 10000 : 0, verificationStatus: 'Unverified',
      whoCanMessage: 'friends', whoCanCall: 'friends', blocked: [], banned: false, online: true, lastSeen: now(), createdAt: now(),
      invitedBy: null
    };
    state.users.push(user);
    state.otpCodes = state.otpCodes.filter(o => o.sim !== sim);
    // Invite credit: only when an invited friend ACTUALLY registers (anti-spam condition).
    const invCode = String(body.inviteCode || '').trim();
    if (invCode && !isFirst) {
      const inviter = state.users.find(u => u.ftId.toLowerCase() === invCode.toLowerCase() || u.username === invCode.toLowerCase());
      if (inviter && inviter.id !== user.id) {
        user.invitedBy = inviter.id;
        const granted = awardXp(inviter, 'invite', 1);
        if (granted > 0) dailyRec(inviter.id).invitesJoined += 1;
      }
    }
    const token = uid('t') + crypto.randomBytes(8).toString('hex');
    state.sessions.push({ token, userId: user.id, at: now() });
    audit(user.username, 'register', isFirst ? 'First account — became owner/Super Admin (TOP level)' : 'New account');
    save();
    return send(res, 200, { ok: true, token, user: publicUser(user) });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    const sim = String(body.sim || '').replace(/\s/g, '');
    const u = state.users.find(x => x.sim === sim);
    if (!u || !checkPw(body.password || '', u.passwordSalt, u.passwordHash)) return send(res, 401, { error: 'Wrong SIM number or password' });
    if (u.banned) return send(res, 403, { error: 'This account is banned' });
    const token = uid('t') + crypto.randomBytes(8).toString('hex');
    state.sessions.push({ token, userId: u.id, at: now() });
    u.online = true; u.lastSeen = now(); save();
    return send(res, 200, { ok: true, token, user: publicUser(u) });
  }
  if (p === '/api/auth/reset-password' && m === 'POST') {
    const sim = String(body.sim || '').replace(/\s/g, '');
    const u = state.users.find(x => x.sim === sim);
    if (!u) return send(res, 404, { error: 'No account with this SIM number' });
    if (!validOtp(sim, body.otpCode)) return send(res, 400, { error: 'That OTP code is not correct' });
    if (!body.newPassword || String(body.newPassword).length < 6) return send(res, 400, { error: 'Password must be at least 6 characters' });
    const pw = hashPw(body.newPassword); u.passwordHash = pw.hash; u.passwordSalt = pw.salt;
    state.otpCodes = state.otpCodes.filter(o => o.sim !== sim); save();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    const me = authUser(req); if (me) { me.online = false; state.sessions = state.sessions.filter(s => s.userId !== me.id || s.token !== (req.headers.authorization || '').slice(7)); save(); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/me' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    if (me.role === 'admin' && me.xp < 10000) { me.xp = 10000; save(); } // owner pinned at TOP floor
    return send(res, 200, { user: publicUser(me), wallet: walletOf(me.id) });
  }
  if (p === '/api/me/boost' && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    if (me.role !== 'admin') return send(res, 403, { error: 'Admin access required' });
    me.xp = Math.max(me.xp, 10000);
    for (const r of state.rooms) if (r.ownerId === me.id) r.xp = Math.max(r.xp, 1500);
    audit(me.username, 'boostOwnerToTop', 'Owner account + rooms pinned to TOP'); save();
    return send(res, 200, { ok: true, user: publicUser(me) });
  }
  if (p === '/api/profile' && m === 'PATCH') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    for (const k of ['displayName', 'bio', 'country', 'avatar', 'whoCanMessage', 'whoCanCall']) if (body[k] !== undefined) me[k] = body[k];
    save(); return send(res, 200, { user: publicUser(me) });
  }

  /* ---------------- users / discover / friends ---------------- */
  if (p === '/api/users' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const q = (url.searchParams.get('q') || '').toLowerCase(); const country = url.searchParams.get('country') || '';
    let list = state.users.filter(u => !u.banned);
    if (q) list = list.filter(u => (u.displayName + ' ' + u.username + ' ' + u.ftId).toLowerCase().includes(q));
    if (country) list = list.filter(u => u.country === country);
    return send(res, 200, { users: list.map(u => publicUser(u)), countries: [...new Set(state.users.map(u => u.country).filter(Boolean))] });
  }
  const userMatch = p.match(/^\/api\/users\/([\w-]+)$/);
  if (userMatch && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const u = state.users.find(x => x.id === userMatch[1]); if (!u) return send(res, 404, { error: 'User not found' });
    const rel = state.friendships.find(f => (f.from === me.id && f.to === u.id) || (f.from === u.id && f.to === me.id));
    return send(res, 200, { user: publicUser(u), relation: rel ? rel.status : 'none', relationFrom: rel ? rel.from : null });
  }
  const actMatch = p.match(/^\/api\/users\/([\w-]+)\/(request|respond|block|report|like)$/);
  if (actMatch && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const other = state.users.find(x => x.id === actMatch[1]); if (!other) return send(res, 404, { error: 'User not found' });
    const action = actMatch[2];
    if (action === 'request') {
      if (other.id === me.id) return send(res, 400, { error: 'Cannot friend yourself' });
      if (isBlocked(other.id, me.id) || isBlocked(me.id, other.id)) return send(res, 403, { error: 'Blocked' });
      if (state.friendships.some(f => (f.from === me.id && f.to === other.id) || (f.from === other.id && f.to === me.id))) return send(res, 400, { error: 'Request already exists' });
      state.friendships.push({ id: uid('f'), from: me.id, to: other.id, status: 'pending', at: now() });
    } else if (action === 'respond') {
      const f = state.friendships.find(x => x.from === other.id && x.to === me.id && x.status === 'pending');
      if (!f) return send(res, 404, { error: 'No pending request' });
      if (body.accept) f.status = 'accepted'; else state.friendships = state.friendships.filter(x => x.id !== f.id);
    } else if (action === 'block') {
      if (!me.blocked.includes(other.id)) me.blocked.push(other.id);
      state.friendships = state.friendships.filter(f => !((f.from === me.id && f.to === other.id) || (f.from === other.id && f.to === me.id)));
    } else if (action === 'report') {
      state.reports.unshift({ id: uid('r'), at: now(), reporterId: me.id, targetType: 'user', targetId: other.id, reason: String(body.reason || 'Reported from profile'), status: 'open' });
      audit(me.username, 'report-user', other.username);
    } else if (action === 'like') {
      if (!state.likes.some(l => l.from === me.id && l.to === other.id)) state.likes.push({ from: me.id, to: other.id, at: now() });
    }
    save(); return send(res, 200, { ok: true });
  }
  if (p === '/api/friends' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const friends = [], incoming = [], outgoing = [];
    for (const f of state.friendships) {
      if (f.status === 'accepted' && (f.from === me.id || f.to === me.id)) friends.push(publicUser(state.users.find(u => u.id === (f.from === me.id ? f.to : f.from))));
      else if (f.status === 'pending' && f.to === me.id) incoming.push(publicUser(state.users.find(u => u.id === f.from)));
      else if (f.status === 'pending' && f.from === me.id) outgoing.push(publicUser(state.users.find(u => u.id === f.to)));
    }
    return send(res, 200, { friends: friends.filter(Boolean), incoming: incoming.filter(Boolean), outgoing: outgoing.filter(Boolean) });
  }

  /* ---------------- private messages (friends only by default) ---------------- */
  const dmMatch = p.match(/^\/api\/messages\/([\w-]+)$/);
  if (dmMatch && (m === 'GET' || m === 'POST')) {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const other = state.users.find(x => x.id === dmMatch[1]); if (!other) return send(res, 404, { error: 'User not found' });
    if (m === 'GET') {
      const thread = state.messages.filter(x => (x.from === me.id && x.to === other.id) || (x.from === other.id && x.to === me.id)).sort((a, b) => a.at - b.at);
      let changed = false;
      for (const msg of thread) if (msg.to === me.id && !msg.read) { msg.read = true; changed = true; }
      if (changed) save();
      return send(res, 200, { messages: thread, peer: publicUser(other) });
    }
    // POST: privacy gate — friends by default
    const canMsg = isFriend(me.id, other.id) || other.whoCanMessage === 'everyone' || me.role === 'admin';
    if (!canMsg) return send(res, 403, { error: 'Only accepted friends can message this user (their privacy setting)' });
    if (isBlocked(other.id, me.id) || isBlocked(me.id, other.id)) return send(res, 403, { error: 'Blocked' });
    const kind = ['text', 'image', 'file', 'voice', 'gift'].includes(body.kind) ? body.kind : 'text';
    if ((kind === 'image' || kind === 'file' || kind === 'voice') && String(body.dataUrl || '').length > 2.8 * 1024 * 1024) return send(res, 400, { error: 'File too large (2 MB limit)' });
    if (kind === 'text' && !String(body.text || '').trim()) return send(res, 400, { error: 'Empty message' });
    const msg = { id: uid('m'), from: me.id, to: other.id, kind, text: String(body.text || ''), dataUrl: body.dataUrl || '', fileName: String(body.fileName || ''), at: now(), delivered: true, read: false };
    state.messages.push(msg); save();
    return send(res, 200, { message: msg });
  }
  if (p === '/api/conversations' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const peers = new Map();
    for (const msg of state.messages) {
      const peerId = msg.from === me.id ? msg.to : msg.to === me.id ? msg.from : null;
      if (!peerId) continue;
      const cur = peers.get(peerId) || { peer: publicUser(state.users.find(u => u.id === peerId)), last: null, unread: 0 };
      if (!cur.last || msg.at > cur.last.at) cur.last = msg;
      if (msg.to === me.id && !msg.read) cur.unread++;
      peers.set(peerId, cur);
    }
    return send(res, 200, { conversations: [...peers.values()].filter(c => c.peer).sort((a, b) => b.last.at - a.last.at) });
  }

  /* ---------------- rooms ---------------- */
  function roomShape(r, me) {
    const owner = state.users.find(u => u.id === r.ownerId);
    const members = state.roomMembers.filter(x => x.roomId === r.id).map(x => ({ ...x, user: publicUser(state.users.find(u => u.id === x.userId)) }));
    const myMember = me ? state.roomMembers.find(x => x.roomId === r.id && x.userId === me.id) : null;
    return {
      ...r, tier: roomTier(r.xp), owner: publicUser(owner), members, memberCount: members.length,
      seats: Array.from({ length: r.seatCount }, (_, i) => members.find(x => x.seat === i) || null),
      myRole: r.ownerId === (me && me.id) ? 'owner' : myMember ? myMember.role : null,
      isMember: !!myMember, banned: me ? state.roomBans.some(b => b.roomId === r.id && b.userId === me.id) : false,
      music: r.music || null, handQueue: r.handQueue || []
    };
  }
  function roomStaff(r, me) { if (!me) return false; if (r.ownerId === me.id || me.role === 'admin') return true; const mm = state.roomMembers.find(x => x.roomId === r.id && x.userId === me.id); return !!(mm && (mm.role === 'admin' || mm.role === 'moderator')); }

  if (p === '/api/rooms' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const list = state.rooms.filter(r => !r.closed && (r.visibility === 'public' || r.ownerId === me.id || state.roomMembers.some(x => x.roomId === r.id && x.userId === me.id)));
    return send(res, 200, { rooms: list.map(r => roomShape(r, me)) });
  }
  if (p === '/api/rooms' && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const name = String(body.name || '').trim(); if (!name) return send(res, 400, { error: 'Room name is required' });
    const seatCount = Math.min(12, Math.max(4, parseInt(body.seatCount || 8, 10) || 8));
    const room = {
      id: uid('rm'), name, description: String(body.description || ''), topic: String(body.topic || ''), category: String(body.category || 'Dosti'),
      cover: String(body.cover || ''), coverColor: String(body.coverColor || '#6d28d9'), welcome: String(body.welcome || ''),
      visibility: body.visibility === 'private' ? 'private' : 'public', password: body.visibility === 'private' ? String(body.password || '') : '',
      joinPolicy: ['anyone', 'friends', 'invite'].includes(body.joinPolicy) ? body.joinPolicy : 'anyone',
      speakPolicy: ['anyone', 'raisehand', 'staff'].includes(body.speakPolicy) ? body.speakPolicy : 'raisehand',
      seatCount, chatEnabled: body.chatEnabled !== false, slowMode: !!body.slowMode, musicEnabled: body.musicEnabled !== false, raiseHandEnabled: body.raiseHandEnabled !== false,
      modPerms: { approve: true, mute: true, kick: true, ban: false, ...(body.modPerms || {}) },
      ownerId: me.id, xp: me.role === 'admin' ? 1500 : 0, featured: false, closed: false, createdAt: now(), handQueue: [], music: null
    };
    state.rooms.push(room);
    state.roomMembers.push({ roomId: room.id, userId: me.id, role: 'owner', seat: 0, muted: false, joinedAt: now() });
    audit(me.username, 'create-room', name); save();
    return send(res, 200, { room: roomShape(room, me) });
  }
  const roomMatch = p.match(/^\/api\/rooms\/([\w-]+)(?:\/(join|leave|seat|raise-hand|approve-hand|mute|role|ban|unban|invite|messages|music|music-control|settings|heartbeat|close))?(?:\/([\w-]+))?$/);
  if (roomMatch && p.startsWith('/api/rooms/')) {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const room = state.rooms.find(r => r.id === roomMatch[1]); if (!room) return send(res, 404, { error: 'Room not found' });
    const action = roomMatch[2]; const targetId = roomMatch[3];
    const myMember = state.roomMembers.find(x => x.roomId === room.id && x.userId === me.id);
    if (!action && m === 'GET') {
      const full = roomShape(room, me);
      full.messages = state.roomMessages.filter(x => x.roomId === room.id).slice(-100).map(x => ({ ...x, user: publicUser(state.users.find(u => u.id === x.userId)) }));
      full.bans = roomStaff(room, me) ? state.roomBans.filter(b => b.roomId === room.id).map(b => ({ ...b, user: publicUser(state.users.find(u => u.id === b.userId)) })) : [];
      return send(res, 200, { room: full });
    }
    if (action === 'join' && m === 'POST') {
      if (state.roomBans.some(b => b.roomId === room.id && b.userId === me.id)) return send(res, 403, { error: 'You are banned from this room' });
      if (myMember) return send(res, 200, { room: roomShape(room, me) });
      if (room.visibility === 'private' && room.ownerId !== me.id && String(body.password || '') !== room.password) return send(res, 403, { error: 'Wrong room password' });
      if (room.joinPolicy === 'invite' && room.ownerId !== me.id) {
        const inv = state.roomInvites.find(i => i.roomId === room.id && i.to === me.id && !i.used);
        if (!inv) return send(res, 403, { error: 'This room is invite-only' });
        inv.used = true;
        const inviter = state.users.find(u => u.id === inv.from);
        if (inviter && !inv.credited) { inv.credited = true; const g = awardXp(inviter, 'invite', 1); if (g > 0) dailyRec(inviter.id).invitesJoined += 1; }
      }
      if (room.joinPolicy === 'friends' && room.ownerId !== me.id && !isFriend(me.id, room.ownerId)) return send(res, 403, { error: "Only the host's friends can join this room" });
      state.roomMembers.push({ roomId: room.id, userId: me.id, role: 'member', seat: null, muted: false, joinedAt: now() });
      room.xp += 2; save(); return send(res, 200, { room: roomShape(room, me) });
    }
    if (action === 'leave' && m === 'POST') {
      state.roomMembers = state.roomMembers.filter(x => !(x.roomId === room.id && x.userId === me.id));
      state.heartbeats = state.heartbeats.filter(h => !(h.roomId === room.id && h.userId === me.id));
      save(); return send(res, 200, { ok: true });
    }
    if (!myMember && room.ownerId !== me.id) return send(res, 403, { error: 'Join the room first' });
    if (action === 'seat' && m === 'POST') {
      const idx = parseInt(body.seatIndex, 10);
      if (!(idx >= 0 && idx < room.seatCount)) return send(res, 400, { error: 'Bad seat' });
      if (state.roomMembers.some(x => x.roomId === room.id && x.seat === idx && x.userId !== me.id)) return send(res, 400, { error: 'Seat taken' });
      const staff = roomStaff(room, me);
      if (room.speakPolicy === 'staff' && !staff) return send(res, 403, { error: 'Only staff can take a mic seat in this room' });
      if (room.speakPolicy === 'raisehand' && !staff && !room.handQueue.includes(me.id)) { if (!room.handQueue.includes(me.id)) room.handQueue.push(me.id); save(); return send(res, 200, { ok: true, handRaised: true, message: 'Hand raised — waiting for the host' }); }
      myMember.seat = idx; myMember.muted = false; room.handQueue = room.handQueue.filter(x => x !== me.id);
      save(); return send(res, 200, { ok: true, seated: true, room: roomShape(room, me) });
    }
    if (action === 'raise-hand' && m === 'POST') {
      if (!room.raiseHandEnabled) return send(res, 400, { error: 'Raise hand is off in this room' });
      if (!room.handQueue.includes(me.id)) room.handQueue.push(me.id);
      save(); return send(res, 200, { ok: true, handRaised: true });
    }
    if (action === 'approve-hand' && m === 'POST') {
      if (!roomStaff(room, me)) return send(res, 403, { error: 'Staff only' });
      const target = state.roomMembers.find(x => x.roomId === room.id && x.userId === targetId); if (!target) return send(res, 404, { error: 'Member not found' });
      const free = [...Array(room.seatCount).keys()].find(i => !state.roomMembers.some(x => x.roomId === room.id && x.seat === i));
      if (free === undefined) return send(res, 400, { error: 'No free seat' });
      target.seat = free; target.muted = false; room.handQueue = room.handQueue.filter(x => x !== targetId);
      save(); return send(res, 200, { ok: true, room: roomShape(room, me) });
    }
    if (action === 'mute' && m === 'POST') {
      const target = state.roomMembers.find(x => x.roomId === room.id && x.userId === (targetId || me.id)); if (!target) return send(res, 404, { error: 'Member not found' });
      if (target.userId !== me.id && !roomStaff(room, me)) return send(res, 403, { error: 'Staff only' });
      target.muted = body.muted !== undefined ? !!body.muted : !target.muted;
      save(); return send(res, 200, { ok: true, muted: target.muted, room: roomShape(room, me) });
    }
    if (action === 'role' && m === 'POST') {
      if (room.ownerId !== me.id && me.role !== 'admin') return send(res, 403, { error: 'Room owner only' });
      const target = state.roomMembers.find(x => x.roomId === room.id && x.userId === targetId); if (!target) return send(res, 404, { error: 'Member not found' });
      if (!['admin', 'moderator', 'member'].includes(body.role)) return send(res, 400, { error: 'Bad role' });
      target.role = body.role; save(); return send(res, 200, { ok: true, room: roomShape(room, me) });
    }
    if (action === 'ban' && m === 'POST') {
      if (!roomStaff(room, me)) return send(res, 403, { error: 'Staff only' });
      if (room.ownerId !== me.id && !room.modPerms.ban && state.roomMembers.find(x => x.roomId === room.id && x.userId === me.id)?.role !== 'admin') return send(res, 403, { error: 'Moderators do not have ban permission in this room' });
      state.roomMembers = state.roomMembers.filter(x => !(x.roomId === room.id && x.userId === targetId));
      if (!state.roomBans.some(b => b.roomId === room.id && b.userId === targetId)) state.roomBans.push({ roomId: room.id, userId: targetId, by: me.id, at: now() });
      audit(me.username, 'room-ban', targetId); save(); return send(res, 200, { ok: true, room: roomShape(room, me) });
    }
    if (action === 'unban' && m === 'POST') {
      if (!roomStaff(room, me)) return send(res, 403, { error: 'Staff only' });
      state.roomBans = state.roomBans.filter(b => !(b.roomId === room.id && b.userId === targetId));
      save(); return send(res, 200, { ok: true });
    }
    if (action === 'invite' && m === 'POST') {
      const to = state.users.find(u => u.id === targetId); if (!to) return send(res, 404, { error: 'User not found' });
      state.roomInvites.push({ id: uid('ri'), roomId: room.id, from: me.id, to: targetId, used: false, credited: false, at: now() });
      save(); return send(res, 200, { ok: true });
    }
    if (action === 'messages' && m === 'POST') {
      if (!room.chatEnabled) return send(res, 403, { error: 'Room chat is turned off in this room' });
      if (room.slowMode && myMember && myMember.role === 'member') {
        const last = [...state.roomMessages].reverse().find(x => x.roomId === room.id && x.userId === me.id);
        if (last && now() - last.at < 5000) return send(res, 429, { error: 'Slow mode: wait a few seconds between messages' });
      }
      const text = String(body.text || '').trim(); if (!text) return send(res, 400, { error: 'Empty message' });
      const msg = { id: uid('rm2'), roomId: room.id, userId: me.id, text, at: now() };
      state.roomMessages.push(msg); save(); return send(res, 200, { message: { ...msg, user: publicUser(me) } });
    }
    if (action === 'music' && m === 'POST') {
      if (!room.musicEnabled) return send(res, 403, { error: 'Music is turned off in this room' });
      if (String(body.dataUrl || '').length > 7 * 1024 * 1024) return send(res, 400, { error: 'Music file too large' });
      room.music = { name: String(body.name || 'Track'), dataUrl: body.dataUrl, by: me.id, playing: true };
      save(); return send(res, 200, { ok: true, room: roomShape(room, me) });
    }
    if (action === 'music-control' && m === 'POST') {
      if (room.music) room.music.playing = !!body.playing;
      save(); return send(res, 200, { ok: true });
    }
    if (action === 'settings' && m === 'PATCH') {
      if (!roomStaff(room, me)) return send(res, 403, { error: 'Only the room owner or a room admin can change settings' });
      const sensitive = ['visibility', 'password', 'joinPolicy'];
      for (const k of ['name', 'description', 'topic', 'category', 'cover', 'coverColor', 'welcome', 'speakPolicy', 'seatCount', 'chatEnabled', 'slowMode', 'musicEnabled', 'raiseHandEnabled', 'modPerms']) if (body[k] !== undefined) room[k] = k === 'seatCount' ? Math.min(12, Math.max(4, parseInt(body[k], 10) || 8)) : body[k];
      for (const k of sensitive) if (body[k] !== undefined) {
        if (room.ownerId !== me.id && me.role !== 'admin') return send(res, 403, { error: 'Access/password settings are owner-only' });
        room[k] = body[k];
      }
      save(); return send(res, 200, { room: roomShape(room, me) });
    }
    if (action === 'heartbeat' && m === 'POST') {
      // Server-clock timing: first beat only starts the clock; XP is computed from real elapsed time.
      const key = h => h.roomId === room.id && h.userId === me.id;
      let hb = state.heartbeats.find(key);
      const t = now();
      if (!hb) { state.heartbeats.push({ roomId: room.id, userId: me.id, last: t }); save(); return send(res, 200, { earnedNow: 0, xp: me.xp }); }
      const elapsedSec = Math.min((t - hb.last) / 1000, 120);
      hb.last = t;
      const rec = dailyRec(me.id);
      const presenceMin = elapsedSec / 60;
      const speakingMin = body.speaking ? presenceMin : 0;
      rec.presenceMinutes += presenceMin; rec.speakMinutes += speakingMin;
      let earned = awardXp(me, 'presence', presenceMin) + awardXp(me, 'speaking', speakingMin);
      room.xp += earned;
      save();
      return send(res, 200, { earnedNow: earned, xp: me.xp, level: levelFromXp(me.xp, me.role), roomXp: room.xp, roomTier: roomTier(room.xp) });
    }
    if (action === 'close' && m === 'POST') {
      if (room.ownerId !== me.id && me.role !== 'admin') return send(res, 403, { error: 'Owner only' });
      room.closed = true; audit(me.username, 'close-room', room.name); save(); return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Room action not found' });
  }

  /* ---------------- calls (friends only; media honestly needs RTC keys) ---------------- */
  if (p === '/api/calls' && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const other = state.users.find(u => u.id === body.toUserId); if (!other) return send(res, 404, { error: 'User not found' });
    if (!isFriend(me.id, other.id) && other.whoCanCall !== 'everyone') return send(res, 403, { error: 'Only accepted friends can call this user' });
    const call = { id: uid('c'), from: me.id, to: other.id, kind: body.kind === 'video' ? 'video' : 'voice', status: 'ringing', at: now(), answeredAt: null, endedAt: null, rtcNote: state.settings.rtcAppId ? '' : 'Cross-device voice/video media needs the owner to add LiveKit/Agora keys in Admin → Settings. Call signalling and the call screen are live now.' };
    state.calls.push(call); save();
    return send(res, 200, { call: { ...call, peer: publicUser(other) } });
  }
  if (p === '/api/calls/incoming' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const inc = state.calls.filter(c => c.to === me.id && c.status === 'ringing').map(c => ({ ...c, peer: publicUser(state.users.find(u => u.id === c.from)) }));
    const active = state.calls.filter(c => (c.from === me.id || c.to === me.id) && c.status === 'ongoing').map(c => ({ ...c, peer: publicUser(state.users.find(u => u.id === (c.from === me.id ? c.to : c.from))) }));
    return send(res, 200, { incoming: inc, active });
  }
  const callMatch = p.match(/^\/api\/calls\/([\w-]+)\/(respond|end)$/);
  if (callMatch && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const call = state.calls.find(c => c.id === callMatch[1]); if (!call) return send(res, 404, { error: 'Call not found' });
    if (callMatch[2] === 'respond') { call.status = body.accept ? 'ongoing' : 'ended'; call.answeredAt = body.accept ? now() : null; if (!body.accept) call.endedAt = now(); }
    else { call.status = 'ended'; call.endedAt = now(); }
    save(); return send(res, 200, { call });
  }

  /* ---------------- gifts, wallet, payments ---------------- */
  if (p === '/api/gifts' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    return send(res, 200, { gifts: state.gifts, packages: state.packages, wallet: walletOf(me.id), ledger: state.ledger.filter(e => e.userId === me.id).slice(-50).reverse(), giftTxns: state.giftTxns.filter(g => g.from === me.id || g.to === me.id).slice(-20).reverse(), easypaisa: state.settings.easypaisa });
  }
  if (p === '/api/gifts/send' && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const gift = state.gifts.find(g => g.id === body.giftId); const to = state.users.find(u => u.id === body.toUserId);
    if (!gift || !to) return send(res, 404, { error: 'Gift or user not found' });
    if (walletOf(me.id) < gift.price) return send(res, 400, { error: 'Not enough coins' });
    addLedger(me.id, -gift.price, 'gift-send', `Sent ${gift.name} to ${to.displayName}`, gift.id);
    state.giftTxns.push({ id: uid('gt'), from: me.id, to: to.id, giftId: gift.id, giftName: gift.name, emoji: gift.emoji, price: gift.price, roomId: body.roomId || null, at: now() });
    state.messages.push({ id: uid('m'), from: me.id, to: to.id, kind: 'gift', text: `${gift.emoji} ${gift.name}`, dataUrl: '', fileName: '', at: now(), delivered: true, read: false });
    save(); return send(res, 200, { ok: true, wallet: walletOf(me.id) });
  }
  if (p === '/api/coins/request' && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const pack = state.packages.find(x => x.id === body.packageId); if (!pack) return send(res, 404, { error: 'Package not found' });
    const ref = String(body.txnRef || '').trim(); if (ref.length < 6) return send(res, 400, { error: 'Enter the Easypaisa transaction reference (at least 6 characters)' });
    if (state.paymentRequests.some(r => r.txnRef === ref)) return send(res, 400, { error: 'This transaction reference was already submitted' });
    const r = { id: uid('pay'), userId: me.id, packageId: pack.id, coins: pack.coins, priceRs: pack.priceRs, txnRef: ref, status: 'pending', at: now() };
    state.paymentRequests.push(r); audit(me.username, 'payment-request', `${pack.coins} coins, ref ${ref}`); save();
    return send(res, 200, { ok: true, request: r, instructions: `Send Rs ${pack.priceRs} by Easypaisa to ${state.settings.easypaisa}, then wait — coins are credited only after the admin verifies your transaction reference. A receipt alone never auto-approves.` });
  }
  if (p === '/api/payments/mine' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    return send(res, 200, { requests: state.paymentRequests.filter(r => r.userId === me.id).slice().reverse() });
  }

  /* ---------------- verification (live camera only) ---------------- */
  if (p === '/api/verification' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const v = [...state.verifications].reverse().find(x => x.userId === me.id);
    return send(res, 200, { status: me.verificationStatus, latest: v ? { at: v.at, status: v.status } : null });
  }
  if (p === '/api/verification' && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    if (body.liveCapture !== true || !String(body.selfieDataUrl || '').startsWith('data:image/')) return send(res, 400, { error: 'Verification needs a LIVE camera selfie — gallery uploads are not accepted as proof of identity' });
    const age = ageFromDob(me.dob);
    if (age < 18) return send(res, 400, { error: 'Verification is for adults (18+) on Free Talk' });
    const v = { id: uid('v'), userId: me.id, selfieDataUrl: body.selfieDataUrl, status: 'Pending', at: now() };
    state.verifications.push(v); me.verificationStatus = 'Pending';
    audit(me.username, 'verification-submit', 'Live selfie submitted'); save();
    return send(res, 200, { ok: true, status: 'Pending' });
  }

  /* ---------------- badges ---------------- */
  if (p === '/api/badges' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const lt = lifetime(me.id); const lv = levelFromXp(me.xp, me.role);
    const friendCount = state.friendships.filter(f => f.status === 'accepted' && (f.from === me.id || f.to === me.id)).length;
    const vals = {
      profileComplete: (me.avatar && me.bio && me.country) ? 1 : 0,
      verified: me.verificationStatus === 'Verified' ? 1 : 0,
      friends: friendCount, roomsHosted: state.rooms.filter(r => r.ownerId === me.id).length,
      speakMinutes: Math.floor(lt.speakMinutes), invitesJoined: lt.invitesJoined, level: lv.level
    };
    return send(res, 200, { badges: BADGE_DEFS.map(b => ({ ...b, progress: Math.min(vals[b.metric], b.target), unlocked: vals[b.metric] >= b.target })) });
  }

  /* ---------------- posts (Facebook-style) ---------------- */
  function postShape(post) {
    return { ...post, user: publicUser(state.users.find(u => u.id === post.userId)), sharedFromUser: post.sharedFrom ? publicUser(state.users.find(u => u.id === post.sharedFrom)) : null, likes: state.postLikes.filter(l => l.postId === post.id).length, comments: state.postComments.filter(c => c.postId === post.id).map(c => ({ ...c, user: publicUser(state.users.find(u => u.id === c.userId)) })) };
  }
  if (p === '/api/posts' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const mine = url.searchParams.get('mine') === '1';
    let list = [...state.posts].reverse();
    if (mine) list = list.filter(x => x.userId === me.id);
    return send(res, 200, { posts: list.slice(0, 100).map(postShape) });
  }
  if (p === '/api/posts' && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    if (!String(body.text || '').trim() && !body.image) return send(res, 400, { error: 'Write something or add a photo' });
    const post = { id: uid('po'), userId: me.id, text: String(body.text || ''), image: String(body.image || ''), sharedFrom: null, at: now() };
    state.posts.push(post); save(); return send(res, 200, { post: postShape(post) });
  }
  const postMatch = p.match(/^\/api\/posts\/([\w-]+)\/(like|comment|share)$/);
  if (postMatch && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const post = state.posts.find(x => x.id === postMatch[1]); if (!post) return send(res, 404, { error: 'Post not found' });
    if (postMatch[2] === 'like') { if (!state.postLikes.some(l => l.postId === post.id && l.userId === me.id)) state.postLikes.push({ postId: post.id, userId: me.id }); }
    else if (postMatch[2] === 'comment') { const text = String(body.text || '').trim(); if (!text) return send(res, 400, { error: 'Empty comment' }); state.postComments.push({ id: uid('pc'), postId: post.id, userId: me.id, text, at: now() }); }
    else { const shared = { id: uid('po'), userId: me.id, text: post.text, image: post.image, sharedFrom: post.userId, at: now() }; state.posts.push(shared); save(); return send(res, 200, { post: postShape(shared) }); }
    save(); return send(res, 200, { post: postShape(post) });
  }
  if (p === '/api/announcements' && m === 'GET') return send(res, 200, { announcements: state.announcements.slice(0, 10) });
  if (p === '/api/reports' && m === 'POST') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    state.reports.unshift({ id: uid('r'), at: now(), reporterId: me.id, targetType: String(body.targetType || 'room'), targetId: String(body.targetId || ''), reason: String(body.reason || ''), status: 'open' });
    save(); return send(res, 200, { ok: true });
  }
  if (p === '/api/level-info' && m === 'GET') {
    const me = authUser(req); if (!me) return send(res, 401, { error: 'Login required' });
    const rec = dailyRec(me.id); const s = state.settings;
    return send(res, 200, { ...levelFromXp(me.xp, me.role), rates: { presence: s.xpPresenceRate, speaking: s.xpSpeakingRate, invite: s.xpInviteRate }, caps: { presence: s.capPresence, speaking: s.capSpeaking, invite: s.capInvite }, today: { presence: rec.presence, speaking: rec.speaking, invite: rec.invite }, inviteCode: me.ftId });
  }

  /* ---------------- Super Admin (server-side role checks + audit log) ---------------- */
  if (p.startsWith('/api/admin/')) {
    const me = requireAdmin(req, res); if (!me) return;
    if (p === '/api/admin/overview' && m === 'GET') {
      return send(res, 200, {
        users: state.users.length, rooms: state.rooms.filter(r => !r.closed).length, messages: state.messages.length + state.roomMessages.length,
        revenueRs: state.paymentRequests.filter(r => r.status === 'approved').reduce((a, r) => a + r.priceRs, 0),
        coinsCredited: state.paymentRequests.filter(r => r.status === 'approved').reduce((a, r) => a + r.coins, 0),
        pendingPayments: state.paymentRequests.filter(r => r.status === 'pending').length,
        pendingVerifications: state.verifications.filter(v => v.status === 'Pending').length,
        openReports: state.reports.filter(r => r.status === 'open').length,
        gifts: state.gifts.length, giftTxns: state.giftTxns.length
      });
    }
    if (p === '/api/admin/users' && m === 'GET') return send(res, 200, { users: state.users.map(u => ({ ...publicUser(u), sim: u.sim, banned: !!u.banned, wallet: walletOf(u.id) })) });
    const au = p.match(/^\/api\/admin\/users\/([\w-]+)\/ban$/);
    if (au && m === 'POST') { const u = state.users.find(x => x.id === au[1]); if (!u) return send(res, 404, { error: 'User not found' }); u.banned = !!body.banned; audit(me.username, body.banned ? 'ban-user' : 'unban-user', u.username); save(); return send(res, 200, { ok: true }); }
    if (p === '/api/admin/verifications' && m === 'GET') return send(res, 200, { verifications: state.verifications.filter(v => v.status === 'Pending').map(v => ({ ...v, user: publicUser(state.users.find(u => u.id === v.userId)) })) });
    const av = p.match(/^\/api\/admin\/verifications\/([\w-]+)$/);
    if (av && m === 'POST') {
      const v = state.verifications.find(x => x.id === av[1]); if (!v) return send(res, 404, { error: 'Not found' });
      const u = state.users.find(x => x.id === v.userId);
      v.status = body.approve ? 'Verified' : 'Rejected'; if (u) u.verificationStatus = v.status;
      audit(me.username, 'verification-' + v.status.toLowerCase(), u ? u.username : v.userId); save(); return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/payments' && m === 'GET') return send(res, 200, { requests: state.paymentRequests.slice().reverse().map(r => ({ ...r, user: publicUser(state.users.find(u => u.id === r.userId)) })) });
    const ap = p.match(/^\/api\/admin\/payments\/([\w-]+)$/);
    if (ap && m === 'POST') {
      const r = state.paymentRequests.find(x => x.id === ap[1]); if (!r) return send(res, 404, { error: 'Not found' });
      if (r.status !== 'pending') return send(res, 400, { error: 'Already decided' });
      if (body.approve) { r.status = 'approved'; addLedger(r.userId, r.coins, 'coin-purchase', `Easypaisa verified, ref ${r.txnRef}`, r.id); }
      else r.status = 'rejected';
      audit(me.username, 'payment-' + r.status, `${r.coins} coins, ref ${r.txnRef}`); save(); return send(res, 200, { ok: true, status: r.status });
    }
    if (p === '/api/admin/gifts' && m === 'GET') return send(res, 200, { gifts: state.gifts, packages: state.packages });
    const ag = p.match(/^\/api\/admin\/gifts\/([\w-]+)$/);
    if (ag && m === 'PATCH') { const g = state.gifts.find(x => x.id === ag[1]); if (!g) return send(res, 404, { error: 'Not found' }); if (body.price !== undefined) g.price = Math.max(1, parseInt(body.price, 10) || g.price); if (body.name) g.name = String(body.name); audit(me.username, 'gift-edit', g.id); save(); return send(res, 200, { gift: g }); }
    if (p === '/api/admin/gifts' && m === 'POST') { const g = { id: uid('g'), name: String(body.name || 'Gift'), emoji: String(body.emoji || '🎁'), price: Math.max(1, parseInt(body.price, 10) || 10), animated: false }; state.gifts.push(g); audit(me.username, 'gift-create', g.name); save(); return send(res, 200, { gift: g }); }
    const apk2 = p.match(/^\/api\/admin\/packages\/([\w-]+)$/);
    if (apk2 && m === 'PATCH') { const pk = state.packages.find(x => x.id === apk2[1]); if (!pk) return send(res, 404, { error: 'Not found' }); for (const k of ['coins', 'priceRs', 'name']) if (body[k] !== undefined) pk[k] = k === 'name' ? String(body[k]) : parseInt(body[k], 10); audit(me.username, 'package-edit', pk.id); save(); return send(res, 200, { package: pk }); }
    if (p === '/api/admin/rooms' && m === 'GET') return send(res, 200, { rooms: state.rooms.map(r => ({ ...r, tier: roomTier(r.xp), owner: publicUser(state.users.find(u => u.id === r.ownerId)) })) });
    const ar = p.match(/^\/api\/admin\/rooms\/([\w-]+)\/feature$/);
    if (ar && m === 'POST') { const r = state.rooms.find(x => x.id === ar[1]); if (!r) return send(res, 404, { error: 'Not found' }); r.featured = !!body.featured; audit(me.username, 'room-feature', r.name); save(); return send(res, 200, { ok: true }); }
    if (p === '/api/admin/reports' && m === 'GET') return send(res, 200, { reports: state.reports.map(r => ({ ...r, reporter: publicUser(state.users.find(u => u.id === r.reporterId)) })) });
    const arp = p.match(/^\/api\/admin\/reports\/([\w-]+)$/);
    if (arp && m === 'POST') { const r = state.reports.find(x => x.id === arp[1]); if (!r) return send(res, 404, { error: 'Not found' }); r.status = body.status || 'closed'; audit(me.username, 'report-' + r.status, r.id); save(); return send(res, 200, { ok: true }); }
    if (p === '/api/admin/announcements' && m === 'POST') { const a = { id: uid('an'), text: String(body.text || ''), at: now() }; state.announcements.unshift(a); audit(me.username, 'announcement', a.text.slice(0, 60)); save(); return send(res, 200, { announcement: a }); }
    if (p === '/api/admin/ledger' && m === 'GET') return send(res, 200, { ledger: state.ledger.slice(-200).reverse().map(e => ({ ...e, user: publicUser(state.users.find(u => u.id === e.userId)) })) });
    if (p === '/api/admin/audit' && m === 'GET') return send(res, 200, { auditLog: state.auditLog });
    if (p === '/api/admin/settings' && m === 'GET') return send(res, 200, { settings: state.settings });
    if (p === '/api/admin/settings' && m === 'PATCH') { for (const k of Object.keys(state.settings)) if (body[k] !== undefined) state.settings[k] = body[k]; audit(me.username, 'settings-edit', Object.keys(body).join(',')); save(); return send(res, 200, { settings: state.settings }); }
    return send(res, 404, { error: 'Admin endpoint not found' });
  }

  return send(res, 404, { error: 'Not found: ' + p });
}

/* ---------------- static + server ---------------- */
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const fp = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!fp.startsWith(PUBLIC_DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      const idx = path.join(PUBLIC_DIR, 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(idx));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(fs.readFileSync(fp));
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: e.message }); }
});
loadState().then(() => server.listen(PORT, () => console.log(`Free Talk deploy copy listening on :${PORT} (db: ${pgPool ? 'Postgres' : 'file'})`)));
