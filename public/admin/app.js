// Painel do site — edita o rascunho (D1), envia mídias (R2) e publica.
// A prévia usa o mesmo renderizador do site (../shared/render.js), então o que aparece aqui
// é exatamente o que vai ao ar.
import { renderSite, makeImages, DEFAULT_MOTION, DEFAULT_COLORS } from "../shared/render.js";

/* =================================================================== state */
const LANGS = [["pt", "PT"], ["en", "EN"], ["ja", "JA"]];
const S = {
  data: null, base: null, published: null, isDefault: false,
  meta: {}, media: { bundled: [], uploads: [] },
  view: "home", sub: null,
  saving: false, dirty: false, saveError: null,
  undo: [], redo: [],
  previewLang: "pt", device: "desktop", previewOn: true,
};
const PREVIEW_V = "p" + Date.now().toString(36);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clone = (o) => JSON.parse(JSON.stringify(o));
let uid = 0;
const nid = () => "f" + ++uid;

/* ====================================================================== dom */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "open") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast on " + kind;
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => { t.className = "toast"; }, kind === "error" ? 6000 : 2600);
}

/* ====================================================================== api */
async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch("/api/" + path, {
    credentials: "same-origin",
    ...opts,
    headers: { ...(opts.body && !isForm ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && path !== "login") { showLogin("Sua sessão expirou. Entre de novo."); }
  if (!res.ok) throw Object.assign(new Error((body && body.error) || `Erro ${res.status}`), { status: res.status, body });
  return body;
}

/* ============================================================ data helpers */
const getAt = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setAt(obj, path, value) {
  let o = obj;
  path.slice(0, -1).forEach((k, i) => { if (o[k] == null) o[k] = typeof path[i + 1] === "number" ? [] : {}; o = o[k]; });
  o[path[path.length - 1]] = value;
}
const get = (path) => getAt(S.data, path);
const tr = (lang, key) => (S.data.i18n[lang] || {})[key] ?? "";
const slugify = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "item";
function uniqueId(base, taken) {
  let id = slugify(base), n = 2;
  while (taken.includes(id)) id = `${slugify(base)}-${n++}`;
  return id;
}

/* ============================================================ change/undo */
let burstTimer = 0, inBurst = false;
// Every edit goes through here: undo snapshot, autosave, live preview.
function change(mutate, { rerender = false } = {}) {
  if (!inBurst) {
    S.undo.push(JSON.stringify(S.data));
    if (S.undo.length > 80) S.undo.shift();
    S.redo = [];
    inBurst = true;
  }
  clearTimeout(burstTimer);
  burstTimer = setTimeout(() => { inBurst = false; }, 700);
  mutate(S.data);
  afterChange(rerender);
}
function afterChange(rerender) {
  S.dirty = true;
  scheduleSave();
  schedulePreview();
  syncUndo();
  if (rerender) renderView();
}
function undo() {
  if (!S.undo.length) return;
  S.redo.push(JSON.stringify(S.data));
  S.data = JSON.parse(S.undo.pop());
  inBurst = false;
  afterChange(true);
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(JSON.stringify(S.data));
  S.data = JSON.parse(S.redo.pop());
  inBurst = false;
  afterChange(true);
}
function syncUndo() { $("#undo").disabled = !S.undo.length; $("#redo").disabled = !S.redo.length; }

/* ==================================================================== save */
let saveTimer = 0;
function scheduleSave() { clearTimeout(saveTimer); setStatus(); saveTimer = setTimeout(save, 900); }
async function save(force = false) {
  clearTimeout(saveTimer);
  if (S.saving) { saveTimer = setTimeout(save, 400); return; }
  if (!S.dirty && !force) return;
  S.saving = true; S.dirty = false; setStatus();
  try {
    const r = await api("content", { method: "PUT", body: JSON.stringify({ data: S.data, base: S.base, force }) });
    S.base = r.updated_at; S.saveError = null; S.isDefault = false;
  } catch (e) {
    S.dirty = true;
    S.saveError = e.message;
    if (e.body && e.body.conflict) conflictDialog();
    else toast("Não foi possível salvar: " + e.message, "error");
  } finally {
    S.saving = false; setStatus();
  }
}
const flush = async () => { if (S.dirty || S.saving) { await save(); while (S.saving) await new Promise((r) => setTimeout(r, 100)); } return !S.dirty; };

function setStatus() {
  const el = $("#status");
  const fmt = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  let txt, cls = "";
  if (S.saveError && S.dirty) { txt = "⚠ Não salvo — " + S.saveError; cls = "bad"; }
  else if (S.saving || S.dirty) { txt = "Salvando…"; }
  else {
    txt = "Rascunho salvo";
    const pub = S.published;
    if (!pub) { txt += " · ainda não publicado"; cls = "warn"; }
    else if (S.base && S.base > pub.created_at) { txt += " · alterações não publicadas"; cls = "warn"; }
    else txt += ` · no ar desde ${fmt(pub.created_at)}`;
  }
  el.textContent = txt;
  el.className = "status " + cls;
}

function conflictDialog() {
  openModal("Conflito de edição", h("p", {}, "O rascunho foi alterado em outra aba ou dispositivo depois que você abriu o painel."), [
    ["Recarregar a versão mais nova", "ghost", () => location.reload()],
    ["Manter as minhas alterações", "primary", () => { closeModal(); save(true); }],
  ]);
}

/* ================================================================== preview */
let previewTimer = 0;
function schedulePreview(delay = 350) { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, delay); }
function updatePreview() {
  if (!S.previewOn) return;
  const frame = $("#preview");
  let y = 0;
  try { y = frame.contentWindow ? frame.contentWindow.scrollY : 0; } catch { /* ignore */ }
  const html = renderSite(S.data, S.meta, { preview: true, assetV: PREVIEW_V, lang: S.previewLang });
  frame.onload = () => { try { if (y) frame.contentWindow.scrollTo(0, y); } catch { /* ignore */ } };
  frame.srcdoc = html;
}
const DEVICES = { desktop: 1280, tablet: 820, mobile: 390 };
function fitPreview() {
  const stage = $("#preview-stage"), frame = $("#preview");
  const w = DEVICES[S.device], avail = stage.clientWidth - 16;
  const scale = Math.min(1, avail / w);
  frame.style.width = w + "px";
  frame.style.height = Math.round((stage.clientHeight - 16) / scale) + "px";
  frame.style.transform = `translateX(-50%) scale(${scale})`;
}
function setPreviewLang(l) {
  if (S.previewLang === l) return;
  S.previewLang = l;
  $$("[data-plang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.plang === l)));
  schedulePreview(50);
}

/* ================================================================== modals */
function openModal(title, body, actions = [["Fechar", "ghost", closeModal]], { wide = false } = {}) {
  const m = $("#modal");
  m.className = "modal" + (wide ? " wide" : "");
  m.replaceChildren(
    h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "icon-btn", "aria-label": "Fechar", onclick: closeModal }, "✕")),
    h("div", { class: "modal-body" }, body),
    actions.length ? h("div", { class: "modal-foot" }, actions.map(([label, kind, fn]) => h("button", { class: "btn " + kind, onclick: fn }, label))) : null,
  );
  if (!m.open) m.showModal();
  return m;
}
function closeModal() { const m = $("#modal"); if (m.open) m.close(); }
const confirmBox = (title, text, okLabel = "Confirmar", danger = false) => new Promise((resolve) => {
  const m = openModal(title, h("p", {}, text), [
    ["Cancelar", "ghost", () => { closeModal(); resolve(false); }],
    [okLabel, danger ? "danger" : "primary", () => { closeModal(); resolve(true); }],
  ]);
  m.addEventListener("close", () => resolve(false), { once: true });
});
const promptBox = (title, label, value = "", okLabel = "OK") => new Promise((resolve) => {
  const id = nid();
  const input = h("input", { id, value });
  const form = h("form", { onsubmit: (e) => { e.preventDefault(); closeModal(); resolve(input.value.trim()); } },
    h("label", { for: id }, label), input);
  const m = openModal(title, form, [
    ["Cancelar", "ghost", () => { closeModal(); resolve(null); }],
    [okLabel, "primary", () => { closeModal(); resolve(input.value.trim()); }],
  ]);
  m.addEventListener("close", () => resolve(null), { once: true });
  setTimeout(() => input.focus(), 30);
});

/* ================================================================== media */
const imgs = () => makeImages(S.meta);
const thumbUrl = (src) => { const i = imgs().info(src); return i ? "/" + i.smSrc : ""; };
function addMedia(row) {
  S.media.uploads.unshift(row);
  if (row.kind === "image") S.meta[row.key] = { w: row.w, h: row.h, lg: row.lg, sm: row.sm };
}

const canvasBlob = (c, type, q) => (c.convertToBlob ? c.convertToBlob({ type, quality: q }) : new Promise((r) => c.toBlob(r, type, q)));
// Resize + convert in the browser (the server only stores): ≤1800px and ≤800px wide, WebP
async function encodeImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width: w, height: hh } = bmp;
  const encode = async (maxW, q) => {
    const s = Math.min(1, maxW / w);
    const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(hh * s));
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement("canvas"), { width: cw, height: ch });
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, cw, ch);
    let blob = await canvasBlob(c, "image/webp", q);
    if (!blob || blob.type !== "image/webp") blob = await canvasBlob(c, "image/png"); // browsers without WebP encoding
    return blob;
  };
  const lg = await encode(1800, 0.86);
  const sm = w > 800 ? await encode(800, 0.8) : null;
  bmp.close && bmp.close();
  return { lg, sm, w, h: hh };
}
async function uploadImage(file) {
  if (!/^image\//.test(file.type)) throw new Error(`${file.name}: não é uma imagem.`);
  const { lg, sm, w, h: hh } = await encodeImage(file);
  const ext = (b) => (b.type === "image/webp" ? "webp" : "png");
  const fd = new FormData();
  fd.append("kind", "image"); fd.append("name", file.name); fd.append("w", w); fd.append("h", hh);
  fd.append("lg", lg, "lg." + ext(lg));
  if (sm) fd.append("sm", sm, "sm." + ext(sm));
  const r = await api("media", { method: "POST", body: fd });
  addMedia(r.media);
  return r.media;
}
async function uploadFile(kind, file) {
  const fd = new FormData();
  fd.append("kind", kind); fd.append("name", file.name); fd.append("file", file);
  const r = await api("media", { method: "POST", body: fd });
  addMedia(r.media);
  return r.media;
}
// Opens the system file chooser and resolves with the chosen files
const chooseFiles = (accept, multiple = false) => new Promise((resolve) => {
  const input = h("input", { type: "file", accept, style: "display:none" });
  input.multiple = multiple;
  input.addEventListener("change", () => { resolve([...input.files]); input.remove(); });
  input.addEventListener("cancel", () => { resolve([]); input.remove(); });
  document.body.append(input);
  input.click();
});
async function withBusy(label, fn) {
  const t = $("#toast");
  t.textContent = label; t.className = "toast on";
  try { return await fn(); }
  catch (e) { toast(e.message, "error"); return null; }
  finally { if (t.textContent === label) t.className = "toast"; }
}

/* Image picker: resolves with an array of image keys (or null) */
function pickImages({ multiple = false, title = "Escolher imagem" } = {}) {
  return new Promise((resolve) => {
    const chosen = [];
    let tab = S.media.uploads.some((m) => m.kind === "image") ? "uploads" : "bundled";
    let q = "";
    const grid = h("div", { class: "pick-grid" });
    const count = h("span", { class: "muted" });
    const useBtn = h("button", { class: "btn primary", disabled: true, onclick: () => { closeModal(); resolve(chosen.slice()); } }, "Usar");
    const list = () => (tab === "uploads"
      ? S.media.uploads.filter((m) => m.kind === "image").map((m) => ({ key: m.key, name: m.name || m.key, w: m.w, h: m.h }))
      : S.media.bundled.map((m) => ({ key: m.key, name: m.key, w: m.w, h: m.h })));
    const draw = () => {
      const items = list().filter((m) => !q || m.name.toLowerCase().includes(q));
      grid.replaceChildren(...(items.length ? items.map((m) => {
        const on = chosen.includes(m.key);
        return h("button", { type: "button", class: "pick", "aria-pressed": String(on), title: m.name, onclick: () => {
          const i = chosen.indexOf(m.key);
          if (i >= 0) chosen.splice(i, 1); else if (multiple) chosen.push(m.key); else chosen.splice(0, chosen.length, m.key);
          draw();
          if (!multiple && chosen.length) { closeModal(); resolve(chosen.slice()); }
        } }, h("img", { src: thumbUrl(m.key), alt: "", loading: "lazy" }), h("span", {}, m.name.split("/").pop()), on && multiple ? h("b", { class: "pick-n" }, chosen.indexOf(m.key) + 1) : null);
      }) : [h("p", { class: "muted" }, tab === "uploads" ? "Nenhuma imagem enviada ainda. Use “Enviar imagens”." : "Nada encontrado.")]));
      count.textContent = chosen.length ? `${chosen.length} selecionada(s)` : "";
      useBtn.disabled = !chosen.length;
      useBtn.textContent = multiple && chosen.length ? `Usar ${chosen.length}` : "Usar";
    };
    const tabs = h("div", { class: "seg", role: "group", "aria-label": "Origem" },
      [["uploads", "Enviadas por você"], ["bundled", "Do site original"]].map(([k, l]) => h("button", { type: "button", "aria-pressed": String(tab === k), onclick: (e) => {
        tab = k; $$("button", e.target.parentElement).forEach((b) => b.setAttribute("aria-pressed", String(b === e.target))); draw();
      } }, l)));
    const search = h("input", { type: "search", placeholder: "Buscar pelo nome…", "aria-label": "Buscar", oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } });
    const up = h("button", { type: "button", class: "btn", onclick: async () => {
      const files = await chooseFiles("image/*", true);
      for (const [i, f] of files.entries()) {
        const row = await withBusy(`Enviando ${i + 1} de ${files.length}…`, () => uploadImage(f));
        if (row) { if (multiple) chosen.push(row.key); else chosen.splice(0, chosen.length, row.key); }
      }
      if (files.length) { tab = "uploads"; $$("button", tabs).forEach((b, i) => b.setAttribute("aria-pressed", String(i === 0))); draw(); }
    } }, "⬆ Enviar imagens");
    const body = h("div", { class: "picker" }, h("div", { class: "pick-tools" }, tabs, search, up), grid,
      h("p", { class: "hint" }, "As imagens enviadas são convertidas para WebP e redimensionadas (até 1800 px) automaticamente."));
    const m = openModal(title, body, [], { wide: true });
    m.append(h("div", { class: "modal-foot" }, count, h("button", { class: "btn ghost", onclick: () => { closeModal(); resolve(null); } }, "Cancelar"), useBtn));
    m.addEventListener("close", () => resolve(null), { once: true });
    draw();
  });
}

/* ================================================================== fields */
function field(label, control, hint) {
  if (!control.id) control.id = nid();
  return h("div", { class: "field" }, h("label", { for: control.id }, label), control, hint ? h("p", { class: "hint" }, hint) : null);
}
function autoGrow(el) {
  const fit = () => { el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; };
  el.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return el;
}
function textInput(path, { multiline = false, placeholder = "", onInput } = {}) {
  const el = h(multiline ? "textarea" : "input", {
    value: get(path) ?? "", placeholder, rows: multiline ? 2 : null,
    oninput: (e) => { change((d) => setAt(d, path, e.target.value)); onInput && onInput(e.target.value); },
  });
  return multiline ? autoGrow(el) : el;
}
const text = (label, path, o = {}) => field(label, textInput(path, o), o.hint);

function i18nField(label, key, { multiline = false, hint } = {}) {
  return h("fieldset", { class: "i18n" }, h("legend", {}, label),
    LANGS.map(([l, L]) => {
      const el = h(multiline ? "textarea" : "input", {
        id: nid(), value: tr(l, key), lang: l === "pt" ? "pt-BR" : l, rows: multiline ? 2 : null,
        onfocus: () => setPreviewLang(l),
        oninput: (e) => change((d) => { (d.i18n[l] ||= {})[key] = e.target.value; }),
      });
      if (multiline) autoGrow(el);
      return h("div", { class: "i18n-row" }, h("label", { for: el.id, class: "lang-tag" }, L), el);
    }),
    hint ? h("p", { class: "hint" }, hint) : null);
}

function toggle(label, path, hint, { rerender = false } = {}) {
  const id = nid();
  return h("div", { class: "field toggle" },
    h("input", { type: "checkbox", id, role: "switch", checked: !!get(path), onchange: (e) => change((d) => setAt(d, path, e.target.checked), { rerender }) }),
    h("label", { for: id }, label), hint ? h("p", { class: "hint" }, hint) : null);
}

function range(label, path, { min, max, step = 1, unit = "", hint, fmt = (v) => v } = {}) {
  const val = h("output", {}, fmt(get(path)) + unit);
  const el = h("input", { type: "range", min, max, step, value: get(path), oninput: (e) => {
    const v = Number(e.target.value); val.textContent = fmt(v) + unit; change((d) => setAt(d, path, v));
  } });
  if (!el.id) el.id = nid();
  return h("div", { class: "field range" }, h("div", { class: "range-head" }, h("label", { for: el.id }, label), val), el, hint ? h("p", { class: "hint" }, hint) : null);
}

function select(label, path, options, { hint, rerender = false } = {}) {
  const el = h("select", { onchange: (e) => change((d) => setAt(d, path, e.target.value), { rerender }) },
    options.map(([v, l]) => h("option", { value: v }, l)));
  el.value = get(path) ?? options[0][0];
  return field(label, el, hint);
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
function colorField(label, path, hint) {
  const cur = get(path) || "#000000";
  const txt = h("input", { class: "hex", value: cur, maxlength: 9, "aria-label": label + " (código)", oninput: (e) => {
    const v = e.target.value.trim();
    if (HEX.test(v)) { pick.value = v.length === 4 ? "#" + [...v.slice(1)].map((c) => c + c).join("") : v; change((d) => setAt(d, path, v)); updateContrast(); }
  } });
  const pick = h("input", { type: "color", value: cur.length === 7 ? cur : "#000000", oninput: (e) => { txt.value = e.target.value.toUpperCase(); change((d) => setAt(d, path, e.target.value.toUpperCase())); updateContrast(); } });
  pick.id = nid();
  return h("div", { class: "field color" }, h("label", { for: pick.id }, label), h("div", { class: "color-row" }, pick, txt), hint ? h("p", { class: "hint" }, hint) : null);
}

// Single image slot { src, alt [, pos] }
function imageOne(label, path, { alt = true, focal = false, hint, allowEmpty = true } = {}) {
  const cur = get(path) || {};
  const wrap = h("div", { class: "image-one" });
  const thumb = cur.src && thumbUrl(cur.src)
    ? h("div", { class: "thumb" + (focal ? " focal" : "") }, h("img", { src: thumbUrl(cur.src), alt: "" }))
    : h("div", { class: "thumb empty" }, "sem imagem");
  if (focal && cur.src) {
    const [px, py] = String(cur.pos || "50% 50%").split(/\s+/).map((v) => parseFloat(v));
    const dot = h("span", { class: "dot", style: `left:${px}%;top:${py}%` });
    thumb.append(dot);
    thumb.title = "Clique para escolher o ponto de foco (a parte que nunca é cortada)";
    thumb.addEventListener("click", (e) => {
      const r = thumb.getBoundingClientRect();
      const x = Math.round(((e.clientX - r.left) / r.width) * 100), y = Math.round(((e.clientY - r.top) / r.height) * 100);
      dot.style.left = x + "%"; dot.style.top = y + "%";
      change((d) => setAt(d, [...path, "pos"], `${x}% ${y}%`));
    });
  }
  const actions = h("div", { class: "row" },
    h("button", { type: "button", class: "btn sm", onclick: async () => {
      const k = await pickImages({ title: label });
      if (k && k[0]) change((d) => { const o = getAt(d, path) || {}; setAt(d, path, { ...o, src: k[0] }); }, { rerender: true });
    } }, cur.src ? "Trocar" : "Escolher"),
    allowEmpty && cur.src ? h("button", { type: "button", class: "btn sm ghost", onclick: () => change((d) => setAt(d, [...path, "src"], ""), { rerender: true }) }, "Remover") : null);
  wrap.append(thumb, h("div", { class: "image-meta" }, actions,
    alt ? text("Descrição da imagem (acessibilidade)", [...path, "alt"], { placeholder: "O que aparece na imagem" }) : null,
    focal ? h("p", { class: "hint" }, "Clique na miniatura para escolher o ponto de foco.") : null));
  return h("div", { class: "field" }, h("p", { class: "label" }, label), wrap, hint ? h("p", { class: "hint" }, hint) : null);
}

// Image stored as a plain key string (project cover, share image)
function imageKey(label, path, hint) {
  const cur = get(path) || "";
  return h("div", { class: "field" }, h("p", { class: "label" }, label),
    h("div", { class: "image-one" },
      cur && thumbUrl(cur) ? h("div", { class: "thumb" }, h("img", { src: thumbUrl(cur), alt: "" })) : h("div", { class: "thumb empty" }, "automática"),
      h("div", { class: "image-meta" }, h("div", { class: "row" },
        h("button", { type: "button", class: "btn sm", onclick: async () => {
          const k = await pickImages({ title: label });
          if (k && k[0]) change((d) => setAt(d, path, k[0]), { rerender: true });
        } }, cur ? "Trocar" : "Escolher"),
        cur ? h("button", { type: "button", class: "btn sm ghost", onclick: () => change((d) => setAt(d, path, ""), { rerender: true }) }, "Remover") : null),
      hint ? h("p", { class: "hint" }, hint) : null)));
}

// List of images [{ src, alt }] with reorder (drag or arrows), alt text and removal
function imageList(label, path, { hint, max = 200, alt = true } = {}) {
  const list = get(path) || [];
  const grid = h("ol", { class: "image-list" });
  let dragFrom = null;
  list.forEach((it, i) => {
    const li = h("li", { draggable: "true" },
      h("div", { class: "thumb" }, thumbUrl(it.src) ? h("img", { src: thumbUrl(it.src), alt: "", loading: "lazy" }) : h("span", { class: "muted" }, "imagem ausente"), h("b", { class: "num" }, i + 1)),
      alt ? h("textarea", { rows: 2, value: it.alt || "", placeholder: "Descrição da imagem", "aria-label": `Descrição da imagem ${i + 1}`, oninput: (e) => change((d) => { getAt(d, path)[i].alt = e.target.value; }) }) : null,
      h("div", { class: "row tight" },
        h("button", { type: "button", class: "icon-btn sm", "aria-label": "Mover para trás", disabled: i === 0, onclick: () => move(i, i - 1) }, "←"),
        h("button", { type: "button", class: "icon-btn sm", "aria-label": "Mover para frente", disabled: i === list.length - 1, onclick: () => move(i, i + 1) }, "→"),
        h("button", { type: "button", class: "icon-btn sm", "aria-label": "Trocar imagem", title: "Trocar imagem", onclick: async () => {
          const k = await pickImages({ title: "Trocar imagem" });
          if (k && k[0]) change((d) => { getAt(d, path)[i].src = k[0]; }, { rerender: true });
        } }, "⇄"),
        h("button", { type: "button", class: "icon-btn sm danger", "aria-label": "Remover imagem", title: "Remover", onclick: () => change((d) => { getAt(d, path).splice(i, 1); }, { rerender: true }) }, "✕")));
    li.addEventListener("dragstart", (e) => { dragFrom = i; li.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("over"); });
    li.addEventListener("dragleave", () => li.classList.remove("over"));
    li.addEventListener("drop", (e) => { e.preventDefault(); li.classList.remove("over"); if (dragFrom !== null && dragFrom !== i) move(dragFrom, i); dragFrom = null; });
    grid.append(li);
  });
  function move(a, b) { change((d) => { const arr = getAt(d, path); const [x] = arr.splice(a, 1); arr.splice(b, 0, x); }, { rerender: true }); }
  const add = list.length < max ? h("button", { type: "button", class: "btn sm", onclick: async () => {
    const keys = await pickImages({ multiple: max - list.length > 1, title: "Adicionar imagens" });
    if (keys && keys.length) change((d) => { if (!getAt(d, path)) setAt(d, path, []); getAt(d, path).push(...keys.slice(0, max - list.length).map((src) => ({ src, alt: "" }))); }, { rerender: true });
  } }, "+ Adicionar imagens") : null;
  return h("div", { class: "field" }, h("div", { class: "list-head" }, h("p", { class: "label" }, `${label} (${list.length})`), add),
    list.length ? grid : h("p", { class: "muted" }, "Nenhuma imagem."), hint ? h("p", { class: "hint" }, hint) : null);
}

// Generic ordered list of objects with a render function per item
function objectList(path, renderItem, { addLabel, onAdd, onRemove, itemTitle, removeLabel = "Remover", collapsed = false } = {}) {
  const list = get(path) || [];
  const box = h("div", { class: "obj-list" });
  list.forEach((it, i) => {
    const move = (to) => change((d) => { const arr = getAt(d, path); const [x] = arr.splice(i, 1); arr.splice(to, 0, x); }, { rerender: true });
    box.append(h("details", { class: "obj", open: !collapsed },
      h("summary", {}, h("span", { class: "obj-title" }, itemTitle ? itemTitle(it, i) : `Item ${i + 1}`),
        h("span", { class: "row tight" },
          h("button", { type: "button", class: "icon-btn sm", "aria-label": "Subir", disabled: i === 0, onclick: (e) => { e.preventDefault(); move(i - 1); } }, "↑"),
          h("button", { type: "button", class: "icon-btn sm", "aria-label": "Descer", disabled: i === list.length - 1, onclick: (e) => { e.preventDefault(); move(i + 1); } }, "↓"),
          h("button", { type: "button", class: "icon-btn sm danger", "aria-label": removeLabel, title: removeLabel, onclick: async (e) => {
            e.preventDefault();
            if (!(await confirmBox(removeLabel, `Remover “${itemTitle ? itemTitle(it, i) : "item"}”?`, "Remover", true))) return;
            change((d) => { const [x] = getAt(d, path).splice(i, 1); onRemove && onRemove(d, x); }, { rerender: true });
          } }, "✕"))),
      h("div", { class: "obj-body" }, renderItem(it, i))));
  });
  return h("div", {}, box, addLabel ? h("button", { type: "button", class: "btn sm", onclick: onAdd }, addLabel) : null);
}

const card = (title, ...kids) => h("section", { class: "card" }, title ? h("h2", {}, title) : null, ...kids);
const intro = (title, text) => h("header", { class: "view-head" }, h("h1", {}, title), text ? h("p", { class: "muted" }, text) : null);

/* ================================================================== views */
const VIEWS = [
  ["home", "Início", "🏠"],
  ["colors", "Cores e aparência", "🎨"],
  ["fonts", "Fontes", "🔤"],
  ["motion", "Animações", "✨"],
  ["texts", "Textos", "📝"],
  ["hero", "Topo do site", "⭐"],
  ["about", "Quem sou eu", "🙂"],
  ["works", "Trabalhos", "🗂"],
  ["more", "Outros projetos", "📎"],
  ["galleries", "Ilustrações e montagens", "🖼"],
  ["skills", "Ferramentas", "🛠"],
  ["contact", "Contato e SEO", "✉"],
  ["media", "Mídia", "📁"],
  ["history", "Histórico", "🕓"],
  ["security", "Segurança", "🔒"],
];

function renderNav() {
  $("#sidebar").replaceChildren(h("ul", {}, VIEWS.map(([k, l, ic]) => h("li", {},
    h("a", { href: "#" + k, "aria-current": S.view === k ? "page" : null, onclick: (e) => { e.preventDefault(); go(k); } }, h("span", { "aria-hidden": "true", class: "ic" }, ic), l)))),
  h("button", { class: "btn ghost sm logout", onclick: async () => { await flush(); await api("logout", { method: "POST" }).catch(() => {}); location.reload(); } }, "Sair"));
}
function go(view, sub = null) {
  S.view = view; S.sub = sub;
  history.replaceState(null, "", "#" + view + (sub != null ? "/" + sub : ""));
  renderNav(); renderView(true);
  $("#sidebar").classList.remove("open"); $("#menu-btn").setAttribute("aria-expanded", "false");
}
function renderView(top = false) {
  const ed = $("#editor");
  const y = ed.scrollTop;
  const fn = { home: viewHome, colors: viewColors, fonts: viewFonts, motion: viewMotion, texts: viewTexts, hero: viewHero, about: viewAbout,
    works: viewWorks, more: viewMore, galleries: viewGalleries, skills: viewSkills, contact: viewContact, media: viewMedia, history: viewHistory, security: viewSecurity }[S.view] || viewHome;
  ed.replaceChildren(fn());
  ed.scrollTop = top ? 0 : y;
  if (top) ed.focus({ preventScroll: true });
}

/* ---------------------------------------------------------------- home */
function viewHome() {
  const pub = S.published;
  const fmt = (iso) => new Date(iso).toLocaleString("pt-BR");
  return h("div", {}, intro("Olá! 👋", "Tudo o que você muda aqui é salvo automaticamente como rascunho. O site só muda quando você clica em “Publicar”."),
    card("Situação",
      h("ul", { class: "facts" },
        h("li", {}, h("b", {}, "Rascunho: "), S.isDefault ? "ainda não editado (conteúdo original do site)" : S.base ? "salvo em " + fmt(S.base) : "—"),
        h("li", {}, h("b", {}, "Site no ar: "), pub ? `versão #${pub.id}, publicada em ${fmt(pub.created_at)}${pub.note ? ` — “${pub.note}”` : ""}` : "versão original (nada publicado pelo painel ainda)")),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: publish }, "Publicar agora"),
        h("a", { class: "btn ghost", href: "/", target: "_blank", rel: "noopener" }, "Abrir o site ↗"))),
    card("Atalhos",
      h("div", { class: "shortcuts" }, VIEWS.slice(1, -3).map(([k, l, ic]) => h("button", { class: "shortcut", onclick: () => go(k) }, h("span", { class: "ic", "aria-hidden": "true" }, ic), l)))),
    card("Cópia de segurança",
      h("p", { class: "muted" }, "Baixe todo o conteúdo (textos, configurações e a lista de imagens) em um arquivo. Dá para importar de volta depois."),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: exportJson }, "⬇ Baixar conteúdo (.json)"),
        h("button", { class: "btn ghost", onclick: importJson }, "⬆ Importar conteúdo"),
        h("button", { class: "btn ghost danger-text", onclick: resetAll }, "Voltar ao conteúdo original"))),
  );
}
function exportJson() {
  const blob = new Blob([JSON.stringify(S.data, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `site-conteudo-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importJson() {
  const [f] = await chooseFiles("application/json,.json");
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data.site || !data.i18n) throw new Error("Esse arquivo não parece ser um conteúdo do site.");
    if (!(await confirmBox("Importar conteúdo", "Isso substitui o rascunho atual pelo conteúdo do arquivo. Dá para desfazer com Ctrl+Z.", "Importar"))) return;
    change((d) => { Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, data); }, { rerender: true });
    toast("Conteúdo importado.");
  } catch (e) { toast(e.message, "error"); }
}
async function resetAll() {
  if (!(await confirmBox("Voltar ao original", "O rascunho volta a ser o conteúdo original do site (as imagens enviadas continuam na Mídia). Dá para desfazer com Ctrl+Z.", "Voltar ao original", true))) return;
  change((d) => { Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, clone(DEFAULT_DOC)); }, { rerender: true });
}

/* ---------------------------------------------------------------- colors */
const COLOR_LABELS = [
  ["bg", "Fundo principal"], ["bgDeep", "Fundo escuro", "Abertura, menu do celular, barra de rolagem e contato"],
  ["surface", "Fundo das seções alternadas", "Trabalhos, Graphic Montages e janelas"], ["tint", "Tom claro do fundo"],
  ["ink", "Texto e linhas"], ["accent", "Destaque principal", "Botões ao passar o mouse, sublinhados"],
  ["sky", "Destaque secundário"], ["sun", "Amarelo das partículas do clique"],
];
const PALETTES = [
  ["Original (azul)", DEFAULT_COLORS],
  ["Noite", { bg: "#14171F", bgDeep: "#0B0D12", surface: "#1C212C", tint: "#262C3A", ink: "#F2EFE8", accent: "#FF5A4E", sky: "#5CC8FF", sun: "#FFD23F" }],
  ["Creme", { bg: "#F3EDE2", bgDeep: "#1E2A5A", surface: "#EAE1D1", tint: "#FFFFFF", ink: "#1E2A5A", accent: "#E8402F", sky: "#2B7BE4", sun: "#F2B705" }],
  ["Vermelho", { bg: "#D93A2B", bgDeep: "#8E1D14", surface: "#C93224", tint: "#E5584A", ink: "#FFF6EC", accent: "#1E2A5A", sky: "#FFD23F", sun: "#FFFFFF" }],
  ["Verde", { bg: "#1F6F4E", bgDeep: "#0F3D2A", surface: "#1A6145", tint: "#2E8A63", ink: "#F4F1E8", accent: "#FF7A3D", sky: "#B8F05A", sun: "#FFD23F" }],
];
function lum(hex) {
  let x = hex.replace("#", ""); if (x.length === 3) x = [...x].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
function updateContrast() {
  const box = $("#contrast"); if (!box) return;
  const c = S.data.theme.colors;
  const rows = [["Texto sobre o fundo principal", c.ink, c.bg], ["Texto sobre o fundo escuro", c.ink, c.bgDeep], ["Texto sobre seções alternadas", c.ink, c.surface]];
  box.replaceChildren(...rows.map(([l, f, b]) => {
    const r = HEX.test(f) && HEX.test(b) ? contrast(f, b) : 0;
    const okk = r >= 4.5;
    return h("li", { class: okk ? "ok" : "bad" }, h("span", { class: "swatch", style: `background:${b};color:${f}` }, "Aa"), `${l}: ${r.toFixed(1)}:1 `, h("b", {}, okk ? "✓ boa leitura" : "⚠ pouco contraste"));
  }));
}
function viewColors() {
  const el = h("div", {}, intro("Cores e aparência", "As cores valem para o site inteiro. A prévia ao lado mostra o resultado na hora."),
    card("Paletas prontas", h("div", { class: "palettes" }, PALETTES.map(([name, p]) => h("button", { class: "palette", onclick: () => change((d) => { d.theme.colors = { ...p }; }, { rerender: true }) },
      h("span", { class: "chips" }, ["bg", "surface", "ink", "accent", "sky"].map((k) => h("i", { style: `background:${p[k]}` }))), name)))),
    card("Cores", h("div", { class: "grid2" }, COLOR_LABELS.map(([k, l, hint]) => colorField(l, ["theme", "colors", k], hint))),
      h("h3", {}, "Legibilidade"), h("ul", { class: "contrast", id: "contrast" })),
    card("Detalhes",
      range("Arredondamento dos cantos", ["theme", "radius"], { min: 0, max: 32, unit: " px" }),
      toggle("Cursores em pixel art (KAPLAY)", ["theme", "pixelCursors"], "Desligado, o site usa os cursores normais do sistema."),
      toggle("Padrão de fundo animado (logos)", ["theme", "pattern"]),
      range("Intensidade do padrão de fundo", ["theme", "patternOpacity"], { min: 0, max: 0.3, step: 0.01, fmt: (v) => Math.round(v * 100), unit: "%" }),
      range("Velocidade do padrão (tempo de uma volta)", ["theme", "patternDuration"], { min: 6, max: 120, unit: " s", hint: "Menor = mais rápido." })),
  );
  requestAnimationFrame(updateContrast);
  return el;
}

/* ---------------------------------------------------------------- fonts */
function fontSlot(slotKey, title, allowSame) {
  const path = ["theme", "fonts", slotKey];
  if (!get(path)) setAt(S.data, path, allowSame ? { source: "same" } : { source: "google", family: "Plus Jakarta Sans", weights: "400;500;700;800" });
  const f = get(path);
  const sources = [["google", "Google Fonts (pelo nome)"], ["file", "Arquivo de fonte (enviar)"], ["system", "Fonte do sistema"]];
  if (allowSame) sources.unshift(["same", "Igual à fonte do texto"]);
  const parts = [select("Origem da fonte", [...path, "source"], sources, { rerender: true })];
  if (f.source === "google") {
    parts.push(text("Nome da fonte", [...path, "family"], { placeholder: "Ex.: Poppins", hint: "Escreva exatamente como aparece em fonts.google.com." }),
      text("Pesos", [...path, "weights"], { placeholder: "400;700", hint: "Separe por ponto e vírgula. Ex.: 400;500;700;800" }),
      h("a", { href: "https://fonts.google.com", target: "_blank", rel: "noopener", class: "link" }, "Procurar fontes no Google Fonts ↗"));
  } else if (f.source === "system") {
    parts.push(text("Nome da fonte", [...path, "family"], { placeholder: "Ex.: Georgia", hint: "Só funciona se a fonte existir no computador de quem visita. Prefira Google Fonts ou um arquivo." }));
  } else if (f.source === "file") {
    if (!Array.isArray(f.files)) f.files = [];
    parts.push(text("Nome da fonte", [...path, "family"], { placeholder: "Ex.: Minha Fonte" }),
      h("p", { class: "label" }, "Arquivos (um por peso/estilo)"),
      f.files.length ? h("ul", { class: "font-files" }, f.files.map((ff, i) => h("li", {},
        h("span", { class: "fname" }, ff.name || ff.url.split("/").pop()),
        h("select", { "aria-label": "Peso", onchange: (e) => change((d) => { getAt(d, path).files[i].weight = Number(e.target.value); }) },
          [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => h("option", { value: w, selected: Number(ff.weight || 400) === w ? true : null }, `${w}${w === 400 ? " (normal)" : w === 700 ? " (negrito)" : ""}`))),
        h("select", { "aria-label": "Estilo", onchange: (e) => change((d) => { getAt(d, path).files[i].style = e.target.value; }) },
          [["normal", "Normal"], ["italic", "Itálico"]].map(([v, l]) => h("option", { value: v, selected: (ff.style || "normal") === v ? true : null }, l))),
        h("button", { class: "icon-btn sm danger", "aria-label": "Remover arquivo", onclick: () => change((d) => { getAt(d, path).files.splice(i, 1); }, { rerender: true }) }, "✕")))) : h("p", { class: "muted" }, "Nenhum arquivo ainda."),
      h("button", { class: "btn sm", onclick: async () => {
        const files = await chooseFiles(".woff2,.woff,.ttf,.otf", true);
        for (const file of files) {
          const row = await withBusy(`Enviando ${file.name}…`, () => uploadFile("font", file));
          if (!row) continue;
          const guess = /black|heavy/i.test(file.name) ? 900 : /extra ?bold/i.test(file.name) ? 800 : /semi ?bold/i.test(file.name) ? 600 : /bold/i.test(file.name) ? 700 : /medium/i.test(file.name) ? 500 : /light/i.test(file.name) ? 300 : /thin/i.test(file.name) ? 100 : 400;
          change((d) => {
            const s = getAt(d, path);
            s.files.push({ url: row.lg, name: file.name, weight: guess, style: /italic/i.test(file.name) ? "italic" : "normal" });
            if (!s.family) s.family = file.name.replace(/\.[^.]+$/, "").replace(/[-_ ]?(regular|bold|italic|medium|light|black|thin|semibold|extrabold|\d{3})/gi, "").trim();
          }, { rerender: true });
        }
      } }, "⬆ Enviar arquivo de fonte"),
      h("p", { class: "hint" }, "Formatos: WOFF2 (melhor), WOFF, TTF ou OTF. Confira se a licença da fonte permite usar na web."));
  }
  return card(title, ...parts);
}
function viewFonts() {
  return h("div", {}, intro("Fontes", "Escolha uma fonte do Google Fonts pelo nome ou envie o arquivo da sua fonte."),
    fontSlot("body", "Fonte do texto (parágrafos, menus, botões)", false),
    fontSlot("display", "Fonte dos títulos (nome no topo e títulos das seções)", true),
    card("Japonês", h("p", { class: "muted" }, "Na versão em japonês, os caracteres japoneses usam sempre a Noto Sans JP, porque a maioria das fontes não tem esses caracteres.")));
}

/* ---------------------------------------------------------------- motion */
function viewMotion() {
  const P = (k) => ["motion", k];
  return h("div", {}, intro("Animações", "Ajuste o tempo e a intensidade das animações. Quem ativa “reduzir movimento” no sistema sempre vê o site sem animações espaciais."),
    card("Geral",
      toggle("Animações ligadas", P("enabled"), "Desligado, o site aparece sem animações (mais simples e leve)."),
      range("Velocidade geral", P("speed"), { min: 0.25, max: 3, step: 0.05, fmt: (v) => v.toFixed(2), unit: "×", hint: "1× é o normal. 2× deixa tudo duas vezes mais rápido; 0,5× mais lento." }),
      toggle("Tela de abertura (logo + contador)", P("loader"), "Na prévia do painel a abertura fica sempre desligada."),
      h("div", { class: "row" }, h("button", { class: "btn sm ghost", onclick: () => change((d) => { d.motion = { ...DEFAULT_MOTION }; }, { rerender: true }) }, "Restaurar valores originais"))),
    card("Rolagem",
      toggle("Rolagem suave", P("smoothScroll")),
      range("Suavidade da rolagem", P("scrollLerp"), { min: 0.03, max: 0.4, step: 0.01, fmt: (v) => v.toFixed(2), hint: "Menor = rolagem mais macia e “deslizante”. Maior = mais direta." }),
      range("Duração ao clicar no menu", P("anchorDuration"), { min: 0, max: 3, step: 0.1, fmt: (v) => v.toFixed(1), unit: " s" })),
    card("Entrada dos elementos ao rolar",
      range("Duração", P("revealDuration"), { min: 0, max: 3000, step: 50, unit: " ms" }),
      range("Intervalo entre itens", P("revealStagger"), { min: 0, max: 300, step: 5, unit: " ms", hint: "Atraso entre uma palavra/item e o próximo." }),
      range("Distância do movimento", P("revealDistance"), { min: 0, max: 160, step: 2, unit: " px" }),
      toggle("Imagens dos carrosséis entram em cascata", P("carouselEntrance")),
      toggle("Trabalhos do topo “respirando”", P("floatBreathe"))),
    card("Faixa de palavras",
      toggle("Faixa acompanha a rolagem", P("marquee")),
      range("Velocidade da faixa", P("marqueeSpeed"), { min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) })),
    card("Interações",
      toggle("Partículas ao clicar em botões", P("burst")),
      range("Quantidade de partículas", P("burstCount"), { min: 0, max: 40 }),
      toggle("Botões magnéticos (seguem o mouse)", P("magnetic")),
      range("Força do ímã", P("magnetStrength"), { min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100), unit: "%" })),
  );
}

/* ---------------------------------------------------------------- texts */
const GROUPS = {
  doc: "Título da aba e descrição (Google)", nav: "Menu", hero: "Topo", marquee: "Faixa de palavras", about: "Quem sou eu", skill: "Ferramentas",
  works: "Trabalhos", filter: "Filtros dos trabalhos", work: "Janela do projeto", more: "Outros projetos", illus: "Ilustrações", collage: "Graphic Montages",
  contact: "Contato", ui: "Botões (leitores de tela)", geral: "Geral",
};
const KEY_HINTS = { marquee: "Separe as palavras com | (barra vertical).", "doc.description": "Aparece no Google e quando o link é compartilhado." };
function viewTexts() {
  const ownIds = new Set([...(S.data.works || []).map((w) => w.id)]);
  const moreIds = new Set((S.data.more || []).map((m) => m.id));
  const keys = Object.keys(S.data.i18n.pt).filter((k) => {
    const [g, rest] = k.split(".");
    if (ownIds.has(g)) return false;                       // edited in Trabalhos
    if (g === "more" && moreIds.has(rest)) return false;   // edited in Outros projetos
    if (g === "filter" && rest !== "label" && rest !== "count" && rest !== "all") return false; // in Trabalhos
    if (g === "about" && /^[kv]\d+$/.test(rest || "")) return false; // in Quem sou eu
    return true;
  });
  const groups = {};
  keys.forEach((k) => { const g = k.includes(".") ? k.split(".")[0] : "geral"; (groups[g] ||= []).push(k); });
  let q = "";
  const box = h("div", {});
  const draw = () => {
    box.replaceChildren(...Object.entries(groups).map(([g, ks]) => {
      const vis = ks.filter((k) => !q || k.toLowerCase().includes(q) || LANGS.some(([l]) => tr(l, k).toLowerCase().includes(q)));
      if (!vis.length) return null;
      return card(GROUPS[g] || g, vis.map((k) => i18nField(k, k, { multiline: tr("pt", k).length > 60, hint: KEY_HINTS[k] || KEY_HINTS[g] })));
    }).filter(Boolean));
  };
  draw();
  return h("div", {}, intro("Textos", "Todos os textos do site em português, inglês e japonês. Ao clicar num campo EN ou JA, a prévia troca de idioma."),
    h("input", { type: "search", class: "search", placeholder: "Buscar texto…", "aria-label": "Buscar texto", oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }),
    box);
}

/* ---------------------------------------------------------------- hero */
function brandUpload(label, path, hint) {
  const cur = get(path);
  return h("div", { class: "field" }, h("p", { class: "label" }, label),
    h("div", { class: "image-one" }, h("div", { class: "thumb contain" }, h("img", { src: "/" + cur, alt: "" })),
      h("div", { class: "image-meta" }, h("div", { class: "row" },
        h("button", { class: "btn sm", onclick: async () => {
          const [f] = await chooseFiles(".svg,.png,.webp,image/svg+xml,image/png,image/webp");
          if (!f) return;
          const row = await withBusy("Enviando…", () => uploadFile("brand", f));
          if (row) change((d) => setAt(d, path, row.lg), { rerender: true });
        } }, "Enviar novo"),
        h("button", { class: "btn sm ghost", onclick: () => change((d) => setAt(d, path, getAt(DEFAULT_DOC, path)), { rerender: true }) }, "Usar o original")),
      hint ? h("p", { class: "hint" }, hint) : null)));
}
function viewHero() {
  const lines = h("textarea", { rows: 3, value: (S.data.site.heroLines || []).join("\n"), oninput: (e) => change((d) => { d.site.heroLines = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean); }) });
  return h("div", {}, intro("Topo do site", "Nome, logo, mascote e as imagens que saem da cabeça do mascote."),
    card("Nome",
      text("Nome completo", ["site", "name"], { hint: "Aparece no cabeçalho, no rodapé e para leitores de tela." }),
      field("Nome grande do topo (uma linha por linha)", autoGrow(lines), "Cada linha vira uma linha do título animado.")),
    card("Logo e mascote",
      brandUpload("Logo (cabeçalho, abertura e ícone da aba)", ["site", "logo"], "SVG ou PNG quadrado, de preferência com fundo transparente."),
      brandUpload("Mascote", ["site", "mascot"], "SVG ou PNG com fundo transparente."),
      h("p", { class: "hint" }, "O padrão animado do fundo continua usando o logo e o mascote originais.")),
    card("Imagens que saem do mascote",
      imageList("Imagens", ["hero", "floats"], { max: 3, alt: false, hint: "Até 3 (esquerda, centro, direita)." })),
    card("Banner (imagem larga depois do topo)",
      imageOne("Imagem do banner", ["banner"], { focal: true })),
    card("Texto do botão", i18nField("Botão do topo", "hero.cta")));
}

/* ---------------------------------------------------------------- about */
function viewAbout() {
  if (!Array.isArray(S.data.aboutFacts)) S.data.aboutFacts = ["1", "2", "4", "5", "3"];
  return h("div", {}, intro("Quem sou eu"),
    card("Foto", imageOne("Retrato", ["portrait"])),
    card("Textos",
      i18nField("Título", "about.title"),
      i18nField("Número em destaque", "about.yearsN"),
      i18nField("Texto ao lado do número", "about.years"),
      i18nField("Parágrafo 1", "about.p1", { multiline: true }),
      i18nField("Parágrafo 2", "about.p2", { multiline: true }),
      i18nField("Dica acima das ferramentas", "skill.hint")),
    card("Informações (lista)",
      objectList(["aboutFacts"], (k) => h("div", {}, i18nField("Rótulo", `about.k${k}`), i18nField("Valor", `about.v${k}`, { multiline: true })), {
        itemTitle: (k) => tr("pt", `about.k${k}`) || "(sem rótulo)",
        addLabel: "+ Adicionar informação",
        onAdd: () => change((d) => {
          const id = String(Math.max(0, ...d.aboutFacts.map(Number).filter(Number.isFinite)) + 1);
          d.aboutFacts.push(id);
          LANGS.forEach(([l]) => { (d.i18n[l] ||= {})[`about.k${id}`] = ""; d.i18n[l][`about.v${id}`] = ""; });
        }, { rerender: true }),
        onRemove: (d, k) => LANGS.forEach(([l]) => { delete d.i18n[l][`about.k${k}`]; delete d.i18n[l][`about.v${k}`]; }),
        removeLabel: "Remover informação",
      })),
    card("Currículo (PDF)",
      cvField("Currículo em português", "pt"), cvField("Currículo em inglês (usado também no japonês)", "en"),
      i18nField("Texto do botão", "about.cv")));
}
function cvField(label, lang) {
  const path = ["site", "cv", lang];
  const cur = get(path) || "";
  return h("div", { class: "field" }, h("p", { class: "label" }, label),
    h("div", { class: "row" }, cur ? h("a", { class: "link", href: "/" + cur, target: "_blank", rel: "noopener" }, cur.split("/").pop()) : h("span", { class: "muted" }, "nenhum"),
      h("button", { class: "btn sm", onclick: async () => {
        const [f] = await chooseFiles("application/pdf,.pdf");
        if (!f) return;
        const row = await withBusy("Enviando PDF…", () => uploadFile("file", f));
        if (row) change((d) => setAt(d, path, row.lg), { rerender: true });
      } }, "Enviar PDF")));
}

/* ---------------------------------------------------------------- works */
function viewWorks() {
  const works = S.data.works || (S.data.works = []);
  if (S.sub != null && works[S.sub]) return workEditor(S.sub);
  const filters = S.data.filters || (S.data.filters = []);
  return h("div", {}, intro("Trabalhos", "Os projetos da grade. Clique num projeto para editar; arraste as setas para mudar a ordem."),
    card(null,
      h("ol", { class: "work-list" }, works.map((w, i) => h("li", {},
        h("button", { class: "work-item", onclick: () => go("works", i) },
          h("span", { class: "thumb" }, (() => { const u = thumbUrl(w.cover) || thumbUrl((w.images[0] || {}).src); return u ? h("img", { src: u, alt: "" }) : null; })()),
          h("span", {}, h("b", {}, w.title || "(sem título)"), h("small", { class: "muted" }, `${w.images.length} imagens · ${(w.tags || []).map((t) => tr("pt", "filter." + t) || t).join(", ") || "sem filtro"}`))),
        h("span", { class: "row tight" },
          h("button", { class: "icon-btn sm", "aria-label": "Subir", disabled: i === 0, onclick: () => change((d) => { const [x] = d.works.splice(i, 1); d.works.splice(i - 1, 0, x); }, { rerender: true }) }, "↑"),
          h("button", { class: "icon-btn sm", "aria-label": "Descer", disabled: i === works.length - 1, onclick: () => change((d) => { const [x] = d.works.splice(i, 1); d.works.splice(i + 1, 0, x); }, { rerender: true }) }, "↓"))))),
      h("button", { class: "btn", onclick: async () => {
        const title = await promptBox("Novo projeto", "Nome do projeto", "", "Criar");
        if (!title) return;
        const taken = [...S.data.works.map((w) => w.id), ...S.data.more.map((m) => m.id), ...Object.keys(GROUPS)];
        const id = uniqueId(title, taken);
        change((d) => { d.works.push({ id, title, tags: [], pos: "", cover: "", images: [] }); LANGS.forEach(([l]) => { d.i18n[l][id + ".cat"] = ""; d.i18n[l][id + ".desc"] = ""; }); });
        go("works", S.data.works.length - 1);
      } }, "+ Novo projeto")),
    card("Filtros da grade",
      h("p", { class: "muted" }, "Os botões acima da grade (“Todos” sempre aparece)."),
      i18nField("Botão “Todos”", "filter.all"),
      objectList(["filters"], (k) => i18nField("Nome do filtro", "filter." + k), {
        itemTitle: (k) => tr("pt", "filter." + k) || k,
        addLabel: "+ Novo filtro",
        removeLabel: "Remover filtro",
        collapsed: true,
        onAdd: async () => {
          const name = await promptBox("Novo filtro", "Nome do filtro (em português)", "", "Criar");
          if (!name) return;
          const key = uniqueId(name, ["all", "label", "count", ...filters]);
          change((d) => { d.filters.push(key); LANGS.forEach(([l]) => { d.i18n[l]["filter." + key] = l === "pt" ? name : ""; }); }, { rerender: true });
        },
        onRemove: (d, k) => { d.works.forEach((w) => { w.tags = (w.tags || []).filter((t) => t !== k); }); LANGS.forEach(([l]) => delete d.i18n[l]["filter." + k]); },
      })),
    card("Textos da seção", i18nField("Título", "works.title"), i18nField("Introdução", "works.intro", { multiline: true })));
}
function workEditor(i) {
  const P = ["works", i];
  const w = get(P);
  if (!Array.isArray(w.tags)) w.tags = String(w.tags || "").split(" ").filter(Boolean);
  return h("div", {},
    h("button", { class: "btn ghost sm back", onclick: () => go("works") }, "← Todos os trabalhos"),
    intro(w.title || "Projeto"),
    card("Informações",
      text("Título", [...P, "title"], { hint: "O título é o mesmo nos três idiomas." }),
      i18nField("Categoria (linha abaixo do título)", w.id + ".cat"),
      i18nField("Descrição", w.id + ".desc", { multiline: true }),
      h("fieldset", { class: "checks" }, h("legend", {}, "Filtros"),
        (S.data.filters || []).map((f) => { const id = nid(); return h("span", {}, h("input", { type: "checkbox", id, checked: w.tags.includes(f), onchange: (e) => change((d) => {
          const t = getAt(d, P).tags; const k = t.indexOf(f); if (e.target.checked && k < 0) t.push(f); if (!e.target.checked && k >= 0) t.splice(k, 1);
        }) }), h("label", { for: id }, tr("pt", "filter." + f) || f)); })),
      (() => { const id = nid(); return h("div", { class: "field toggle" },
        h("input", { type: "checkbox", id, role: "switch", checked: w.pos === "top", onchange: (e) => change((d) => { getAt(d, P).pos = e.target.checked ? "top" : ""; }) }),
        h("label", { for: id }, "Mostrar o topo das imagens"), h("p", { class: "hint" }, "Bom para telas de site: o corte mantém o começo da página.")); })(),
    ),
    card("Imagens", imageList("Imagens do projeto", [...P, "images"], { hint: "A primeira imagem é a capa do card, a menos que você escolha outra capa abaixo." }),
      imageKey("Capa do card (opcional)", [...P, "cover"], "Sem capa escolhida, o card usa a primeira imagem.")),
    card("Zona de perigo", h("button", { class: "btn danger", onclick: async () => {
      if (!(await confirmBox("Excluir projeto", `Excluir “${w.title}”? Dá para desfazer com Ctrl+Z.`, "Excluir", true))) return;
      change((d) => { const [x] = d.works.splice(i, 1); LANGS.forEach(([l]) => { delete d.i18n[l][x.id + ".cat"]; delete d.i18n[l][x.id + ".desc"]; }); });
      go("works");
    } }, "Excluir projeto")));
}

/* ---------------------------------------------------------------- more */
function viewMore() {
  return h("div", {}, intro("Outros projetos", "A lista abaixo da grade. Ao passar o mouse aparece a primeira imagem; ao clicar, abre a galeria."),
    card(null, i18nField("Título da lista", "more.title"),
      objectList(["more"], (p, i) => h("div", {},
        text("Título", ["more", i, "title"]),
        i18nField("Descrição curta", "more." + p.id),
        imageList("Imagens", ["more", i, "images"])), {
        itemTitle: (p) => p.title || "(sem título)",
        addLabel: "+ Novo item",
        removeLabel: "Remover projeto",
        collapsed: true,
        onAdd: async () => {
          const title = await promptBox("Novo item", "Nome do projeto", "", "Criar");
          if (!title) return;
          const id = uniqueId(title, [...S.data.works.map((w) => w.id), ...S.data.more.map((m) => m.id), ...Object.keys(GROUPS)]);
          change((d) => { d.more.push({ id, title, images: [] }); LANGS.forEach(([l]) => { d.i18n[l]["more." + id] = ""; }); }, { rerender: true });
        },
        onRemove: (d, p) => LANGS.forEach(([l]) => delete d.i18n[l]["more." + p.id]),
      })));
}

/* ---------------------------------------------------------------- galleries */
function viewGalleries() {
  return h("div", {}, intro("Ilustrações e montagens"),
    card("Ilustrações (carrossel)", i18nField("Título", "illus.title"), i18nField("Introdução", "illus.intro", { multiline: true }), imageList("Carrossel", ["illus"])),
    card("Mais ilustrações (grade)", imageList("Grade", ["gallery"], { hint: "No celular aparecem 6 e o resto fica atrás do botão “Ver mais”." }), i18nField("Botão “ver mais”", "illus.showMore"), i18nField("Botão “ver menos”", "illus.showLess")),
    card("Graphic Montages", i18nField("Título", "collage.title"), imageList("Carrossel", ["collage"])));
}

/* ---------------------------------------------------------------- skills */
function viewSkills() {
  return h("div", {}, intro("Ferramentas", "Os botões de softwares em “Quem sou eu”. Cada um abre uma janela com os trabalhos feitos nele."),
    card(null, objectList(["skills"], (s, i) => h("div", {},
      text("Nome", ["skills", i, "name"]),
      toggle("Mostrar o vídeo de apresentação nesta ferramenta", ["skills", i, "video"]),
      imageList("Trabalhos feitos nesta ferramenta", ["skills", i, "images"])), {
      itemTitle: (s) => `${s.name} · ${(s.images || []).length} itens`,
      addLabel: "+ Nova ferramenta",
      removeLabel: "Remover ferramenta",
      collapsed: true,
      onAdd: async () => {
        const name = await promptBox("Nova ferramenta", "Nome do software", "", "Criar");
        if (!name) return;
        change((d) => { d.skills.push({ id: uniqueId(name, d.skills.map((s) => s.id)), name, video: false, images: [] }); }, { rerender: true });
      },
    })),
    card("Vídeo de apresentação",
      text("Link do vídeo (incorporar)", ["site", "video", "src"], { hint: "Google Drive: Compartilhar → “Qualquer pessoa com o link” e use o endereço terminado em /preview. YouTube: use https://www.youtube.com/embed/ID." }),
      text("Título do vídeo", ["site", "video", "title"]),
      i18nField("Legenda do vídeo", "skill.video")));
}

/* ---------------------------------------------------------------- contact */
function viewContact() {
  if (!Array.isArray(S.data.site.links)) S.data.site.links = [];
  return h("div", {}, intro("Contato e SEO"),
    card("Contato",
      text("E-mail", ["site", "email"]),
      i18nField("Chamada", "contact.kicker"), i18nField("Título", "contact.title"), i18nField("Texto", "contact.text", { multiline: true }),
      imageOne("Arte ao lado do contato", ["contactArt"])),
    card("Links (redes)", objectList(["site", "links"], (l, i) => h("div", { class: "grid2" }, text("Nome do botão", ["site", "links", i, "label"]), text("Endereço (https://…)", ["site", "links", i, "url"])), {
      itemTitle: (l) => l.label || "(sem nome)",
      addLabel: "+ Novo link",
      removeLabel: "Remover link",
      onAdd: () => change((d) => { d.site.links.push({ label: "", url: "https://" }); }, { rerender: true }),
    })),
    card("Google e compartilhamento",
      i18nField("Título da aba", "doc.title"),
      i18nField("Descrição", "doc.description", { multiline: true, hint: "Aparece no Google e quando o link é compartilhado." }),
      imageKey("Imagem de compartilhamento", ["site", "ogImage"], "Aparece quando o link é enviado no WhatsApp, LinkedIn etc.")));
}

/* ---------------------------------------------------------------- media */
function viewMedia() {
  const ups = S.media.uploads;
  const size = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB");
  const kinds = { image: "Imagem", font: "Fonte", file: "PDF", brand: "Logo/mascote" };
  return h("div", {}, intro("Mídia", "Tudo o que você enviou. Para apagar um arquivo, primeiro tire ele do site."),
    card(null, h("div", { class: "row" },
      h("button", { class: "btn", onclick: async () => {
        const files = await chooseFiles("image/*", true);
        for (const [i, f] of files.entries()) await withBusy(`Enviando ${i + 1} de ${files.length}…`, () => uploadImage(f));
        if (files.length) { toast("Imagens enviadas."); renderView(); }
      } }, "⬆ Enviar imagens"),
      h("button", { class: "btn ghost", onclick: async () => {
        const [f] = await chooseFiles("application/pdf,.pdf");
        if (f && await withBusy("Enviando…", () => uploadFile("file", f))) renderView();
      } }, "⬆ Enviar PDF")),
    ups.length ? h("ul", { class: "media-grid" }, ups.map((m) => h("li", {},
      m.kind === "image" ? h("img", { src: "/" + m.sm, alt: "", loading: "lazy" }) : h("span", { class: "file-ic" }, m.kind === "font" ? "Aa" : m.kind === "brand" ? "★" : "PDF"),
      h("b", { title: m.name }, m.name), h("small", { class: "muted" }, `${kinds[m.kind] || m.kind} · ${size(m.size || 0)}${m.w ? ` · ${m.w}×${m.h}` : ""}`),
      h("span", { class: "row tight" },
        h("a", { class: "icon-btn sm", href: "/" + m.lg, target: "_blank", rel: "noopener", "aria-label": "Abrir", title: "Abrir" }, "↗"),
        h("button", { class: "icon-btn sm danger", "aria-label": "Apagar", title: "Apagar", onclick: async () => {
          if (!(await confirmBox("Apagar arquivo", `Apagar “${m.name}” de vez?`, "Apagar", true))) return;
          await flush();
          try {
            await api("media?key=" + encodeURIComponent(m.key), { method: "DELETE" });
            S.media.uploads = S.media.uploads.filter((x) => x.key !== m.key); delete S.meta[m.key];
            renderView(); toast("Arquivo apagado.");
          } catch (e) { toast(e.message, "error"); }
        } }, "🗑"))))) : h("p", { class: "muted" }, "Nada enviado ainda.")),
    card("Imagens do site original", h("details", {}, h("summary", {}, `${S.media.bundled.length} imagens (já fazem parte do site)`),
      h("ul", { class: "media-grid small" }, S.media.bundled.map((m) => h("li", {}, h("img", { src: "/" + m.sm, alt: "", loading: "lazy" }), h("small", {}, m.key.split("/").pop())))))));
}

/* ---------------------------------------------------------------- history */
function viewHistory() {
  const box = h("div", {}, h("p", { class: "muted" }, "Carregando…"));
  api("versions").then(({ versions }) => {
    box.replaceChildren(versions.length ? h("ol", { class: "versions" }, versions.map((v, i) => h("li", {},
      h("div", {}, h("b", {}, `#${v.id}`), i === 0 ? h("span", { class: "badge" }, "no ar") : null,
        h("span", {}, new Date(v.created_at).toLocaleString("pt-BR")), v.note ? h("em", {}, `“${v.note}”`) : null),
      h("span", { class: "row tight" },
        h("a", { class: "btn sm ghost", href: `/api/versions/${v.id}`, target: "_blank", rel: "noopener" }, "Ver"),
        h("button", { class: "btn sm", onclick: async () => {
          if (!(await confirmBox("Restaurar versão", `Copiar a versão #${v.id} para o rascunho? Depois é só publicar. Dá para desfazer com Ctrl+Z.`, "Restaurar"))) return;
          await flush();
          try {
            const r = await api(`versions/${v.id}`, { method: "POST" });
            S.undo.push(JSON.stringify(S.data)); S.data = normalize(r.data); S.base = r.updated_at; S.dirty = false;
            syncUndo(); setStatus(); schedulePreview(10); toast(`Versão #${v.id} copiada para o rascunho.`);
          } catch (e) { toast(e.message, "error"); }
        } }, "Restaurar"))))) : h("p", { class: "muted" }, "Nenhuma versão publicada ainda."));
  }).catch((e) => box.replaceChildren(h("p", { class: "error" }, e.message)));
  return h("div", {}, intro("Histórico", "Cada publicação vira uma versão. Você pode ver qualquer uma e trazê-la de volta para o rascunho."), card(null, box));
}

/* ---------------------------------------------------------------- security */
const EVENTS = {
  login_ok: ["Entrou", "good"], login_fail: ["Login recusado", "bad"], login_blocked: ["Tentativa com IP bloqueado", "bad"],
  honeypot: ["Robô barrado", "bad"], logout: ["Saiu", ""], sessions_revoked: ["Sessões encerradas", ""],
  publish: ["Publicou", "good"], restore: ["Restaurou versão", ""], upload: ["Enviou arquivo", ""], media_delete: ["Apagou arquivo", ""],
};
function device(ua = "") {
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const o = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return o ? `${b} no ${o}` : b;
}
function viewSecurity() {
  const box = h("div", {}, h("p", { class: "muted" }, "Carregando…"));
  const when = (t) => new Date(t * 1000).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const load = () => api("security").then((d) => {
    const p = d.protections;
    const item = (on, title, text) => h("li", { class: on ? "on" : "off" }, h("span", { class: "ic", "aria-hidden": "true" }, on ? "✓" : "!"), h("div", {}, h("b", {}, title), h("p", { class: "hint" }, text)));
    box.replaceChildren(
      card("Proteções", h("ul", { class: "sec-status" },
        item(true, "Senha + bloqueio de tentativas", "Depois de 5 erros, o IP fica bloqueado 15 min (dobra a cada nova falha, até 24 h). Com muitos erros no geral, o limite cai para 2."),
        item(true, "Barreira contra robôs", "Campo invisível (honeypot) e tempo mínimo de preenchimento do formulário."),
        item(p.totp, "Verificação em 2 etapas", p.totp ? "Ativa: o login pede o código do app autenticador." : "Desligada. Recomendado: configure ADMIN_TOTP_SECRET (veja o README)."),
        item(p.turnstile, "Cloudflare Turnstile", p.turnstile ? "Ativo: verificação anti-robô no login." : "Opcional: verificação anti-robô gratuita da Cloudflare (veja o README)."),
        item(p.access, "Cloudflare Access", p.access ? `Ativo e conferido pelo servidor: você entrou como ${d.accessUser}.` : "Opcional: exige login por e-mail da Cloudflare antes mesmo da senha (veja o README).")),
        h("p", { class: d.failures24h > 10 ? "error" : "muted" }, `${d.failures24h} tentativa(s) recusada(s) nas últimas 24 h.`)),
      card("Onde o painel está aberto",
        h("ul", { class: "sessions" }, d.sessions.map((s) => h("li", {},
          h("div", {}, h("b", {}, device(s.ua)), s.current ? h("span", { class: "badge" }, "este aparelho") : null,
            h("br"), h("small", {}, `${s.ip}${s.country ? " · " + s.country : ""} · entrou ${when(s.created_at)} · ativo ${when(s.last_seen)}`)),
          s.current ? null : h("button", { class: "btn sm ghost", onclick: async () => {
            try { await api("security?session=" + encodeURIComponent(s.id), { method: "DELETE" }); toast("Sessão encerrada."); load(); } catch (e) { toast(e.message, "error"); }
          } }, "Encerrar")))),
        d.sessions.length > 1 ? h("button", { class: "btn danger", onclick: async () => {
          if (!(await confirmBox("Sair dos outros aparelhos", "Todos os outros aparelhos vão precisar entrar de novo.", "Encerrar", true))) return;
          try { await api("security?all=1", { method: "DELETE" }); toast("Outras sessões encerradas."); load(); } catch (e) { toast(e.message, "error"); }
        } }, "Sair de todos os outros aparelhos") : null,
        h("p", { class: "hint" }, "Se suspeitar que a senha vazou: troque ADMIN_PASSWORD no Cloudflare e encerre as outras sessões (o botão aparece quando há mais de um aparelho). Trocar SESSION_SECRET derruba todas as sessões, inclusive esta.")),
      card("Registro de acessos (últimos 150)",
        d.log.length ? h("ol", { class: "audit" }, d.log.map((l) => {
          const [label, cls] = EVENTS[l.event] || [l.event, ""];
          return h("li", {}, h("small", {}, when(l.at)), h("span", { class: "ev " + cls }, label),
            h("span", {}, l.detail ? l.detail + " · " : "", h("small", {}, `${l.ip}${l.country ? " (" + l.country + ")" : ""} · ${device(l.ua)}`)));
        })) : h("p", { class: "muted" }, "Nada registrado ainda.")));
  }).catch((e) => box.replaceChildren(h("p", { class: "error" }, e.message)));
  load();
  return h("div", {}, intro("Segurança", "Quem entrou, de onde, e o que está protegendo o painel."), box);
}

/* ================================================================== publish */
async function publish() {
  const id = nid();
  const note = h("input", { id, placeholder: "Ex.: novas fotos do projeto LUMA", maxlength: 200 });
  const run = async () => {
    closeModal();
    if (!(await flush())) { toast("Não foi possível salvar o rascunho, então nada foi publicado.", "error"); return; }
    await withBusy("Publicando…", async () => {
      const r = await api("publish", { method: "POST", body: JSON.stringify({ note: note.value.trim() }) });
      S.published = { id: r.id, created_at: r.created_at, note: note.value.trim() };
      setStatus();
      toast("Publicado! O site já está atualizado. 🎉", "ok");
      if (S.view === "home" || S.view === "history") renderView();
    });
  };
  openModal("Publicar o site", h("form", { onsubmit: (e) => { e.preventDefault(); run(); } },
    h("p", {}, "O rascunho atual vai substituir o site no ar. Versões anteriores ficam no Histórico."),
    h("label", { for: id }, "Nota (opcional)"), note), [["Cancelar", "ghost", closeModal], ["Publicar", "primary", run]]);
  setTimeout(() => note.focus(), 30);
}

/* ================================================================ normalize */
// Older/imported documents may miss newer fields; fill them so every view can rely on them.
let DEFAULT_DOC = null;
function normalize(d) {
  const D = DEFAULT_DOC || {};
  d.site ||= clone(D.site || {}); d.site.cv ||= {}; d.site.video ||= { src: "", title: "" }; d.site.links ||= [];
  d.theme ||= {}; d.theme.colors = { ...DEFAULT_COLORS, ...(d.theme.colors || {}) }; d.theme.fonts ||= clone((D.theme || {}).fonts || {});
  for (const [k, v] of Object.entries({ radius: 10, pixelCursors: true, pattern: true, patternOpacity: 0.07, patternDuration: 36 })) if (d.theme[k] === undefined) d.theme[k] = v;
  d.motion = { ...DEFAULT_MOTION, ...(d.motion || {}) };
  d.hero ||= { floats: [] }; d.hero.floats ||= [];
  for (const k of ["works", "more", "illus", "gallery", "collage", "skills", "filters"]) d[k] ||= [];
  d.aboutFacts ||= ["1", "2", "4", "5", "3"];
  d.i18n ||= {}; LANGS.forEach(([l]) => { d.i18n[l] ||= {}; });
  for (const k of ["banner", "portrait", "contactArt"]) d[k] ||= { src: "", alt: "" };
  return d;
}

/* ================================================================== boot */
// Login: every time the form is shown it gets a fresh form token from /api/session (the server
// refuses logins sent without one, or less than 2 s after it was issued — typical of bots).
const LOGIN = { form: null, formAt: 0, turnstile: null, widget: null };
// (checks for .render: an element with id="turnstile" would also show up as window.turnstile)
const turnstileApi = () => (window.turnstile && typeof window.turnstile.render === "function" ? window.turnstile : null);
function loadTurnstile() {
  if (turnstileApi()) return Promise.resolve(turnstileApi());
  return new Promise((resolve, reject) => {
    const s = h("script", { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async: true });
    s.onload = () => (turnstileApi() ? resolve(turnstileApi()) : reject(new Error("Não foi possível carregar a verificação anti-robô."))); s.onerror = () => reject(new Error("Não foi possível carregar a verificação anti-robô."));
    document.head.append(s);
  });
}
async function showLogin(msg, sess) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  if (msg) $("#login-msg").textContent = msg;
  try {
    const s = sess || await api("session");
    LOGIN.form = s.form;
    LOGIN.formAt = Date.now();
    $("#totp-field").hidden = !s.totp;
    $("#code").required = !!s.totp;
    if (s.turnstileSiteKey) {
      const ts = await loadTurnstile();
      LOGIN.turnstile = null;
      if (LOGIN.widget != null) ts.reset(LOGIN.widget);
      else LOGIN.widget = ts.render("#turnstile-box", { sitekey: s.turnstileSiteKey, language: "pt-br", callback: (t) => { LOGIN.turnstile = t; }, "expired-callback": () => { LOGIN.turnstile = null; } });
    }
  } catch (e) { $("#login-err").textContent = e.message; }
  setTimeout(() => $("#pw").focus(), 30);
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#login-btn");
  $("#login-err").textContent = "";
  btn.disabled = true;
  try {
    // A page opened before the panel was configured has no form token yet: fetch one first
    if (!LOGIN.form) await showLogin();
    if (!LOGIN.form) throw new Error("O painel ainda não foi configurado no Cloudflare.");
    // The Turnstile box must finish before sending (otherwise the try would count as a failure)
    if (LOGIN.widget != null && !LOGIN.turnstile) throw new Error("Aguarde a verificação da Cloudflare terminar (a caixinha acima) e clique de novo.");
    // The server refuses logins sent less than 2 s after the form token: wait instead of failing
    const wait = LOGIN.formAt + 2300 - Date.now();
    if (wait > 0) { btn.textContent = "Entrando…"; await new Promise((r) => setTimeout(r, wait)); }
    await api("login", { method: "POST", body: JSON.stringify({
      password: $("#pw").value, code: $("#code").value, form: LOGIN.form,
      website: $("#website").value, turnstile: LOGIN.turnstile,
    }) });
    $("#pw").value = ""; $("#code").value = "";
    await start();
  } catch (err) {
    $("#login-err").textContent = err.message;
    $("#code").value = "";
    await showLogin(); // new form token (and a new Turnstile challenge) for the next try
  } finally { btn.disabled = false; btn.textContent = "Entrar"; }
});

async function start() {
  const [content, media] = await Promise.all([api("content"), api("media")]);
  DEFAULT_DOC = content.isDefault ? clone(content.data) : (await api("content?default=1")).data;
  S.data = normalize(content.data);
  S.base = content.updated_at; S.published = content.published; S.isDefault = content.isDefault;
  S.media = media;
  S.meta = {};
  media.bundled.forEach((m) => { S.meta[m.key] = { w: m.w, h: m.h, lg: m.lg, sm: m.sm }; });
  media.uploads.filter((m) => m.kind === "image").forEach((m) => { S.meta[m.key] = { w: m.w, h: m.h, lg: m.lg, sm: m.sm }; });
  $("#login").hidden = true; $("#app").hidden = false;
  const [v, sub] = location.hash.slice(1).split("/");
  if (VIEWS.some(([k]) => k === v)) { S.view = v; S.sub = sub != null && sub !== "" ? Number(sub) : null; }
  renderNav(); renderView(true); setStatus(); syncUndo();
  // Small screens: the preview starts closed (it would cover half of the editor)
  setPreviewOn(innerWidth >= 1180);
}

// Back/forward buttons and typed #hashes switch views too
addEventListener("hashchange", () => {
  if ($("#app").hidden) return;
  const [v, sub] = location.hash.slice(1).split("/");
  const s = sub != null && sub !== "" ? Number(sub) : null;
  if (VIEWS.some(([k]) => k === v) && (v !== S.view || s !== S.sub)) go(v, s);
});

// Top bar + preview controls
$("#undo").addEventListener("click", undo);
$("#redo").addEventListener("click", redo);
$("#publish").addEventListener("click", publish);
$("#open-draft").addEventListener("click", async () => { const w = window.open("about:blank", "_blank"); await flush(); if (w) w.location = "/api/preview"; });
$("#menu-btn").addEventListener("click", () => { const o = $("#sidebar").classList.toggle("open"); $("#menu-btn").setAttribute("aria-expanded", String(o)); });
$$("[data-device]").forEach((b) => b.addEventListener("click", () => {
  S.device = b.dataset.device; $$("[data-device]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); fitPreview();
}));
$$("[data-plang]").forEach((b) => b.addEventListener("click", () => setPreviewLang(b.dataset.plang)));
$("#reload-preview").addEventListener("click", () => updatePreview());
const setPreviewOn = (on) => {
  S.previewOn = on;
  $("#app").classList.toggle("no-preview", !on);
  $("#show-preview").hidden = on;
  if (on) { fitPreview(); updatePreview(); }
};
$("#toggle-preview").addEventListener("click", () => setPreviewOn(false));
$("#show-preview").addEventListener("click", () => setPreviewOn(true));
new ResizeObserver(fitPreview).observe($("#preview-stage"));
addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || $("#app").hidden) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
  else if (k === "s") { e.preventDefault(); save(); }
});
addEventListener("beforeunload", (e) => { if (S.dirty || S.saving) { e.preventDefault(); e.returnValue = ""; } });

(async () => {
  try {
    const s = await api("session");
    if (!s.configured) { $("#login").hidden = false; $("#login-form").querySelectorAll("input, button").forEach((x) => { x.disabled = true; }); $("#login-msg").textContent = "O painel ainda não foi configurado no Cloudflare (banco D1 e segredos). Veja o README."; return; }
    if (s.authed) await start(); else showLogin(null, s);
  } catch (e) { $("#login").hidden = false; $("#login-err").textContent = e.message; }
})();
