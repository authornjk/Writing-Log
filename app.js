/* Writing Log — Nicole J Kimzey
   Runs on its own (GitHub Pages). Reads word counts with the Google Docs API and keeps the
   log in one file in your Google Drive ("Writing Log data.json"), so every device shares it. */
(function(){
"use strict";
const CFG = window.WRITING_LOG_CONFIG || {};
const CLIENT_ID = CFG.googleClientId || "";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents.readonly";
const DATA_NAME = "Writing Log data.json";
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
const todayStr = () => ymd(new Date());
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
function emptyData(){ return {v:1, books:[], activeId:null, booksAt:0, snapshots:{}, sessions:{}, deleted:{}, active:null, activeAt:0, goals:{}}; }
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
  for (const src of [a, b]) for (const [d, g] of Object.entries(src.goals || {})) {
    if (!out.goals[d] || (g.at||0) > (out.goals[d].at||0)) out.goals[d] = g;
  }
  return out;
}

const S = { data: lsGet("data") || emptyData(), counts:{}, view:null, selected:todayStr(), editId:null,
  syncing:false, driveErr:null, form:{type:"writing", words:"", min:""}, picking:false, sprintMin:"", ringing:false,
  pendingDel:null, stopManual:false, busy:false, fileId: lsGet("fileId"), online:false, saving:false, dirty:false };
{ const t = new Date(); S.view = new Date(t.getFullYear(), t.getMonth(), 1); }

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
function sumRange(from, to){ let t = 0; for (let d = from; d <= to; d = addDays(d,1)) t += dayInfo(d).total; return t; }
function streaks(){
  const today = todayStr();
  const dates = allDates().concat(sessionList().map(x=>x.date)).sort();
  if (!dates.length) return {cur:0, long:0};
  let run = 0, long = 0;
  for (let d = dates[0]; d <= today; d = addDays(d,1)){
    if (isSun(d)) continue;
    if (dayInfo(d).active){ run++; long = Math.max(long, run); }
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
    const p = new URLSearchParams({client_id: CLIENT_ID, redirect_uri: this.redirectUri(), response_type: "token", scope: SCOPES,
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
  try { const remote = await readRemote(); S.data = merge(S.data, remote); lsSet("data", S.data); S.online = true; S.loadErr = null;
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
      '<span class="bmeta num">'+(cur!=null ? '<b>'+fmt(cur)+'</b> / '+short(g)+' · '+(cur>=g ? "Done!" : Math.round(pct)+'%') : 'Goal '+short(g))+'</span></div>';
  }).join("") : '<p style="margin:0;font-size:13px;color:var(--muted)">No books yet. Open Manuscript settings at the bottom and add your first book.</p>';
  $("booksWhen").textContent = S.syncing ? "Reading your docs…" : S.saving ? "Saving…" : lastAt ? "Updated "+new Date(lastAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}) : "";
  $("syncBtn").disabled = S.syncing || !Auth.token() || !bs.length;
  const n = $("driveNote");
  if (S.driveErr){ n.hidden = false; n.innerHTML = esc(S.driveErr.text) + (S.driveErr.retry ? ' <button class="linkbtn" type="button" id="driveRetry">Try again</button>' : ""); const r = $("driveRetry"); if (r) r.onclick = () => { S.driveErr = null; syncNow(); flush(); }; }
  else n.hidden = true;
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
    $("spGo").onclick = () => { const m = parseInt($("spMin").value || "25", 10); if (!m || m < 1) return; S.sprintMin = String(m); armAlarm(m*60000); startSession("sprint", m); };
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
      (alarmOff ? '<div class="note">The alarm is off because the app was closed or reloaded. <button class="linkbtn" id="spRearm" type="button">Turn the alarm back on</button></div>' : '')+
      (S.stopManual ? '<div class="form"><div class="row"><label class="label" for="spManual">Words this session</label><input class="inp num" id="spManual" type="number" inputmode="numeric"><button class="btn teal" id="spManualSave" type="button">Save</button></div><div class="meta">Google couldn\'t be reached, so type the words yourself.</div></div>' : "");
  $("spStop").onclick = stopSession;
  $("spCancel").onclick = cancelSession;
  const h = $("spHush"); if (h) h.onclick = () => silence();
  const r = $("spRearm"); if (r) r.onclick = () => { armAlarm(endAt - Date.now()); renderSprint(); };
  const ms = $("spManualSave"); if (ms) ms.onclick = () => { const w = parseInt($("spManual").value,10); if (!isNaN(w)) finishSession(null, w); };
  let wasUp = up;
  tick = setInterval(() => { const el = $("spTimer"); if (el) el.textContent = timeText();
    if (endAt && !wasUp && Date.now() >= endAt){ wasUp = true; S.ringing = !!alarm.ctx; renderSprint(); } }, 500);
}

// ---------------- alarm ----------------
const alarm = { ctx:null, lock:null };
function armAlarm(ms){
  silence(true);
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC){
      const ctx = new AC(); alarm.ctx = ctx;
      const t0 = ctx.currentTime + Math.max(0, ms)/1000;
      for (let i = 0; i < 12; i++) [[880,0],[1318.5,0.16]].forEach(([f,off]) => {
        const o = ctx.createOscillator(), g = ctx.createGain(); const at = t0 + i*1.3 + off;
        o.type = "sine"; o.frequency.value = f; g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.35, at+0.02); g.gain.exponentialRampToValueAtTime(0.0001, at+0.5);
        o.connect(g); g.connect(ctx.destination); o.start(at); o.stop(at+0.55);
      });
    }
  } catch(_){ alarm.ctx = null; }
  try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(l => { alarm.lock = l; }).catch(()=>{}); } catch(_){}
}
function silence(quiet){
  if (alarm.ctx){ try { alarm.ctx.close(); } catch(_){} alarm.ctx = null; }
  if (alarm.lock){ try { alarm.lock.release(); } catch(_){} alarm.lock = null; }
  S.ringing = false; if (quiet !== true) renderSprint();
}

function renderCal(){
  const v = S.view; const y = v.getFullYear(), m = v.getMonth();
  $("calTitle").textContent = v.toLocaleString("en-US",{month:"long",year:"numeric"});
  const today = todayStr();
  const lead = new Date(y,m,1).getDay(); const days = new Date(y,m+1,0).getDate();
  let h = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>'<div class="dow label">'+d+'</div>').join("");
  for (let i=0;i<lead;i++) h += '<div class="day out" aria-hidden="true"></div>';
  for (let d=1; d<=days; d++){
    const s = y+"-"+pad(m+1)+"-"+pad(d); const info = dayInfo(s);
    const cls = ["day"]; if (isSun(s)) cls.push("sun"); if (s===today) cls.push("today"); if (s===S.selected) cls.push("sel"); if (s>today) cls.push("future");
    let w = '<span class="w zero">0</span>';
    if (info.total > 0) w = '<span class="w num">'+short(info.total)+'</span>';
    else if (info.net != null && info.net < 0) w = '<span class="w neg num" title="Net change in the doc">'+short(info.net)+'</span>';
    const gd = goalFor(s); const gmet = gd && goalDone(s, gd) >= gd.target;
    const dots = info.ss.slice(0,4).map(x => '<i class="'+(x.type==="sprint"?"s":x.type==="editing"?"e":"")+'"></i>').join("");
    h += '<button type="button" class="'+cls.join(" ")+'" data-day="'+s+'" aria-label="'+parse(s).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})+', '+fmt(info.total)+' words'+(gmet ? ', daily goal met' : '')+'"><span class="d">'+d+'</span>'+w+'<span class="dots">'+dots+'</span>'+(gmet ? '<span class="gm" aria-hidden="true">★</span>' : '')+'</button>';
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
  if (gd){ const dn = goalDone(d, gd); const un = gd.unit === "pages" ? "pages" : "words";
    rows = '<div class="item"><span class="type goal">Goal</span><span class="grow">'+fmt(gd.target)+' '+un+' · '+fmt(dn)+' done</span>'+(dn >= gd.target ? '<span class="wds" style="color:var(--gold)">★ Met</span>' : '')+'</div>' + rows; }
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
function goalFor(d){ const g = (S.data.goals || {})[d]; return g && !g.cleared && g.target > 0 ? g : null; }
function goalDone(d, g){ return g.unit === "pages" ? (g.done || 0) : dayInfo(d).total; }
function setGoal(d, g){ (S.data.goals || (S.data.goals = {}))[d] = Object.assign({}, g, {at: Date.now()}); save(); }
function renderGoal(){
  const box = $("goalBox"), btn = $("goalOpen"); const t = todayStr(); const g = goalFor(t); const f = S.goalForm;
  btn.hidden = !!g || !!f;
  if (f){
    box.innerHTML = '<div class="goalform"><span class="label">Today\'s goal</span>'+
      '<div class="seg" role="group" aria-label="Goal type">'+[["words","Words"],["pages","Pages"]].map(([k,v]) => '<button type="button" data-gunit="'+k+'" aria-pressed="'+(f.unit===k)+'">'+v+'</button>').join("")+'</div>'+
      '<input class="inp num" id="goalNum" type="number" min="1" inputmode="numeric" aria-label="'+(f.unit==="pages"?"Pages":"Words")+'" placeholder="'+(f.unit==="pages"?"20":"1000")+'" value="'+esc(f.target)+'">'+
      '<button class="btn teal sm" id="goalSet" type="button">Set goal</button>'+
      '<button class="linkbtn" id="goalCancel" type="button">Cancel</button>'+
      (g ? '<button class="linkbtn" id="goalRemove" type="button">Remove goal</button>' : '')+'</div>';
    box.querySelectorAll("[data-gunit]").forEach(b => b.onclick = () => { f.target = $("goalNum").value; f.unit = b.dataset.gunit; renderGoal(); $("goalNum").focus(); });
    $("goalNum").oninput = e => { f.target = e.target.value; };
    $("goalNum").onkeydown = e => { if (e.key === "Enter") $("goalSet").click(); };
    $("goalSet").onclick = () => {
      const n = parseInt($("goalNum").value, 10); if (!n || n < 1){ $("goalNum").focus(); return; }
      const prev = goalFor(t);
      setGoal(t, {unit: f.unit, target: n, done: prev && prev.unit === f.unit ? (prev.done || 0) : 0});
      lsSet("lastGoal", {unit: f.unit, target: n}); S.goalForm = null; renderAll();
    };
    $("goalCancel").onclick = () => { S.goalForm = null; renderGoal(); };
    const rm = $("goalRemove"); if (rm) rm.onclick = () => { (S.data.goals || (S.data.goals = {}))[t] = {cleared: true, at: Date.now()}; save(); S.goalForm = null; renderAll(); };
    return;
  }
  if (!g){ box.innerHTML = ""; return; }
  const done = goalDone(t, g); const pct = Math.min(100, done / g.target * 100); const met = done >= g.target;
  const unit = g.unit === "pages" ? (g.target === 1 ? "page" : "pages") : "words";
  box.innerHTML = '<div class="dgoal'+(met ? " met" : "")+'"><div class="dtop">'+
    '<span class="dlabel">Today\'s goal</span><span class="dnum num">'+fmt(done)+' / '+fmt(g.target)+' '+unit+'</span>'+
    (met ? '<span class="dmet">Goal met! ♥</span>' : '<span class="dleft num">'+fmt(g.target - done)+' to go</span>')+
    '<span class="dact">'+(g.unit === "pages" ? '<button class="tiny" id="pgMinus" type="button" aria-label="Take back a page"'+(done ? '' : ' disabled')+'>−</button><button class="tiny plus" id="pgPlus" type="button">+1 page</button>' : '')+
    '<button class="linkbtn" id="goalEdit" type="button">Change</button></span></div>'+
    '<div class="dtrack" role="progressbar" aria-label="Today\'s goal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(pct)+'"><div class="dfill" style="width:'+pct.toFixed(1)+'%"></div></div></div>';
  const plus = $("pgPlus"), minus = $("pgMinus");
  if (plus) plus.onclick = () => { setGoal(t, Object.assign({}, g, {done: (g.done || 0) + 1})); renderGoal(); renderCal(); renderPanel(); };
  if (minus) minus.onclick = () => { setGoal(t, Object.assign({}, g, {done: Math.max(0, (g.done || 0) - 1)})); renderGoal(); renderCal(); renderPanel(); };
  $("goalEdit").onclick = () => { S.goalForm = {unit: g.unit, target: String(g.target)}; renderGoal(); };
}
function renderAll(){ renderGoal(); renderTotals(); renderMs(); renderSprint(); renderCal(); renderPanel(); renderTod(); fillSettings(); }

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
  S.data.sessions[uid("s")] = {date: ymd(new Date(sp.start)), type: sp.type, start: sp.start, end, minutes: Math.max(1, Math.round((end-sp.start)/60000)),
    plannedMin: sp.durationMin || null, docId: sp.docId, bookId: sp.bookId, bookTitle: sp.bookTitle, startCount: sp.startCount ?? null, endCount: endCount ?? null,
    words, timeOfDay: sp.timeOfDay || null, at: now};
  if (endCount != null) recordToday(endCount, sp.docId);
  S.data.active = null; S.data.activeAt = now; S.stopManual = false; S.selected = ymd(new Date(sp.start));
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
  [$("setTitle"), $("setLink"), $("setGoal"), $("saveSet")].forEach(el => el.disabled = !a);
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
    a.title = $("setTitle").value.trim() || a.title; a.link = link; a.docId = id; a.goal = goal > 0 ? goal : (a.goal || 80000);
    S.data.booksAt = Date.now(); save(); $("setMsg").textContent = "Saved."; renderAll(); if (changedDoc) syncNow();
  };
  $("addOpen").onclick = () => { $("addForm").hidden = false; $("addOpen").hidden = true; $("addTitle").focus(); };
  $("addCancel").onclick = () => { $("addForm").hidden = true; $("addOpen").hidden = false; $("addMsg").textContent = ""; };
  $("addSave").onclick = () => {
    const title = $("addTitle").value.trim(); const id = docIdFrom($("addLink").value.trim()); const goal = parseInt($("addGoal").value, 10);
    if (!title){ $("addMsg").textContent = "Give the book a title."; return; }
    if (!id){ $("addMsg").textContent = "Paste the book's Google Doc link."; return; }
    const nb = {id: uid("b"), title, docId: id, link: $("addLink").value.trim(), goal: goal > 0 ? goal : 80000};
    S.data.books = books().concat([nb]); if (!S.data.activeId) S.data.activeId = nb.id; S.data.booksAt = Date.now();
    save(); $("addForm").hidden = true; $("addOpen").hidden = false; ["addTitle","addLink","addGoal"].forEach(k => $(k).value = "");
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
  $("goalOpen").onclick = () => { const last = lsGet("lastGoal") || {unit: "words", target: ""}; S.goalForm = {unit: last.unit, target: last.target ? String(last.target) : ""}; renderGoal(); const i = $("goalNum"); if (i){ i.focus(); i.select(); } };
}

// ---------------- boot ----------------
async function fetchEmail(){
  try { const r = await gfetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)"); const j = await r.json(); if (j.user) lsSet("email", j.user.emailAddress); } catch(_){}
}
async function boot(){
  wireSettings();
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
  const ps = lsGet("pendingStop"), pst = lsGet("pendingStart"); lsDel("pendingStop"); lsDel("pendingStart");
  if (ps && S.data.active) await stopSession();
  else if (pst && !S.data.active) await startSession(pst.type, pst.durationMin);
  syncNow();
}
// Renew the sign-in when coming back to the app with it expired (not in the middle of a session).
function checkToken(){ if (!CLIENT_ID || !lsGet("everSigned")) return; if (!Auth.token() && !S.data.active && document.visibilityState === "visible") renew(); }
document.addEventListener("visibilitychange", checkToken);
const lastRead = () => Math.max(0, ...Object.values(S.counts).map(c => c.at));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Auth.token()){ pull().then(() => { if (Date.now() - lastRead() > 30000) syncNow(); }); } });
window.addEventListener("pageshow", e => { if (e.persisted && Auth.token()) pull().then(() => syncNow()); });
window.addEventListener("online", () => flush());
setInterval(() => { checkToken(); if (document.visibilityState === "visible" && Auth.token() && !S.saving){ pull().then(() => { if (Date.now() - lastRead() > 3*60000) syncNow(); }); } }, 60000);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(()=>{}));
boot();
})();
