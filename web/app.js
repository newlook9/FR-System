"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = { lang: "ur", token: null, user: null };
try { S.lang = localStorage.getItem("frs_lang") || "ur"; S.token = sessionStorage.getItem("frs_tok"); } catch (e) {}
const t = k => (I18N[S.lang] && I18N[S.lang][k]) || I18N.en[k] || k;
const PST = ["wanted", "absconder", "arrested", "under_investigation", "convicted", "cleared"];
const CST = ["registered", "investigation", "in_court", "convicted", "acquitted", "closed"];

function setLang(l) {
  S.lang = l; try { localStorage.setItem("frs_lang", l); } catch (e) {}
  document.documentElement.lang = l; document.documentElement.dir = l === "ur" ? "rtl" : "ltr";
  document.title = t("app");
}
function toast(m, bad) { const e = $("#toast"); e.textContent = m; e.className = "show" + (bad ? " bad" : ""); clearTimeout(toast.h); toast.h = setTimeout(() => e.className = "", 3200); }
const errMsg = e => t(e.message in I18N.en ? e.message : (e.message === "Failed to fetch" ? "net" : "server_err"));

async function api(method, path, body) {
  let r;
  try {
    r = await fetch("/api" + path, { method, headers: { "Content-Type": "application/json", ...(S.token ? { Authorization: "Bearer " + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Error("net"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && d.error === "auth") { signOut(true); }
    throw new Error(d.error || "server");
  }
  return d;
}
function signOut(expired) {
  S.token = null; S.user = null; try { sessionStorage.removeItem("frs_tok"); } catch (e) {}
  location.hash = "#/login"; if (expired) toast(t("auth"), true);
}

const photoCache = new Map();
async function loadPhotos() {
  for (const el of document.querySelectorAll("[data-ph],[data-img]")) {
    const id = el.dataset.img || "/api/photo/" + el.dataset.ph;
    if (!photoCache.has(id)) photoCache.set(id, fetch(id, { headers: { Authorization: "Bearer " + S.token } }).then(r => r.ok ? r.blob() : null).then(b => b ? URL.createObjectURL(b) : null).catch(() => null));
    const u = await photoCache.get(id); if (u) el.style.backgroundImage = `url(${u})`;
  }
}
const ph = (p, cls = "") => `<div class="ph ${cls}" ${p.has_photo ? `data-ph="${p.id}"` : ""} aria-hidden="true"></div>`;
const tag = (st) => `<span class="tag s-${esc(st)}">${esc(t(st))}</span>`;
const fmtTs = ts => { const d = new Date(ts * 1000), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const opts = (arr, sel) => arr.map(v => `<option value="${v}" ${v === sel ? "selected" : ""}>${esc(t(v))}</option>`).join("");
const field = (id, label, v = "", type = "text", cls = "") => `<div class="${cls}"><label for="${id}">${esc(t(label))}</label><input id="${id}" type="${type}" value="${esc(v)}"></div>`;
const val = id => $("#" + id).value;

function shell(active, inner) {
  const u = S.user, adm = u.role === "admin";
  const nav = [["dashboard", "dashboard"], ["persons", "persons"], ...(u.role !== "viewer" ? [["facesearch", "facesearch"]] : []), ["events", "events"], ...(adm ? [["users", "users"], ["audit", "audit"]] : []), ["settings", "settings"]];
  $("#app").innerHTML = `<div class="shell"><nav class="side" aria-label="Main">
    <div class="brand"><img src="logo.svg" alt=""><span>${esc(t("app"))}</span></div>
    ${nav.map(([h, k]) => `<a href="#/${h}" class="${h === active ? "on" : ""}">${esc(t(k))}</a>`).join("")}
    <div class="sp"></div><div class="who">${esc(u.name)}<br>${esc(t(u.role))}</div>
    <a href="#" id="out">${esc(t("logout"))}</a></nav><main class="main">${inner}</main></div>`;
  $("#out").onclick = async e => { e.preventDefault(); try { await api("POST", "/logout"); } catch (x) {} signOut(); };
}
const canEdit = () => S.user && S.user.role !== "viewer";

/* ---------- views ---------- */
function viewLogin() {
  $("#app").innerHTML = `<div class="login"><div class="hero"><img src="logo.svg" alt="${esc(t("app"))}"><h1>${esc(t("app"))}</h1><p>${esc(t("tag"))}</p></div>
  <form id="f"><div class="row" style="justify-content:flex-end"><button type="button" class="btn alt sm" id="lg">${S.lang === "ur" ? "English" : "اردو"}</button></div>
  <h2>${esc(t("login"))}</h2>${field("u", "username", "", "text")}${field("p", "password", "", "password")}
  <div class="err" id="e" role="alert"></div><button class="btn">${esc(t("login"))}</button></form></div>`;
  $("#u").autocomplete = "username"; $("#p").autocomplete = "current-password";
  $("#lg").onclick = () => { setLang(S.lang === "ur" ? "en" : "ur"); viewLogin(); };
  $("#f").onsubmit = async e => {
    e.preventDefault();
    try {
      const d = await api("POST", "/login", { username: val("u"), password: val("p") });
      S.token = d.token; S.user = d.user; try { sessionStorage.setItem("frs_tok", d.token); } catch (x) {}
      location.hash = d.user.must_change ? "#/password" : "#/dashboard"; route();
    } catch (x) { $("#e").textContent = errMsg(x); }
  };
}

function viewPassword(forced) {
  const inner = `<div class="bar"><h1>${esc(t("change_password"))}</h1></div><form id="f" class="card form" style="max-width:520px">
  ${forced ? `<div class="full err">${esc(t("must_change"))}</div>` : ""}
  ${field("o", "old_password", "", "password", "full")}${field("n", "new_password", "", "password", "full")}
  <div class="full err" id="e" role="alert"></div><div class="full"><button class="btn">${esc(t("save"))}</button></div></form>`;
  forced ? $("#app").innerHTML = `<main class="main">${inner}</main>` : shell("settings", inner);
  $("#f").onsubmit = async e => {
    e.preventDefault();
    try { await api("POST", "/password", { old: val("o"), new: val("n") }); S.user.must_change = 0; toast(t("saved")); location.hash = "#/dashboard"; }
    catch (x) { $("#e").textContent = errMsg(x); }
  };
}

async function viewDashboard() {
  const d = await api("GET", "/dashboard");
  const w = (d.by_status.wanted || 0) + (d.by_status.absconder || 0);
  shell("dashboard", `<div class="bar"><h1>${esc(t("dashboard"))}</h1>${canEdit() ? `<a class="btn" href="#/person/new">${esc(t("add_person"))}</a>` : ""}</div>
  <div class="grid g4"><div class="card stat"><b class="num">${d.total}</b><span>${esc(t("total_records"))}</span></div>
  <div class="card stat w"><b class="num">${w}</b><span>${esc(t("wanted"))} / ${esc(t("absconder"))}</span></div>
  <div class="card stat"><b class="num">${d.cases}</b><span>${esc(t("total_cases"))}</span></div>
  <a class="card stat w" href="#/events" style="text-decoration:none"><b class="num">${d.new_events}</b><span>${esc(t("new_events"))}</span></a></div>
  <div class="grid g2" style="margin-top:14px">
  <div class="card"><h2>${esc(t("hearings"))}</h2>${d.hearings.length ? `<div class="list" style="margin-top:10px">${d.hearings.map(h => `<a class="item" href="#/person/${h.pid}"><div class="t"><b>${esc(h.name)}</b><br><small>FIR <span class="num">${esc(h.fir_no)}</span> · ${esc(h.court)}</small></div><span class="num">${esc(h.next_hearing)}</span></a>`).join("")}</div>` : `<p class="empty">${esc(t("no_hearings"))}</p>`}</div>
  <div class="card"><h2>${esc(t("recent"))}</h2>${d.recent.length ? `<div class="list" style="margin-top:10px">${d.recent.map(p => `<a class="item" href="#/person/${p.id}">${ph(p)}<div class="t"><b>${esc(p.name)}</b><br><small class="num">${esc(p.cnic)}</small></div>${tag(p.status)}</a>`).join("")}</div>` : `<p class="empty">${esc(t("no_results"))}</p>`}</div></div>`);
  loadPhotos();
}

let lastQ = { q: "", st: "" };
async function viewPersons() {
  shell("persons", `<div class="bar"><h1>${esc(t("persons"))}</h1>${canEdit() ? `<a class="btn" href="#/person/new">${esc(t("add_person"))}</a>` : ""}</div>
  <div class="search"><input id="q" type="search" placeholder="${esc(t("search"))}" value="${esc(lastQ.q)}" aria-label="${esc(t("search"))}">
  <select id="st" aria-label="${esc(t("status"))}"><option value="">${esc(t("all"))}</option>${opts(PST, lastQ.st)}</select></div><div id="res" class="list"></div>`);
  let h; const go = async () => {
    lastQ = { q: val("q"), st: val("st") };
    try {
      const r = await api("GET", `/persons?q=${encodeURIComponent(lastQ.q)}&status=${lastQ.st}`);
      $("#res").innerHTML = r.length ? r.map(p => `<a class="item" href="#/person/${p.id}">${ph(p)}<div class="t"><b>${esc(p.name)}</b> <small>${esc(p.father_name)}</small><br><small class="num">${esc(p.cnic)}</small></div>${tag(p.status)}</a>`).join("") : `<div class="empty">${esc(t("no_results"))}</div>`;
      loadPhotos();
    } catch (x) { toast(errMsg(x), true); }
  };
  $("#q").oninput = () => { clearTimeout(h); h = setTimeout(go, 300); }; $("#st").onchange = go; go();
}

function resizePhoto(file) {
  return new Promise((res, rej) => {
    const img = new Image(), u = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, 640 / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = img.width * k; c.height = img.height * k; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); res(c.toDataURL("image/jpeg", 0.85)); };
    img.onerror = () => rej(new Error("photo_invalid")); img.src = u;
  });
}

async function viewPersonForm(id) {
  const p = id ? await api("GET", "/persons/" + id) : { status: "wanted", gender: "male" };
  shell("persons", `<div class="bar"><h1>${esc(t(id ? "edit" : "add_person"))}</h1></div><form id="f" class="card form">
  ${field("name", "name", p.name, "text", "full")}${field("father_name", "father_name", p.father_name)}${field("alias", "alias", p.alias)}
  ${field("cnic", "cnic", p.cnic)}${field("dob", "dob", p.dob, "date")}
  <div><label for="gender">${esc(t("gender"))}</label><select id="gender">${opts(["male", "female", "other"], p.gender)}</select></div>
  <div><label for="status">${esc(t("status"))}</label><select id="status">${opts(PST, p.status)}</select></div>
  ${field("phone", "phone", p.phone, "tel")}${field("height", "height", p.height)}
  <div class="full"><label for="address">${esc(t("address"))}</label><textarea id="address">${esc(p.address)}</textarea></div>
  <div class="full"><label for="marks">${esc(t("marks"))}</label><textarea id="marks">${esc(p.marks)}</textarea></div>
  <div class="full"><label for="notes">${esc(t("notes"))}</label><textarea id="notes">${esc(p.notes)}</textarea></div>
  <div class="full row">${ph(p, "lg").replace('class="ph lg"', 'id="prev" class="ph lg"')}<div><label for="photo">${esc(t("photo"))}</label><input id="photo" type="file" accept="image/*"></div></div>
  <div class="full err" id="e" role="alert"></div>
  <div class="full row"><button class="btn">${esc(t("save"))}</button><a class="btn alt" href="#/${id ? "person/" + id : "persons"}">${esc(t("cancel"))}</a></div></form>`);
  loadPhotos(); let photo = null;
  $("#photo").onchange = async e => { try { photo = await resizePhoto(e.target.files[0]); $("#prev").style.backgroundImage = `url(${photo})`; } catch (x) { $("#e").textContent = errMsg(x); } };
  $("#f").onsubmit = async e => {
    e.preventDefault();
    const b = {}; ["name", "father_name", "alias", "cnic", "dob", "gender", "status", "phone", "height", "address", "marks", "notes"].forEach(k => b[k] = val(k)); if (photo) b.photo = photo;
    try { const r = id ? await api("PUT", "/persons/" + id, b) : await api("POST", "/persons", b); photoCache.delete("/api/photo/" + (id || r.id)); toast(r.face === "no_face" ? t("no_face") : t("saved"), r.face === "no_face"); location.hash = "#/person/" + (id || r.id); }
    catch (x) { $("#e").textContent = errMsg(x); }
  };
}

async function viewPerson(id) {
  const p = await api("GET", "/persons/" + id);
  const rows = [["father_name", p.father_name], ["alias", p.alias], ["cnic", p.cnic], ["dob", p.dob], ["gender", p.gender ? t(p.gender) : ""], ["phone", p.phone], ["height", p.height], ["address", p.address], ["marks", p.marks], ["notes", p.notes]].filter(r => r[1]);
  shell("persons", `<div class="bar"><h1>${esc(p.name)}</h1>${canEdit() ? `<div class="row"><a class="btn alt" href="#/person/${id}/edit">${esc(t("edit"))}</a><button class="btn bad" id="arch">${esc(t("archive"))}</button></div>` : ""}</div>
  <div class="card row" style="align-items:flex-start;gap:20px">${ph(p, "lg")}<div style="flex:1;min-width:240px">${tag(p.status)} <span class="tag" style="color:var(--mute)">${esc(t(p.face_enrolled ? "face_ok" : "face_none"))}</span><dl class="kv" style="margin-top:10px">${rows.map(([k, v]) => `<dt>${esc(t(k))}</dt><dd class="${k === "cnic" || k === "phone" || k === "dob" ? "num" : ""}">${esc(v)}</dd>`).join("")}</dl></div></div>
  <div class="bar" style="margin-top:22px"><h2>${esc(t("cases"))}</h2>${canEdit() ? `<a class="btn" href="#/person/${id}/case">${esc(t("add_case"))}</a>` : ""}</div>
  ${p.cases.length ? `<div class="grid">${p.cases.map(c => `<div class="card"><div class="row" style="justify-content:space-between"><b>FIR <span class="num">${esc(c.fir_no)}</span></b><span class="tag">${esc(t(c.status))}</span></div>
  <dl class="kv" style="margin-top:8px">${[["police_station", c.police_station], ["fir_date", c.fir_date], ["sections", c.sections], ["location", c.location], ["court", c.court], ["next_hearing", c.next_hearing], ["details", c.details]].filter(r => r[1]).map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
  ${canEdit() ? `<div class="row" style="margin-top:10px"><a class="btn alt sm" href="#/person/${id}/case/${c.id}">${esc(t("edit"))}</a></div>` : ""}</div>`).join("")}</div>` : `<div class="empty">${esc(t("no_cases"))}</div>`}`);
  loadPhotos();
  if ($("#arch")) $("#arch").onclick = async () => { if (confirm(t("confirm_archive"))) { try { await api("DELETE", "/persons/" + id); location.hash = "#/persons"; } catch (x) { toast(errMsg(x), true); } } };
  window.__cases = p.cases;
}

async function viewCaseForm(pid, cid) {
  let c = { status: "registered" };
  if (cid) { const p = await api("GET", "/persons/" + pid); c = p.cases.find(x => x.id == cid) || c; }
  shell("persons", `<div class="bar"><h1>${esc(t(cid ? "edit" : "add_case"))}</h1></div><form id="f" class="card form">
  ${field("fir_no", "fir_no", c.fir_no)}${field("fir_date", "fir_date", c.fir_date, "date")}${field("police_station", "police_station", c.police_station)}${field("sections", "sections", c.sections)}
  ${field("location", "location", c.location)}<div><label for="status">${esc(t("status"))}</label><select id="status">${opts(CST, c.status)}</select></div>
  ${field("court", "court", c.court)}${field("next_hearing", "next_hearing", c.next_hearing, "date")}
  <div class="full"><label for="details">${esc(t("details"))}</label><textarea id="details">${esc(c.details)}</textarea></div>
  <div class="full err" id="e" role="alert"></div><div class="full row"><button class="btn">${esc(t("save"))}</button><a class="btn alt" href="#/person/${pid}">${esc(t("cancel"))}</a>
  ${cid ? `<button type="button" class="btn bad" id="del">${esc(t("archive"))}</button>` : ""}</div></form>`);
  const body = () => { const b = {}; ["fir_no", "fir_date", "police_station", "sections", "location", "status", "court", "next_hearing", "details"].forEach(k => b[k] = val(k)); return b; };
  $("#f").onsubmit = async e => { e.preventDefault(); try { cid ? await api("PUT", "/cases/" + cid, body()) : await api("POST", `/persons/${pid}/cases`, body()); toast(t("saved")); location.hash = "#/person/" + pid; } catch (x) { $("#e").textContent = errMsg(x); } };
  if ($("#del")) $("#del").onclick = async () => { if (confirm(t("confirm_archive"))) { await api("DELETE", "/cases/" + cid); location.hash = "#/person/" + pid; } };
}


const pct = v => Math.round(v * 100) + "%";
async function viewFaceSearch() {
  const st = await api("GET", "/face/status");
  shell("facesearch", `<div class="bar"><h1>${esc(t("face_search"))}</h1></div><div class="card"><p style="margin-top:0">${esc(t("match_lead"))}</p>
  ${st.available ? `<label for="fp">${esc(t("choose_photo"))}</label><input id="fp" type="file" accept="image/*"><div id="fr" class="list" style="margin-top:14px"></div>` : `<p class="err">${esc(t("face_off"))}</p>`}</div>`);
  if (!st.available) return;
  $("#fp").onchange = async e => {
    try {
      const r = await api("POST", "/face/search", { photo: await resizePhoto(e.target.files[0]) });
      $("#fr").innerHTML = r.length ? r.map(x => `<a class="item" href="#/person/${x.id}">${ph(x)}<div class="t"><b>${esc(x.name)}</b> <small>${esc(x.father_name)}</small><br><small class="num">${esc(x.cnic)}</small><br>
        <small style="color:${x.strong ? "var(--red)" : "var(--mute)"}">${esc(t("score"))} <span class="num">${pct(x.score)}</span> - ${esc(t(x.strong ? "strong" : "weak"))}</small></div>${tag(x.status)}</a>`).join("") : `<div class="empty">${esc(t("no_results"))}</div>`;
      loadPhotos();
    } catch (x) { $("#fr").innerHTML = `<div class="err" role="alert">${esc(errMsg(x))}</div>`; }
  };
}

async function viewEvents() {
  const ev = await api("GET", "/events");
  shell("events", `<div class="bar"><h1>${esc(t("events"))}</h1></div><p>${esc(t("match_lead"))}</p>
  ${ev.length ? `<div class="grid">${ev.map(e => `<div class="card"><div class="row" style="align-items:flex-start">
    <div><small>${esc(t("snapshot"))}</small><div class="ph lg" data-img="/api/event_photo/${e.id}"></div></div>
    <div><small>${esc(t("record"))}</small>${ph({ id: e.person_id, has_photo: e.has_photo }, "lg")}</div>
    <div style="flex:1;min-width:200px"><a href="#/person/${e.person_id}"><b>${esc(e.name)}</b></a> ${tag(e.pstatus)}
    <p style="margin:6px 0">${esc(t("camera"))}: ${esc(e.camera_name)}<br><span class="num">${fmtTs(e.ts)}</span><br>${esc(t("score"))}: <span class="num">${pct(e.score)}</span></p>
    ${e.status === "new" && canEdit() ? `<div class="row"><button class="btn sm" data-v="confirmed" data-i="${e.id}">${esc(t("confirm"))}</button><button class="btn alt sm" data-v="false" data-i="${e.id}">${esc(t("false_match"))}</button></div>`
      : `<span class="tag">${esc(t(e.status))}${e.reviewed_by ? " - " + esc(e.reviewed_by) : ""}</span>`}</div></div></div>`).join("")}</div>` : `<div class="empty">${esc(t("no_events"))}</div>`}`);
  loadPhotos();
  document.querySelectorAll("[data-v]").forEach(b => b.onclick = async () => { try { await api("POST", `/events/${b.dataset.i}/review`, { verdict: b.dataset.v }); viewEvents(); } catch (x) { toast(errMsg(x), true); } });
}

async function viewUsers() {
  const us = await api("GET", "/users");
  shell("users", `<div class="bar"><h1>${esc(t("users"))}</h1></div><div class="wrap"><table><tr><th>${esc(t("username"))}</th><th>${esc(t("full_name"))}</th><th>${esc(t("role"))}</th><th></th></tr>
  ${us.map(u => `<tr><td class="num">${esc(u.username)}</td><td>${esc(u.name)}</td><td>${u.id === S.user.id ? esc(t(u.role)) : `<select data-r="${u.id}">${opts(["admin", "officer", "viewer"], u.role)}</select>`}</td>
  <td>${u.id === S.user.id ? "" : `<button class="btn alt sm" data-a="${u.id}" data-v="${u.active ? 0 : 1}">${esc(t(u.active ? "disabled" : "active"))}</button> <button class="btn alt sm" data-p="${u.id}">${esc(t("reset_pw"))}</button>`}</td></tr>`).join("")}</table></div>
  <h2 style="margin-top:22px">${esc(t("add_user"))}</h2><form id="f" class="card form" style="margin-top:10px">${field("un", "username")}${field("nm", "full_name")}
  <div><label for="rl">${esc(t("role"))}</label><select id="rl">${opts(["officer", "viewer", "admin"], "officer")}</select></div>${field("pw", "new_password", "", "password")}
  <div class="full err" id="e" role="alert"></div><div class="full"><button class="btn">${esc(t("add_user"))}</button></div></form>`);
  document.querySelectorAll("[data-r]").forEach(s => s.onchange = async () => { try { await api("PUT", "/users/" + s.dataset.r, { role: s.value }); toast(t("saved")); } catch (x) { toast(errMsg(x), true); } });
  document.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => { await api("PUT", "/users/" + b.dataset.a, { active: b.dataset.v == 1 }); viewUsers(); });
  document.querySelectorAll("[data-p]").forEach(b => b.onclick = async () => { const pw = prompt(t("new_password")); if (pw) try { await api("PUT", "/users/" + b.dataset.p, { password: pw }); toast(t("saved")); } catch (x) { toast(errMsg(x), true); } });
  $("#f").onsubmit = async e => { e.preventDefault(); try { await api("POST", "/users", { username: val("un"), name: val("nm"), role: val("rl"), password: val("pw") }); toast(t("saved")); viewUsers(); } catch (x) { $("#e").textContent = errMsg(x); } };
}

async function viewAudit() {
  const a = await api("GET", "/audit");
  shell("audit", `<div class="bar"><h1>${esc(t("audit"))}</h1></div><div class="wrap"><table><tr><th>${esc(t("when"))}</th><th>${esc(t("who"))}</th><th>${esc(t("action"))}</th><th>${esc(t("target"))}</th><th>IP</th></tr>
  ${a.map(r => `<tr><td class="num">${fmtTs(r.ts)}</td><td class="num">${esc(r.username)}</td><td class="num">${esc(r.action)}</td><td class="num">${esc(r.target)}</td><td class="num">${esc(r.ip)}</td></tr>`).join("")}</table></div>`);
}

function viewSettings() {
  shell("settings", `<div class="bar"><h1>${esc(t("settings"))}</h1></div><div class="card form" style="max-width:520px">
  <div class="full"><label for="l">${esc(t("language"))}</label><select id="l"><option value="ur" ${S.lang === "ur" ? "selected" : ""}>اردو</option><option value="en" ${S.lang === "en" ? "selected" : ""}>English</option></select></div>
  <div class="full"><a class="btn alt" href="#/password">${esc(t("change_password"))}</a></div>
  ${S.user.role === "admin" ? `<div class="full"><button class="btn alt" id="enr">${esc(t("enroll_all"))}</button></div>` : ""}
  ${window.Android && Android.changeServer ? `<div class="full"><button class="btn alt" id="srv">${esc(t("change_server"))}</button></div>` : ""}</div>`);
  $("#l").onchange = e => { setLang(e.target.value); viewSettings(); };
  if ($("#srv")) $("#srv").onclick = () => Android.changeServer();
  if ($("#enr")) $("#enr").onclick = async () => { try { const r = await api("POST", "/face/enroll_all"); toast(t("saved") + ": " + r.enrolled); } catch (x) { toast(errMsg(x), true); } };
}

/* ---------- router ---------- */
async function route() {
  setLang(S.lang);
  const h = (location.hash || "#/dashboard").slice(2).split("/");
  try {
    if (!S.token) { if (h[0] !== "login") location.hash = "#/login"; return viewLogin(); }
    if (!S.user) S.user = await api("GET", "/me");
    if (S.user.must_change) return viewPassword(true);
    const [a, b, c, d] = h;
    if (a === "login") return (location.hash = "#/dashboard");
    if (a === "dashboard") return viewDashboard();
    if (a === "persons") return viewPersons();
    if (a === "person" && b === "new") return canEdit() ? viewPersonForm() : (location.hash = "#/persons");
    if (a === "person" && c === "edit") return viewPersonForm(b);
    if (a === "person" && c === "case") return viewCaseForm(b, d);
    if (a === "person") return viewPerson(b);
    if (a === "facesearch") return canEdit() ? viewFaceSearch() : (location.hash = "#/dashboard");
    if (a === "events") return viewEvents();
    if (a === "users") return viewUsers();
    if (a === "audit") return viewAudit();
    if (a === "settings") return viewSettings();
    if (a === "password") return viewPassword(false);
    location.hash = "#/dashboard";
  } catch (x) { if (x.message === "auth") return; toast(errMsg(x), true); }
}
window.addEventListener("hashchange", route);
route();
