import { parseResume } from "./latex.js";

const $ = (id) => document.getElementById(id);
const els = {
  openBtn: $("openBtn"), docName: $("docName"), openDialog: $("openDialog"), openList: $("openList"), openRoot: $("openRoot"), openCancel: $("openCancel"), browseBtn: $("browseBtn"), fileInput: $("fileInput"), emptyDoc: $("emptyDoc"), emptyOpenBtn: $("emptyOpenBtn"), saveBtn: $("saveBtn"), saveAsBtn: $("saveAsBtn"), undoBtn: $("undoBtn"), redoBtn: $("redoBtn"),
  pageBadge: $("pageBadge"), dirtyDot: $("dirtyDot"), paper: $("paper"), previewView: $("previewView"), askFloat: $("askFloat"),
  pdfView: $("pdfView"), pdfFrame: $("pdfFrame"), pdfError: $("pdfError"), sourceView: $("sourceView"), source: $("source"),
  messages: $("messages"), chips: $("chips"), input: $("input"), sendBtn: $("sendBtn"), newChatBtn: $("newChatBtn"), quick: $("quick"),
};

const state = {
  path: null,
  tex: "",
  savedTex: "",
  undo: [],
  redo: [],
  parsed: { html: "", elements: {} },
  selections: [], // { key, kind, label, latex, text?, elId }
  conversationId: crypto.randomUUID(),
  streaming: false,
  view: "preview",
  pdfUrl: null,
  pendingText: null,
};

const KIND_NAMES = { item: "bullet", entry: "entry", section: "section", header: "header", text: "text", block: "block", row: "row" };

// ---------- document state ----------

function setTex(tex, { record = true, fromSource = false } = {}) {
  if (tex === state.tex) return;
  if (record) {
    state.undo.push(state.tex);
    if (state.undo.length > 200) state.undo.shift();
    state.redo = [];
  }
  state.tex = tex;
  if (!fromSource) els.source.value = tex;
  render();
  scheduleCompile();
  updateButtons();
}

function render() {
  try {
    state.parsed = parseResume(state.tex);
    els.paper.innerHTML = state.parsed.html;
  } catch (err) {
    els.paper.innerHTML = `<p style="color:#a00">Preview failed: ${err.message}. Use the Source or PDF tab.</p>`;
    state.parsed = { html: "", elements: {} };
  }
  // Re-mark selections whose source is unchanged.
  for (const sel of state.selections) {
    const el = state.parsed.elements[sel.elId];
    if (el && state.tex.slice(el.start, el.end) === sel.latex && sel.kind !== "text") markSelected(sel.elId, true);
  }
}

function updateButtons() {
  els.undoBtn.disabled = state.undo.length === 0;
  els.redoBtn.disabled = state.redo.length === 0;
  const dirty = state.tex !== state.savedTex;
  els.dirtyDot.hidden = !dirty;
  els.saveBtn.disabled = !state.tex || (state.path && !dirty);
  els.saveAsBtn.disabled = !state.tex;
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(state.tex);
  setTex(state.undo.pop(), { record: false });
  updateButtons();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(state.tex);
  setTex(state.redo.pop(), { record: false });
  updateButtons();
}

// ---------- compile ----------

let compileTimer = null;
let compileSeq = 0;
function scheduleCompile() {
  clearTimeout(compileTimer);
  compileTimer = setTimeout(compile, 900);
}
async function compile() {
  if (!state.tex) return;
  const seq = ++compileSeq;
  setBadge("busy", "compiling…");
  try {
    const res = await fetch("/api/compile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tex: state.tex }) });
    if (seq !== compileSeq) return;
    if (!res.ok) {
      const { error } = await res.json();
      setBadge("warn", "LaTeX error");
      els.pdfError.textContent = error;
      els.pdfError.hidden = false;
      els.pdfFrame.hidden = true;
      return;
    }
    const pages = Number(res.headers.get("X-Pages"));
    setBadge(pages === 1 ? "ok" : "warn", pages === 1 ? "1 page ✓" : `${pages} pages`);
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = URL.createObjectURL(await res.blob());
    els.pdfError.hidden = true;
    els.pdfFrame.hidden = false;
    if (state.view === "pdf") els.pdfFrame.src = state.pdfUrl + "#toolbar=0&view=FitH";
  } catch {
    if (seq === compileSeq) setBadge("warn", "compile failed");
  }
}
function setBadge(kind, text) {
  els.pageBadge.className = `badge ${kind}`;
  els.pageBadge.textContent = text;
}

// ---------- files ----------

function loadDocument({ tex, path, name, restoreChat = true }) {
  state.path = path;
  state.docName = name ?? path;
  state.savedTex = path ? tex : "";
  state.undo = [];
  state.redo = [];
  state.tex = "";
  els.docName.textContent = state.docName;
  els.docName.title = path ? `resume/${path}` : `${name} (not saved in the resume folder yet)`;
  els.emptyDoc.hidden = true;
  clearSelections();
  setTex(tex, { record: false });
  if (restoreChat && path) restoreLatestChat(path);
  else if (restoreChat) newChat();
}

function confirmDiscard() {
  return state.tex === state.savedTex || confirm("You have unsaved changes. Discard them?");
}

async function openFile(path, { restoreChat = true } = {}) {
  const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  loadDocument({ tex: data.tex, path, restoreChat });
}

async function showOpenDialog() {
  const { root, files } = await (await fetch("/api/files")).json();
  els.openRoot.textContent = root;
  els.openList.innerHTML = "";
  if (!files.length) els.openList.innerHTML = '<li class="none">No .tex files found in this folder.</li>';
  for (const f of files) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const [dir, name] = f.path.includes("/") ? [f.path.slice(0, f.path.lastIndexOf("/") + 1), f.path.split("/").pop()] : ["", f.path];
    btn.innerHTML = `<span class="f-dir"></span><span class="f-name"></span><span class="f-date"></span>`;
    btn.querySelector(".f-dir").textContent = dir;
    btn.querySelector(".f-name").textContent = name;
    btn.querySelector(".f-date").textContent = new Date(f.mtime).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    if (f.path === state.path) btn.classList.add("current");
    btn.addEventListener("click", async () => {
      if (!confirmDiscard()) return;
      els.openDialog.close();
      await openFile(f.path);
    });
    li.appendChild(btn);
    els.openList.appendChild(li);
  }
  els.openDialog.showModal();
}

async function saveFile(path, overwrite) {
  const res = await fetch("/api/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, tex: state.tex, overwrite }) });
  const data = await res.json();
  if (res.status === 409) {
    if (confirm(`${path} already exists. Overwrite it?`)) return saveFile(path, true);
    return false;
  }
  if (!res.ok) { alert(data.error); return false; }
  state.savedTex = state.tex;
  updateButtons();
  return true;
}

async function saveAs() {
  if (!state.tex) return;
  const base = (state.path ?? state.docName ?? "resume.tex").split("/").pop();
  const path = prompt("Save as (path inside the resume folder):", `company/${base}`);
  if (!path) return;
  const target = path.endsWith(".tex") ? path : `${path}.tex`;
  if (await saveFile(target, false)) {
    state.path = state.docName = target;
    els.docName.textContent = target;
    els.docName.title = `resume/${target}`;
  }
}

els.openBtn.addEventListener("click", showOpenDialog);
els.emptyOpenBtn.addEventListener("click", showOpenDialog);
els.openCancel.addEventListener("click", () => els.openDialog.close());
els.browseBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  els.fileInput.value = "";
  if (!file || !confirmDiscard()) return;
  els.openDialog.close();
  loadDocument({ tex: await file.text(), path: null, name: file.name });
});
els.saveBtn.addEventListener("click", () => (state.path ? saveFile(state.path, true) : saveAs()));
els.saveAsBtn.addEventListener("click", saveAs);
els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);

// ---------- views ----------

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    els.previewView.hidden = state.view !== "preview";
    els.pdfView.hidden = state.view !== "pdf";
    els.sourceView.hidden = state.view !== "source";
    if (state.view === "pdf" && state.pdfUrl) els.pdfFrame.src = state.pdfUrl + "#toolbar=0&view=FitH";
  }),
);

let sourceTimer = null;
els.source.addEventListener("input", () => {
  clearTimeout(sourceTimer);
  sourceTimer = setTimeout(() => setTex(els.source.value, { fromSource: true }), 400);
});

// ---------- selection ----------

function markSelected(elId, on) {
  const el = state.parsed.elements[elId];
  if (!el) return;
  const node = el.kind === "section"
    ? els.paper.querySelector(`section[data-id="${elId}"]`)
    : els.paper.querySelector(`[data-select="${elId}"]`);
  node?.classList.toggle("selected", on);
}

function clearSelections() {
  for (const s of state.selections) markSelected(s.elId, false);
  state.selections = [];
  renderChips();
}

function toggleElement(elId, additive) {
  const el = state.parsed.elements[elId];
  if (!el) return;
  const key = `el:${elId}`;
  const existing = state.selections.find((s) => s.key === key);
  if (!additive) {
    const onlyThis = existing && state.selections.length === 1;
    clearSelections();
    if (onlyThis) return;
  } else if (existing) {
    state.selections = state.selections.filter((s) => s !== existing);
    markSelected(elId, false);
    renderChips();
    return;
  }
  state.selections.push({ key, kind: el.kind, label: el.label, latex: state.tex.slice(el.start, el.end), elId });
  markSelected(elId, true);
  renderChips();
}

function renderChips() {
  els.chips.innerHTML = "";
  for (const sel of state.selections) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<span class="kind"></span><span class="label"></span><button title="Remove">×</button>`;
    chip.querySelector(".kind").textContent = KIND_NAMES[sel.kind] ?? sel.kind;
    chip.querySelector(".label").textContent = sel.kind === "text" ? `“${sel.text}”` : sel.label;
    chip.title = sel.kind === "text" ? sel.text : sel.label;
    chip.querySelector("button").addEventListener("click", () => {
      state.selections = state.selections.filter((s) => s !== sel);
      if (sel.kind !== "text") markSelected(sel.elId, false);
      renderChips();
    });
    els.chips.appendChild(chip);
  }
}

// Shift/Ctrl-click would otherwise extend the browser's text selection.
els.paper.addEventListener("mousedown", (e) => {
  if ((e.shiftKey || e.ctrlKey || e.metaKey) && e.target.closest("[data-select]")) {
    e.preventDefault();
    window.getSelection().removeAllRanges();
  }
});

els.paper.addEventListener("click", (e) => {
  if (e.target.closest("a")) e.preventDefault();
  if (!window.getSelection().isCollapsed) return;
  const target = e.target.closest("[data-select]");
  if (target) toggleElement(target.dataset.select, e.shiftKey || e.ctrlKey || e.metaKey);
});

let pendingTextSel = null;
els.paper.addEventListener("mouseup", () => {
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (sel.isCollapsed || !text || !els.paper.contains(sel.anchorNode)) return hideAskFloat();
    const range = sel.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) container = container.parentElement;
    const owner = container.closest("[data-id]");
    if (!owner) return hideAskFloat();
    pendingTextSel = { text, elId: owner.dataset.id };
    const rect = range.getBoundingClientRect();
    const host = els.previewView.getBoundingClientRect();
    els.askFloat.style.left = `${rect.left - host.left + els.previewView.scrollLeft + rect.width / 2 - 50}px`;
    els.askFloat.style.top = `${rect.top - host.top + els.previewView.scrollTop - 34}px`;
    els.askFloat.hidden = false;
  });
});
function hideAskFloat() {
  els.askFloat.hidden = true;
  pendingTextSel = null;
}
els.askFloat.addEventListener("mousedown", (e) => e.preventDefault());
els.askFloat.addEventListener("click", () => {
  if (!pendingTextSel) return;
  const el = state.parsed.elements[pendingTextSel.elId];
  if (el) {
    state.selections.push({
      key: `text:${crypto.randomUUID()}`, kind: "text", label: el.label, text: pendingTextSel.text,
      latex: state.tex.slice(el.start, el.end), elId: el.id,
    });
    renderChips();
  }
  window.getSelection().removeAllRanges();
  hideAskFloat();
  els.input.focus();
});
document.addEventListener("selectionchange", () => {
  if (window.getSelection().isCollapsed && !els.askFloat.matches(":hover")) els.askFloat.hidden = true;
});

// Flash and reveal the elements an edit touched.
function flashRange(at, length) {
  const hits = Object.values(state.parsed.elements).filter((el) =>
    el.kind !== "section" && el.start <= at + length && el.end >= at);
  const deepest = hits.filter((el) => !hits.some((o) => o !== el && o.start >= el.start && o.end <= el.end && (o.start > el.start || o.end < el.end)));
  let first = null;
  for (const el of deepest) {
    const node = els.paper.querySelector(`[data-select="${el.id}"]`) ?? els.paper.querySelector(`[data-id="${el.id}"]`);
    if (!node) continue;
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
    first ??= node;
  }
  if (first && state.view === "preview") first.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return first;
}

// ---------- chat ----------

const EMPTY_CHAT = `<div class="empty"><p>Select part of your resume, then tell me what to change.</p>
  <p class="muted">For example: “quantify this”, “tailor the Experience section to this job description: …”, or “make the skills section shorter”.</p></div>`;

function newChat() {
  if (state.streaming) return;
  state.conversationId = crypto.randomUUID();
  els.messages.innerHTML = EMPTY_CHAT;
}
els.newChatBtn.addEventListener("click", newChat);

// ---------- chat history ----------

const historyEls = {
  btn: document.getElementById("historyBtn"), dialog: document.getElementById("historyDialog"),
  list: document.getElementById("historyList"), close: document.getElementById("historyClose"),
  thisFile: document.getElementById("historyThisFile"),
};

function renderTranscript(transcript) {
  els.messages.innerHTML = "";
  if (!transcript.length) { els.messages.innerHTML = EMPTY_CHAT; return; }
  for (const entry of transcript) {
    const div = addMessage(entry.role);
    if (entry.role === "user") {
      if (entry.ctx?.length) {
        const ctx = document.createElement("span");
        ctx.className = "ctx";
        ctx.textContent = "📎 " + entry.ctx.map((c) => `${KIND_NAMES[c.kind] ?? c.kind}: ${(c.text || c.label).slice(0, 40)}`).join(" · ");
        div.appendChild(ctx);
      }
      div.appendChild(document.createTextNode(entry.text));
      continue;
    }
    for (const part of entry.parts ?? []) {
      if (part.type === "text") {
        const span = document.createElement("span");
        span.innerHTML = miniMarkdown(part.text);
        div.appendChild(span);
      } else if (part.type !== "break") {
        const ev = document.createElement("span");
        ev.className = `event past ${part.type === "error" ? "err" : part.type === "layout" ? "layout" : ""}`;
        ev.textContent = part.type === "edit" ? `✎ ${part.summary}`
          : part.type === "layout" ? (part.ok ? `Layout check: ${part.pages} page${part.pages === 1 ? "" : "s"}${part.pages === 1 ? " ✓" : ""}` : "Layout check: LaTeX errors")
          : part.message;
        div.appendChild(ev);
      }
    }
  }
  const note = document.createElement("div");
  note.className = "resumed-note";
  note.textContent = "Earlier conversation. Keep chatting to continue it with full context.";
  els.messages.appendChild(note);
  scrollChat();
}

async function openChat(id) {
  if (state.streaming) return;
  const res = await fetch(`/api/chats/${id}`);
  const chat = await res.json();
  if (!res.ok) return alert(chat.error);
  if (chat.file && chat.file !== state.path) {
    if (!confirmDiscard()) return;
    await openFile(chat.file, { restoreChat: false });
  }
  state.conversationId = chat.id;
  renderTranscript(chat.transcript);
}

// Reopen the most recent chat for a file, if there is one.
async function restoreLatestChat(path) {
  const { chats } = await (await fetch("/api/chats")).json();
  const latest = chats.find((c) => c.file === path);
  if (latest) await openChat(latest.id);
  else newChat();
}

const timeAgo = (ms) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
};

async function showHistory() {
  const { chats } = await (await fetch("/api/chats")).json();
  const onlyThisFile = historyEls.thisFile.checked && state.path;
  const shown = onlyThisFile ? chats.filter((c) => c.file === state.path) : chats;
  historyEls.list.innerHTML = shown.length ? "" : `<li class="none">${onlyThisFile ? "No earlier chats for this resume." : "No saved chats yet."}</li>`;
  for (const chat of shown) {
    const li = document.createElement("li");
    li.innerHTML = `<button class="h-open"><span class="h-title"></span><span class="h-meta"></span></button><button class="h-del" title="Delete chat">×</button>`;
    li.querySelector(".h-title").textContent = chat.title || "(untitled)";
    li.querySelector(".h-meta").textContent = `${chat.file ?? "unsaved file"} · ${chat.turns} message${chat.turns === 1 ? "" : "s"} · ${timeAgo(chat.updatedAt)}`;
    if (chat.id === state.conversationId) li.classList.add("current");
    li.querySelector(".h-open").addEventListener("click", async () => {
      historyEls.dialog.close();
      await openChat(chat.id);
    });
    li.querySelector(".h-del").addEventListener("click", async () => {
      if (!confirm(`Delete the chat “${chat.title}”? This can't be undone.`)) return;
      const res = await fetch(`/api/chats/${chat.id}`, { method: "DELETE" });
      if (!res.ok) return alert((await res.json()).error);
      if (chat.id === state.conversationId) newChat();
      showHistory();
    });
    historyEls.list.appendChild(li);
  }
  if (!historyEls.dialog.open) historyEls.dialog.showModal();
}
historyEls.btn.addEventListener("click", showHistory);
historyEls.close.addEventListener("click", () => historyEls.dialog.close());
historyEls.thisFile.addEventListener("change", showHistory);

function miniMarkdown(text) {
  const escaped = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

function addMessage(role) {
  els.messages.querySelector(".empty")?.remove();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  els.messages.appendChild(div);
  return div;
}
function scrollChat() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function send(text) {
  const message = text.trim();
  if (!message || state.streaming) return;
  if (!state.tex) {
    showOpenDialog();
    return;
  }
  state.streaming = true;
  els.sendBtn.disabled = true;
  els.input.value = "";

  const selections = state.selections.map(({ kind, label, latex, text }) => ({ kind, label, latex, ...(text ? { text } : {}) }));
  const userDiv = addMessage("user");
  if (selections.length) {
    const ctx = document.createElement("span");
    ctx.className = "ctx";
    ctx.textContent = "📎 " + state.selections.map((s) => `${KIND_NAMES[s.kind]}: ${(s.kind === "text" ? s.text : s.label).slice(0, 40)}`).join(" · ");
    userDiv.appendChild(ctx);
  }
  userDiv.appendChild(document.createTextNode(message));
  clearSelections();

  const bot = addMessage("assistant");
  const typing = document.createElement("span");
  typing.className = "typing";
  bot.appendChild(typing);
  let textSpan = null;
  let textRaw = "";
  let statusEl = null;
  scrollChat();

  const appendEvent = (cls, content, onClick) => {
    const ev = document.createElement("span");
    ev.className = `event ${cls}`;
    ev.textContent = content;
    if (onClick) ev.addEventListener("click", onClick);
    bot.insertBefore(ev, typing);
    textSpan = null;
  };

  const handlers = {
    text({ delta }) {
      statusEl?.remove();
      statusEl = null;
      if (!textSpan) {
        textSpan = document.createElement("span");
        textRaw = "";
        bot.insertBefore(textSpan, typing);
      }
      textRaw += delta;
      textSpan.innerHTML = miniMarkdown(textRaw);
    },
    edit({ tex, at, length, summary }) {
      setTex(tex);
      flashRange(at, length);
      appendEvent("", `✎ ${summary}`, () => {
        const node = flashRange(at, length);
        node?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    },
    layout({ pages, ok }) {
      appendEvent("layout", ok ? `Layout check: ${pages} page${pages === 1 ? "" : "s"}${pages === 1 ? " ✓" : ""}` : "Layout check: LaTeX errors");
    },
    status({ text }) {
      statusEl?.remove();
      statusEl = document.createElement("span");
      statusEl.className = "status";
      statusEl.textContent = text;
      bot.insertBefore(statusEl, typing);
    },
    turn() { textSpan = null; },
    error({ message }) { appendEvent("err", message); },
    done() {},
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: state.conversationId, file: state.path, tex: state.tex, message, selections }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (event && data) handlers[event]?.(JSON.parse(data));
        scrollChat();
      }
    }
  } catch (err) {
    appendEvent("err", err.message);
  } finally {
    statusEl?.remove();
    typing.remove();
    if (!bot.childNodes.length) bot.textContent = "(no reply)";
    state.streaming = false;
    els.sendBtn.disabled = false;
    scrollChat();
  }
}

els.sendBtn.addEventListener("click", () => send(els.input.value));
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(els.input.value);
  }
});
els.quick.addEventListener("click", (e) => {
  const prompt = e.target.closest("button")?.dataset.prompt;
  if (!prompt) return;
  if (!state.selections.length) {
    els.input.value = prompt;
    els.input.focus();
    return;
  }
  send(prompt);
});

// ---------- shortcuts ----------

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!state.path) saveAs();
    else if (state.tex !== state.savedTex) saveFile(state.path, true);
    return;
  }
  if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    showOpenDialog();
    return;
  }
  const typing = ["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement?.tagName);
  if (typing) return;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  } else if (e.key === "Escape") {
    clearSelections();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (state.tex !== state.savedTex) e.preventDefault();
});

// ---------- project folders ----------

const projectEls = {
  btn: document.getElementById("projectsBtn"), dialog: document.getElementById("projectsDialog"),
  list: document.getElementById("projectList"), form: document.getElementById("projectForm"),
  input: document.getElementById("projectInput"), error: document.getElementById("projectError"),
  unsupported: document.getElementById("projectUnsupported"), close: document.getElementById("projectsClose"),
};
let projects = [];

function renderProjects() {
  projectEls.btn.textContent = projects.length ? `Projects (${projects.length})` : "Projects";
  projectEls.list.innerHTML = projects.length ? "" : '<li class="none">No folders yet. Add one below.</li>';
  for (const dir of projects) {
    const li = document.createElement("li");
    li.innerHTML = '<span></span><button title="Remove">×</button>';
    li.querySelector("span").textContent = li.title = dir;
    li.querySelector("button").addEventListener("click", () => saveProjects(projects.filter((p) => p !== dir)));
    projectEls.list.appendChild(li);
  }
}
async function saveProjects(next) {
  const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projects: next }) });
  const data = await res.json();
  projectEls.error.hidden = res.ok;
  if (!res.ok) { projectEls.error.textContent = data.error; return false; }
  projects = data.projects;
  renderProjects();
  return true;
}
fetch("/api/projects").then((r) => r.json()).then((data) => {
  projects = data.projects;
  projectEls.unsupported.hidden = data.supported;
  projectEls.form.hidden = !data.supported;
  renderProjects();
});
projectEls.btn.addEventListener("click", () => { projectEls.error.hidden = true; projectEls.dialog.showModal(); projectEls.input.focus(); });
projectEls.close.addEventListener("click", () => projectEls.dialog.close());
projectEls.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const dir = projectEls.input.value.trim();
  if (dir && (await saveProjects([...projects, dir]))) projectEls.input.value = "";
});

// ---------- resizable panes ----------

const splitter = document.getElementById("splitter");
const app = document.querySelector(".app");
function setChatWidth(px) {
  const width = Math.max(280, Math.min(window.innerWidth - 360, px));
  app.style.setProperty("--chat-w", `${width}px`);
  return width;
}
const savedWidth = Number(localStorage.getItem("resumeStudio.chatWidth"));
if (savedWidth) setChatWidth(savedWidth);
splitter.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add("dragging");
  document.body.classList.add("resizing");
});
splitter.addEventListener("pointermove", (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  localStorage.setItem("resumeStudio.chatWidth", String(setChatWidth(e.clientX)));
});
splitter.addEventListener("pointerup", (e) => {
  splitter.releasePointerCapture(e.pointerId);
  splitter.classList.remove("dragging");
  document.body.classList.remove("resizing");
});
splitter.addEventListener("dblclick", () => {
  localStorage.removeItem("resumeStudio.chatWidth");
  app.style.removeProperty("--chat-w");
});

// Scale the A4 page to the space available in the resume pane.
const PAPER_PX = (210 / 25.4) * 96;
function fitPaper() {
  const available = els.previewView.clientWidth - 40;
  const zoom = Math.max(0.45, Math.min(1.35, available / PAPER_PX));
  els.paper.style.zoom = zoom.toFixed(3);
  document.querySelector(".hint").style.maxWidth = `${PAPER_PX * zoom}px`;
}
new ResizeObserver(fitPaper).observe(els.previewView);

updateButtons();
showOpenDialog();
fetch("/api/info").then((r) => r.json()).then(({ backend }) => {
  document.querySelector(".chat-sub").textContent = backend;
});
