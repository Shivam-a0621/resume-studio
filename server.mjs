// Resume Studio: live LaTeX resume editor with a Claude chat sidebar.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { latexToHtml, plain } from "./public/latex.js";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
// Optional, git-ignored local settings, e.g. { "resumeRoot": "~/resumes" }.
const localConfig = JSON.parse(await fs.readFile(path.join(here, "config.local.json"), "utf8").catch(() => "{}"));
const expandHome = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
// The folder whose .tex files the app opens. Defaults to the bundled examples.
const RESUME_ROOT = path.resolve(here, expandHome(process.env.RESUME_ROOT ?? localConfig.resumeRoot ?? "resumes"));
const PORT = Number(process.env.PORT ?? 4321);
const MODEL = process.env.RESUME_MODEL ?? "claude-opus-5-5";
const EFFORT = process.env.RESUME_EFFORT ?? "medium";
const MAX_TOOL_TURNS = 25;
// "claude-code" runs your local Claude Code CLI on its own login; "api" calls the
// Claude API with ANTHROPIC_API_KEY.
const PROVIDER = process.env.RESUME_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code");
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

const client = new Anthropic();
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "public")));

// ---------- files ----------

async function isSkippedDir(dir, name) {
  if (["node_modules", ".git", "public", "docs"].includes(name) || name.startsWith(".")) return true;
  if (path.resolve(dir) === here) return true; // the app itself, when it sits inside the resume folder
  // Python virtualenvs live next to the resumes; skip them.
  return fs.access(path.join(dir, "pyvenv.cfg")).then(() => true, () => false);
}

async function listTexFiles(dir, depth = 0) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 2 && !(await isSkippedDir(full, entry.name))) out.push(...(await listTexFiles(full, depth + 1)));
    } else if (entry.name.endsWith(".tex")) {
      const stat = await fs.stat(full);
      out.push({ path: path.relative(RESUME_ROOT, full), mtime: stat.mtimeMs });
    }
  }
  return out;
}

function resolveTexPath(relPath) {
  if (typeof relPath !== "string" || !relPath.endsWith(".tex")) throw new Error("Path must end in .tex");
  const target = path.resolve(RESUME_ROOT, relPath);
  const rel = path.relative(RESUME_ROOT, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path must stay inside the resume folder");
  return target;
}

app.get("/api/info", (_req, res) => {
  res.json({ backend: PROVIDER === "claude-code" ? "local Claude Code" : `Claude API · ${MODEL}` });
});

app.get("/api/files", async (_req, res) => {
  const files = await listTexFiles(RESUME_ROOT);
  files.sort((a, b) => b.mtime - a.mtime);
  res.json({ root: RESUME_ROOT, files });
});

app.get("/api/file", async (req, res) => {
  try {
    const tex = await fs.readFile(resolveTexPath(req.query.path), "utf8");
    res.json({ path: req.query.path, tex });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/file", async (req, res) => {
  const { path: relPath, tex, overwrite } = req.body ?? {};
  try {
    const target = resolveTexPath(relPath);
    if (typeof tex !== "string") throw new Error("Missing tex");
    if (!overwrite) {
      const exists = await fs.access(target).then(() => true, () => false);
      if (exists) return res.status(409).json({ error: `${relPath} already exists` });
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, tex, "utf8");
    res.json({ ok: true, path: relPath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Latin Modern fonts from the local TeX install, so the preview looks like the PDF.
const FONT_FILES = {
  regular: "lmroman10-regular.otf",
  bold: "lmroman10-bold.otf",
  italic: "lmroman10-italic.otf",
  bolditalic: "lmroman10-bolditalic.otf",
  caps: "lmromancaps10-regular.otf",
};
const fontPaths = {};
app.get("/fonts/:name", async (req, res) => {
  const file = FONT_FILES[req.params.name];
  if (!file) return res.sendStatus(404);
  try {
    fontPaths[file] ??= (await execFileAsync("kpsewhich", [file])).stdout.trim();
    // TinyTeX lives under ~/.TinyTeX, which sendFile skips as a dotfile by default.
    res.type("font/otf").sendFile(fontPaths[file], { dotfiles: "allow" });
  } catch {
    res.sendStatus(404);
  }
});

// ---------- project folders the assistant may read ----------

const PROJECTS_FILE = path.resolve(here, process.env.RESUME_PROJECTS_FILE ?? "projects.json");

async function loadProjects() {
  try {
    const list = JSON.parse(await fs.readFile(PROJECTS_FILE, "utf8"));
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

app.get("/api/projects", async (_req, res) => {
  res.json({ projects: await loadProjects(), supported: PROVIDER === "claude-code" });
});

app.post("/api/projects", async (req, res) => {
  const input = req.body?.projects;
  if (!Array.isArray(input)) return res.status(400).json({ error: "Expected a list of folders" });
  const projects = [];
  for (const raw of input) {
    const dir = path.resolve(String(raw).trim().replace(/^~(?=$|\/)/, os.homedir()));
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) return res.status(400).json({ error: `Not a folder: ${raw}` });
    if (dir === "/" || dir === os.homedir()) return res.status(400).json({ error: `Pick a specific project folder, not ${dir}` });
    if (!projects.includes(dir)) projects.push(dir);
  }
  await fs.writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2));
  res.json({ projects });
});

// ---------- compile ----------

async function compileTex(tex) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-studio-"));
  try {
    await fs.writeFile(path.join(dir, "resume.tex"), tex, "utf8");
    let failed = false;
    try {
      await execFileAsync(
        "pdflatex",
        ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "resume.tex"],
        { cwd: dir, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
    } catch {
      failed = true;
    }
    const log = await fs.readFile(path.join(dir, "resume.log"), "utf8").catch(() => "");
    const errors = log
      .split("\n")
      .filter((line, i, lines) => line.startsWith("!") || (i > 0 && lines[i - 1].startsWith("!")))
      .slice(0, 12)
      .join("\n");
    const overfull = (log.match(/Overfull \\hbox/g) ?? []).length;
    const pages = Number(log.match(/Output written on resume\.pdf \((\d+) page/)?.[1] ?? 0);
    const pdf = failed ? null : await fs.readFile(path.join(dir, "resume.pdf")).catch(() => null);
    return { ok: Boolean(pdf), pdf, pages, errors, overfull };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

app.post("/api/compile", async (req, res) => {
  const { tex } = req.body ?? {};
  if (typeof tex !== "string") return res.status(400).json({ error: "Missing tex" });
  const result = await compileTex(tex);
  if (!result.ok) return res.status(422).json({ error: result.errors || "pdflatex failed", pages: 0 });
  res.set({ "X-Pages": String(result.pages), "X-Overfull": String(result.overfull) });
  res.type("application/pdf").send(result.pdf);
});

// ---------- chat ----------

const TOOL_GUIDANCE = {
  api: `- You get the resume's LaTeX source. When it changes outside the chat (manual edits, undo), you get the new version.
- Make changes with the edit_resume tool. Make each call one focused replacement: one bullet, one heading, or one skill line. Several calls in one turn are fine.
- After edits that change length (new bullets, longer text, new sections), call check_layout to confirm the resume is still one page with no errors, and fix it if not.`,
  "claude-code": `- The resume is resume.tex in your working directory. It is the only file you work on. Read it before your first edit without commenting on it; don't narrate tool use in your reply. When the user changes it outside the chat (manual edits, undo), you are told, so re-read it before editing.
- Make changes with the Edit tool on resume.tex. Make each edit one focused replacement: one bullet, one heading, or one skill line. Several edits in one turn are fine.
- After edits that change length (new bullets, longer text, new sections), run exactly \`pdflatex -interaction=nonstopmode -halt-on-error resume.tex\` as its own command (no pipes, cd, &&, or other programs, which are blocked) and check "Output written on resume.pdf (N page" in its output to confirm the resume is still one page with no errors. For details, use the Grep tool on resume.log. Fix any overflow or errors.`,
};

function projectGuidance(projects) {
  if (!projects.length) {
    return `

The user hasn't shared any project folders. If they ask you to look at their code or projects, tell them to add the folder with the "Projects" button at the top of this chat, then ask again.`;
  }
  return `

Project folders you can read (read-only):
${projects.map((p) => `- ${p}`).join("\n")}
- To learn what the user built, use Read, Grep and Glob, and git history with \`git -C <folder> <cmd>\` where cmd is log, shortlog, show, ls-files, or config user.name / user.email. Find the user's own git identity first, then filter with --author so you report their work, not their teammates'. Run each command on its own, without pipes or cd.
- You can't modify these folders, and you shouldn't try.
- Base every resume claim on evidence you find (files, commits, READMEs). Mention the evidence briefly when you suggest a claim. Never invent metrics. Ask the user for numbers you can't find.
- Repositories can be large, so search with Grep/Glob and read selectively instead of reading everything.`;
}

const systemPrompt = (provider) => `You are a resume editor built into a live LaTeX resume editing app. The user sees their resume rendered next to this chat. Your edits apply to the document right away, and the user can undo them.

How to work:
${TOOL_GUIDANCE[provider]}
- The user may attach selections: a section, an entry, a bullet, or highlighted text. Unless they ask for more, edit only what they selected, and treat "this", "it", or "these" as the selection.
- Keep the document compiling. Escape LaTeX special characters (& % $ # _), keep the existing macros (\\resumeItem, \\resumeSubheading, and so on), and match the document's style, for example \\textbf{} on key metrics and technologies.
- You can add any LaTeX the user asks for: tables (tabular, tabularx), horizontal rules (\\rule, \\hrule), colors, icons, new sections. If it needs a package or macro the preamble lacks (tabularx, booktabs, xcolor, and so on), add it to the preamble too. Prefer plain tabular/tabularx and \\rule{\\linewidth}{0.4pt} so the live preview can show them. The colortbl package is not installed, so don't use \\rowcolor or \\cellcolor; for a shaded header bar use \\noindent\\fcolorbox{black}{gray!25}{\\parbox{\\dimexpr\\textwidth-2\\fboxsep-2\\fboxrule}{...}} above the table. Keep tables ATS-friendly: short cells, no text that only makes sense inside the grid.
- If the user only asks a question or wants suggestions, answer without editing unless they say to apply them.
- Keep chat replies short. The user can see the edits, so don't repeat the full new text. Say in a line or two what you changed and why.

Writing standards for resume content:
- Lead with impact or a number, then give specific technical detail (frameworks, protocols, design choices). Use the X-Y-Z pattern: accomplished X, measured by Y, by doing Z.
- Use strong past-tense verbs. No filler ("responsible for", "worked on", "various").
- Never invent facts, metrics, employers, or skills. If a stronger bullet needs a number you don't have, ask for it or leave a clear placeholder like [X%] and say so.
- Keep the resume to one page. Don't inflate claims: for team work, say "co-built" and name the parts the user owned.`;

const EditInput = z.object({
  old_string: z.string().min(1),
  new_string: z.string(),
  summary: z.string(),
});

const TOOLS = [
  {
    name: "edit_resume",
    description:
      "Replace one exact substring of the resume's LaTeX source with new text. old_string must appear exactly once in the current source, so include enough surrounding text to make it unique (for example the whole \\resumeItem{...} line). To delete text, pass an empty new_string. The change is shown to the user immediately.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        old_string: { type: "string", description: "Exact text currently in the LaTeX source, matching once." },
        new_string: { type: "string", description: "Replacement LaTeX text." },
        summary: { type: "string", description: "A few words describing the change for the UI, e.g. 'Quantified RAG bullet'." },
      },
      required: ["old_string", "new_string", "summary"],
    },
  },
  {
    name: "check_layout",
    description:
      "Compile the current resume with pdflatex and report the page count, LaTeX errors, and overfull lines. Use after edits that change length.",
    input_schema: { type: "object", properties: {} },
  },
];

// Chats are saved to chats/<id>.json so they survive restarts and can be
// reopened. Each keeps the model-side history (append-only), the resume
// source the model last saw, the Claude Code session, and a transcript for the UI.
const CHATS_DIR = path.resolve(here, process.env.RESUME_CHATS_DIR ?? "chats");
const conversations = new Map();
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const chatFile = (id) => path.join(CHATS_DIR, `${id}.json`);

async function getConversation(id, file) {
  if (conversations.has(id)) return conversations.get(id);
  const saved = await fs.readFile(chatFile(id), "utf8").then(JSON.parse, () => null);
  const convo = {
    id,
    file: saved?.file ?? file ?? null,
    title: saved?.title ?? "",
    createdAt: saved?.createdAt ?? Date.now(),
    updatedAt: saved?.updatedAt ?? Date.now(),
    provider: saved?.provider ?? PROVIDER,
    messages: saved?.messages ?? [],
    seenTex: saved?.seenTex ?? null,
    sessionId: saved?.sessionId,
    sessionStarted: saved?.sessionStarted ?? false,
    transcript: saved?.transcript ?? [],
    // A stable folder, so Claude Code can resume the session after a restart.
    workDir: path.join(CHATS_DIR, id),
    busy: false,
  };
  conversations.set(id, convo);
  return convo;
}

async function saveConversation(convo) {
  convo.updatedAt = Date.now();
  const { busy, workDir, ...data } = convo;
  await fs.mkdir(CHATS_DIR, { recursive: true });
  await fs.writeFile(chatFile(convo.id), JSON.stringify(data));
}

app.get("/api/chats", async (_req, res) => {
  const names = await fs.readdir(CHATS_DIR).catch(() => []);
  const chats = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const data = await fs.readFile(path.join(CHATS_DIR, name), "utf8").then(JSON.parse, () => null);
    if (!data?.transcript?.length) continue;
    chats.push({
      id: data.id, title: data.title, file: data.file, updatedAt: data.updatedAt,
      turns: data.transcript.filter((t) => t.role === "user").length,
    });
  }
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ chats });
});

app.get("/api/chats/:id", async (req, res) => {
  if (!CHAT_ID.test(req.params.id)) return res.status(400).json({ error: "Bad chat id" });
  const data = await fs.readFile(chatFile(req.params.id), "utf8").then(JSON.parse, () => null);
  if (!data) return res.status(404).json({ error: "Chat not found" });
  res.json({ id: data.id, title: data.title, file: data.file, updatedAt: data.updatedAt, transcript: data.transcript });
});

app.delete("/api/chats/:id", async (req, res) => {
  const id = req.params.id;
  if (!CHAT_ID.test(id)) return res.status(400).json({ error: "Bad chat id" });
  if (conversations.get(id)?.busy) return res.status(409).json({ error: "That chat is replying right now" });
  conversations.delete(id);
  await fs.rm(chatFile(id), { force: true });
  await fs.rm(path.join(CHATS_DIR, id), { recursive: true, force: true });
  res.json({ ok: true });
});

function countOccurrences(haystack, needle) {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

function buildUserContent(convo, tex, selections, message, { inline = true } = {}) {
  const parts = [];
  if (!inline) {
    if (convo.seenTex !== null && convo.seenTex !== tex) {
      parts.push("The user changed resume.tex outside this chat (manual edit or undo). Re-read it before editing.");
    }
  } else if (convo.seenTex === null) {
    parts.push(`Current resume (LaTeX source):\n<resume>\n${tex}\n</resume>`);
  } else if (convo.seenTex !== tex) {
    parts.push(`The resume was changed outside this chat (manual edit or undo). Current source:\n<resume>\n${tex}\n</resume>`);
  }
  if (selections.length) {
    const rendered = selections.map((s, i) => {
      const lines = [`<selection index="${i + 1}" kind="${s.kind}" label="${s.label.replaceAll('"', "'")}">`];
      lines.push(`<latex>\n${s.latex}\n</latex>`);
      if (s.text) lines.push(`<highlighted_text>${s.text}</highlighted_text>`);
      lines.push("</selection>");
      return lines.join("\n");
    });
    parts.push(`The user selected these parts of the resume:\n${rendered.join("\n")}`);
  }
  parts.push(message);
  return parts.join("\n\n");
}

const ChatBody = z.object({
  conversationId: z.string().regex(CHAT_ID),
  file: z.string().nullable().optional(),
  tex: z.string(),
  message: z.string().min(1),
  selections: z
    .array(z.object({ kind: z.string(), label: z.string(), latex: z.string(), text: z.string().optional() }))
    .default([]),
});

app.post("/api/chat", async (req, res) => {
  const parsedBody = ChatBody.safeParse(req.body);
  if (!parsedBody.success) return res.status(400).json({ error: "Bad request" });
  const { conversationId, tex, message, selections, file } = parsedBody.data;

  const convo = await getConversation(conversationId, file);
  if (convo.busy) return res.status(409).json({ error: "A reply is already in progress" });
  if (convo.provider !== PROVIDER) {
    return res.status(409).json({ error: "This chat was started with a different AI backend. Start a new chat." });
  }
  convo.busy = true;
  if (file) convo.file = file;
  if (!convo.title) convo.title = message.replace(/\s+/g, " ").slice(0, 80);

  // Record what the user sees, so the chat can be reopened later.
  convo.transcript.push({ role: "user", text: message, ctx: selections.map(({ kind, label, text }) => ({ kind, label, text })), at: Date.now() });
  const reply = { role: "assistant", parts: [], at: Date.now() };
  convo.transcript.push(reply);
  const record = (event, data) => {
    const last = reply.parts.at(-1);
    if (event === "text") {
      if (last?.type === "text") last.text += data.delta;
      else reply.parts.push({ type: "text", text: data.delta });
    } else if (event === "edit") reply.parts.push({ type: "edit", summary: data.summary });
    else if (event === "layout") reply.parts.push({ type: "layout", pages: data.pages, ok: data.ok });
    else if (event === "error") reply.parts.push({ type: "error", message: data.message });
    else if (event === "turn" && last?.type === "text") reply.parts.push({ type: "break" });
    else if (event === "done") {
      if (!reply.parts.length) reply.parts.push({ type: "text", text: "(no reply)" });
      return saveConversation(convo).catch((err) => console.error("Couldn't save chat:", err.message));
    }
  };

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event, data) => {
    record(event, data);
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  if (PROVIDER === "claude-code") {
    try {
      await runClaudeCodeTurn({ convo, tex, selections, message, send, signal: abort.signal });
    } catch (err) {
      if (!abort.signal.aborted) send("error", { message: err.message });
    } finally {
      convo.busy = false;
      send("done", {});
      res.end();
    }
    return;
  }

  // On failure, roll history back so it never ends on an unanswered tool call.
  const historyLength = convo.messages.length;
  const messages = convo.messages;
  messages.push({ role: "user", content: buildUserContent(convo, tex, selections, message) });
  let working = tex;
  let completed = false;
  let jsonRetries = 0;

  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 64000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: EFFORT },
          cache_control: { type: "ephemeral" },
          system: systemPrompt("api"),
          tools: TOOLS,
          messages,
        },
        { signal: abort.signal },
      );
      stream.on("text", (delta) => send("text", { delta }));

      let response;
      try {
        response = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // Retry only an unparseable streamed tool input. The SDK reports it as a
        // plain AnthropicError with this message; every other error propagates.
        const badToolJson = !(err instanceof Anthropic.APIError) && err?.message?.startsWith("Unable to parse tool parameter JSON");
        if (!badToolJson || abort.signal.aborted || jsonRetries++ >= 2) throw err;
        send("status", { text: "Retrying a malformed tool call…" });
        continue;
      }

      if (response.stop_reason === "refusal") {
        send("error", { message: "The model declined this request." });
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (toolUses.length === 0) {
        completed = true;
        break;
      }
      if (response.stop_reason === "max_tokens") throw new Error("The reply was cut off mid-edit. Try a smaller request.");

      const results = [];
      for (const tool of toolUses) {
        if (tool.name === "edit_resume") {
          const input = EditInput.safeParse(tool.input);
          if (!input.success) {
            results.push({ type: "tool_result", tool_use_id: tool.id, is_error: true, content: "Invalid input: need old_string, new_string, summary." });
            continue;
          }
          const { old_string, new_string, summary } = input.data;
          const count = countOccurrences(working, old_string);
          if (count !== 1) {
            const why = count === 0 ? "old_string was not found in the current source" : `old_string matches ${count} times; include more surrounding text`;
            results.push({ type: "tool_result", tool_use_id: tool.id, is_error: true, content: why });
            continue;
          }
          const at = working.indexOf(old_string);
          working = working.slice(0, at) + new_string + working.slice(at + old_string.length);
          send("edit", { tex: working, at, length: new_string.length, summary });
          results.push({ type: "tool_result", tool_use_id: tool.id, content: "Applied." });
        } else if (tool.name === "check_layout") {
          send("status", { text: "Checking layout…" });
          const result = await compileTex(working);
          send("layout", { pages: result.pages, ok: result.ok });
          const report = result.ok
            ? `Compiled: ${result.pages} page(s), ${result.overfull} overfull line warning(s).`
            : `Compile failed:\n${result.errors}`;
          results.push({ type: "tool_result", tool_use_id: tool.id, content: report, is_error: !result.ok });
        } else {
          results.push({ type: "tool_result", tool_use_id: tool.id, is_error: true, content: `Unknown tool ${tool.name}` });
        }
      }
      messages.push({ role: "user", content: results });
      send("turn", {});
    }
    if (completed) convo.seenTex = working;
    else messages.length = historyLength;
  } catch (err) {
    messages.length = historyLength;
    if (!abort.signal.aborted) {
      let text = err.message;
      if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(text)) {
        text = "No valid Claude API key. Set ANTHROPIC_API_KEY, then restart the server.";
      }
      else if (err instanceof Anthropic.RateLimitError) text = "Rate limited. Wait a moment and retry.";
      else if (err instanceof Anthropic.APIConnectionError) text = "Couldn't reach the Claude API. Check your connection.";
      send("error", { message: text });
    }
  } finally {
    convo.busy = false;
    send("done", {});
    res.end();
  }
});

// ---------- local Claude Code backend ----------

// Smallest changed span between two versions, for highlighting in the preview.
function changedSpan(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { at: start, length: after.length - start - end };
}

// A readable one-line summary of an Edit for the chat.
function describeEdit(oldText, newText) {
  const text = (latex) => { try { return plain(latexToHtml(latex)); } catch { return ""; } };
  const before = text(oldText);
  const after = text(newText);
  const shorten = (t) => (t.length > 60 ? `${t.slice(0, 60)}…` : t);
  if (/\\begin\{(tabular|tabularx)/.test(newText) && !/\\begin\{(tabular|tabularx)/.test(oldText)) return "Added a table";
  if (/\\(rule|hrule)\b/.test(newText) && !/\\(rule|hrule)\b/.test(oldText)) return "Added a horizontal line";
  if (/\\section\{/.test(newText) && (newText.match(/\\section\{/g).length > (oldText.match(/\\section\{/g) ?? []).length)) {
    return `Added section: ${newText.match(/\\section\{([^}]*)\}/)[1]}`;
  }
  if (!newText.trim()) return `Removed: ${shorten(before) || "content"}`;
  if (before === after) return "Adjusted layout/formatting";
  // Spacing, margins and lengths have no real words in them.
  const words = (after.match(/[A-Za-z]{3,}/g) ?? []).filter((w) => !/^(top|bottom|left|right|margin|pt|cm|mm|fill)$/i.test(w));
  if (!words.length) return "Adjusted layout/formatting";
  return `Edited: ${shorten(after || before)}`;
}

const TOOL_STATUS = { Read: "Reading the resume…", Edit: "Editing…", Bash: "Checking layout…" };

async function runClaudeCodeTurn({ convo, tex, selections, message, send, signal }) {
  await fs.mkdir(convo.workDir, { recursive: true });
  convo.sessionId ??= crypto.randomUUID();
  const file = path.join(convo.workDir, "resume.tex");
  await fs.writeFile(file, tex, "utf8");

  const prompt = buildUserContent(convo, tex, selections, message, { inline: false });
  const projects = await loadProjects();
  const args = [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--system-prompt", systemPrompt("claude-code") + projectGuidance(projects),
    "--tools", "Read,Grep,Glob,Edit,Bash",
    // dontAsk denies anything not listed here: the resume is the only writable
    // file, and project folders are readable (plus git history) but never editable.
    "--allowedTools", "Read(./**)", "Edit(./resume.tex)", "Bash(pdflatex:*)",
    ...projects.flatMap((dir) => [
      `Read(/${dir}/**)`,
      ...["log", "shortlog", "show", "ls-files", "config user.name", "config user.email"].map((cmd) => `Bash(git -C ${dir} ${cmd}:*)`),
    ]),
    ...projects.flatMap((dir) => ["--add-dir", dir]),
    "--permission-mode", "dontAsk",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--effort", EFFORT,
    ...(process.env.RESUME_MODEL ? ["--model", process.env.RESUME_MODEL] : []),
    ...(convo.sessionStarted ? ["--resume", convo.sessionId] : ["--session-id", convo.sessionId]),
  ];

  const child = spawn(CLAUDE_BIN, args, { cwd: convo.workDir, stdio: ["ignore", "pipe", "pipe"] });
  const onAbort = () => child.kill("SIGTERM");
  signal.addEventListener("abort", onAbort);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve, reject) => {
    child.on("error", (err) =>
      reject(err.code === "ENOENT" ? new Error(`Couldn't find the "${CLAUDE_BIN}" command. Install Claude Code or set CLAUDE_BIN.`) : err));
    child.on("close", resolve);
  });

  let lastTex = tex;
  const tools = new Map(); // tool_use_id -> { name, input }
  let succeeded = false;
  let failure = null;

  const emitFileChange = async (summary) => {
    const current = await fs.readFile(file, "utf8").catch(() => lastTex);
    if (current === lastTex) return;
    const { at, length } = changedSpan(lastTex, current);
    lastTex = current;
    send("edit", { tex: current, at, length, summary });
  };

  const lines = readline.createInterface({ input: child.stdout });
  for await (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.type === "system" && msg.subtype === "init") convo.sessionStarted = true;
    else if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "message_start") send("turn", {});
      else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") send("text", { delta: ev.delta.text });
      else if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
        send("status", { text: TOOL_STATUS[ev.content_block.name] ?? "Working…" });
      }
    } else if (msg.type === "assistant") {
      for (const block of msg.message.content) if (block.type === "tool_use") tools.set(block.id, block);
    } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const result of msg.message.content) {
        if (result.type !== "tool_result") continue;
        const tool = tools.get(result.tool_use_id);
        const output = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        if (tool?.name === "Edit" || tool?.name === "Write") {
          await emitFileChange(describeEdit(tool.input?.old_string ?? "", tool.input?.new_string ?? ""));
        } else if (tool?.name === "Bash" && /pdflatex/.test(tool.input?.command ?? "")) {
          const pages = Number(output.match(/Output written on resume\.pdf \((\d+) page/)?.[1] ?? 0);
          send("layout", { pages, ok: pages > 0 });
        }
      }
    } else if (msg.type === "result") {
      succeeded = msg.subtype === "success" && !msg.is_error;
      if (!succeeded) failure = msg.result || msg.errors?.join("\n") || `Claude Code stopped (${msg.subtype}).`;
    }
  }

  const code = await exited;
  signal.removeEventListener("abort", onAbort);
  await emitFileChange("Edited resume");
  if (signal.aborted) return;
  if (succeeded) {
    convo.seenTex = lastTex;
    return;
  }
  const detail = failure ?? (stderr.trim().split("\n").slice(-5).join("\n") || `claude exited with code ${code}`);
  const hint = /log ?in|auth|credential/i.test(detail) ? " Run `claude` in a terminal once to log in." : "";
  throw new Error(detail + hint);
}


app.listen(PORT, "127.0.0.1", () => {
  console.log(`Resume Studio running at http://localhost:${PORT}`);
  console.log(`Resume folder: ${RESUME_ROOT}`);
  console.log(PROVIDER === "claude-code"
    ? "AI backend: local Claude Code CLI (uses your Claude Code login)"
    : `AI backend: Claude API (${MODEL})`);
});
