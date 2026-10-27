'use strict';
/* Free Talk — front end (deployable copy). Talks only to /api on this origin. */
const COUNTRIES = ['Pakistan', 'India', 'Bangladesh', 'UAE', 'Saudi Arabia', 'Turkey', 'United Kingdom', 'USA', 'Canada', 'Germany', 'Malaysia', 'Indonesia', 'Egypt', 'Afghanistan', 'Other'];
const FLAG = { Pakistan: '🇵🇰', India: '🇮🇳', Bangladesh: '🇧🇩', UAE: '🇦🇪', 'Saudi Arabia': '🇸🇦', Turkey: '🇹🇷', 'United Kingdom': '🇬🇧', USA: '🇺🇸', Canada: '🇨🇦', Germany: '🇩🇪', Malaysia: '🇲🇾', Indonesia: '🇮🇩', Egypt: '🇪🇬', Afghanistan: '🇦🇫', Other: '🌍' };
let token = localStorage.getItem('ft_token') || '';
let me = null;
let curView = 'home';
let curRoom = null, curPeer = null, curCall = null;
let micStream = null, analyser = null, hbTimer = null, speakingNow = false;
let callTimer = null, callStartedAt = null, localCallStream = null;
let recorder = null, recChunks = [];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 3200) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms); }
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
function avatarHtml(u, cls = '') {
  if (!u) return `<div class="avatar ${cls}">?</div>`;
  return `<div class="avatar ${cls}">${u.avatar ? `<img src="${u.avatar}" alt="">` : esc((u.displayName || '?')[0].toUpperCase())}</div>`;
}
function levelChip(u) {
  if (u.isTop) return `<span class="chip gold">👑 TOP · Lv ${u.level} ${esc(u.levelTitle)}</span>`;
  return `<span class="chip">Lv ${u.level} ${esc(u.levelTitle)}</span>`;
}
function personCard(u) {
  return `<div class="person">${avatarHtml(u, 'big')}<div style="margin-top:6px;font-weight:700">${esc(u.displayName)} ${u.verified ? '✅' : ''}</div>
  <div class="mut small">${FLAG[u.country] || '🌍'} ${esc(u.country || '')} · Age ${u.age ?? '—'}</div>
  <div style="margin:5px 0">${levelChip(u)}</div>
  <div class="row" style="justify-content:center"><span class="dot ${u.online ? 'on' : ''}"></span><span class="mut small">${u.online ? 'Online' : 'Offline'}</span></div>
  <div style="margin-top:8px;display:flex;gap:6px;justify-content:center"><button class="small" onclick="userAction('${u.id}','request')">➕ Friend</button><button class="small ghost" onclick="openUser('${u.id}')">View</button></div></div>`;
}

/* ---------------- auth ---------------- */
function authTab(t) {
  for (const k of ['login', 'register', 'forgot']) { $('tab' + k[0].toUpperCase() + k.slice(1)).classList.toggle('act', k === t); $(k + 'Box').classList.toggle('hidden', k !== t); }
}
async function requestOtp(prefix) {
  try {
    const sim = $(prefix + 'Sim').value;
    const d = await api('/auth/request-otp', 'POST', { sim });
    $(prefix + 'OtpNote').innerHTML = `<div class="announce">Your code: <b style="font-size:1.2rem;letter-spacing:3px">${d.code}</b><br><span class="small">${esc(d.note)}</span></div>`;
  } catch (e) { toast(e.message); }
}
async function doRegister() {
  try {
    const d = await api('/auth/register', 'POST', { sim: $('rgSim').value, otpCode: $('rgOtp').value, password: $('rgPw').value, displayName: $('rgName').value, username: $('rgUser').value, dob: $('rgDob').value, country: $('rgCountry').value, inviteCode: $('rgInvite').value });
    token = d.token; localStorage.setItem('ft_token', token); me = d.user;
    toast(d.user.isOwner ? 'Welcome, Owner! Your account is TOP level 👑' : 'Account created — welcome to Free Talk!');
    enterApp();
  } catch (e) { toast(e.message); }
}
async function doLogin() {
  try { const d = await api('/auth/login', 'POST', { sim: $('liSim').value, password: $('liPw').value }); token = d.token; localStorage.setItem('ft_token', token); me = d.user; enterApp(); }
  catch (e) { toast(e.message); }
}
async function doReset() {
  try { await api('/auth/reset-password', 'POST', { sim: $('fgSim').value, otpCode: $('fgOtp').value, newPassword: $('fgPw').value }); toast('Password reset — log in now'); authTab('login'); }
  catch (e) { toast(e.message); }
}
async function doLogout() { try { await api('/auth/logout', 'POST', {}); } catch {} token = ''; me = null; localStorage.removeItem('ft_token'); location.reload(); }

function enterApp() {
  $('authView').classList.add('hidden'); $('appView').classList.remove('hidden');
  refreshMe(); go('home');
  setInterval(pollIncoming, 5000);
}
async function refreshMe() {
  try { const d = await api('/me'); me = d.user; $('walletChip').textContent = '🪙 ' + d.wallet; $('meAvatar').innerHTML = me.avatar ? `<img src="${me.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : esc(me.displayName[0].toUpperCase()); }
  catch { /* session expired */ }
}

/* ---------------- navigation ---------------- */
function go(view) {
  curView = view;
  for (const v of ['home', 'rooms', 'friends', 'messages', 'gifts', 'profile']) { $('view-' + v).classList.toggle('hidden', v !== view); }
  document.querySelectorAll('nav.bottom button').forEach(b => b.classList.toggle('act', b.dataset.nav === view));
  ({ home: renderHome, rooms: renderRooms, friends: renderFriends, messages: renderMessages, gifts: renderGifts, profile: renderProfile })[view]();
  window.scrollTo(0, 0);
}

/* ---------------- home ---------------- */
async function renderHome() {
  const el = $('view-home'); el.innerHTML = '<div class="card">Loading…</div>';
  try {
    const [ann, rooms, users, posts] = await Promise.all([api('/announcements'), api('/rooms'), api('/users'), api('/posts')]);
    $('announceBox').innerHTML = ann.announcements.map(a => `<div class="announce">📢 ${esc(a.text)}</div>`).join('');
    el.innerHTML = `
    <div class="hero"><h2>Make friends from every country 🌍</h2><p class="mut" style="color:#cfd2ff">Unlimited gapshap, free video calls and live rooms.</p>
      <p style="margin-top:8px"><span class="chip free">FREE • No coins needed • Unlimited</span></p></div>
    <h3 style="margin:14px 0 4px">🔴 Live rooms</h3>
    <div>${rooms.rooms.length ? rooms.rooms.map(r => roomCard(r)).join('') : '<div class="card mut">No rooms yet — create the first one from the Rooms tab.</div>'}</div>
    <h3 style="margin:16px 0 4px">✍️ Share a post</h3>
    <div class="card"><textarea id="postText" rows="2" placeholder="What's on your mind?"></textarea>
      <div class="row"><label class="grow" style="margin:0">Photo <input type="file" id="postImg" accept="image/*"></label><button onclick="createPost()">Post</button></div></div>
    <div id="feedBox">${posts.posts.map(postHtml).join('') || '<div class="card mut">No posts yet.</div>'}</div>
    <h3 style="margin:16px 0 4px">🌍 Discover people</h3>
    <div class="row"><select id="discCountry" onchange="renderDiscover()"><option value="">All countries</option>${users.countries.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
    <div class="grid" id="discGrid">${users.users.filter(u => u.id !== me.id).map(personCard).join('') || '<div class="card mut">No other users yet — invite your friends with your Free Talk ID: <b>' + me.ftId + '</b></div>'}</div>`;
  } catch (e) { el.innerHTML = `<div class="card">Free Talk didn't load — ${esc(e.message)} <button class="small" onclick="renderHome()">Tap to retry</button></div>`; }
}
async function renderDiscover() {
  const c = $('discCountry').value;
  const d = await api('/users' + (c ? '?country=' + encodeURIComponent(c) : ''));
  $('discGrid').innerHTML = d.users.filter(u => u.id !== me.id).map(personCard).join('') || '<div class="card mut">Nobody here yet.</div>';
}
function roomCard(r) {
  const bg = r.cover ? `background-image:linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.65)),url(${r.cover})` : `background:linear-gradient(130deg,${esc(r.coverColor)},#1e1b4b)`;
  return `<div class="roomcard" style="${bg};margin:8px 0" onclick="openRoom('${r.id}')">
    <div class="row"><b style="font-size:1.05rem">${r.featured ? '⭐ ' : ''}${esc(r.name)}</b><span class="grow"></span><span class="chip gold">${esc(r.tier)}</span><span class="chip">${r.visibility === 'private' ? '🔒 Private' : '🌐 Public'}</span></div>
    <div class="small" style="opacity:.9">${esc(r.topic || r.category || '')} · 👥 ${r.memberCount} · Host: ${esc(r.owner?.displayName || '')}</div></div>`;
}
function postHtml(p) {
  return `<div class="card"><div class="row">${avatarHtml(p.user)}<div class="grow"><b>${esc(p.user?.displayName || '')}</b> ${p.user?.verified ? '✅' : ''}<div class="mut small">${new Date(p.at).toLocaleString()}${p.sharedFromUser ? ' · shared from ' + esc(p.sharedFromUser.displayName) : ''}</div></div></div>
  ${p.text ? `<p style="margin-top:8px">${esc(p.text)}</p>` : ''}${p.image ? `<img src="${p.image}" style="width:100%;border-radius:12px;margin-top:8px">` : ''}
  <div class="row" style="margin-top:9px"><button class="small ghost" onclick="postAct('${p.id}','like')">❤️ ${p.likes}</button>
  <button class="small ghost" onclick="postComment('${p.id}')">💬 ${p.comments.length}</button>
  <button class="small ghost" onclick="postAct('${p.id}','share')">↗️ Share</button></div>
  ${p.comments.map(c => `<div class="small" style="margin-top:6px"><b>${esc(c.user?.displayName || '')}:</b> ${esc(c.text)}</div>`).join('')}</div>`;
}
async function postAct(id, act) { try { await api('/posts/' + id + '/' + act, 'POST', {}); if (curView === 'home') renderHome(); if (curView === 'profile') renderProfile(); } catch (e) { toast(e.message); } }
async function postComment(id) { const text = prompt('Your comment:'); if (!text) return; try { await api('/posts/' + id + '/comment', 'POST', { text }); if (curView === 'home') renderHome(); if (curView === 'profile') renderProfile(); } catch (e) { toast(e.message); } }
function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
async function createPost() {
  try {
    const f = $('postImg').files[0];
    const image = f ? await fileToDataUrl(f) : '';
    await api('/posts', 'POST', { text: $('postText').value, image });
    renderHome();
  } catch (e) { toast(e.message); }
}
async function userAction(id, action) { try { await api('/users/' + id + '/' + action, 'POST', {}); toast(action === 'request' ? 'Friend request sent' : 'Done'); } catch (e) { toast(e.message); } }
async function openUser(id) {
  try {
    const d = await api('/users/' + id); const u = d.user;
    const wins = window; // simple detail via toast-like card injected into home
    const html = `<div class="card" id="userSheet">${avatarHtml(u, 'big')}<h3 style="margin-top:8px">${esc(u.displayName)} ${u.verified ? '✅' : ''}</h3>
    <div class="mut small">@${esc(u.username)} · ${esc(u.ftId)} · ${FLAG[u.country] || ''} ${esc(u.country || '')} · Age ${u.age ?? '—'}</div>
    <p style="margin:7px 0">${esc(u.bio || '')}</p>${levelChip(u)}
    <div class="row" style="margin-top:10px;flex-wrap:wrap">
      ${d.relation === 'none' ? `<button class="small" onclick="userAction('${u.id}','request')">➕ Add friend</button>` : ''}
      ${d.relation === 'pending' && d.relationFrom === u.id ? `<button class="small" onclick="respondFriend('${u.id}',true)">✔ Accept</button><button class="small ghost" onclick="respondFriend('${u.id}',false)">✖ Reject</button>` : ''}
      ${d.relation === 'accepted' ? `<button class="small" onclick="openChat('${u.id}')">💬 Message</button><button class="small" onclick="startCall('${u.id}','voice')">📞 Voice</button><button class="small" onclick="startCall('${u.id}','video')">🎥 Video</button>` : ''}
      <button class="small ghost" onclick="userAction('${u.id}','like')">❤️ Like</button>
      <button class="small ghost" onclick="userAction('${u.id}','block');go('friends')">🚫 Block</button>
      <button class="small danger" onclick="reportUser('${u.id}')">⚠️ Report</button>
      <button class="small ghost" onclick="document.getElementById('userSheet').remove()">Close</button></div></div>`;
    $('view-' + curView).insertAdjacentHTML('afterbegin', html); window.scrollTo(0, 0);
  } catch (e) { toast(e.message); }
}
async function reportUser(id) { const reason = prompt('Reason for report:'); if (!reason) return; try { await api('/users/' + id + '/report', 'POST', { reason }); toast('Reported — admin will review'); } catch (e) { toast(e.message); } }
async function respondFriend(id, accept) { try { await api('/users/' + id + '/respond', 'POST', { accept }); toast(accept ? 'Friend added' : 'Request rejected'); go(curView); } catch (e) { toast(e.message); } }

/* ---------------- friends ---------------- */
async function renderFriends() {
  const el = $('view-friends');
  try {
    const d = await api('/friends');
    const row = u => `<div class="card"><div class="row">${avatarHtml(u)}<div class="grow"><b>${esc(u.displayName)}</b> ${u.verified ? '✅' : ''}<div class="mut small">${FLAG[u.country] || ''} ${esc(u.country || '')} · Age ${u.age ?? '—'} · ${u.online ? 'Online' : 'Offline'}</div></div></div></div>`;
    el.innerHTML = `<h3>👥 Friends</h3>
    ${d.incoming.length ? '<h4 style="margin:10px 0 2px">Requests for you</h4>' + d.incoming.map(u => `<div class="card"><div class="row">${avatarHtml(u)}<div class="grow"><b>${esc(u.displayName)}</b><div class="mut small">${esc(u.country || '')}</div></div><button class="small" onclick="respondFriend('${u.id}',true)">✔ Accept</button><button class="small ghost" onclick="respondFriend('${u.id}',false)">✖</button></div></div>`).join('') : ''}
    ${d.friends.length ? d.friends.map(u => `<div class="card"><div class="row">${avatarHtml(u)}<div class="grow"><b>${esc(u.displayName)}</b> ${u.verified ? '✅' : ''}<div class="mut small">${u.online ? 'Online' : 'Offline'} · ${esc(u.country || '')}</div></div><button class="small" onclick="openChat('${u.id}')">💬</button><button class="small" onclick="startCall('${u.id}','voice')">📞</button><button class="small" onclick="startCall('${u.id}','video')">🎥</button></div></div>`).join('') : '<div class="card mut">No friends yet — find people on Home → Discover and send a request.</div>'}
    ${d.outgoing.length ? '<h4 style="margin:10px 0 2px">Sent by you</h4>' + d.outgoing.map(row).join('') : ''}`;
  } catch (e) { el.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}

/* ---------------- rooms ---------------- */
async function renderRooms() {
  const el = $('view-rooms');
  try {
    const d = await api('/rooms');
    el.innerHTML = `<button style="width:100%;font-size:1.05rem;padding:14px" onclick="toggleCreateRoom()">➕ Create a Room</button>
    <div id="createRoomBox" class="card hidden">
      <label>Room name</label><input id="crName" placeholder="e.g. Urdu Dost Room">
      <label>Description</label><input id="crDesc" placeholder="What is this room about?">
      <label>Topic</label><input id="crTopic" placeholder="Topic">
      <label>Category</label><select id="crCat"><option>Dosti</option><option>Music</option><option>Learning</option><option>Fun</option><option>Islamic</option><option>News</option></select>
      <label>Welcome message</label><input id="crWelcome" placeholder="Welcome to my room!">
      <label>Cover colour</label><input id="crColor" type="color" value="#6d28d9" style="height:44px;padding:4px">
      <label>Cover photo (optional)</label><input type="file" id="crCover" accept="image/*">
      <label>Visibility</label><select id="crVis" onchange="document.getElementById('crPw').classList.toggle('hidden',this.value!=='private')"><option value="public">Public</option><option value="private">Private (password)</option></select>
      <input id="crPw" class="hidden" placeholder="Room password">
      <label>Who can join</label><select id="crJoin"><option value="anyone">Anyone</option><option value="friends">Host's friends</option><option value="invite">Invite only</option></select>
      <label>Who can speak</label><select id="crSpeak"><option value="raisehand">Raise-hand approval</option><option value="anyone">Anyone</option><option value="staff">Staff only</option></select>
      <label>Mic seats (4–12)</label><input id="crSeats" type="number" min="4" max="12" value="8">
      <div class="row" style="margin-top:8px;flex-wrap:wrap"><label style="margin:0"><input type="checkbox" id="crChat" checked style="width:auto"> Room chat</label><label style="margin:0"><input type="checkbox" id="crMusic" checked style="width:auto"> Music</label><label style="margin:0"><input type="checkbox" id="crHand" checked style="width:auto"> Raise hand</label><label style="margin:0"><input type="checkbox" id="crSlow" style="width:auto"> Slow mode</label></div>
      <button style="width:100%;margin-top:10px" onclick="createRoom()">Create room</button>
    </div>
    <h3 style="margin:14px 0 2px">Rooms</h3>
    ${d.rooms.length ? d.rooms.map(roomCard).join('') : '<div class="card mut">No rooms yet.</div>'}`;
  } catch (e) { el.innerHTML = `<div class="card">${esc(e.message)} <button class="small" onclick="renderRooms()">Retry</button></div>`; }
}
function toggleCreateRoom() { $('createRoomBox').classList.toggle('hidden'); }
async function shrinkImage(file, max = 900) {
  const url = await fileToDataUrl(file);
  return new Promise(res => { const img = new Image(); img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.75)); }; img.onerror = () => res(url); img.src = url; });
}
async function createRoom() {
  try {
    const f = $('crCover').files[0];
    const cover = f ? await shrinkImage(f) : '';
    const d = await api('/rooms', 'POST', { name: $('crName').value, description: $('crDesc').value, topic: $('crTopic').value, category: $('crCat').value, welcome: $('crWelcome').value, coverColor: $('crColor').value, cover, visibility: $('crVis').value, password: $('crPw').value, joinPolicy: $('crJoin').value, speakPolicy: $('crSpeak').value, seatCount: $('crSeats').value, chatEnabled: $('crChat').checked, musicEnabled: $('crMusic').checked, raiseHandEnabled: $('crHand').checked, slowMode: $('crSlow').checked });
    toast('Room created'); openRoom(d.room.id);
  } catch (e) { toast(e.message); }
}
async function openRoom(id, password) {
  try {
    let d = await api('/rooms/' + id);
    if (!d.room.isMember && d.room.ownerId !== me.id) {
      try { const j = await api('/rooms/' + id + '/join', 'POST', { password: password || '' }); d = { room: (await api('/rooms/' + id)).room }; }
      catch (e) {
        if (e.message.includes('password')) { const pw = prompt('This room needs a password:'); if (pw) return openRoom(id, pw); }
        toast(e.message); return;
      }
    }
    curRoom = d.room; drawRoom();
  } catch (e) { toast(e.message); }
}
function drawRoom() {
  const r = curRoom; if (!r) return;
  const staff = r.myRole === 'owner' || r.myRole === 'admin' || r.myRole === 'moderator' || me.isOwner;
  const mySeat = r.members.find(x => x.userId === me.id);
  $('roomView').classList.remove('hidden');
  $('roomView').innerHTML = `
  <div class="row"><button class="ghost small" onclick="leaveRoomView()">← Back</button><div class="grow"><b style="font-size:1.1rem">${esc(r.name)}</b> <span class="chip gold">${esc(r.tier)}</span> ${r.visibility === 'private' ? '<span class="chip">🔒</span>' : ''}
  <div class="mut small">${esc(r.topic || '')} · 👥 ${r.memberCount} · XP ${r.xp}</div></div>
  ${staff ? '<button class="small ghost" onclick="toggleRoomSettings()">⚙️ Settings</button>' : ''}</div>
  ${r.welcome ? `<div class="announce">${esc(r.welcome)}</div>` : ''}
  <div class="mut small" style="margin-top:4px">${esc(r.description || '')}</div>
  <span class="chip free">FREE • No coins needed • Unlimited</span>
  <div class="seats">${r.seats.map((s, i) => s ? `<div class="seat" data-seat="${i}"><div class="ring">${s.user?.avatar ? `<img src="${s.user.avatar}">` : '🎙️'}</div><div class="small">${esc(s.user?.displayName?.split(' ')[0] || '')}${s.muted ? ' 🔇' : ''}</div><div class="mut small">${s.role}</div></div>` : `<div class="seat" onclick="takeSeat(${i})"><div class="ring">➕</div><div class="small">Seat ${i + 1}</div><div class="mut small">Tap to sit</div></div>`).join('')}</div>
  <div class="card"><div class="row"><button id="micBtn" style="flex:1" onclick="toggleMic()">🎙️ ${mySeat && mySeat.seat !== null && mySeat.seat !== undefined ? 'Leave mic / mute' : 'Take the mic'}</button>
  <button class="ghost" onclick="raiseHand()">✋ Raise hand</button></div>
  <div class="row" style="margin-top:10px"><span class="small mut" id="micStatus">Mic off</span><div class="meter"><i id="micMeter"></i></div></div>
  ${r.handQueue?.length && staff ? `<div style="margin-top:8px">${r.handQueue.map(uid2 => { const u = r.members.find(x => x.userId === uid2)?.user; return u ? `<div class="row"><span class="grow">✋ ${esc(u.displayName)} wants the mic</span><button class="small" onclick="roomAct('approve-hand/${uid2}')">Approve</button></div>` : ''; }).join('')}</div>` : ''}
  </div>
  <div id="roomSettings"></div>
  ${r.musicEnabled ? `<div class="card"><b>🎵 Room music</b><div class="row" style="margin-top:6px"><input type="file" id="roomMusicFile" accept="audio/*" class="grow"><button class="small" onclick="uploadRoomMusic()">Upload & play</button></div>
  ${r.music ? `<div class="row" style="margin-top:8px"><span class="grow small">▶ ${esc(r.music.name)}</span></div><audio id="roomAudio" controls style="width:100%" ${r.music.playing ? 'autoplay' : ''} src="${r.music.dataUrl}"></audio>` : '<div class="mut small">Upload your own local music and play it for the room.</div>'}</div>` : ''}
  <div class="card"><b>👥 Members</b>${r.members.map(x => `<div class="row" style="margin-top:7px">${avatarHtml(x.user)}<div class="grow"><b class="small">${esc(x.user?.displayName || '')}</b> ${x.user?.isTop ? '👑' : ''}<div class="mut small">${x.role}${x.seat !== null && x.seat !== undefined ? ' · Seat ' + (x.seat + 1) : ''}${x.muted ? ' · 🔇 muted' : ''}</div></div>
    ${staff && x.userId !== me.id ? `<button class="small ghost" onclick="roomAct('mute/${x.userId}')">Mute</button><button class="small ghost" onclick="setRole('${x.userId}')">Role</button><button class="small danger" onclick="roomAct('ban/${x.userId}')">Ban</button>` : ''}</div>`).join('')}
  ${r.bans?.length ? `<div style="margin-top:8px"><b class="small">Ban list</b>${r.bans.map(b => `<div class="row"><span class="grow small">${esc(b.user?.displayName || b.userId)}</span><button class="small ghost" onclick="roomAct('unban/${b.userId}')">Unban</button></div>`).join('')}</div>` : ''}</div>
  <div class="card"><b>💬 Room chat</b><div id="roomMsgs" style="max-height:300px;overflow-y:auto;margin-top:6px">${(r.messages || []).map(m => `<div class="msg ${m.userId === me.id ? 'me' : ''}"><b class="small">${esc(m.user?.displayName || '')}</b><br>${esc(m.text)}<div class="meta">${new Date(m.at).toLocaleTimeString()}</div></div>`).join('')}</div>
  ${r.chatEnabled ? `<div class="row" style="margin-top:8px"><input id="roomMsgText" placeholder="Message…" class="grow"><button onclick="sendRoomMsg()">Send</button></div>` : '<div class="mut small">Room chat is off.</div>'}</div>`;
  const box = $('roomMsgs'); if (box) box.scrollTop = box.scrollHeight;
}
async function roomAct(action, body = {}) { try { const d = await api('/rooms/' + curRoom.id + '/' + action, 'POST', body); if (d.room) { curRoom = d.room; drawRoom(); } else { const f = await api('/rooms/' + curRoom.id); curRoom = f.room; drawRoom(); } } catch (e) { toast(e.message); } }
async function takeSeat(i) {
  try { const d = await api('/rooms/' + curRoom.id + '/seat', 'POST', { seatIndex: i }); if (d.handRaised) toast('✋ Hand raised — waiting for the host'); if (d.room) curRoom = d.room; if (d.seated) await startMic(); const f = await api('/rooms/' + curRoom.id); curRoom = f.room; drawRoom(); }
  catch (e) { toast(e.message); }
}
async function raiseHand() { await roomAct('raise-hand'); toast('✋ Hand raised'); }
async function setRole(userId) { const role = prompt('Role: admin / moderator / member', 'moderator'); if (!role) return; roomAct('role/' + userId, { role }); }
async function sendRoomMsg() { const t = $('roomMsgText').value; if (!t.trim()) return; try { await api('/rooms/' + curRoom.id + '/messages', 'POST', { text: t }); const f = await api('/rooms/' + curRoom.id); curRoom = f.room; drawRoom(); } catch (e) { toast(e.message); } }
async function uploadRoomMusic() {
  const f = $('roomMusicFile').files[0]; if (!f) return toast('Choose a music file first');
  try { const dataUrl = await fileToDataUrl(f); await roomAct('music', { name: f.name, dataUrl }); toast('🎵 Music playing in room'); } catch (e) { toast(e.message); }
}
function toggleRoomSettings() {
  const r = curRoom; const box = $('roomSettings');
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const owner = r.ownerId === me.id || me.isOwner;
  box.innerHTML = `<div class="card"><b>⚙️ Room Settings</b>
  <label>Name</label><input id="rsName" value="${esc(r.name)}">
  <label>Description</label><input id="rsDesc" value="${esc(r.description || '')}">
  <label>Topic</label><input id="rsTopic" value="${esc(r.topic || '')}">
  <label>Welcome message</label><input id="rsWelcome" value="${esc(r.welcome || '')}">
  <label>Cover colour</label><input id="rsColor" type="color" value="${esc(r.coverColor || '#6d28d9')}" style="height:44px;padding:4px">
  <label>Cover photo</label><input type="file" id="rsCover" accept="image/*">
  <label>Who can speak</label><select id="rsSpeak"><option value="anyone">Anyone</option><option value="raisehand">Raise-hand approval</option><option value="staff">Staff only</option></select>
  <label>Mic seats (4–12)</label><input id="rsSeats" type="number" min="4" max="12" value="${r.seatCount}">
  <div class="row" style="flex-wrap:wrap;margin-top:6px"><label style="margin:0"><input type="checkbox" id="rsChat" ${r.chatEnabled ? 'checked' : ''} style="width:auto"> Chat</label><label style="margin:0"><input type="checkbox" id="rsSlow" ${r.slowMode ? 'checked' : ''} style="width:auto"> Slow mode</label><label style="margin:0"><input type="checkbox" id="rsMusic" ${r.musicEnabled ? 'checked' : ''} style="width:auto"> Music</label><label style="margin:0"><input type="checkbox" id="rsHand" ${r.raiseHandEnabled ? 'checked' : ''} style="width:auto"> Raise hand</label></div>
  ${owner ? `<label>Visibility</label><select id="rsVis"><option value="public">Public</option><option value="private">Private</option></select>
  <label>Password (private rooms)</label><input id="rsPw" value="${esc(r.password || '')}">
  <label>Who can join</label><select id="rsJoin"><option value="anyone">Anyone</option><option value="friends">Host's friends</option><option value="invite">Invite only</option></select>
  <label style="margin:0"><input type="checkbox" id="rsModBan" ${r.modPerms?.ban ? 'checked' : ''} style="width:auto"> Moderators can ban</label>` : '<p class="mut small">Access & password settings are owner-only.</p>'}
  <button style="width:100%;margin-top:10px" onclick="saveRoomSettings()">Save settings</button>
  ${owner ? '<button class="danger" style="width:100%;margin-top:8px" onclick="closeRoom()">Close / delete room</button>' : ''}</div>`;
  $('rsSpeak').value = r.speakPolicy; if (owner) { $('rsVis').value = r.visibility; $('rsJoin').value = r.joinPolicy; }
}
async function saveRoomSettings() {
  try {
    const body = { name: $('rsName').value, description: $('rsDesc').value, topic: $('rsTopic').value, welcome: $('rsWelcome').value, coverColor: $('rsColor').value, speakPolicy: $('rsSpeak').value, seatCount: $('rsSeats').value, chatEnabled: $('rsChat').checked, slowMode: $('rsSlow').checked, musicEnabled: $('rsMusic').checked, raiseHandEnabled: $('rsHand').checked };
    const f = $('rsCover').files[0]; if (f) body.cover = await shrinkImage(f);
    if ($('rsVis')) { body.visibility = $('rsVis').value; body.password = $('rsPw').value; body.joinPolicy = $('rsJoin').value; body.modPerms = { ...curRoom.modPerms, ban: $('rsModBan').checked }; }
    const d = await api('/rooms/' + curRoom.id + '/settings', 'PATCH', body); curRoom = d.room; drawRoom(); toast('Settings saved');
  } catch (e) { toast(e.message); }
}
async function closeRoom() { if (!confirm('Close this room for everyone?')) return; await roomAct('close'); leaveRoomView(); }
function leaveRoomView() { stopMic(); if (curRoom) api('/rooms/' + curRoom.id + '/leave', 'POST', {}).catch(() => {}); curRoom = null; $('roomView').classList.add('hidden'); if (curView === 'rooms') renderRooms(); else renderHome(); }

/* ---- real device microphone (Yalla-style): local live mic + meter + XP heartbeat ---- */
async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(micStream); analyser = ctx.createAnalyser(); analyser.fftSize = 256; src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const st = $('micStatus'); if (st) st.textContent = '🎙️ Mic LIVE — bolain, meter aapki asal awaaz par hilega';
    (function loop() {
      if (!analyser) return;
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      speakingNow = avg > 18;
      const bar = $('micMeter'); if (bar) bar.style.width = Math.min(100, avg * 1.6) + '%';
      const mySeat = curRoom?.members.find(x => x.userId === me.id);
      document.querySelectorAll('.seat').forEach(sEl => { if (mySeat && +sEl.dataset.seat === mySeat.seat) sEl.classList.toggle('speaking', speakingNow); });
      requestAnimationFrame(loop);
    })();
    clearInterval(hbTimer);
    hbTimer = setInterval(async () => { if (!curRoom) return; try { const d = await api('/rooms/' + curRoom.id + '/heartbeat', 'POST', { speaking: speakingNow && !isMicMuted() }); if (d.earnedNow > 0) toast('+' + d.earnedNow + ' XP earned'); } catch {} }, 15000);
  } catch (e) {
    const st = $('micStatus'); if (st) st.textContent = 'Microphone is blocked — allow access, then tap the mic to try again';
    toast('Mic permission needed');
  }
}
function isMicMuted() { const m = curRoom?.members.find(x => x.userId === me.id); return !!(m && m.muted); }
async function toggleMic() {
  const mySeat = curRoom?.members.find(x => x.userId === me.id);
  if (!mySeat || mySeat.seat === null || mySeat.seat === undefined) {
    const free = curRoom.seats.findIndex(s => !s);
    if (free >= 0) return takeSeat(free);
    return raiseHand();
  }
  if (!micStream) { await startMic(); return; }
  const muted = !isMicMuted();
  micStream.getAudioTracks().forEach(t => t.enabled = !muted);
  await roomAct('mute/' + me.id, { muted });
  const st = $('micStatus'); if (st) st.textContent = muted ? '🔇 You are muted (mic is really off)' : '🎙️ Mic LIVE';
}
function stopMic() { if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; } analyser = null; clearInterval(hbTimer); }

/* ---------------- messages & chat ---------------- */
async function renderMessages() {
  const el = $('view-messages');
  try {
    const d = await api('/conversations');
    el.innerHTML = `<h3>💬 Messages</h3><p><span class="chip free">FREE • No coins needed • Unlimited</span></p>
    ${d.conversations.length ? d.conversations.map(c => `<div class="card" onclick="openChat('${c.peer.id}')"><div class="row">${avatarHtml(c.peer)}<div class="grow"><b>${esc(c.peer.displayName)}</b> ${c.peer.verified ? '✅' : ''}<div class="mut small">${c.last.kind === 'text' ? esc(c.last.text) : '📎 ' + c.last.kind} · ${new Date(c.last.at).toLocaleTimeString()}</div></div>${c.unread ? `<span class="chip" style="background:#dc2626">${c.unread}</span>` : ''}</div></div>`).join('') : '<div class="card mut">No chats yet — message a friend from the Friends tab.</div>'}`;
  } catch (e) { el.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}
async function openChat(userId) {
  curPeer = userId;
  try {
    const d = await api('/messages/' + userId);
    $('chatView').classList.remove('hidden');
    $('chatView').innerHTML = `
    <div class="row">${avatarHtml(d.peer)}<div class="grow"><b>${esc(d.peer.displayName)}</b> ${d.peer.verified ? '✅' : ''}<div class="mut small">${d.peer.online ? 'Online' : 'Offline'} · ${esc(d.peer.country || '')}</div></div>
    <button class="small" onclick="startCall('${d.peer.id}','voice')">📞</button><button class="small" onclick="startCall('${d.peer.id}','video')">🎥</button>
    <button class="small ghost" onclick="closeChat()">✖</button></div>
    <div id="chatMsgs" style="margin-top:10px">${d.messages.map(msgHtml).join('')}</div>
    <div class="card" style="position:sticky;bottom:0">
      <div class="row"><input id="chatText" placeholder="Message… gapshap karein" class="grow" onkeydown="if(event.key==='Enter')sendChat()"><button onclick="sendChat()">Send</button></div>
      <div class="row" style="margin-top:7px;flex-wrap:wrap">
        <button class="small ghost" onclick="sendEmoji()">😊</button>
        <label class="small" style="margin:0">📷 <input type="file" id="chatImg" accept="image/*" class="hidden" onchange="sendChatFile('image')"></label>
        <label class="small" style="margin:0">📎 File <input type="file" id="chatFile" class="hidden" onchange="sendChatFile('file')"></label>
        <button class="small ghost" id="voiceBtn" onclick="toggleVoice()">🎤 Voice message</button>
        <button class="small ghost" onclick="sendGiftPrompt('${d.peer.id}')">🎁 Gift</button>
      </div><div class="mut small">✓ Delivered · <span style="color:#60a5fa">✓✓ Read</span> — files up to 2 MB</div></div>`;
    const box = $('chatMsgs'); box.scrollTop = 1e7;
  } catch (e) { toast(e.message); }
}
function msgHtml(m) {
  const mine = m.from === me.id;
  let inner = '';
  if (m.kind === 'text') inner = esc(m.text);
  else if (m.kind === 'image') inner = `<img src="${m.dataUrl}">`;
  else if (m.kind === 'voice') inner = `<audio controls src="${m.dataUrl}" style="max-width:220px"></audio>`;
  else if (m.kind === 'file') inner = `📎 <a href="${m.dataUrl}" download="${esc(m.fileName || 'file')}">${esc(m.fileName || 'File')}</a>`;
  else if (m.kind === 'gift') inner = `<span style="font-size:1.3rem">${esc(m.text)}</span>`;
  return `<div class="msg ${mine ? 'me' : ''}">${inner}<div class="meta">${new Date(m.at).toLocaleTimeString()} ${mine ? (m.read ? '<span style="color:#93c5fd">✓✓ Read</span>' : '✓ Delivered') : ''}</div></div>`;
}
function closeChat() { curPeer = null; $('chatView').classList.add('hidden'); if (curView === 'messages') renderMessages(); }
async function sendChat() {
  const t = $('chatText').value; if (!t.trim()) return;
  try { await api('/messages/' + curPeer, 'POST', { kind: 'text', text: t }); openChat(curPeer); } catch (e) { toast(e.message); }
}
function sendEmoji() { $('chatText').value += '😊❤️👍'; $('chatText').focus(); }
async function sendChatFile(kind) {
  const f = $(kind === 'image' ? 'chatImg' : 'chatFile').files[0]; if (!f) return;
  if (f.size > 2 * 1024 * 1024) return toast('File too large — 2 MB limit');
  try { const dataUrl = await fileToDataUrl(f); await api('/messages/' + curPeer, 'POST', { kind, dataUrl, fileName: f.name }); openChat(curPeer); } catch (e) { toast(e.message); }
}
async function toggleVoice() {
  if (recorder && recorder.state === 'recording') { recorder.stop(); $('voiceBtn').textContent = '🎤 Voice message'; return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream); recChunks = [];
    recorder.ondataavailable = e => recChunks.push(e.data);
    recorder.onstop = async () => { stream.getTracks().forEach(t => t.stop()); const blob = new Blob(recChunks, { type: 'audio/webm' }); const dataUrl = await fileToDataUrl(blob); try { await api('/messages/' + curPeer, 'POST', { kind: 'voice', dataUrl }); openChat(curPeer); } catch (e) { toast(e.message); } };
    recorder.start(); $('voiceBtn').textContent = '⏹ Stop & send';
  } catch { toast('Microphone permission needed for voice messages'); }
}
async function sendGiftPrompt(toUserId) {
  try {
    const d = await api('/gifts');
    const names = d.gifts.map((g, i) => `${i + 1}. ${g.emoji} ${g.name} — ${g.price} coins`).join('\n');
    const pick = prompt('Send a gift (your balance: ' + d.wallet + ' coins)\n' + names + '\n\nNumber likhein:');
    if (!pick) return;
    const g = d.gifts[parseInt(pick, 10) - 1]; if (!g) return toast('Wrong number');
    await api('/gifts/send', 'POST', { toUserId, giftId: g.id }); toast('🎁 Gift sent'); refreshMe(); openChat(toUserId);
  } catch (e) { toast(e.message); }
}

/* ---------------- calls ---------------- */
async function startCall(userId, kind) {
  try {
    const d = await api('/calls', 'POST', { toUserId: userId, kind });
    curCall = d.call; drawCall('Calling… ringing');
    pollCallState();
  } catch (e) { toast(e.message); }
}
async function pollIncoming() {
  if (!me) return;
  try {
    const d = await api('/calls/incoming');
    if (d.incoming.length && !curCall) { curCall = d.incoming[0]; drawCall('Incoming ' + curCall.kind + ' call'); }
  } catch {}
}
async function pollCallState() {
  clearTimeout(pollCallState._t);
  pollCallState._t = setTimeout(async () => {
    if (!curCall) return;
    try {
      const d = await api('/calls/incoming');
      const active = d.active.find(c => c.id === curCall.id);
      if (active && curCall.status !== 'ongoing') { curCall = active; onCallOngoing(); return; }
      if (!active && !d.incoming.some(c => c.id === curCall.id) && curCall.status === 'ongoing') { endCallUi(); toast('Call ended'); return; }
      if (curCall.status === 'ringing') pollCallState();
    } catch {}
  }, 2000);
}
function drawCall(status) {
  const c = curCall; if (!c) return;
  const isIncoming = c.to === me.id && c.status === 'ringing';
  $('callView').classList.remove('hidden');
  $('callView').innerHTML = `<div class="center" style="padding-top:36px">${avatarHtml(c.peer, 'big')}
  <h2 style="margin-top:10px">${esc(c.peer?.displayName || '')}</h2><p class="mut">${c.kind === 'video' ? '🎥 Video call' : '📞 Voice call'} · <span id="callStatus">${esc(status)}</span></p>
  <p class="mut" id="callTimer"></p>
  <video id="callVideo" autoplay playsinline muted style="width:100%;max-width:340px;border-radius:16px;background:#000;margin:14px auto;display:${c.kind === 'video' ? 'block' : 'none'}"></video>
  ${c.rtcNote ? `<div class="announce" style="max-width:420px;margin:10px auto">${esc(c.rtcNote)}</div>` : ''}
  <span class="chip free">FREE • No coins needed • Unlimited</span>
  <div class="row" style="justify-content:center;margin-top:22px;flex-wrap:wrap">
  ${isIncoming ? `<button style="background:#16a34a" onclick="respondCall(true)">✔ Accept</button><button class="danger" onclick="respondCall(false)">✖ Reject</button>` :
    c.status === 'ongoing' ? `<button class="ghost" onclick="toggleCallMute()">🎙️ Mute</button><button class="ghost" onclick="toggleSpeaker()">🔊 Speaker</button><button class="ghost" onclick="toggleCamera()">📷 Camera</button><button class="danger" onclick="endCall()">📵 End call</button>` :
    `<button class="danger" onclick="endCall()">Cancel call</button>`}</div></div>`;
}
async function respondCall(accept) {
  try { const d = await api('/calls/' + curCall.id + '/respond', 'POST', { accept }); curCall = { ...curCall, ...d.call }; if (accept) onCallOngoing(); else { endCallUi(); toast('Call rejected'); } }
  catch (e) { toast(e.message); }
}
async function onCallOngoing() {
  drawCall('Ongoing');
  callStartedAt = Date.now();
  clearInterval(callTimer);
  callTimer = setInterval(() => { const s = Math.floor((Date.now() - callStartedAt) / 1000); const el = $('callTimer'); if (el) el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }, 1000);
  try { localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: curCall.kind === 'video' }); const v = $('callVideo'); if (v && curCall.kind === 'video') v.srcObject = localCallStream; }
  catch { toast('Camera/mic permission needed — call signalling is live, media needs permission + RTC keys'); }
  pollCallState();
}
function toggleCallMute() { if (localCallStream) { const t = localCallStream.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; toast(t.enabled ? 'Mic on' : 'Mic muted (real track off)'); } } }
function toggleSpeaker() { toast('Speaker toggle (device output)'); }
function toggleCamera() { if (localCallStream) { const t = localCallStream.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; toast(t.enabled ? 'Camera on' : 'Camera off'); } } }
async function endCall() { try { await api('/calls/' + curCall.id + '/end', 'POST', {}); } catch {} endCallUi(); }
function endCallUi() { curCall = null; clearInterval(callTimer); if (localCallStream) { localCallStream.getTracks().forEach(t => t.stop()); localCallStream = null; } $('callView').classList.add('hidden'); }

/* ---------------- gifts ---------------- */
async function renderGifts() {
  const el = $('view-gifts');
  try {
    const d = await api('/gifts');
    el.innerHTML = `<h3>🎁 Gift Shop</h3>
    <div class="card"><div class="row"><span class="grow">Your wallet</span><b style="font-size:1.2rem">🪙 ${d.wallet} coins</b></div>
    <div class="mut small">Calls, messages and rooms are FREE forever — coins are only for optional gifts. You can never edit your own balance; every coin movement is in the ledger below.</div></div>
    <div class="giftgrid">${d.gifts.map(g => `<div class="gift"><div class="em">${g.emoji}</div><div class="small"><b>${esc(g.name)}</b></div><div class="mut small">🪙 ${g.price}</div><button class="small" style="margin-top:5px" onclick="giftToFriend('${g.id}')">Send</button></div>`).join('')}</div>
    <h3 style="margin:16px 0 4px">🪙 Buy coins — Easypaisa</h3>
    <div class="card"><p class="small">1) Send the amount by Easypaisa to <b>${esc(d.easypaisa)}</b><br>2) Choose the package and enter your <b>transaction reference</b>.<br>3) Coins are credited <b>only after the admin verifies</b> the reference — a receipt alone never auto-approves.</p>
    ${d.packages.map(pk => `<div class="kv"><span>${esc(pk.name)} — 🪙 ${pk.coins}</span><span>Rs ${pk.priceRs}</span><button class="small" onclick="buyCoins('${pk.id}')">Buy</button></div>`).join('')}
    <div id="payStatus"></div></div>
    <h3 style="margin:16px 0 4px">🧾 My ledger</h3>
    <div class="card">${d.ledger.length ? d.ledger.map(e => `<div class="kv"><span>${esc(e.type)} — ${esc(e.note)}</span><span style="color:${e.delta >= 0 ? 'var(--ok)' : 'var(--bad)'}">${e.delta >= 0 ? '+' : ''}${e.delta} → ${e.balanceAfter}</span></div>`).join('') : '<span class="mut">No coin movements yet.</span>'}</div>
    <h3 style="margin:16px 0 4px">🎁 Gift history</h3>
    <div class="card">${d.giftTxns.length ? d.giftTxns.map(g => `<div class="kv"><span>${g.emoji} ${esc(g.giftName)}</span><span class="mut small">${new Date(g.at).toLocaleString()}</span></div>`).join('') : '<span class="mut">No gifts yet.</span>'}</div>`;
    renderPayStatus();
  } catch (e) { el.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}
async function renderPayStatus() { try { const d = await api('/payments/mine'); const box = $('payStatus'); if (box) box.innerHTML = d.requests.map(r => `<div class="kv"><span>Ref ${esc(r.txnRef)} · 🪙 ${r.coins}</span><span class="chip">${r.status}</span></div>`).join(''); } catch {} }
async function buyCoins(packageId) {
  const ref = prompt('Easypaisa transaction reference likhein:'); if (!ref) return;
  try { const d = await api('/coins/request', 'POST', { packageId, txnRef: ref }); toast('Request submitted — admin verification ke baad coins milenge'); renderGifts(); } catch (e) { toast(e.message); }
}
async function giftToFriend(giftId) {
  try {
    const d = await api('/friends');
    if (!d.friends.length) return toast('Pehle kisi ko friend banayein');
    const names = d.friends.map((f, i) => `${i + 1}. ${f.displayName}`).join('\n');
    const pick = prompt('Gift kis ko bhejna hai?\n' + names); if (!pick) return;
    const f = d.friends[parseInt(pick, 10) - 1]; if (!f) return toast('Wrong number');
    await api('/gifts/send', 'POST', { toUserId: f.id, giftId }); toast('🎁 Gift sent to ' + f.displayName); refreshMe(); renderGifts();
  } catch (e) { toast(e.message); }
}

/* ---------------- profile ---------------- */
async function renderProfile() {
  const el = $('view-profile');
  try {
    const [lv, badges, posts] = await Promise.all([api('/level-info'), api('/badges'), api('/posts?mine=1')]);
    const pct = lv.nextAt ? Math.min(100, Math.round(100 * lv.xp / lv.nextAt)) : 100;
    el.innerHTML = `
    <div class="card center">${avatarHtml(me, 'big')}<h2 style="margin-top:8px">${esc(me.displayName)} ${me.verified ? '✅' : ''}</h2>
    <div class="mut small">@${esc(me.username)} · ${esc(me.ftId)} · ${FLAG[me.country] || ''} ${esc(me.country || '')} · Age ${me.age ?? '—'} ${me.isOwner ? '· 👑 App Owner' : ''}</div>
    <p style="margin:6px 0">${esc(me.bio || '')}</p>
    ${me.isTop ? '<span class="chip gold" style="font-size:.95rem;padding:7px 16px">👑 TOP LEVEL — App Owner</span>' : levelChip(me)}
    <div class="bar ${me.isTop ? 'gold' : ''}" style="margin-top:10px"><i style="width:${pct}%"></i></div>
    <div class="mut small">${lv.xp} XP ${lv.nextAt ? '· next level at ' + lv.nextAt + ' XP' : '· MAX'}</div></div>
    ${me.isOwner ? '<button style="width:100%" onclick="boostTop()">👑 Boost me & my rooms to TOP</button>' : ''}
    <div class="card"><b>📈 How your level grows</b>
      <div class="kv"><span>🎙️ Room mein baat (mic)</span><span>+${lv.rates.speaking} XP/min · today ${lv.today.speaking}/${lv.caps.speaking}</span></div>
      <div class="kv"><span>🕐 Room mein time</span><span>+${lv.rates.presence} XP/min · today ${lv.today.presence}/${lv.caps.presence}</span></div>
      <div class="kv"><span>✉️ Friend invite (asal join par)</span><span>+${lv.rates.invite} XP · today ${lv.today.invite}/${lv.caps.invite}</span></div>
      <div class="small" style="margin-top:6px">Your invite code: <b>${esc(lv.inviteCode)}</b> — dost register karte waqt ye code de to XP aapko milega. Level sirf XP se barhta hai — coins/gifts/posts se nahi, aur level khareeda nahi ja sakta.</div></div>
    <div class="card"><b>✏️ Edit profile</b>
      <label>Display name</label><input id="pfName" value="${esc(me.displayName)}">
      <label>Bio</label><input id="pfBio" value="${esc(me.bio || '')}">
      <label>Country</label><select id="pfCountry">${COUNTRIES.map(c => `<option ${c === me.country ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <label>Profile picture (gallery se choos karein)</label><input type="file" id="pfAvatar" accept="image/*">
      <label>Who can message me</label><select id="pfMsg"><option value="friends">Friends only</option><option value="everyone">Everyone</option></select>
      <label>Who can call me</label><select id="pfCall"><option value="friends">Friends only</option><option value="everyone">Everyone</option></select>
      <button style="width:100%;margin-top:8px" onclick="saveProfile()">Save profile</button></div>
    <div class="card"><b>🛡️ Verification — sirf LIVE camera</b>
      <p class="small mut" style="margin:5px 0">Status: <b>${esc(me.verificationStatus)}</b> · Gallery photo verification ke liye kabhi accept nahi hoti. Neeche camera khulega, live selfie lein — admin approve kare to hi ✅ badge milega. (Age 18+ zaroori.)</p>
      <video id="verVideo" class="cam hidden" autoplay playsinline muted></video>
      <canvas id="verCanvas" class="hidden"></canvas>
      <img id="verPreview" class="hidden" style="width:100%;border-radius:14px">
      <div class="row" style="margin-top:8px"><button class="ghost" onclick="startVerCam()">📷 Open live camera</button><button onclick="submitVerification()">✔ Capture & submit</button></div></div>
    <div class="card"><b>🏅 Badges</b><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(100px,1fr))">${badges.badges.map(b => `<div class="badge ${b.unlocked ? 'unlocked' : ''}"><div style="font-size:1.8rem">${b.emoji}</div><div class="small"><b>${esc(b.name)}</b></div><div class="mut small">${b.unlocked ? 'Unlocked ✔' : b.progress + '/' + b.target}</div><div class="mut small">${esc(b.desc)}</div></div>`).join('')}</div></div>
    <div class="card"><b>📝 My posts</b><div style="margin-top:8px">${posts.posts.map(postHtml).join('') || '<span class="mut">No posts yet — Home se post karein.</span>'}</div></div>
    ${me.isOwner ? '<div id="adminBox"></div>' : ''}
    <button class="danger" style="width:100%" onclick="doLogout()">Log out</button>`;
    $('pfMsg').value = me.whoCanMessage; $('pfCall').value = me.whoCanCall;
    if (me.isOwner) renderAdmin();
  } catch (e) { el.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}
async function boostTop() { try { const d = await api('/me/boost', 'POST', {}); me = d.user; toast('👑 You and your rooms are TOP'); renderProfile(); } catch (e) { toast(e.message); } }
async function saveProfile() {
  try {
    const body = { displayName: $('pfName').value, bio: $('pfBio').value, country: $('pfCountry').value, whoCanMessage: $('pfMsg').value, whoCanCall: $('pfCall').value };
    const f = $('pfAvatar').files[0]; if (f) body.avatar = await shrinkImage(f, 500);
    const d = await api('/profile', 'PATCH', body); me = d.user; refreshMe(); toast('Profile saved'); renderProfile();
  } catch (e) { toast(e.message); }
}
let verStream = null;
async function startVerCam() {
  try { verStream = await navigator.mediaDevices.getUserMedia({ video: true }); const v = $('verVideo'); v.classList.remove('hidden'); v.srcObject = verStream; toast('Live camera on — Capture dabayein'); }
  catch { toast('Camera permission needed for live verification'); }
}
async function submitVerification() {
  const v = $('verVideo');
  if (!verStream || v.classList.contains('hidden')) return toast('Pehle live camera kholein — gallery se verification nahi hoti');
  const c = $('verCanvas'); c.width = v.videoWidth || 480; c.height = v.videoHeight || 480;
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', 0.8);
  $('verPreview').src = dataUrl; $('verPreview').classList.remove('hidden');
  try { await api('/verification', 'POST', { selfieDataUrl: dataUrl, liveCapture: true }); toast('Selfie submitted — Pending. Admin approve kare to badge milega'); refreshMe(); }
  catch (e) { toast(e.message); }
  verStream.getTracks().forEach(t => t.stop()); verStream = null; v.classList.add('hidden');
}

/* ---------------- Super Admin ---------------- */
async function renderAdmin() {
  const box = $('adminBox'); if (!box) return;
  try {
    const o = await api('/admin/overview');
    box.innerHTML = `<div class="card"><b>🛡️ Super Admin Panel</b> <span class="mut small">(server-side role check)</span>
    <div class="kv"><span>Users</span><span>${o.users}</span></div><div class="kv"><span>Rooms</span><span>${o.rooms}</span></div>
    <div class="kv"><span>Messages</span><span>${o.messages}</span></div><div class="kv"><span>Revenue (approved)</span><span>Rs ${o.revenueRs}</span></div>
    <div class="kv"><span>Pending payments</span><span>${o.pendingPayments}</span></div><div class="kv"><span>Pending verifications</span><span>${o.pendingVerifications}</span></div>
    <div class="kv"><span>Open reports</span><span>${o.openReports}</span></div>
    <div class="tabs"><button class="small" onclick="adminSection('users')">Users/Bans</button><button class="small" onclick="adminSection('verifications')">Verifications</button><button class="small" onclick="adminSection('payments')">Payments</button><button class="small" onclick="adminSection('gifts')">Gifts/Prices</button><button class="small" onclick="adminSection('rooms')">Rooms</button><button class="small" onclick="adminSection('reports')">Reports</button><button class="small" onclick="adminSection('announce')">Announce</button><button class="small" onclick="adminSection('settings')">Settings</button><button class="small" onclick="adminSection('audit')">Audit log</button></div>
    <div id="adminSection"></div></div>`;
  } catch (e) { box.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}
async function adminSection(name) {
  const box = $('adminSection');
  try {
    if (name === 'users') { const d = await api('/admin/users'); box.innerHTML = d.users.map(u => `<div class="kv"><span>${esc(u.displayName)} (@${esc(u.username)}) · 🪙 ${u.wallet}${u.banned ? ' · BANNED' : ''}</span><button class="small ${u.banned ? '' : 'danger'}" onclick="adminBan('${u.id}',${!u.banned})">${u.banned ? 'Unban' : 'Ban'}</button></div>`).join(''); }
    if (name === 'verifications') { const d = await api('/admin/verifications'); box.innerHTML = d.verifications.length ? d.verifications.map(v => `<div class="card"><div class="row">${avatarHtml(v.user)}<b>${esc(v.user?.displayName || '')}</b><span class="mut small">Age ${v.user?.age ?? '—'}</span></div><img src="${v.selfieDataUrl}" style="width:100%;border-radius:12px;margin-top:8px"><div class="row" style="margin-top:8px"><button class="small" onclick="adminVerify('${v.id}',true)">✔ Approve</button><button class="small danger" onclick="adminVerify('${v.id}',false)">✖ Reject</button></div></div>`).join('') : '<span class="mut">No pending verifications.</span>'; }
    if (name === 'payments') { const d = await api('/admin/payments'); box.innerHTML = d.requests.length ? d.requests.map(r => `<div class="kv"><span>${esc(r.user?.displayName || '')} · Ref ${esc(r.txnRef)} · 🪙 ${r.coins} (Rs ${r.priceRs})</span>${r.status === 'pending' ? `<span><button class="small" onclick="adminPay('${r.id}',true)">✔ Credit</button> <button class="small danger" onclick="adminPay('${r.id}',false)">✖</button></span>` : `<span class="chip">${r.status}</span>`}</div>`).join('') : '<span class="mut">No payment requests.</span>'; }
    if (name === 'gifts') { const d = await api('/admin/gifts'); box.innerHTML = d.gifts.map(g => `<div class="kv"><span>${g.emoji} ${esc(g.name)}</span><span>🪙 <input style="width:80px;display:inline;padding:5px" id="gp-${g.id}" value="${g.price}"> <button class="small" onclick="adminGiftPrice('${g.id}')">Save</button></span></div>`).join('') + d.packages.map(pk => `<div class="kv"><span>📦 ${esc(pk.name)}</span><span>🪙 ${pk.coins} · Rs ${pk.priceRs}</span></div>`).join(''); }
    if (name === 'rooms') { const d = await api('/admin/rooms'); box.innerHTML = d.rooms.map(r => `<div class="kv"><span>${esc(r.name)} · ${esc(r.tier)} · by ${esc(r.owner?.displayName || '')}</span><button class="small ${r.featured ? '' : 'ghost'}" onclick="adminFeature('${r.id}',${!r.featured})">${r.featured ? '⭐ Featured' : 'Feature'}</button></div>`).join('') || '<span class="mut">No rooms.</span>'; }
    if (name === 'reports') { const d = await api('/admin/reports'); box.innerHTML = d.reports.length ? d.reports.map(r => `<div class="kv"><span>${esc(r.targetType)} · ${esc(r.reason)} <span class="mut small">by ${esc(r.reporter?.displayName || '')}</span></span>${r.status === 'open' ? `<button class="small" onclick="adminReport('${r.id}')">Close</button>` : `<span class="chip">${r.status}</span>`}</div>`).join('') : '<span class="mut">No reports.</span>'; }
    if (name === 'announce') { box.innerHTML = `<input id="annText" placeholder="Announcement sab users ko…"><button class="small" onclick="adminAnnounce()">Publish</button>`; }
    if (name === 'settings') { const d = await api('/admin/settings'); const s = d.settings; box.innerHTML = `
      <label>XP — room time / min</label><input id="stPres" type="number" value="${s.xpPresenceRate}">
      <label>XP — mic speaking / min</label><input id="stSpeak" type="number" value="${s.xpSpeakingRate}">
      <label>XP — invite join</label><input id="stInv" type="number" value="${s.xpInviteRate}">
      <label>Daily caps (time / speaking / invite)</label><div class="row"><input id="stCapP" type="number" value="${s.capPresence}"><input id="stCapS" type="number" value="${s.capSpeaking}"><input id="stCapI" type="number" value="${s.capInvite}"></div>
      <label>RTC provider (LiveKit / Agora — keys yahan lagte hain, app code mein kabhi nahi)</label><input id="stRtcProv" value="${esc(s.rtcProvider || '')}" placeholder="e.g. LiveKit">
      <label>RTC App ID / key reference</label><input id="stRtcId" value="${esc(s.rtcAppId || '')}" placeholder="App ID">
      <label>Easypaisa (payment instructions)</label><input id="stEasy" value="${esc(s.easypaisa)}">
      <button class="small" onclick="adminSaveSettings()">Save settings</button>`; }
    if (name === 'audit') { const d = await api('/admin/audit'); box.innerHTML = d.auditLog.map(a => `<div class="kv"><span>${esc(a.action)} — ${esc(a.detail)}</span><span class="mut small">${esc(a.actor)} · ${new Date(a.at).toLocaleString()}</span></div>`).join('') || '<span class="mut">No audit entries.</span>'; }
  } catch (e) { box.innerHTML = esc(e.message); }
}
async function adminBan(id, banned) { await api('/admin/users/' + id + '/ban', 'POST', { banned }); adminSection('users'); }
async function adminVerify(id, approve) { await api('/admin/verifications/' + id, 'POST', { approve }); toast(approve ? 'Verified ✔' : 'Rejected'); adminSection('verifications'); }
async function adminPay(id, approve) { await api('/admin/payments/' + id, 'POST', { approve }); toast(approve ? 'Coins credited ✔' : 'Rejected'); adminSection('payments'); }
async function adminGiftPrice(id) { await api('/admin/gifts/' + id, 'PATCH', { price: $('gp-' + id).value }); toast('Price saved'); }
async function adminFeature(id, featured) { await api('/admin/rooms/' + id + '/feature', 'POST', { featured }); adminSection('rooms'); }
async function adminReport(id) { await api('/admin/reports/' + id, 'POST', { status: 'closed' }); adminSection('reports'); }
async function adminAnnounce() { await api('/admin/announcements', 'POST', { text: $('annText').value }); toast('Announcement published'); }
async function adminSaveSettings() { await api('/admin/settings', 'PATCH', { xpPresenceRate: +$('stPres').value, xpSpeakingRate: +$('stSpeak').value, xpInviteRate: +$('stInv').value, capPresence: +$('stCapP').value, capSpeaking: +$('stCapS').value, capInvite: +$('stCapI').value, rtcProvider: $('stRtcProv').value, rtcAppId: $('stRtcId').value, easypaisa: $('stEasy').value }); toast('Settings saved'); }

/* ---------------- boot ---------------- */
(function boot() {
  const sel = $('rgCountry'); for (const c of COUNTRIES) { const o = document.createElement('option'); o.textContent = c; sel.appendChild(o); }
  if (token) { api('/me').then(d => { me = d.user; enterApp(); }).catch(() => { token = ''; localStorage.removeItem('ft_token'); }); }
})();
