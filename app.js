/* Writing Log — Nicole J Kimzey
   Runs on its own (GitHub Pages). Reads word counts with the Google Docs API and keeps the
   log in one file in your Google Drive ("Writing Log data.json"), so every device shares it. */
(function(){
"use strict";
const CFG = window.WRITING_LOG_CONFIG || {};
const CLIENT_ID = CFG.googleClientId || "";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents.readonly";
const DATA_NAME = "Writing Log data.json";
const COMMENT_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const LS = "writinglog.";
const TODS = [["early-morning","Early morning"],["late-morning","Later morning"],["noon","Noon"],["early-afternoon","Early afternoon"],["mid-afternoon","Mid afternoon"],["evening","Evening"],["night","Night"]];
const TOD_NAME = Object.fromEntries(TODS);
const TYPES = [["writing","Writing"],["editing","Editing"],["sprint","Sprint"]];
const TYPE_NAME = {writing:"Writing", editing:"Editing", sprint:"Sprint"};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = n => Number(n||0).toLocaleString("en-US");
const short = n => n >= 10000 ? (n/1000).toFixed(1).replace(/\.0$/,"")+"k" : fmt(n);
const pad = n => String(n).padStart(2,"0");
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parse = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m-1,d); };
const addDays = (s,n) => { const d = parse(s); d.setDate(d.getDate()+n); return ymd(d); };
const isSun = s => parse(s).getDay() === 0;
// A writing day runs from 2 am to 2 am, so a late-night session counts toward the day you started it.
const DAY_START_HOUR = 2;
const dayOf = ts => ymd(new Date(ts - DAY_START_HOUR*3600000));
const todayStr = () => dayOf(Date.now());
const lsGet = k => { try { return JSON.parse(localStorage.getItem(LS+k)); } catch(_){ return null; } };
const lsSet = (k,v) => { try { localStorage.setItem(LS+k, JSON.stringify(v)); } catch(_){} };
const lsDel = k => { try { localStorage.removeItem(LS+k); } catch(_){} };
function todFor(date){ const h = date.getHours();
  if (h>=4 && h<8) return "early-morning"; if (h>=8 && h<11) return "late-morning"; if (h>=11 && h<13) return "noon";
  if (h>=13 && h<15) return "early-afternoon"; if (h>=15 && h<17) return "mid-afternoon"; if (h>=17 && h<21) return "evening"; return "night"; }
function uid(p){ return p + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// Same counting rule everywhere (app and nightly script).
function countWords(text){
  const cut = text.search(/^#{1,3}[ \t]*(acknowledg|dark matter)/im);
  if (cut >= 0) text = text.slice(0, cut);
  text = text.replace(/\\(.)/g,"$1").replace(/[#*_]+/g," ").replace(/[—–]/g," ");
  return text.split(/\s+/).filter(t => /[\p{L}\p{N}]/u.test(t)).length;
}

// ---------------- data model ----------------
// data = { v, books:[{id,title,docId,link,goal}], activeId, booksAt,
//          snapshots:{ docId:{ "YYYY-MM-DD":{count,at,m} } },   m = "api" (this app/nightly) or "import"
//          sessions:{ id:{...} }, deleted:{ id:ts }, active:{...}|null, activeAt }
function emptyData(){ return {v:1, books:[], activeId:null, booksAt:0, snapshots:{}, sessions:{}, deleted:{}, active:null, activeAt:0, goals:{}, daysOff:{}, weekGoals:{}}; }
function merge(a, b){
  a = a || emptyData(); b = b || emptyData();
  const out = emptyData();
  const nb = (b.booksAt||0) > (a.booksAt||0) ? b : a;
  out.books = nb.books || []; out.activeId = nb.activeId || null; out.booksAt = nb.booksAt || 0;
  const na = (b.activeAt||0) > (a.activeAt||0) ? b : a;
  out.active = na.active || null; out.activeAt = na.activeAt || 0;
  out.deleted = Object.assign({}, a.deleted, b.deleted);
  for (const src of [a, b]) for (const [id, s] of Object.entries(src.sessions || {})) {
    if (out.deleted[id]) continue;
    const cur = out.sessions[id]; if (!cur || (s.at||0) > (cur.at||0)) out.sessions[id] = s;
  }
  for (const src of [a, b]) for (const [did, m] of Object.entries(src.snapshots || {})) {
    const o = out.snapshots[did] || (out.snapshots[did] = {});
    for (const [d, s] of Object.entries(m)) { if (!o[d] || (s.at||0) > (o[d].at||0)) o[d] = s; }
  }
  for (const src of [a, b]) for (const [d, g] of Object.entries(src.weekGoals || {})) {
    if (!out.weekGoals[d] || (g.at||0) > (out.weekGoals[d].at||0)) out.weekGoals[d] = g;
  }
  for (const src of [a, b]) for (const [d, o] of Object.entries(src.daysOff || {})) {
    if (!out.daysOff[d] || (o.at||0) > (out.daysOff[d].at||0)) out.daysOff[d] = o;
  }
  for (const src of [a, b]) for (const [d, g] of Object.entries(src.goals || {})) {
    if (!out.goals[d] || (g.at||0) > (out.goals[d].at||0)) out.goals[d] = g;
  }
  return normalizeDays(out);
}

// Files counts and sessions under the 2 am writing day (fixes anything saved under the old midnight rule).
let normChanged = false;
function normalizeDays(data){
  for (const m of Object.values(data.snapshots || {})) {
    for (const [d, s] of Object.entries(m)) {
      if (!s.at || s.src === "nightly" || (s.m && s.m !== "api")) continue;
      const wd = dayOf(s.at); if (wd === d) continue;
      if (!m[wd] || (m[wd].at||0) < s.at) m[wd] = s;
      delete m[d]; normChanged = true;
    }
  }
  for (const s of Object.values(data.sessions || {})) if (s.start && s.source !== "manual" && s.date !== dayOf(s.start)){ s.date = dayOf(s.start); normChanged = true; }
  return data;
}
const S = { data: normalizeDays(lsGet("data") || emptyData()), counts:{}, view:null, selected:todayStr(), editId:null,
  syncing:false, driveErr:null, form:{type:"writing", words:"", min:""}, picking:false, sprintMin:"", ringing:false,
  pendingDel:null, stopManual:false, busy:false, fileId: lsGet("fileId"), online:false, saving:false, dirty:false };
{ const t = parse(todayStr()); S.view = new Date(t.getFullYear(), t.getMonth(), 1); }

function books(){ return S.data.books || []; }
function activeBook(){ const bs = books(); return bs.find(b => b.id === S.data.activeId) || bs[0] || null; }
function titleFor(did){ const b = books().find(x => x.docId === did); return b ? b.title : (did === "sheet-import" ? "Booked & Handcuffed" : "A past book"); }
function docIdFrom(link){ if (!link) return null; const m = link.match(/\/d\/([A-Za-z0-9_-]{20,})/) || link.match(/^([A-Za-z0-9_-]{20,})$/); return m ? m[1] : null; }

// ---------------- math ----------------
function docDates(did){ return Object.keys(S.data.snapshots[did] || {}).sort(); }
function allDates(){ const s = new Set(); Object.values(S.data.snapshots).forEach(m => Object.keys(m).forEach(d => s.add(d))); return [...s].sort(); }
function deltaFor(did, d){
  const m = S.data.snapshots[did]; if (!m || !m[d]) return null;
  const ds = docDates(did); const i = ds.indexOf(d); if (i <= 0) return null;
  return m[d].count - m[ds[i-1]].count;
}
function latestCount(did){
  if (S.counts[did]) return S.counts[did].n;
  const ds = docDates(did); return ds.length ? S.data.snapshots[did][ds[ds.length-1]].count : null;
}
function sessionList(){ return Object.entries(S.data.sessions).map(([id, s]) => Object.assign({id}, s)); }
function sessionsOn(d){ return sessionList().filter(x => x.date === d).sort((a,b)=>(a.start||a.createdAt||0)-(b.start||b.createdAt||0)); }
function dayInfo(d){
  const snaps = S.data.snapshots;
  const parts = Object.keys(snaps).filter(did => snaps[did][d]).map(did => ({did, delta: deltaFor(did, d), count: snaps[did][d].count}));
  const known = parts.filter(x => x.delta != null);
  const delta = known.length ? known.reduce((a,x) => a + Math.max(0, x.delta), 0) : null;
  const ss = sessionsOn(d);
  const sesSum = ss.reduce((a,x)=>a+Math.max(0,Number(x.words)||0),0);
  const total = delta == null ? sesSum : Math.max(delta, sesSum);
  const net = known.length ? known.reduce((a,x) => a + x.delta, 0) : null;
  return { delta, total, active: total > 0 || ss.length > 0, ss, net, parts };
}
// Vacation and sick days: { "YYYY-MM-DD": {kind:"vacation"|"sick"|null, at} }. kind null means it was cleared.
const OFF_NAME = {vacation:"Vacation", sick:"Sick day"};
const OFF_ICON = {vacation:"🌴", sick:"🤒"};
const OFF_CLS = {vacation:"vac", sick:"sick"};
function offKind(d){ const o = (S.data.daysOff || {})[d]; return o && OFF_NAME[o.kind] ? o.kind : null; }
function setOff(d, kind){ (S.data.daysOff || (S.data.daysOff = {}))[d] = {kind: kind || null, at: Date.now()}; save(); }
// Days that count as writing days for planning: not Sundays, vacation or sick days.
function isWritingDay(d){ return !isSun(d) && !offKind(d); }
function writingDaysBetween(from, to){ let n = 0; for (let d = from; d <= to; d = addDays(d,1)) if (isWritingDay(d)) n++; return n; }
function countBefore(did, d){ const ds = docDates(did).filter(x => x < d); return ds.length ? S.data.snapshots[did][ds[ds.length-1]].count : null; }
// Finish-by plan for one book. The words-per-day figure is set from where the book stood when today began,
// so it holds steady through the day and recalculates tomorrow from what you actually wrote.
function finishPlan(b){
  if (!b.finishBy) return null;
  const t = todayStr(); const cur = latestCount(b.docId); const goal = Number(b.goal) || 80000;
  if (cur == null) return {pending: true};
  if (cur >= goal) return {finished: true};
  if (b.finishBy < t) return {past: true, left: goal - cur};
  const writeToday = isWritingDay(t);
  const start = writeToday ? (countBefore(b.docId, t) ?? cur) : cur;
  const days = writingDaysBetween(writeToday ? t : addDays(t, 1), b.finishBy);
  if (days <= 0) return {noDays: true, left: goal - cur};
  return {perDay: Math.ceil(Math.max(0, goal - start) / days), days, today: writeToday ? Math.max(0, cur - start) : null, left: goal - cur};
}
function sumRange(from, to){ let t = 0; for (let d = from; d <= to; d = addDays(d,1)) t += dayInfo(d).total; return t; }
function streaks(){
  const today = todayStr();
  const dates = allDates().concat(sessionList().map(x=>x.date)).sort();
  if (!dates.length) return {cur:0, long:0};
  let run = 0, long = 0;
  for (let d = dates[0]; d <= today; d = addDays(d,1)){
    if (isSun(d)) continue;
    if (dayInfo(d).active){ run++; long = Math.max(long, run); }   // any day you write counts, vacation and sick days included
    else if (offKind(d)) continue;   // a vacation or sick day with no writing is skipped: it never ends a streak
    else if (d < today) run = 0;
  }
  return {cur:run, long};
}

// ---------------- Google sign-in (redirect, works from the home screen) ----------------
const Auth = {
  token(){ const t = lsGet("token"); return t && t.exp > Date.now() + 60000 ? t.v : null; },
  redirectUri(){ return location.origin + location.pathname; },
  go(silent){
    if (!CLIENT_ID){ showAuth("setup"); return; }
    const state = Math.random().toString(36).slice(2);
    lsSet("authState", {state, silent: !!silent, at: Date.now()});
    const p = new URLSearchParams({client_id: CLIENT_ID, redirect_uri: this.redirectUri(), response_type: "token", scope: SCOPES + (lsGet("wantComments") ? " " + COMMENT_SCOPE : ""),
      include_granted_scopes: "true", state});
    if (silent) p.set("prompt", "none"); else p.set("prompt", "consent");
    const hint = lsGet("email"); if (hint) p.set("login_hint", hint);
    location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + p.toString());
  },
  takeRedirect(){
    if (!location.hash || location.hash.length < 2) return null;
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.has("access_token") && !h.has("error")) return null;
    const saved = lsGet("authState"); lsDel("authState");
    history.replaceState(null, "", location.pathname + location.search);
    if (!saved || saved.state !== h.get("state")) return {error:"state"};
    if (h.get("error")) return {error: h.get("error"), silent: saved.silent};
    lsSet("token", {v: h.get("access_token"), exp: Date.now() + (Number(h.get("expires_in"))||3600)*1000});
    lsSet("scopes", h.get("scope") || "");
    return {ok:true};
  },
  signOut(){ const t = lsGet("token"); lsDel("token"); lsDel("fileId"); lsDel("email");
    if (t) fetch("https://oauth2.googleapis.com/revoke?token="+encodeURIComponent(t.v), {method:"POST"}).catch(()=>{}); }
};
// Quietly get a fresh sign-in (Google ends each one after an hour). The page reloads for a moment and picks up where it was.
function renew(){
  const tried = lsGet("silentAt");
  if (!CLIENT_ID || (tried && Date.now() - tried < 20000)){ showAuth("expired"); return; }
  lsSet("silentAt", Date.now()); Auth.go(true);
}
function tokenLeft(){ const t = lsGet("token"); return t ? t.exp - Date.now() : 0; }
async function gfetch(url, opts){
  const tok = Auth.token(); if (!tok) throw {code:"auth"};
  const r = await fetch(url, Object.assign({}, opts, {headers: Object.assign({Authorization: "Bearer "+tok}, (opts && opts.headers) || {})}));
  if (r.status === 401){ lsDel("token"); throw {code:"auth"}; }
  if (r.status === 403 || r.status === 404) { let msg = "", reason = ""; try { const j = await r.json(); msg = j.error.message || ""; reason = ((j.error.errors||[])[0]||{}).reason || (j.error.status||""); } catch(_){}
    if (/insufficient|scope|PERMISSION_DENIED/i.test(reason + " " + msg) && !/does not have permission|not found/i.test(msg) && r.status === 403) throw {code:"scope", message: msg};
    throw {code: r.status === 404 ? "notfound" : "forbidden", message: msg}; }
  if (!r.ok) throw {code:"net", status:r.status};
  return r;
}

// ---------------- Drive storage ----------------
async function findFile(){
  const q = encodeURIComponent("name = '"+DATA_NAME+"' and trashed = false");
  const r = await gfetch("https://www.googleapis.com/drive/v3/files?q="+q+"&spaces=drive&fields=files(id,modifiedTime)&orderBy=modifiedTime desc");
  const j = await r.json(); return j.files && j.files[0] ? j.files[0].id : null;
}
async function readRemote(){
  if (!S.fileId){ S.fileId = await findFile(); lsSet("fileId", S.fileId); }
  if (!S.fileId) return null;
  try {
    const r = await gfetch("https://www.googleapis.com/drive/v3/files/"+S.fileId+"?alt=media");
    return await r.json();
  } catch(e){ if (e.code === "notfound"){ S.fileId = null; lsDel("fileId"); return readRemote(); } throw e; }
}
async function writeRemote(obj){
  const body = JSON.stringify(obj);
  if (!S.fileId){
    const boundary = "wl" + Date.now();
    const meta = JSON.stringify({name: DATA_NAME, mimeType: "application/json"});
    const multipart = "--"+boundary+"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"+meta+"\r\n--"+boundary+"\r\nContent-Type: application/json\r\n\r\n"+body+"\r\n--"+boundary+"--";
    const r = await gfetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {method:"POST", headers:{"Content-Type":"multipart/related; boundary="+boundary}, body: multipart});
    S.fileId = (await r.json()).id; lsSet("fileId", S.fileId);
  } else {
    await gfetch("https://www.googleapis.com/upload/drive/v3/files/"+S.fileId+"?uploadType=media", {method:"PATCH", headers:{"Content-Type":"application/json"}, body});
  }
}
async function pull(){
  if (!Auth.token()) return;
  try { const remote = await readRemote(); normChanged = false; S.data = merge(S.data, remote); lsSet("data", S.data); S.online = true; S.loadErr = null;
    if (normChanged) save();
    if (!S.fileId && books().length) save(true); }
  catch(e){ handleErr(e); }
  renderAll();
}
let saveTimer = null;
function save(now){
  lsSet("data", S.data); S.dirty = true; lsSet("dirty", true);
  clearTimeout(saveTimer); saveTimer = setTimeout(flush, now ? 0 : 700);
}
async function flush(){
  if (!S.dirty || S.saving || !Auth.token()) return;
  S.saving = true; S.dirty = false;
  try { const remote = await readRemote(); S.data = merge(remote, S.data); lsSet("data", S.data); await writeRemote(S.data); S.online = true; S.savedAt = Date.now(); lsSet("savedAt", S.savedAt); if (!S.dirty) lsDel("dirty"); }
  catch(e){ S.dirty = true; handleErr(e); }
  S.saving = false; if (S.dirty) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 4000); }
  renderAll();
}
function handleErr(e){
  if (e && e.code === "auth"){ if (!S.data.active) renew(); else showAuth("expired"); }
  else if (e && e.code === "scope") showAuth("scope");
  else if (e && e.code === "forbidden") { S.driveErr = {text: "Google refused to save your log"+(e.message ? " ("+e.message+")" : "")+". Try signing out and back in under Manuscript settings.", retry:true}; renderMs(); }
  else { S.driveErr = {text: "Couldn't reach Google just now. Your changes are kept on this device and will save when you're back online.", retry:true}; renderMs(); }
}

// ---------------- reading the manuscripts ----------------
function docText(doc){
  const out = [];
  const walk = content => (content || []).forEach(el => {
    if (el.paragraph){
      const st = (el.paragraph.paragraphStyle || {}).namedStyleType || "";
      const t = (el.paragraph.elements || []).map(x => (x.textRun && x.textRun.content) || "").join("");
      out.push((/^HEADING_[123]$|^TITLE$/.test(st) ? "# " : "") + t);
    } else if (el.table){ (el.table.tableRows || []).forEach(r => (r.tableCells || []).forEach(c => walk(c.content))); }
  });
  walk(doc.body && doc.body.content);
  return out.join("\n");
}
async function readCount(did){
  const r = await gfetch("https://docs.googleapis.com/v1/documents/"+encodeURIComponent(did)+"?fields=body(content(paragraph(elements(textRun(content)),paragraphStyle(namedStyleType)),table(tableRows(tableCells(content(paragraph(elements(textRun(content)),paragraphStyle(namedStyleType))))))))");
  return countWords(docText(await r.json()));
}
function recordToday(count, did){
  const t = todayStr(); const m = S.data.snapshots[did] || (S.data.snapshots[did] = {});
  S.counts[did] = {n: count, at: Date.now()};
  if (m[t] && m[t].count === count && (m[t].m||"api") === "api") return false;
  m[t] = {count, at: Date.now(), m: "api"}; return true;
}
function docErr(e, b){
  if (e && e.code === "auth") return null;
  if (e && (e.code === "notfound" || e.code === "forbidden")) return {text: (b ? b.title+": " : "")+"Google couldn't open that doc. Check its link in Manuscript settings, and that it's in the Google account you signed in with.", retry:true};
  return {text:"Couldn't read your doc from Google just now.", retry:true};
}
async function syncNow(){
  if (!Auth.token() || S.syncing) return;
  S.syncing = true; S.driveErr = null; renderMs();
  let changed = false;
  for (const b of books()){
    try { const n = await readCount(b.docId); if (recordToday(n, b.docId)) changed = true; }
    catch(e){ if (e.code === "auth"){ if (!S.data.active) renew(); else showAuth("expired"); break; } if (!S.driveErr) S.driveErr = docErr(e, books().length > 1 ? b : null); }
  }
  await refreshCommentGoal();
  S.syncing = false; if (changed) save(); renderAll();
}

// ---------------- rendering ----------------
function showAuth(kind){
  const n = $("authBar"); n.hidden = false; n.className = "note signin";
  const g = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.3 13.4 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.7-3.9-13.6-9.4l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>';
  if (kind === "setup"){ n.innerHTML = "This app isn't connected to Google yet. Add your Google client ID to config.js, then reload."; return; }
  const msg = kind === "scope" ? "Google didn't give the app permission to save your log to Drive. Sign in again and check every box on Google's permission screen." : kind === "expired" ? "Your Google sign-in timed out. Your log is still here." : kind === "denied" ? "Google sign-in was cancelled. The app needs it to read your docs and save your log." : "Sign in with Google to read your manuscripts and save your log.";
  n.innerHTML = '<span style="flex:1;min-width:12em">'+esc(msg)+'</span><button class="gbtn" type="button" id="gSign">'+g+'Sign in with Google</button>';
  $("gSign").onclick = () => Auth.go(false);
}
function hideAuth(){ $("authBar").hidden = true; }

function renderTotals(){
  const t = todayStr(); const td = parse(t);
  const wk = new Date(td); wk.setDate(td.getDate() - td.getDay());
  const first = new Date(td.getFullYear(), td.getMonth(), 1);
  $("tToday").textContent = fmt(dayInfo(t).total);
  $("tWeek").textContent = fmt(sumRange(ymd(wk), t));
  $("tMonth").textContent = fmt(sumRange(ymd(first), t));
  $("tMonthLabel").textContent = td.toLocaleString("en-US",{month:"long"});
  const s = streaks();
  $("sCur").textContent = s.cur + (s.cur===1?" day":" days");
  $("sLong").textContent = s.long + (s.long===1?" day":" days");
}
function renderMs(){
  const bs = books(); let lastAt = 0;
  $("bookList").innerHTML = bs.length ? bs.map(b => {
    const cur = latestCount(b.docId); const g = Number(b.goal) || 80000;
    const pct = cur != null ? Math.min(100, cur/g*100) : 0;
    const c = S.counts[b.docId]; if (c && c.at > lastAt) lastAt = c.at;
    return '<div class="book'+(cur!=null && cur>=g?" done":"")+'" title="'+(cur!=null ? fmt(Math.max(0,g-cur))+' words to go' : '')+'"><span class="btitle">'+esc(b.title)+'</span>'+
      '<div class="gtrack" role="progressbar" aria-label="'+esc(b.title)+' progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(pct)+'"><div class="gfill" style="width:'+pct.toFixed(1)+'%"></div></div>'+
      '<span class="bmeta num">'+(cur!=null ? '<b>'+fmt(cur)+'</b> / '+short(g)+' · '+(cur>=g ? "Done!" : Math.round(pct)+'%') : 'Goal '+short(g))+'</span>'+planLine(b)+'</div>';
  }).join("") : '<p style="margin:0;font-size:13px;color:var(--muted)">No books yet. Open Manuscript settings at the bottom and add your first book.</p>';
  $("booksWhen").textContent = S.syncing ? "Reading your docs…" : S.saving ? "Saving…" : lastAt ? "Updated "+new Date(lastAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}) : "";
  $("syncBtn").disabled = S.syncing || !Auth.token() || !bs.length;
  const n = $("driveNote");
  if (S.driveErr){ n.hidden = false; n.innerHTML = esc(S.driveErr.text) + (S.driveErr.retry ? ' <button class="linkbtn" type="button" id="driveRetry">Try again</button>' : ""); const r = $("driveRetry"); if (r) r.onclick = () => { S.driveErr = null; syncNow(); flush(); }; }
  else n.hidden = true;
}

function planLine(b){
  const p = finishPlan(b); if (!p) return "";
  const by = parse(b.finishBy).toLocaleDateString("en-US", {month:"short", day:"numeric"});
  let txt;
  if (p.pending) txt = "Finish by "+by;
  else if (p.finished) txt = "Finished! ♥";
  else if (p.past) txt = "Finish date ("+by+") has passed · "+fmt(p.left)+" words to go";
  else if (p.noDays) txt = "No writing days left before "+by+" · "+fmt(p.left)+" to go";
  else txt = 'Finish by '+by+' · <b>'+fmt(p.perDay)+'</b> words a day · '+p.days+' writing '+(p.days === 1 ? "day" : "days")+' left'+
    (p.today == null ? ' · rest day today' : ' · today <b class="'+(p.today >= p.perDay ? "hit" : "")+'">'+fmt(p.today)+'</b> / '+fmt(p.perDay)+(p.today >= p.perDay ? ' ✓' : ''));
  return '<span class="bplan num">'+txt+'</span>';
}
let tick = null;
function clock(ms){ const s = Math.max(0, Math.round(ms/1000)); const h = Math.floor(s/3600), m = Math.floor(s%3600/60), x = s%60; return (h? h+":"+pad(m) : m)+":"+pad(x); }
function renderSprint(){
  const c = $("sprintCard"); const sp = S.data.active;
  c.className = "sprint" + (sp ? " on t-"+(sp.type||"sprint") : (S.picking ? " picking" : "")) + (S.ringing ? " ring" : "");
  clearInterval(tick); tick = null;
  const bs = books(), ab = activeBook();
  if (!ab){ c.innerHTML = ""; return; }
  const dis = (S.busy || !Auth.token()) ? " disabled" : "";
  const picker = sp ? '<div class="pick"><span class="booktitle">'+esc(sp.bookTitle || titleFor(sp.docId))+'</span></div>'
    : bs.length > 1 ? '<div class="pick"><select class="booksel" id="bookSel" aria-label="Book">'+bs.map(b => '<option value="'+esc(b.id)+'"'+(b.id===ab.id?" selected":"")+'>'+esc(b.title)+'</option>').join("")+'</select></div>'
    : '<div class="pick"><span class="booktitle">'+esc(ab.title)+'</span></div>';
  const wirePicker = () => { const s = $("bookSel"); if (s) s.onchange = e => { S.data.activeId = e.target.value; S.data.booksAt = Date.now(); save(); renderSprint(); }; };
  if (!sp && !S.picking){
    c.innerHTML = '<div class="idle">' + picker + '<div class="modes">'+["writing","editing","sprint"].map(k => '<button class="mode '+k+'" type="button" data-mode="'+k+'"'+dis+'><i></i>'+TYPE_NAME[k]+'</button>').join("")+'</div></div>'+
      (S.busy ? '<div class="meta">Reading your doc…</div>' : '');
    wirePicker();
    c.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { if (b.dataset.mode === "sprint"){ S.picking = true; renderSprint(); const i = $("spMin"); if (i) i.focus(); } else startSession(b.dataset.mode, null); });
    return;
  }
  if (!sp && S.picking){
    c.innerHTML = picker + '<div class="sprint-row"><label class="label" for="spMin">How many minutes?</label>'+
      '<input class="inp num" id="spMin" type="number" min="1" max="600" inputmode="numeric" placeholder="25" value="'+esc(S.sprintMin)+'" style="width:100px">'+
      '<button class="btn primary" id="spGo" type="button"'+dis+'>'+(S.busy?"Reading your doc…":"Start sprint")+'</button>'+
      '<button class="linkbtn" id="spBack" type="button">Back</button></div>'+
      '<div class="meta">An alarm rings when time is up. Keep the app open while you write.</div>';
    wirePicker();
    $("spMin").oninput = e => { S.sprintMin = e.target.value; };
    $("spMin").onkeydown = e => { if (e.key === "Enter") $("spGo").click(); };
    $("spGo").onclick = () => { const m = parseInt($("spMin").value || "25", 10); if (!m || m < 1) return; S.sprintMin = String(m); armAlarm(); startSession("sprint", m); };
    $("spBack").onclick = () => { S.picking = false; renderSprint(); };
    return;
  }
  const endAt = sp.type === "sprint" && sp.durationMin ? sp.start + sp.durationMin*60000 : null;
  const st = new Date(sp.start).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});
  const timeText = () => endAt ? (Date.now() < endAt ? clock(endAt - Date.now()) : "Time's up!") : clock(Date.now()-sp.start);
  const up = endAt && Date.now() >= endAt;
  const alarmOff = endAt && !up && !alarm.ctx;
  c.innerHTML = picker + '<div class="sprint-row"><div style="flex:1;min-width:0"><span class="label">'+TYPE_NAME[sp.type]+(endAt? " · "+sp.durationMin+" min" : "")+'</span><div class="timer num" id="spTimer">'+timeText()+'</div></div>'+
      (S.ringing ? '<button class="btn" id="spHush" type="button">Silence alarm</button>' : '')+
      '<button class="btn primary" id="spStop" type="button"'+(S.busy?' disabled':'')+'>'+(S.busy?"Reading your doc…": up ? "Log sprint" : endAt ? "Stop early" : "Stop")+'</button></div>'+
      '<div class="meta num">Started at '+st+(sp.startCount!=null?' with '+fmt(sp.startCount)+' words':'')+' · <button class="linkbtn" id="spCancel" type="button">Cancel</button></div>'+
      (alarmOff ? '<div class="note err"><span style="flex:1;min-width:12em">The alarm is off because the app was closed or reloaded.</span><button class="btn sm primary" id="spRearm" type="button">Turn on the alarm</button></div>' : '')+
      (S.stopManual ? '<div class="form"><div class="row"><label class="label" for="spManual">Words this session</label><input class="inp num" id="spManual" type="number" inputmode="numeric"><button class="btn teal" id="spManualSave" type="button">Save</button></div><div class="meta">Google couldn\'t be reached, so type the words yourself.</div></div>' : "");
  $("spStop").onclick = stopSession;
  $("spCancel").onclick = cancelSession;
  const h = $("spHush"); if (h) h.onclick = () => silence();
  const r = $("spRearm"); if (r) r.onclick = () => { armAlarm(); renderSprint(); };
  const ms = $("spManualSave"); if (ms) ms.onclick = () => { const w = parseInt($("spManual").value,10); if (!isNaN(w)) finishSession(null, w); };
  const check = () => { const el = $("spTimer"); if (el) el.textContent = timeText();
    if (endAt && Date.now() >= endAt && alarm.ctx && alarm.rungFor !== sp.start){ alarm.rungFor = sp.start; ring(); renderSprint(); } };
  tick = setInterval(check, 500); setTimeout(check, 0);
}

// ---------------- alarm ----------------
// The sound is unlocked when you tap Start (phones only allow sound after a tap), then played when the timer
// reaches zero. "playback" lets it ring even when the phone's silent switch is on.
const alarm = { ctx:null, lock:null, loop:null, rungFor:null };
function armAlarm(){
  silence(true);
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch(_){}
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC){
      const ctx = new AC(); alarm.ctx = ctx; if (ctx.resume) ctx.resume();
      const o = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = 0.0001;
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.05);
    }
  } catch(_){ alarm.ctx = null; }
  try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(l => { alarm.lock = l; }).catch(()=>{}); } catch(_){}
}
function ring(){
  const ctx = alarm.ctx; if (!ctx) return;
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch(_){}
  if (ctx.state !== "running" && ctx.resume) ctx.resume();
  let n = 0;
  const beep = () => {
    try {
      const t0 = ctx.currentTime + 0.03;
      [[880,0],[1318.5,0.16]].forEach(([f,off]) => {
        const o = ctx.createOscillator(), g = ctx.createGain(); const at = t0 + off;
        o.type = "sine"; o.frequency.value = f; g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.4, at+0.02); g.gain.exponentialRampToValueAtTime(0.0001, at+0.5);
        o.connect(g); g.connect(ctx.destination); o.start(at); o.stop(at+0.55);
      });
    } catch(_){}
    if (++n >= 45){ clearInterval(alarm.loop); alarm.loop = null; S.ringing = false; renderSprint(); }
  };
  clearInterval(alarm.loop); beep(); alarm.loop = setInterval(beep, 1300);
  S.ringing = true;
}
function silence(quiet){
  clearInterval(alarm.loop); alarm.loop = null;
  if (alarm.ctx){ try { alarm.ctx.close(); } catch(_){} alarm.ctx = null; }
  if (alarm.lock){ try { alarm.lock.release(); } catch(_){} alarm.lock = null; }
  S.ringing = false; if (quiet !== true) renderSprint();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !alarm.ctx) return;
  if (alarm.ctx.state !== "running" && alarm.ctx.resume) alarm.ctx.resume();
  if (S.data.active && navigator.wakeLock && !alarm.loop) navigator.wakeLock.request("screen").then(l => { alarm.lock = l; }).catch(()=>{});
});

function renderCal(){
  const v = S.view; const y = v.getFullYear(), m = v.getMonth();
  $("calTitle").textContent = v.toLocaleString("en-US",{month:"long",year:"numeric"});
  const today = todayStr();
  const lead = new Date(y,m,1).getDay(); const days = new Date(y,m+1,0).getDate();
  let h = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>'<div class="dow label">'+d+'</div>').join("");
  for (let i=0;i<lead;i++) h += '<div class="day out" aria-hidden="true"></div>';
  for (let d=1; d<=days; d++){
    const s = y+"-"+pad(m+1)+"-"+pad(d); const info = dayInfo(s);
    const cls = ["day"]; if (isSun(s)) cls.push("sun"); const off = offKind(s); if (off) cls.push(OFF_CLS[off]); if (s===today) cls.push("today"); if (s===S.selected) cls.push("sel"); if (s>today) cls.push("future");
    let w = '<span class="w zero">0</span>';
    if (info.total > 0) w = '<span class="w num">'+short(info.total)+'</span>';
    else if (info.net != null && info.net < 0) w = '<span class="w neg num" title="Net change in the doc">'+short(info.net)+'</span>';
    else if (off) w = '<span class="w off">'+(off === "vacation" ? "Vacay" : "Sick")+'</span>';
    const gd = goalFor(s); const gmet = gd && goalDone(s, gd) >= gd.target;
    const dots = info.ss.slice(0,4).map(x => '<i class="'+(x.type==="sprint"?"s":x.type==="editing"?"e":"")+'"></i>').join("");
    h += '<button type="button" class="'+cls.join(" ")+'" data-day="'+s+'" aria-label="'+parse(s).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})+', '+fmt(info.total)+' words'+(gmet ? ', daily goal met' : '')+(off ? ', '+OFF_NAME[off] : '')+'"><span class="d">'+d+(off ? '<span class="oi" aria-hidden="true">'+OFF_ICON[off]+'</span>' : '')+'</span>'+w+'<span class="dots">'+dots+'</span>'+(gmet ? '<span class="gm" aria-hidden="true">★</span>' : '')+'</button>';
  }
  $("cal").innerHTML = h;
  $("cal").querySelectorAll("[data-day]").forEach(b => b.onclick = () => { S.selected = b.dataset.day; S.pendingDel = null; renderCal(); renderPanel(); });
}
function renderPanel(){
  const d = S.selected; const info = dayInfo(d); const p = $("panel");
  const nice = parse(d).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"});
  let rows = "";
  info.parts.forEach(x => {
    const tt = esc(titleFor(x.did));
    if (x.delta != null) rows += '<div class="item"><span class="type doc">Doc</span><span class="grow">'+(x.delta>=0?"Words added to "+tt:"Net change in "+tt+" (more cut than added)")+'</span><span class="wds num">'+(x.delta>0?"+":"")+fmt(x.delta)+'</span></div>';
    else rows += '<div class="item"><span class="type doc">Doc</span><span class="grow">'+tt+' starting point: '+fmt(x.count)+' words. Daily counts begin after this.</span></div>';
  });
  info.ss.forEach(x => {
    const bits = [];
    if (books().length > 1 && (x.bookTitle || x.docId)) bits.push(x.bookTitle || titleFor(x.docId));
    if (x.timeOfDay) bits.push(TOD_NAME[x.timeOfDay]);
    if (x.start) bits.push(new Date(x.start).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}));
    if (x.minutes) bits.push(x.minutes+" min");
    if (x.minutes && x.words>0) bits.push(Math.round(x.words/x.minutes)+" words/min");
    const del = S.pendingDel === x.id
      ? '<span class="grow" style="flex:0 0 auto">Delete this?</span><button class="x" data-yes="'+esc(x.id)+'" type="button">Yes, delete</button><button class="x" data-no="1" type="button">Keep</button>'
      : '<button class="x" data-del="'+esc(x.id)+'" type="button" aria-label="Delete entry">Delete</button>';
    rows += '<div class="item"><span class="type '+esc(x.type)+'">'+esc(TYPE_NAME[x.type] || x.type)+'</span><span class="grow">'+esc(bits.join(" · "))+'</span>'+
      (x.words!=null && x.words!=="" ? '<span class="wds num">'+fmt(x.words)+'</span>' : '')+del+'</div>';
  });
  const gd = goalFor(d);
  if (gd){ const dn = goalDone(d, gd);
    rows = '<div class="item"><span class="type goal">Goal</span><span class="grow">'+fmt(gd.target)+' '+unitName(gd, gd.target)+(gd.unit === "comments" ? " to clear" : "")+' · '+fmt(dn)+(gd.unit === "comments" ? " cleared" : " done")+'</span>'+(dn >= gd.target ? '<span class="wds" style="color:var(--gold)">★ Met</span>' : '')+'</div>' + rows; }
  const off = offKind(d);
  if (off) rows = '<div class="item"><span class="type '+OFF_CLS[off]+'">'+OFF_ICON[off]+' '+OFF_NAME[off]+'</span><span class="grow">'+(info.active ? 'You wrote, so it counts toward your streak.' : 'Won\'t end your streak. If you write, it counts.')+'</span><button class="x" id="offClear" type="button">Remove</button></div>' + rows;
  if (!rows) rows = '<div class="item"><span class="grow">'+(isSun(d)?"Sunday rest day. You can still log something if you wrote.":"Nothing logged yet.")+'</span></div>';
  const f = S.form;
  p.innerHTML = '<div class="panel-head"><h3>'+esc(nice)+'</h3><span class="big num">'+fmt(info.total)+'</span><span class="label">words</span></div>'+
    '<div class="list">'+rows+'</div>'+
    (books().length ? '<div class="form"><span class="label">Forgot to tap a button? Log it here</span>'+
      '<div class="seg" role="group" aria-label="Kind of session">'+TYPES.map(([k,v])=>'<button type="button" data-ftype="'+k+'" aria-pressed="'+(f.type===k)+'">'+v+'</button>').join("")+'</div>'+
      '<div class="row"><label class="label" for="fMin">Minutes</label><input class="inp num" id="fMin" type="number" min="1" inputmode="numeric" placeholder="optional" value="'+esc(f.min)+'" style="width:110px">'+
      '<label class="label" for="fWords">Words</label><input class="inp num" id="fWords" type="number" inputmode="numeric" placeholder="optional" value="'+esc(f.words)+'" style="width:110px">'+
      '<button class="btn teal" id="fSave" type="button">Save</button></div>'+
      '<p style="margin:0;font-size:13px;color:var(--muted)">This adds a session to the day\'s log. The day\'s word count already comes from your doc, so words here are just for the session\'s own record.</p>'+
    '</div>' : '');
  p.querySelectorAll("[data-ftype]").forEach(b => b.onclick = () => { f.type = b.dataset.ftype; f.words = $("fWords").value; f.min = $("fMin").value; renderPanel(); });
  if ($("fMin")){ $("fMin").oninput = e => { f.min = e.target.value; }; $("fWords").oninput = e => { f.words = e.target.value; }; $("fSave").onclick = saveEntry; }
  const oc = $("offClear"); if (oc) oc.onclick = () => { setOff(d, null); renderAll(); };
  p.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { S.pendingDel = b.dataset.del; renderPanel(); });
  p.querySelectorAll("[data-no]").forEach(b => b.onclick = () => { S.pendingDel = null; renderPanel(); });
  p.querySelectorAll("[data-yes]").forEach(b => b.onclick = () => { const id = b.dataset.yes; S.pendingDel = null; delete S.data.sessions[id]; S.data.deleted[id] = Date.now(); save(); renderAll(); });
}
function renderTod(){
  const agg = {}; TODS.forEach(([k]) => agg[k] = {w:0,n:0});
  sessionList().forEach(x => { if (x.timeOfDay && agg[x.timeOfDay] && Number(x.words) > 0){ agg[x.timeOfDay].w += Number(x.words); agg[x.timeOfDay].n++; } });
  const used = TODS.filter(([k]) => agg[k].n);
  const avg = k => agg[k].n ? agg[k].w/agg[k].n : 0; const max = Math.max(1, ...used.map(([k])=>avg(k)));
  const best = used.length ? used.reduce((a,b)=> avg(b[0])>avg(a[0])?b:a)[0] : null;
  $("tod").innerHTML = TODS.map(([k,v]) => { const n = agg[k].n; const a = avg(k);
    return '<div class="bar'+(k===best?" best":"")+'"><span>'+v+'</span><span class="track"><span class="fill" style="width:'+(n? Math.max(4,a/max*100):0)+'%"></span></span><span class="v num">'+(n? fmt(Math.round(a))+' avg · '+n : '—')+'</span></div>'; }).join("")+
    '<p class="label" style="margin:4px 0 0">'+(used.length ? 'Average words per session · number of sessions' : 'Fills in as you log writing, editing and sprints')+'</p>';
}
// ---------------- daily goal ----------------
const UNITS = [["words","Words"],["pages","Pages"],["comments","Comments"]];
const UNIT_NAME = {words:["word","words"], pages:["page","pages"], comments:["comment","comments"]};
function unitName(g, n){ const u = UNIT_NAME[g.unit] || UNIT_NAME.words; return n === 1 ? u[0] : u[1]; }
function goalFor(d){ const g = (S.data.goals || {})[d]; return g && !g.cleared && g.target > 0 ? g : null; }
function goalDone(d, g){
  if (g.unit === "pages") return g.current != null && g.start != null ? Math.max(0, g.current - g.start) : (g.done || 0);
  if (g.unit === "comments") return g.done || 0;
  return dayInfo(d).total;
}
function setGoal(d, g){ (S.data.goals || (S.data.goals = {}))[d] = Object.assign({}, g, {at: Date.now()}); save(); }
function hasCommentScope(){ return (lsGet("scopes") || "").indexOf(COMMENT_SCOPE) >= 0; }
function askCommentScope(){ lsSet("wantComments", true); lsSet("pendingGoal", "comments"); Auth.go(false); }
async function readOpenComments(did){
  const ids = []; let tok = "";
  do {
    const r = await gfetch("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(did)+"/comments?pageSize=100&includeDeleted=false&fields=nextPageToken,comments(id,resolved)"+(tok ? "&pageToken="+encodeURIComponent(tok) : ""));
    const j = await r.json(); (j.comments || []).forEach(c => { if (!c.resolved) ids.push(c.id); }); tok = j.nextPageToken || "";
  } while (tok);
  return ids;
}
async function loadFormComments(f){
  const ab = activeBook(); if (!ab) return;
  f.comments = {loading: true}; f.commentsDoc = ab.docId;
  try { f.comments = {ids: await readOpenComments(ab.docId)}; }
  catch(e){ if (e.code === "scope" || e.code === "forbidden") lsSet("scopes", ""); f.comments = {err: true}; }
  if (S.goalForm === f) renderGoal();
}
async function refreshCommentGoal(){
  const t = todayStr(); const g = goalFor(t);
  if (!g || g.unit !== "comments" || !hasCommentScope() || !Auth.token()) return;
  try {
    const open = await readOpenComments(g.docId); const now = new Set(open);
    const done = (g.startIds || []).filter(id => !now.has(id)).length;
    if (done !== g.done || open.length !== g.open) setGoal(t, Object.assign({}, g, {done, open: open.length}));
  } catch(e){ if (e.code === "scope" || e.code === "forbidden") lsSet("scopes", ""); }
}
function openGoalForm(unit){
  const u = unit || lsGet("lastGoalUnit") || "words";
  const last = lsGet("lastGoal_"+u);
  S.goalForm = {unit: u, target: last ? String(last) : "", start: ""};
  renderGoal();
  if (u === "comments" && hasCommentScope()) loadFormComments(S.goalForm);
  const i = $("goalStart") || $("goalNum"); if (i){ i.focus(); i.select(); }
}
function renderGoal(){
  const box = $("goalBox"), btn = $("goalOpen"); const t = todayStr(); const g = goalFor(t); const f = S.goalForm;
  btn.hidden = !!g || !!f;
  if (f){
    const ab = activeBook(); let mid = "", canSet = true;
    const num = (id, ph, val, label) => '<label class="glab" for="'+id+'">'+label+'</label><input class="inp num" id="'+id+'" type="number" min="0" inputmode="numeric" placeholder="'+ph+'" value="'+esc(val)+'">';
    if (f.unit === "words") mid = num("goalNum", "1000", f.target, "Words");
    else if (f.unit === "pages") mid = num("goalStart", "1", f.start, "Starting page") + num("goalNum", "20", f.target, "Pages to edit");
    else if (!ab){ mid = '<span class="ginfo">Add a book first.</span>'; canSet = false; }
    else if (!hasCommentScope()){ mid = '<span class="ginfo">To count the comments in '+esc(ab.title)+', Google needs to OK the app reading your docs\' comments. It asks once.</span><button class="btn sm" id="goalAllow" type="button">Allow</button>'; canSet = false; }
    else {
      const c = f.comments || {};
      mid = '<span class="ginfo">'+esc(ab.title)+': '+(c.ids ? '<b class="num">'+fmt(c.ids.length)+'</b> open '+(c.ids.length === 1 ? "comment" : "comments") : c.err ? "couldn't count the comments" : "counting comments…")+'</span>'+
        (c.err ? '<button class="linkbtn" id="goalRetry" type="button">Try again</button>' : '') + num("goalNum", "30", f.target, "Comments to clear");
      canSet = !!c.ids;
    }
    box.innerHTML = '<div class="goalform"><div class="grow1"><span class="label">Today\'s goal</span>'+
      '<div class="seg" role="group" aria-label="Goal type">'+UNITS.map(([k,v]) => '<button type="button" data-gunit="'+k+'" aria-pressed="'+(f.unit===k)+'">'+v+'</button>').join("")+'</div></div>'+
      '<div class="grow1">'+mid+'</div>'+
      '<div class="grow1"><button class="btn teal sm" id="goalSet" type="button"'+(canSet ? '' : ' disabled')+'>Set goal</button>'+
      '<button class="linkbtn" id="goalCancel" type="button">Cancel</button>'+
      (g ? '<button class="linkbtn" id="goalRemove" type="button">Remove goal</button>' : '')+'</div></div>';
    const keep = () => { if ($("goalNum")) f.target = $("goalNum").value; if ($("goalStart")) f.start = $("goalStart").value; };
    box.querySelectorAll("[data-gunit]").forEach(b => b.onclick = () => {
      keep(); if (f.unit === b.dataset.gunit) return;
      f.unit = b.dataset.gunit; const last = lsGet("lastGoal_"+f.unit); f.target = last ? String(last) : "";
      if (f.unit === "comments" && hasCommentScope() && (!f.comments || f.commentsDoc !== (activeBook()||{}).docId)) loadFormComments(f);
      renderGoal();
    });
    ["goalNum","goalStart"].forEach(id => { const el = $(id); if (el){ el.oninput = keep; el.onkeydown = e => { if (e.key === "Enter") $("goalSet").click(); }; } });
    const al = $("goalAllow"); if (al) al.onclick = askCommentScope;
    const rt = $("goalRetry"); if (rt) rt.onclick = () => loadFormComments(f);
    $("goalSet").onclick = () => {
      keep(); const n = parseInt(f.target, 10); if (!n || n < 1){ $("goalNum").focus(); return; }
      const prev = goalFor(t); let ng;
      if (f.unit === "words") ng = {unit: "words", target: n};
      else if (f.unit === "pages"){
        const st = parseInt(f.start, 10); if (isNaN(st) || st < 0){ $("goalStart").focus(); return; }
        ng = {unit: "pages", target: n, start: st, current: prev && prev.unit === "pages" && prev.start === st ? prev.current : st};
      } else {
        const ab = activeBook(); if (!f.comments || !f.comments.ids) return;
        ng = prev && prev.unit === "comments" && prev.docId === ab.docId
          ? Object.assign({}, prev, {target: n})
          : {unit: "comments", target: n, docId: ab.docId, bookTitle: ab.title, startIds: f.comments.ids, open: f.comments.ids.length, done: 0};
      }
      setGoal(t, ng); lsSet("lastGoal_"+f.unit, n); lsSet("lastGoalUnit", f.unit); S.goalForm = null; renderAll();
    };
    $("goalCancel").onclick = () => { S.goalForm = null; renderGoal(); };
    const rm = $("goalRemove"); if (rm) rm.onclick = () => { (S.data.goals || (S.data.goals = {}))[t] = {cleared: true, at: Date.now()}; save(); S.goalForm = null; renderAll(); };
    return;
  }
  if (!g){ box.innerHTML = ""; return; }
  const done = goalDone(t, g); const pct = Math.min(100, done / g.target * 100); const met = done >= g.target;
  let detail = "", act = "";
  if (g.unit === "pages"){
    detail = '<span class="dleft num">Page '+fmt(g.start)+' → '+fmt(g.current)+'</span>';
    act = '<label class="glab" for="pgNow">On page</label><input class="tinp num" id="pgNow" type="number" min="0" inputmode="numeric" value="'+esc(g.current)+'"><button class="tiny plus" id="pgSave" type="button">Update</button>';
  } else if (g.unit === "comments"){
    detail = g.open != null ? '<span class="dleft num">'+fmt(g.open)+' still open in '+esc(g.bookTitle || titleFor(g.docId))+'</span>' : '';
    if (!hasCommentScope()) act = '<button class="linkbtn" id="goalAllow2" type="button">Count comments here</button>';
  }
  box.innerHTML = '<div class="dgoal'+(met ? " met" : "")+'"><div class="dtop">'+
    '<span class="dlabel">Today\'s goal</span><span class="dnum num">'+fmt(done)+' / '+fmt(g.target)+' '+unitName(g, g.target)+(g.unit === "comments" ? " cleared" : "")+'</span>'+
    (met ? '<span class="dmet">Goal met! ♥</span>' : '<span class="dleft num">'+fmt(g.target - done)+' to go</span>')+detail+
    '<span class="dact">'+act+'<button class="linkbtn" id="goalEdit" type="button">Change</button></span></div>'+
    '<div class="dtrack" role="progressbar" aria-label="Today\'s goal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(pct)+'"><div class="dfill" style="width:'+pct.toFixed(1)+'%"></div></div></div>';
  const ps = $("pgSave");
  if (ps){ const go = () => { const v = parseInt($("pgNow").value, 10); if (isNaN(v) || v < 0) return; setGoal(t, Object.assign({}, g, {current: v})); renderGoal(); renderCal(); renderPanel(); };
    ps.onclick = go; $("pgNow").onkeydown = e => { if (e.key === "Enter") go(); }; }
  const al = $("goalAllow2"); if (al) al.onclick = askCommentScope;
  $("goalEdit").onclick = () => {
    S.goalForm = {unit: g.unit, target: String(g.target), start: g.start != null ? String(g.start) : ""};
    if (g.unit === "comments" && hasCommentScope()) loadFormComments(S.goalForm);
    renderGoal();
  };
}
// ---------------- calendar settings (vacation / sick days) ----------------
function renderOffCal(){
  const mode = S.offMode; const v = S.offView; const y = v.getFullYear(), m = v.getMonth();
  const vb = $("offVac"), sb = $("offSick");
  vb.textContent = mode === "vacation" ? "Done" : "🌴 Vacation"; vb.classList.toggle("on", mode === "vacation"); vb.hidden = mode === "sick";
  sb.textContent = mode === "sick" ? "Done" : "🤒 Sick day"; sb.classList.toggle("on", mode === "sick"); sb.hidden = mode === "vacation";
  $("offHint").textContent = mode ? "Tap each "+(mode === "vacation" ? "vacation day" : "sick day")+". Tap a day again to undo it. Tap Done when you're finished."
    : "Tap Vacation or Sick day, then tap the days on the calendar.";
  $("offTitle").textContent = v.toLocaleString("en-US",{month:"long",year:"numeric"});
  const today = todayStr(); const lead = new Date(y,m,1).getDay(); const days = new Date(y,m+1,0).getDate();
  let h = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>'<div class="dow label">'+d+'</div>').join("");
  for (let i=0;i<lead;i++) h += '<div class="day out" aria-hidden="true"></div>';
  for (let d=1; d<=days; d++){
    const s = y+"-"+pad(m+1)+"-"+pad(d); const off = offKind(s);
    const cls = ["day"]; if (isSun(s)) cls.push("sun"); if (off) cls.push(OFF_CLS[off]); if (s===today) cls.push("today");
    h += '<button type="button" class="'+cls.join(" ")+'" data-off="'+s+'"'+(mode ? '' : ' tabindex="-1"')+' aria-label="'+parse(s).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})+(off ? ', '+OFF_NAME[off] : '')+'">'+
      '<span class="d">'+d+(off ? '<span class="oi" aria-hidden="true">'+OFF_ICON[off]+'</span>' : '')+'</span>'+
      (off ? '<span class="w off">'+(off === "vacation" ? "Vacay" : "Sick")+'</span>' : '<span class="w zero">0</span>')+'</button>';
  }
  const c = $("offCal"); c.innerHTML = h;
  c.className = "cal mini " + (mode ? "picking-"+OFF_CLS[mode] : "locked");
  c.querySelectorAll("[data-off]").forEach(b => b.onclick = () => {
    if (!S.offMode) return;
    const s = b.dataset.off; setOff(s, offKind(s) === S.offMode ? null : S.offMode);
    renderOffCal(); renderTotals(); renderCal(); renderPanel();
  });
}
function wireOffCal(){
  const t = new Date(); S.offView = new Date(t.getFullYear(), t.getMonth(), 1); S.offMode = null;
  $("offVac").onclick = () => { S.offMode = S.offMode === "vacation" ? null : "vacation"; renderOffCal(); };
  $("offSick").onclick = () => { S.offMode = S.offMode === "sick" ? null : "sick"; renderOffCal(); };
  $("offPrev").onclick = () => { S.offView = new Date(S.offView.getFullYear(), S.offView.getMonth()-1, 1); renderOffCal(); };
  $("offNext").onclick = () => { S.offView = new Date(S.offView.getFullYear(), S.offView.getMonth()+1, 1); renderOffCal(); };
  $("calSettings").addEventListener("toggle", () => { if (!$("calSettings").open){ S.offMode = null; } renderOffCal(); });
}
// ---------------- weekly goal ----------------
// Set once and it carries into later weeks until you change or remove it.
const weekStart = d => addDays(d, -parse(d).getDay());
function weekGoalFor(ws){
  const g = S.data.weekGoals || {}; const k = Object.keys(g).filter(x => x <= ws).sort().pop();
  const v = k && g[k]; return v && !v.cleared && v.target > 0 ? v : null;
}
function renderWeek(){
  const box = $("weekBox"), btn = $("weekOpen"); const t = todayStr(); const ws = weekStart(t); const we = addDays(ws, 6);
  const g = weekGoalFor(ws); const f = S.weekForm;
  btn.hidden = !!g || !!f;
  if (f){
    box.innerHTML = '<div class="goalform wk"><div class="grow1"><span class="label">Weekly goal</span>'+
      '<label class="glab" for="weekNum">Words a week</label><input class="inp num" id="weekNum" type="number" min="1" inputmode="numeric" placeholder="10000" value="'+esc(f.target)+'"></div>'+
      '<div class="grow1"><button class="btn teal sm" id="weekSet" type="button">Set goal</button><button class="linkbtn" id="weekCancel" type="button">Cancel</button>'+
      (g ? '<button class="linkbtn" id="weekRemove" type="button">Remove goal</button>' : '')+'</div>'+
      '<p style="margin:0;font-size:12px;color:var(--muted)">Weeks run Sunday to Saturday. It stays set for the weeks after this one until you change it.</p></div>';
    $("weekNum").oninput = e => { f.target = e.target.value; };
    $("weekNum").onkeydown = e => { if (e.key === "Enter") $("weekSet").click(); };
    $("weekSet").onclick = () => { const n = parseInt($("weekNum").value, 10); if (!n || n < 1){ $("weekNum").focus(); return; }
      (S.data.weekGoals || (S.data.weekGoals = {}))[ws] = {target: n, at: Date.now()}; save(); S.weekForm = null; renderAll(); };
    $("weekCancel").onclick = () => { S.weekForm = null; renderWeek(); };
    const rm = $("weekRemove"); if (rm) rm.onclick = () => { (S.data.weekGoals || (S.data.weekGoals = {}))[ws] = {cleared: true, at: Date.now()}; save(); S.weekForm = null; renderAll(); };
    return;
  }
  if (!g){ box.innerHTML = ""; return; }
  const done = sumRange(ws, t); const met = done >= g.target; const pct = Math.min(100, done / g.target * 100);
  const writeToday = isWritingDay(t);
  const before = t > ws ? sumRange(ws, addDays(t, -1)) : 0;
  const days = writingDaysBetween(writeToday ? t : addDays(t, 1), we);
  const perDay = days > 0 ? Math.ceil(Math.max(0, g.target - (writeToday ? before : done)) / days) : 0;
  const pace = met ? '' : days > 0 ? '<span class="dleft num">about '+fmt(perDay)+' a day for '+days+' more writing '+(days === 1 ? "day" : "days")+'</span>' : '<span class="dleft">no writing days left this week</span>';
  box.innerHTML = '<div class="dgoal wk'+(met ? " met" : "")+'"><div class="dtop">'+
    '<span class="dlabel">This week</span><span class="dnum num">'+fmt(done)+' / '+fmt(g.target)+' words</span>'+
    (met ? '<span class="dmet">Week goal met! ♥</span>' : '<span class="dleft num">'+fmt(g.target - done)+' to go</span>')+pace+
    '<span class="dact"><button class="linkbtn" id="weekEdit" type="button">Change</button></span></div>'+
    '<div class="dtrack" role="progressbar" aria-label="Weekly goal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(pct)+'"><div class="dfill" style="width:'+pct.toFixed(1)+'%"></div></div></div>';
  $("weekEdit").onclick = () => { S.weekForm = {target: String(g.target)}; renderWeek(); };
}
function renderAll(){ renderWeek(); renderGoal(); renderTotals(); renderMs(); renderSprint(); renderCal(); renderPanel(); renderTod(); fillSettings(); renderOffCal(); }

// ---------------- sessions ----------------
async function startSession(type, durationMin){
  const ab = activeBook(); if (S.busy || !ab) return;
  if (tokenLeft() < 5*60000){ lsSet("pendingStart", {type, durationMin: durationMin || null}); renew(); return; }
  S.busy = true; S.driveErr = null; renderSprint();
  try {
    const n = await readCount(ab.docId); recordToday(n, ab.docId);
    S.data.active = {type, durationMin: durationMin || null, start: Date.now(), startCount: n, docId: ab.docId, bookId: ab.id, bookTitle: ab.title, timeOfDay: todFor(new Date())};
    S.data.activeAt = Date.now(); S.picking = false; save(true);
  } catch(e){ silence(true); if (e.code === "auth"){ lsSet("pendingStart", {type, durationMin: durationMin || null}); renew(); } else S.driveErr = docErr(e, ab); }
  S.busy = false; renderAll();
}
async function stopSession(){
  if (S.busy || !S.data.active) return; silence(true); S.busy = true; S.driveErr = null; renderSprint();
  if (!Auth.token()){ lsSet("pendingStop", true); S.busy = false; renew(); return; }
  try { const n = await readCount(S.data.active.docId); finishSession(n, null); }
  catch(e){ if (e.code === "auth"){ lsSet("pendingStop", true); S.busy = false; renew(); return; } S.driveErr = docErr(e); S.stopManual = true; }
  S.busy = false; renderAll();
}
function finishSession(endCount, manualWords){
  const sp = S.data.active; if (!sp) return;
  const now = Date.now();
  const planned = sp.durationMin ? sp.start + sp.durationMin*60000 : null;
  const end = planned && now > planned ? planned : now;
  const words = manualWords != null ? manualWords : (sp.startCount != null ? endCount - sp.startCount : 0);
  S.data.sessions[uid("s")] = {date: dayOf(sp.start), type: sp.type, start: sp.start, end, minutes: Math.max(1, Math.round((end-sp.start)/60000)),
    plannedMin: sp.durationMin || null, docId: sp.docId, bookId: sp.bookId, bookTitle: sp.bookTitle, startCount: sp.startCount ?? null, endCount: endCount ?? null,
    words, timeOfDay: sp.timeOfDay || null, at: now};
  if (endCount != null) recordToday(endCount, sp.docId);
  S.data.active = null; S.data.activeAt = now; S.stopManual = false; S.selected = dayOf(sp.start);
  save(true); renderAll();
}
function cancelSession(){ silence(true); S.data.active = null; S.data.activeAt = Date.now(); S.stopManual = false; save(true); renderAll(); }
function saveEntry(){
  const f = S.form; const raw = $("fWords").value.trim(); const words = raw === "" ? null : parseInt(raw,10);
  if (raw !== "" && isNaN(words)) return;
  const mraw = $("fMin").value.trim(); const minutes = mraw === "" ? null : parseInt(mraw,10);
  if (mraw !== "" && (isNaN(minutes) || minutes < 1)) return;
  const ab = activeBook();
  S.data.sessions[uid("m")] = {date: S.selected, type: f.type, docId: ab.docId, bookId: ab.id, bookTitle: ab.title, words, minutes,
    timeOfDay: S.selected === todayStr() ? todFor(new Date()) : null, at: Date.now(), source: "manual"};
  S.form = {type: f.type, words: "", min: ""}; save(); renderAll();
}

// ---------------- settings ----------------
function editBook(){ const bs = books(); return bs.find(b => b.id === S.editId) || activeBook(); }
function fillSettings(){
  const bs = books(), a = editBook();
  if (document.activeElement && /^set/.test(document.activeElement.id)) return;
  $("bookPick").hidden = bs.length < 2;
  $("setBook").innerHTML = bs.map(b => '<option value="'+esc(b.id)+'"'+(a && b.id===a.id?" selected":"")+'>'+esc(b.title)+'</option>').join("");
  [$("setTitle"), $("setLink"), $("setGoal"), $("setFinish"), $("saveSet")].forEach(el => el.disabled = !a);
  $("setFinish").value = a && a.finishBy ? a.finishBy : "";
  $("setTitle").value = a ? a.title || "" : ""; $("setLink").value = a ? a.link || "" : ""; $("setGoal").value = a ? a.goal || "" : "";
  const em = lsGet("email"); const sv = S.savedAt || lsGet("savedAt");
  $("acctMsg").textContent = Auth.token() ? "Signed in to Google"+(em ? " as "+em : "")+" · "+(sv ? "last saved to Drive "+new Date(sv).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : "not saved to Drive yet") : "Not signed in. Your log is only on this device until you sign in.";
}
function wireSettings(){
  $("setBook").onchange = e => { S.editId = e.target.value; $("setMsg").textContent = ""; fillSettings(); };
  $("saveSet").onclick = () => {
    const a = books().find(b => b.id === (editBook()||{}).id); if (!a) return;
    const link = $("setLink").value.trim(); const id = link ? docIdFrom(link) : a.docId;
    if (!id){ $("setMsg").textContent = "That doesn't look like a Google Doc link."; return; }
    const goal = parseInt($("setGoal").value, 10); const changedDoc = id !== a.docId;
    a.title = $("setTitle").value.trim() || a.title; a.link = link; a.docId = id; a.goal = goal > 0 ? goal : (a.goal || 80000); a.finishBy = $("setFinish").value || null;
    S.data.booksAt = Date.now(); save(); $("setMsg").textContent = "Saved."; renderAll(); if (changedDoc) syncNow();
  };
  $("addOpen").onclick = () => { $("addForm").hidden = false; $("addOpen").hidden = true; $("addTitle").focus(); };
  $("addCancel").onclick = () => { $("addForm").hidden = true; $("addOpen").hidden = false; $("addMsg").textContent = ""; };
  $("addSave").onclick = () => {
    const title = $("addTitle").value.trim(); const id = docIdFrom($("addLink").value.trim()); const goal = parseInt($("addGoal").value, 10);
    if (!title){ $("addMsg").textContent = "Give the book a title."; return; }
    if (!id){ $("addMsg").textContent = "Paste the book's Google Doc link."; return; }
    const nb = {id: uid("b"), title, docId: id, link: $("addLink").value.trim(), goal: goal > 0 ? goal : 80000, finishBy: $("addFinish").value || null};
    S.data.books = books().concat([nb]); if (!S.data.activeId) S.data.activeId = nb.id; S.data.booksAt = Date.now();
    save(); $("addForm").hidden = true; $("addOpen").hidden = false; ["addTitle","addLink","addGoal","addFinish"].forEach(k => $(k).value = "");
    $("addMsg").textContent = ""; $("setMsg").textContent = "Added "+title+"."; renderAll(); syncNow();
  };
  $("importFile").onchange = async e => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    try {
      const inc = JSON.parse(await file.text());
      if (!inc || !inc.snapshots) throw 0;
      const cur = S.data;
      const mergedBooks = books().slice();
      (inc.books || []).forEach(b => { if (!mergedBooks.some(x => x.docId === b.docId)) mergedBooks.push(b); });
      inc.books = mergedBooks; inc.booksAt = Date.now(); inc.activeId = cur.activeId || (mergedBooks[0] && mergedBooks[0].id);
      inc.active = cur.active; inc.activeAt = cur.activeAt;
      S.data = merge(cur, inc); S.data.books = mergedBooks; S.data.booksAt = inc.booksAt; S.data.activeId = inc.activeId;
      save(true); $("importMsg").textContent = "History added."; renderAll(); syncNow();
    } catch(_){ $("importMsg").textContent = "That file isn't a Writing Log import."; }
    e.target.value = "";
  };
  $("signOut").onclick = () => { Auth.signOut(); S.counts = {}; renderAll(); showAuth("signin"); };
  $("prevM").onclick = () => { S.view = new Date(S.view.getFullYear(), S.view.getMonth()-1, 1); renderCal(); };
  $("nextM").onclick = () => { S.view = new Date(S.view.getFullYear(), S.view.getMonth()+1, 1); renderCal(); };
  $("syncBtn").onclick = () => syncNow();
  $("goalOpen").onclick = () => openGoalForm();
  $("weekOpen").onclick = () => { const ws = weekStart(todayStr()); const k = Object.keys(S.data.weekGoals || {}).filter(x => x <= ws).sort().pop(); const prev = k && S.data.weekGoals[k];
    S.weekForm = {target: prev && prev.target ? String(prev.target) : ""}; renderWeek(); const i = $("weekNum"); if (i){ i.focus(); i.select(); } };
}

// ---------------- boot ----------------
async function fetchEmail(){
  try { const r = await gfetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)"); const j = await r.json(); if (j.user) lsSet("email", j.user.emailAddress); } catch(_){}
}
async function boot(){
  wireSettings(); wireOffCal();
  const back = Auth.takeRedirect();
  renderAll();
  if (!CLIENT_ID){ showAuth("setup"); return; }
  if (!Auth.token()){
    if (back && back.error){ showAuth(back.silent ? "signin" : "denied"); return; }
    // Try a quiet sign-in once per launch unless a session is running (it survives the reload, but the alarm would not).
    const tried = lsGet("silentAt");
    if (lsGet("everSigned") && (!tried || Date.now() - tried > 20000)){ lsSet("silentAt", Date.now()); Auth.go(true); return; }
    showAuth(lsGet("everSigned") ? "expired" : "signin"); return;
  }
  lsSet("everSigned", true); hideAuth();
  if (!lsGet("email")) fetchEmail();
  await pull();
  if (lsGet("dirty")){ S.dirty = true; flush(); }
  const pg = lsGet("pendingGoal"); if (pg){ lsDel("pendingGoal"); if (!goalFor(todayStr()) || goalFor(todayStr()).unit === pg) openGoalForm(pg); }
  const ps = lsGet("pendingStop"), pst = lsGet("pendingStart"); lsDel("pendingStop"); lsDel("pendingStart");
  if (ps && S.data.active) await stopSession();
  else if (pst && !S.data.active) await startSession(pst.type, pst.durationMin);
  syncNow();
}
// Renew the sign-in when coming back to the app with it expired (not in the middle of a session).
function checkToken(e){ if (!CLIENT_ID || !lsGet("everSigned") || S.data.active || document.visibilityState !== "visible") return;
  if (!Auth.token() || (e && e.type === "visibilitychange" && tokenLeft() < 15*60000)) renew(); }
document.addEventListener("visibilitychange", checkToken);
const lastRead = () => Math.max(0, ...Object.values(S.counts).map(c => c.at));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Auth.token()){ pull().then(() => { if (Date.now() - lastRead() > 30000) syncNow(); }); } });
window.addEventListener("pageshow", e => { if (e.persisted && Auth.token()) pull().then(() => syncNow()); });
window.addEventListener("online", () => flush());
setInterval(() => { checkToken(); if (document.visibilityState === "visible" && Auth.token() && !S.saving){ pull().then(() => { if (Date.now() - lastRead() > 3*60000) syncNow(); }); } }, 60000);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(()=>{}));
boot();
})();
