/* Free Talk deploy copy — local smoke test.
   Copies the project to a temp dir (so the shipped data/ stays EMPTY),
   starts the server on a test port with the file DB, and exercises:
   health → OTP → register (owner) → login → register friend with invite code →
   friend request/accept → DM + read receipt → create room → join → heartbeat →
   buy coins (Easypaisa ref) → admin approve → balance → send gift → admin overview.
   Prints PASS/FAIL per check; exit code 1 if anything fails. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-smoke-'));
fs.cpSync(SRC, TMP, { recursive: true, filter: f => !f.includes('node_modules') && !f.includes(`${path.sep}data${path.sep}`) });
const PORT = 18777;
const BASE = `http://127.0.0.1:${PORT}/api`;
let failures = 0;
function check(name, cond, extra = '') { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; }
async function call(p, method = 'GET', body, token) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn('node', ['server.js'], { cwd: TMP, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
let srvLog = ''; srv.stdout.on('data', d => srvLog += d); srv.stderr.on('data', d => srvLog += d);
try {
  let up = false;
  for (let i = 0; i < 30; i++) { try { const h = await call('/health'); if (h.d.ok) { up = true; break; } } catch {} await wait(300); }
  check('server starts + health', up, srvLog.trim().split('\n').pop() || '');

  // OTP + register owner (first account)
  const otp1 = await call('/auth/request-otp', 'POST', { sim: '+923001111111' });
  check('request-otp returns in-app code (no SMS provider)', otp1.status === 200 && /^\d{6}$/.test(otp1.d.code || ''));
  const bad = await call('/auth/register', 'POST', { sim: '+923001111111', otpCode: '000000', password: 'secret1', displayName: 'Owner One', username: 'owner1', dob: '1998-05-01', country: 'Pakistan' });
  check('wrong OTP rejected', bad.status === 400);
  const reg1 = await call('/auth/register', 'POST', { sim: '+923001111111', otpCode: otp1.d.code, password: 'secret1', displayName: 'Owner One', username: 'owner1', dob: '1998-05-01', country: 'Pakistan' });
  check('register owner', reg1.status === 200 && !!reg1.d.token, JSON.stringify(reg1.d).slice(0, 120));
  const t1 = reg1.d.token, owner = reg1.d.user;
  check('first account is owner + TOP (Lv 10, 10000 XP)', owner.isOwner === true && owner.isTop === true && owner.level === 10 && owner.xp === 10000);
  check('public shape hides full DOB', owner.dob === undefined && owner.age === new Date().getFullYear() - 1998 || owner.age === 27 || owner.age === 28);

  const dup = await call('/auth/request-otp', 'POST', { sim: '+923001111111' });
  const dupReg = await call('/auth/register', 'POST', { sim: '+923001111111', otpCode: dup.d.code, password: 'secret1', displayName: 'Dup', username: 'dupuser', dob: '1999-01-01', country: 'Pakistan' });
  check('one SIM = one account (duplicate rejected)', dupReg.status === 400);

  const loginBad = await call('/auth/login', 'POST', { sim: '+923001111111', password: 'wrong' });
  check('login wrong password rejected', loginBad.status === 401);
  const login = await call('/auth/login', 'POST', { sim: '+923001111111', password: 'secret1' });
  check('login ok', login.status === 200 && !!login.d.token);

  // Friend registers with owner's invite code -> owner is admin so XP pinned; use friend->friend invite for XP check below
  const otp2 = await call('/auth/request-otp', 'POST', { sim: '+923002222222' });
  const reg2 = await call('/auth/register', 'POST', { sim: '+923002222222', otpCode: otp2.d.code, password: 'secret2', displayName: 'Bilal Friend', username: 'bilal2', dob: '2000-03-03', country: 'India', inviteCode: owner.ftId });
  check('register friend', reg2.status === 200);
  const t2 = reg2.d.token, friend = reg2.d.user;
  check('friend starts Lv 1, not top', friend.level === 1 && friend.isTop === false);

  // Friend invites a third user -> friend earns +50 invite XP
  const otp3 = await call('/auth/request-otp', 'POST', { sim: '+923003333333' });
  const reg3 = await call('/auth/register', 'POST', { sim: '+923003333333', otpCode: otp3.d.code, password: 'secret3', displayName: 'Sara Third', username: 'sara3', dob: '2001-07-07', country: 'UAE', inviteCode: friend.ftId });
  check('register third user', reg3.status === 200);
  const t3 = reg3.d.token;
  const friendMe = await call('/me', 'GET', null, t2);
  check('invite XP +50 credited on actual join', friendMe.d.user.xp === 50, 'xp=' + friendMe.d.user.xp);

  // Friend request owner->friend, friend accepts, DM both ways + read receipt
  const fr = await call(`/users/${friend.id}/request`, 'POST', {}, t1);
  check('friend request sent', fr.status === 200);
  const early = await call(`/messages/${owner.id}`, 'POST', { kind: 'text', text: 'too early' }, t2);
  check('DM blocked before friendship (friends-only default)', early.status === 403);
  const acc = await call(`/users/${owner.id}/respond`, 'POST', { accept: true }, t2);
  check('friend request accepted', acc.status === 200);
  const dm = await call(`/messages/${friend.id}`, 'POST', { kind: 'text', text: 'Assalam o alaikum dost' }, t1);
  check('DM sent after accept', dm.status === 200 && dm.d.message.delivered === true && dm.d.message.read === false);
  const thread = await call(`/messages/${owner.id}`, 'GET', null, t2);
  check('read receipt flips after recipient opens thread', thread.status === 200 && thread.d.messages[0].read === true);

  // Room: owner creates, friend joins, heartbeat instant earns 0 (server clock)
  const room = await call('/rooms', 'POST', { name: 'Smoke Room', topic: 'Test', seatCount: 8, speakPolicy: 'anyone', visibility: 'public' }, t1);
  check('create room', room.status === 200 && room.d.room.tier === 'Legendary', 'owner room tier=' + (room.d.room && room.d.room.tier));
  const rid = room.d.room.id;
  const join = await call(`/rooms/${rid}/join`, 'POST', {}, t2);
  check('friend joins room', join.status === 200);
  const hb1 = await call(`/rooms/${rid}/heartbeat`, 'POST', { speaking: true }, t2);
  const hb2 = await call(`/rooms/${rid}/heartbeat`, 'POST', { speaking: true }, t2);
  check('heartbeat: fake instant speaking earns 0', hb1.d.earnedNow === 0 && hb2.d.earnedNow === 0);
  const rmsg = await call(`/rooms/${rid}/messages`, 'POST', { text: 'Room gapshap' }, t2);
  check('room chat message', rmsg.status === 200);

  // Wallet: friend requests coins (Popular Pack 550), owner(Admin) approves -> +550 exactly, gift send deducts
  const pay = await call('/coins/request', 'POST', { packageId: 'p2', txnRef: 'TXN-SMOKE-12345' }, t2);
  check('coin purchase request (pending, not auto-credited)', pay.status === 200);
  const w0 = await call('/gifts', 'GET', null, t2);
  check('balance still 0 before admin verification', w0.d.wallet === 0);
  const pays = await call('/admin/payments', 'GET', null, t1);
  const reqId = pays.d.requests.find(r => r.txnRef === 'TXN-SMOKE-12345')?.id;
  const appr = await call(`/admin/payments/${reqId}`, 'POST', { approve: true }, t1);
  check('admin approves payment', appr.status === 200);
  const w1 = await call('/gifts', 'GET', null, t2);
  check('balance exactly 550 after approval', w1.d.wallet === 550, 'wallet=' + w1.d.wallet);
  const gift = await call('/gifts/send', 'POST', { toUserId: owner.id, giftId: 'g1' }, t2);
  const w2 = await call('/gifts', 'GET', null, t2);
  check('gift send deducts 10 (Rose) -> 540 + ledger entry', gift.status === 200 && w2.d.wallet === 540 && w2.d.ledger.length >= 2);
  const nonAdmin = await call('/admin/overview', 'GET', null, t2);
  check('admin endpoints reject non-admin (server-side role check)', nonAdmin.status === 403);
  const over = await call('/admin/overview', 'GET', null, t1);
  check('admin overview responds', over.status === 200 && over.d.users === 3 && over.d.revenueRs === 500);

  // Verification: gallery-style submit (liveCapture false) must be rejected; live capture accepted
  const vBad = await call('/verification', 'POST', { selfieDataUrl: 'data:image/png;base64,x', liveCapture: false }, t3);
  check('verification rejects non-live upload', vBad.status === 400);
  const vOk = await call('/verification', 'POST', { selfieDataUrl: 'data:image/jpeg;base64,x', liveCapture: true }, t3);
  check('live-selfie verification submitted -> Pending', vOk.status === 200);
  const vList = await call('/admin/verifications', 'GET', null, t1);
  const vid = vList.d.verifications[0]?.id;
  const vApp = await call(`/admin/verifications/${vid}`, 'POST', { approve: true }, t1);
  const thirdMe = await call('/me', 'GET', null, t3);
  check('admin approval flips to Verified', vApp.status === 200 && thirdMe.d.user.verificationStatus === 'Verified' && thirdMe.d.user.verified === true);

  // Call state machine: friends owner<->friend
  const callR = await call('/calls', 'POST', { toUserId: friend.id, kind: 'voice' }, t1);
  check('call created ringing', callR.status === 200 && callR.d.call.status === 'ringing');
  const resp = await call(`/calls/${callR.d.call.id}/respond`, 'POST', { accept: true }, t2);
  const end = await call(`/calls/${callR.d.call.id}/end`, 'POST', {}, t1);
  check('call accept -> ongoing, end -> ended', resp.d.call.status === 'ongoing' && end.d.call.status === 'ended');

  // Posts
  const post = await call('/posts', 'POST', { text: 'First post from smoke test' }, t2);
  const like = await call(`/posts/${post.d.post.id}/like`, 'POST', {}, t3);
  const share = await call(`/posts/${post.d.post.id}/share`, 'POST', {}, t3);
  check('post + like + share (sharedFrom attribution)', post.status === 200 && like.d.post.likes === 1 && share.d.post.sharedFrom === friend.id);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
} catch (e) {
  console.error('SMOKE ERROR', e); failures++;
} finally {
  srv.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
