// Parses a resume written with the common \resumeSubheading / \resumeItem macros
// into HTML. Every clickable piece records its [start, end) offsets in the
// LaTeX source so selections in the preview map back to exact source text.
// Anything else in a section (tables, rules, paragraphs) renders as a
// selectable block.

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Blank out comments while keeping offsets stable.
function maskComments(src) {
  return src.replace(/(^|[^\\])(%[^\n]*)/g, (_m, pre, comment) => pre + " ".repeat(comment.length));
}

// Reads a balanced {...} group starting at or after i (skipping whitespace).
function readGroup(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { start: i + 1, end: j, next: j + 1 };
  }
  return null;
}

// Splits at a top-level separator ("&" or "\\"), ignoring braces and escapes.
function splitTop(src, sep) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let j = 0; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      if (sep === "\\\\" && src[j + 1] === "\\" && depth === 0) {
        parts.push(src.slice(last, j));
        j += 2;
        while (/\s/.test(src[j] ?? "")) j++;
        if (src[j] === "[") j = src.indexOf("]", j); // \\[2pt]
        else j--;
        last = j + 1;
        continue;
      }
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (sep === "&" && c === "&" && depth === 0) {
      parts.push(src.slice(last, j));
      last = j + 1;
    }
  }
  parts.push(src.slice(last));
  return parts;
}

// Index just past the \\end{env} that closes a \\begin{env} whose name ends before `from`.
function findMatchingEnd(src, env, from) {
  const beginTag = `\\begin{${env}}`;
  const endTag = `\\end{${env}}`;
  let depth = 1;
  let j = from;
  while (depth > 0) {
    const nextEnd = src.indexOf(endTag, j);
    if (nextEnd < 0) return src.length;
    const nextBegin = src.indexOf(beginTag, j);
    if (nextBegin >= 0 && nextBegin < nextEnd) { depth++; j = nextBegin + beginTag.length; continue; }
    depth--;
    j = nextEnd + endTag.length;
  }
  return j;
}

// Macros and environments the document defines itself, filled in by parseResume.
// The structured resume macros are rendered by parseResume, not expanded.
let userMacros = {};
let userEnvs = {};
let expandDepth = 0;
const isStructural = (name) => name.startsWith("resume");

function readOptAt(src, j) {
  while (/\s/.test(src[j] ?? "")) j++;
  if (src[j] !== "[") return null;
  const close = src.indexOf("]", j);
  return close < 0 ? null : { value: src.slice(j + 1, close), next: close + 1 };
}

function parseDefinitions(src) {
  userMacros = {};
  userEnvs = {};
  const defRe = /\\(re)?newcommand\*?|\\providecommand\*?|\\(re)?newenvironment\*?|\\def(?=\\)/g;
  for (const m of src.matchAll(defRe)) {
    let j = m.index + m[0].length;
    try {
      if (m[0].includes("environment")) {
        const name = readGroup(src, j);
        j = name.next;
        const n = readOptAt(src, j); if (n) j = n.next;
        const d = readOptAt(src, j); if (d) j = d.next;
        const begin = readGroup(src, j);
        const end = begin && readGroup(src, begin.next);
        if (!end) continue;
        userEnvs[src.slice(name.start, name.end).trim()] = {
          n: n ? Number(n.value) : 0, def: d?.value,
          begin: normalizeEnvCode(src.slice(begin.start, begin.end)),
          end: normalizeEnvCode(src.slice(end.start, end.end)),
        };
        continue;
      }
      let name;
      while (/\s/.test(src[j] ?? "")) j++;
      if (src[j] === "{") { const g = readGroup(src, j); name = src.slice(g.start, g.end).trim(); j = g.next; }
      else { const nm = /^\\[A-Za-z@]+/.exec(src.slice(j)); if (!nm) continue; name = nm[0]; j += nm[0].length; }
      let n = 0;
      let def;
      if (m[0] === "\\def") {
        const params = /^(#\d)*/.exec(src.slice(j))[0];
        n = params.length / 2;
        j += params.length;
      } else {
        const no = readOptAt(src, j); if (no) { n = Number(no.value) || 0; j = no.next; }
        const d = readOptAt(src, j); if (d) { def = d.value; j = d.next; }
      }
      const body = readGroup(src, j);
      if (!body) continue;
      const key = name.replace(/^\\/, "");
      if (!isStructural(key)) userMacros[key] = { n, def, body: src.slice(body.start, body.end) };
    } catch {
      // Skip a definition we can't read; the PDF still renders it.
    }
  }
}

// Environment definitions often use the primitive form \\tabularx{..}{..} ... \\endtabularx.
function normalizeEnvCode(code) {
  return code
    .replace(/\\end(tabularx|tabulary|tabular\*?)(?![A-Za-z])/g, "\\end{$1}")
    .replace(/\\(tabularx|tabulary|tabular\*?)(?![A-Za-z])/g, "\\begin{$1}");
}

// Expands the document's own macros as text. Tables need this before splitting
// rows, because a row macro like \\expRow{a}{b} hides its "&" and "\\\\" inside.
function expandText(str) {
  const names = Object.keys(userMacros).filter((k) => /^[A-Za-z]+$/.test(k));
  if (!names.length) return str;
  const re = new RegExp(String.raw`\\(${names.join("|")})(?![A-Za-z])`, "g");
  let out = str;
  let guard = 0;
  for (let m; (m = re.exec(out)) && guard++ < 500; ) {
    const def = userMacros[m[1]];
    let pos = re.lastIndex;
    const args = [];
    let k = 0;
    if (def.def !== undefined) {
      const opt = readOptAt(out, pos);
      if (opt) { args.push(opt.value); pos = opt.next; } else args.push(def.def);
      k = 1;
    }
    for (; k < def.n; k++) {
      const g = readGroup(out, pos);
      if (!g) break;
      args.push(out.slice(g.start, g.end));
      pos = g.next;
    }
    out = out.slice(0, m.index) + substitute(def.body, args) + out.slice(pos);
    re.lastIndex = m.index; // rescan the replacement for nested macros
  }
  return out;
}

const substitute = (body, args) =>
  body.replace(/##/g, "\u0000").replace(/#(\d)/g, (_m, k) => args[k - 1] ?? "").replace(/\u0000/g, "#");

// Colors from \definecolor in the preamble, filled in by parseResume.
let definedColors = {};
function cssColor(name) {
  const [base, pct, other] = name.trim().split("!");
  const one = (n) => definedColors[n] ?? n.replace(/[^a-zA-Z#0-9]/g, "");
  if (pct === undefined || isNaN(Number(pct))) return one(base);
  return `color-mix(in srgb, ${one(base)} ${Number(pct)}%, ${other ? one(other) : "white"})`;
}
function cssLength(len) {
  const s = len.trim();
  const rel = /^([\d.]*)\s*\\(linewidth|textwidth|columnwidth|hsize)$/.exec(s);
  if (rel) return `${(rel[1] ? Number(rel[1]) : 1) * 100}%`;
  const abs = /^(-?[\d.]+)\s*(pt|cm|mm|in|em|ex|bp|pc)$/.exec(s);
  if (abs) return `${abs[1]}${abs[2] === "bp" ? "pt" : abs[2] === "pc" ? "pc" : abs[2]}`;
  return null;
}

// Parses a column spec like "|l|c|p{3cm}X" into [{ align, borderLeft, borderRight }].
function parseColSpec(spec) {
  const cols = [];
  let leadingBar = false;
  let prefix = "";
  for (let j = 0; j < spec.length; j++) {
    const c = spec[j];
    if (c === "|") {
      if (cols.length) cols.at(-1).borderRight = true;
      else leadingBar = true;
      continue;
    }
    if (c === "@" || c === ">" || c === "<" || c === "!") {
      const g = readGroup(spec, j + 1);
      if (!g) continue;
      const inner = spec.slice(g.start, g.end);
      if (c === ">") prefix = inner; // applied to the next column's cells
      if ((c === "@" || c === "!") && /\\vrule/.test(inner) && cols.length) {
        cols.at(-1).borderRight = true;
        const color = /\\color\{([^}]*)\}/.exec(inner);
        if (color) cols.at(-1).borderColor = cssColor(color[1]);
      }
      j = g.end;
      continue;
    }
    if (c === "*") {
      const n = readGroup(spec, j + 1);
      const inner = n && readGroup(spec, n.next);
      if (n && inner) {
        const repeated = spec.slice(inner.start, inner.end).repeat(Number(spec.slice(n.start, n.end)) || 1);
        spec = spec.slice(0, j) + repeated + spec.slice(inner.next);
        j--;
      }
      continue;
    }
    const align = { l: "left", c: "center", r: "right", p: "left", m: "left", b: "left", X: "left" }[c];
    if (!align) continue;
    const col = { align, borderLeft: cols.length === 0 && leadingBar, prefix, flex: c === "X" };
    prefix = "";
    if ("pmb".includes(c)) {
      const g = readGroup(spec, j + 1);
      if (g) { col.width = cssLength(spec.slice(g.start, g.end)); j = g.end; }
    }
    cols.push(col);
  }
  return cols;
}

const RULE_RE = /^\s*\\(hline|toprule|midrule|bottomrule|specialrule\{[^}]*\}\{[^}]*\}\{[^}]*\}|cline\{[^}]*\}|cmidrule(?:\([^)]*\))?\{[^}]*\})/;

function tableHtml(spec, body, width) {
  const cols = parseColSpec(spec);
  const rows = [];
  let ruleAbove = false;
  for (let raw of splitTop(expandText(body), "\\\\")) {
    let rowId = null;
    const mark = /\\studiomark\{([^}]*)\}/.exec(raw);
    if (mark) { rowId = mark[1]; raw = raw.replace(mark[0], ""); }
    let m;
    while ((m = RULE_RE.exec(raw))) {
      ruleAbove = true;
      raw = raw.slice(m[0].length);
    }
    raw = raw.replace(/\\(addlinespace|noalign)(\[[^\]]*\])?(\{[^}]*\})?/g, "");
    let rowColor = null;
    const rc = /^\s*\\rowcolor(\[[^\]]*\])?\{([^}]*)\}/.exec(raw);
    if (rc) { rowColor = cssColor(rc[2]); raw = raw.slice(rc[0].length); }
    if (!raw.trim()) {
      if (ruleAbove && rows.length) rows.at(-1).ruleBelow = true;
      ruleAbove = false;
      continue;
    }
    rows.push({ cells: splitTop(raw, "&"), ruleAbove, ruleBelow: false, rowColor, rowId });
    ruleAbove = false;
  }

  // With a set width, fixed layout keeps label columns aligned across separate one-row tables.
  const fixed = width && cols.length && cols.every((c) => c.width || c.flex);
  let html = `<table class="r-table"${width ? ` style="width:${width}${fixed ? ";table-layout:fixed" : ""}"` : ""}>`;
  for (const row of rows) {
    const cls = [row.ruleAbove && "rule-above", row.ruleBelow && "rule-below"].filter(Boolean).join(" ");
    const rowAttrs = row.rowId ? ` data-id="${row.rowId}" data-select="${row.rowId}"` : "";
    html += `<tr${cls ? ` class="${cls}"` : ""}${rowAttrs}${row.rowColor ? ` style="background:${esc(row.rowColor)}"` : ""}>`;
    let col = 0;
    for (const cellSrc of row.cells) {
      let content = cellSrc.trim();
      let span = 1;
      let align = cols[col]?.align ?? "left";
      const mc = /^\\multicolumn\s*/.exec(content);
      if (mc) {
        const n = readGroup(content, mc[0].length);
        const a = n && readGroup(content, n.next);
        const c = a && readGroup(content, a.next);
        if (c) {
          span = Number(content.slice(n.start, n.end)) || 1;
          align = parseColSpec(content.slice(a.start, a.end))[0]?.align ?? align;
          content = content.slice(c.start, c.end);
        }
      }
      const def = cols[col] ?? {};
      const styles = [`text-align:${align}`];
      const cc = /\\cellcolor(\[[^\]]*\])?\{([^}]*)\}/.exec(content);
      if (cc) { styles.push(`background:${esc(cssColor(cc[2]))}`); content = content.replace(cc[0], ""); }
      const mr = /^\\multirow\s*\{[^}]*\}\s*\{[^}]*\}\s*/.exec(content);
      if (mr) { const g = readGroup(content, mr[0].length); if (g) content = content.slice(g.start, g.end); }
      if (def.width) styles.push(`width:${def.width}`);
      else if (width && !def.flex && span === 1) styles.push("width:1%;white-space:nowrap");
      if (def.borderLeft) styles.push("border-left:0.6px solid #000");
      const last = cols[col + span - 1] ?? {};
      if (last.borderRight) styles.push(`border-right:0.8px solid ${last.borderColor ?? "#000"}`);
      if (def.prefix && span === 1) content = `{${def.prefix} ${content}}`;
      html += `<td${span > 1 ? ` colspan="${span}"` : ""} style="${styles.join(";")}">${latexToHtml(content)}</td>`;
      col += span;
    }
    html += "</tr>";
  }
  return html + "</table>";
}

const TABLE_ENVS = new Set(["tabular", "tabular*", "tabularx", "tabulary", "array", "longtable"]);
const ICONS = { faPhone: "☎", faEnvelope: "✉", faMobile: "☎", faMapMarker: "⌖", faGlobe: "◎" };
const SWITCHES = {
  Large: "sz-Large", LARGE: "sz-LARGE", large: "sz-large", huge: "sz-huge", Huge: "sz-huge",
  small: "sz-small", footnotesize: "sz-footnote", scriptsize: "sz-footnote", normalsize: "",
  bfseries: "bf", itshape: "it", scshape: "sc", centering: "center-block", raggedleft: "right-block",
};
const WRAPS = { textbf: "strong", textit: "em", emph: "em", underline: "u", texttt: "code" };
const SYMBOLS = { "&": "&amp;", "%": "%", $: "$", "#": "#", _: "_", "{": "{", "}": "}", " ": " ", ",": "&thinsp;" };
const DROP_WITH_ARG = new Set(["vspace", "hspace", "vspace*", "hspace*", "end", "label", "addlinespace", "pagestyle", "thispagestyle"]);
// Settings and definitions that take two arguments and print nothing.
const DROP_TWO_ARGS = new Set(["setlength", "addtolength", "renewcommand", "newcommand", "providecommand", "definecolor", "setcounter", "titlespacing", "titlespacing*"]);
const RULES = new Set(["hrule", "hline", "titlerule", "toprule", "midrule", "bottomrule", "rule*"]);

export function latexToHtml(src) {
  let i = 0;
  const opens = [];

  function skipSpace() { while (/\s/.test(src[i] ?? "")) i++; }
  function skipOpt() {
    skipSpace();
    if (src[i] === "[") { const j = src.indexOf("]", i); i = j < 0 ? src.length : j + 1; return true; }
    return false;
  }
  function rawGroup() {
    const g = readGroup(src, i);
    if (!g) return "";
    i = g.next;
    return src.slice(g.start, g.end);
  }
  function htmlGroup() {
    skipSpace();
    if (src[i] !== "{") return "";
    i++;
    return parseUntil("}");
  }
  function macroArgs(n, def) {
    const args = [];
    let k = 0;
    if (def !== undefined) {
      const opt = readOptAt(src, i);
      if (opt) { args.push(opt.value); i = opt.next; } else args.push(def);
      k = 1;
    }
    for (; k < n; k++) {
      skipSpace();
      if (src[i] === "{") args.push(rawGroup());
      else {
        const tok = /^\\([A-Za-z]+|.)|^./s.exec(src.slice(i))?.[0] ?? "";
        args.push(tok);
        i += tok.length;
      }
    }
    return args;
  }
  function expand(latex) {
    if (expandDepth > 25) return "";
    expandDepth++;
    try { return latexToHtml(latex); } finally { expandDepth--; }
  }
  function findEnvEnd(env) {
    const beginTag = `\\begin{${env}}`;
    const endTag = `\\end{${env}}`;
    let depth = 1;
    let j = i;
    while (depth > 0) {
      const nextEnd = src.indexOf(endTag, j);
      if (nextEnd < 0) return { endIdx: src.length, after: src.length };
      const nextBegin = src.indexOf(beginTag, j);
      if (nextBegin >= 0 && nextBegin < nextEnd) { depth++; j = nextBegin + beginTag.length; continue; }
      depth--;
      j = nextEnd + endTag.length;
      if (depth === 0) return { endIdx: nextEnd, after: j };
    }
    return { endIdx: src.length, after: src.length };
  }
  function openSpan(cls, style = "") {
    opens[opens.length - 1]++;
    return `<span${cls ? ` class="${cls}"` : ""}${style ? ` style="${style}"` : ""}>`;
  }
  function environment() {
    const env = rawGroup();
    const user = userEnvs[env];
    if (user) {
      const args = macroArgs(user.n, user.def);
      const { endIdx, after } = findEnvEnd(env);
      const body = src.slice(i, endIdx);
      i = after;
      return expand(`{${substitute(user.begin, args)}${body}${user.end}}`);
    }
    if (env === "itemize" || env === "enumerate") {
      skipOpt();
      const { endIdx, after } = findEnvEnd(env);
      const body = src.slice(i, endIdx);
      i = after;
      const items = body.split(/\\item(?![A-Za-z])/).slice(1).map((it) => `<li>${expand(it.replace(/^\s*\[[^\]]*\]/, ""))}</li>`);
      const tag = env === "enumerate" ? "ol" : "ul";
      return `<${tag} class="r-list ${env === "enumerate" ? "numbered" : "bullet"} in-cell">${items.join("")}</${tag}>`;
    }
    if (!TABLE_ENVS.has(env)) {
      skipOpt();
      return "";
    }
    const width = env === "tabular*" || env === "tabularx" || env === "tabulary" ? cssLength(rawGroup()) : null;
    skipOpt();
    const spec = rawGroup();
    const { endIdx, after } = findEnvEnd(env);
    const body = src.slice(i, endIdx);
    i = after;
    return tableHtml(spec, body, width);
  }
  function command() {
    i++; // backslash
    const c = src[i];
    if (c === "\\") {
      i++;
      if (src[i] === "[") i = src.indexOf("]", i) + 1 || src.length;
      return "<br>";
    }
    if (c in SYMBOLS) { i++; return SYMBOLS[c]; }
    const m = /^[A-Za-z]+\*?/.exec(src.slice(i));
    if (!m) { i++; return ""; }
    const name = m[0];
    i += name.length;
    const macro = userMacros[name];
    if (macro) return expand(`{${substitute(macro.body, macroArgs(macro.n, macro.def))}}`);
    if (WRAPS[name]) return `<${WRAPS[name]}>${htmlGroup()}</${WRAPS[name]}>`;
    if (name === "textsc") return `<span class="sc">${htmlGroup()}</span>`;
    if (name === "href") {
      const url = rawGroup();
      return `<a href="${esc(url)}" target="_blank" rel="noopener">${htmlGroup()}</a>`;
    }
    if (name === "url") { const url = rawGroup(); return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`; }
    if (name === "begin") return environment();
    if (name === "textcolor") { skipOpt(); const color = cssColor(rawGroup()); return `<span style="color:${esc(color)}">${htmlGroup()}</span>`; }
    if (name === "color") { skipOpt(); return openSpan("", `color:${esc(cssColor(rawGroup()))}`); }
    if (name === "colorbox" || name === "fcolorbox") {
      skipOpt();
      const frame = name === "fcolorbox" ? cssColor(rawGroup()) : null;
      const bg = cssColor(rawGroup());
      const border = frame ? `;border:0.6px solid ${esc(frame)}` : "";
      return `<span class="cbox" style="background:${esc(bg)}${border}">${htmlGroup()}</span>`;
    }
    if (name === "studiomark") return `<span data-row="${esc(rawGroup())}"></span>`;
    if (name === "parbox") {
      skipOpt(); skipOpt(); skipOpt();
      const width = cssLength(rawGroup()) ?? "100%";
      return `<span class="parbox" style="width:${width}">${htmlGroup()}</span>`;
    }
    if (RULES.has(name)) return '<hr class="r-rule">';
    if (name === "rule") {
      skipOpt();
      const width = cssLength(rawGroup()) ?? "100%";
      const height = cssLength(rawGroup()) ?? "0.4pt";
      if (width.endsWith("%")) return `<hr class="r-rule" style="width:${width};border-top-width:${height}">`;
      return `<span class="r-rulebox" style="width:${width};height:${height}"></span>`;
    }
    if (name === "hrulefill") return '<span class="hrulefill"></span>';
    if (name === "dotfill") return '<span class="dotfill"></span>';
    if (name === "cmidrule" || name === "cline") { if (src[i] === "(") i = src.indexOf(")", i) + 1; rawGroup(); return ""; }
    if (name in SWITCHES) {
      while (src[i] === " ") i++;
      if (!SWITCHES[name]) return "";
      return openSpan(SWITCHES[name]);
    }
    if (name.startsWith("fa")) { while (src[i] === " ") i++; return ICONS[name] ? `<span class="icon">${ICONS[name]}</span>` : ""; }
    if (DROP_WITH_ARG.has(name)) {
      rawGroup();
      return "";
    }
    if (name === "newenvironment" || name === "renewenvironment") {
      rawGroup(); skipOpt(); skipOpt(); rawGroup(); rawGroup();
      return "";
    }
    if (name === "def") {
      const nm = /^\s*\\[A-Za-z@]+(#\d)*/.exec(src.slice(i));
      if (nm) i += nm[0].length;
      rawGroup();
      return "";
    }
    if (DROP_TWO_ARGS.has(name)) {
      skipSpace();
      if (src[i] === "\\") { i++; while (/[A-Za-z@]/.test(src[i] ?? "")) i++; } else rawGroup(); // \setlength\tabcolsep{..}
      skipOpt();
      skipOpt();
      rawGroup();
      if (name === "definecolor") rawGroup();
      return "";
    }
    while (src[i] === " ") i++;
    switch (name) {
      case "quad": return "&emsp;";
      case "qquad": return "&emsp;&emsp;";
      case "hfill": return '<span class="hfill"></span>';
      case "textbar": return "|";
      case "ldots": case "dots": return "…";
      case "textbullet": return "•";
      case "arrayrulecolor": rawGroup(); return "";
      case "LaTeX": return "LaTeX";
      case "item": return "";
      case "newline": case "linebreak": return "<br>";
      case "par": return "<br>";
    }
    if (src[i] === "=") {
      const assign = /^=\s*-?[\d.]+\s*(pt|cm|mm|em|ex|in)?/.exec(src.slice(i));
      if (assign) i += assign[0].length;
      return "";
    }
    return src[i] === "{" ? htmlGroup() : "";
  }
  function math(s) {
    return s
      .replace(/\\(cdot|times|sim|approx|le|ge|pm|rightarrow|to|bullet)\b/g, (_m, n) =>
        ({ cdot: "·", times: "×", sim: "~", approx: "≈", le: "≤", ge: "≥", pm: "±", rightarrow: "→", to: "→", bullet: "•" })[n])
      .replace(/\^\{?([^}]*)\}?/g, "<sup>$1</sup>")
      .replace(/\\%/g, "%")
      .replace(/\b([A-Za-z])\b/g, "<i>$1</i>")
      .replace(/[{}]/g, "");
  }
  function parseUntil(stop) {
    let out = "";
    opens.push(0);
    while (i < src.length) {
      const c = src[i];
      if (stop && c === stop) { i++; break; }
      if (c === "\\") out += command();
      else if (c === "{") { i++; out += parseUntil("}"); }
      else if (c === "$") {
        const j = src.indexOf("$", i + 1);
        const end = j < 0 ? src.length : j;
        out += math(src.slice(i + 1, end));
        i = end + 1;
      } else if (c === "~") { out += "&nbsp;"; i++; }
      else if (src.startsWith("---", i)) { out += "—"; i += 3; }
      else if (src.startsWith("--", i)) { out += "–"; i += 2; }
      else if (src.startsWith("``", i)) { out += "“"; i += 2; }
      else if (src.startsWith("''", i)) { out += "”"; i += 2; }
      else if (c === "%") { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j + 1; }
      else if (c === "\n" && src[i + 1] === "\n") { out += "<br>"; while (src[i] === "\n" || src[i] === " ") i++; }
      else if (c === "\n" || c === "\t") { out += " "; i++; }
      else { out += esc(c); i++; }
    }
    out += "</span>".repeat(opens.pop());
    return out;
  }
  return parseUntil(null).trim().replace(/^(<br>\s*)+|(\s*<br>)+$/g, "");
}

const HEADINGS = { resumeSubheading: 4, resumeProjectHeading: 2, resumePOR: 3 };

export function plain(html) {
  return html.replace(/<\/(td|th|div|li|p)>|<br>|<hr[^>]*>/g, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;|&emsp;|&thinsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function trimRange(src, start, end) {
  while (start < end && /\s/.test(src[start])) start++;
  while (end > start && /\s/.test(src[end - 1])) end--;
  return [start, end];
}
const isVisible = (html) => Boolean(plain(html)) || /<(hr|table)\b|r-rulebox|hrulefill|dotfill/.test(html);
function blockLabel(html) {
  if (/<table\b/.test(html)) return `Table: ${plain(html).slice(0, 50)}`;
  if (!plain(html)) return "Line";
  return plain(html);
}

/**
 * Returns { html, elements } where elements maps id -> { id, kind, label, start, end, parent }.
 */
export function parseResume(tex) {
  const src = maskComments(tex);
  const elements = {};
  let counter = 0;
  const add = (el) => { el.id = `e${counter++}`; elements[el.id] = el; return el; };

  const docAt = src.indexOf("\\begin{document}");
  parseDefinitions(docAt < 0 ? src : src.slice(0, docAt));
  definedColors = {};
  for (const m of src.matchAll(/\\definecolor\{([^}]+)\}\{(HTML|RGB|rgb|gray)\}\{([^}]+)\}/g)) {
    const [, name, model, value] = m;
    if (model === "HTML") definedColors[name] = `#${value.trim()}`;
    else if (model === "RGB") definedColors[name] = `rgb(${value})`;
    else if (model === "rgb") definedColors[name] = `rgb(${value.split(",").map((v) => Math.round(Number(v) * 255)).join(",")})`;
    else definedColors[name] = `rgb(${Array(3).fill(Math.round(Number(value) * 255)).join(",")})`;
  }

  const docStart = src.indexOf("\\begin{document}");
  const bodyStart = docStart < 0 ? 0 : docStart + "\\begin{document}".length;
  let bodyEnd = src.indexOf("\\end{document}", bodyStart);
  if (bodyEnd < 0) bodyEnd = src.length;

  const sectionRe = /\\section\*?\s*(?=\{)/g;
  sectionRe.lastIndex = bodyStart;
  const sections = [];
  for (let m; (m = sectionRe.exec(src)) && m.index < bodyEnd; ) sections.push(m.index);

  let html = "";

  // Header: everything before the first section.
  const headerEnd = sections[0] ?? bodyEnd;
  const [hs, he] = trimRange(src, bodyStart, headerEnd);
  if (he > hs) {
    let inner = src.slice(hs, he);
    const center = /\\begin\{center\}([\s\S]*?)\\end\{center\}/.exec(inner);
    const headerEnd = center ? hs + center.index + center[0].length : he;
    const header = add({ kind: "header", label: "Header", start: hs, end: headerEnd });
    const [as, ae] = trimRange(src, headerEnd, he);
    const after = src.slice(as, ae);
    if (center) inner = center[1];
    const lines = inner.split(/\\\\(?:\s*\[[^\]]*\])?/).map((l) => latexToHtml(l)).filter((l) => isVisible(l));
    const [name, ...rest] = lines;
    header.label = plain(name ?? "Header") || "Header";
    html += `<header class="r-header" data-id="${header.id}" data-select="${header.id}">`;
    html += `<div class="r-name">${name ?? ""}</div>`;
    html += rest.map((l) => `<div class="r-contact">${l}</div>`).join("");
    html += "</header>";
    const afterHtml = latexToHtml(after);
    if (isVisible(afterHtml)) {
      const block = add({ kind: "block", label: blockLabel(afterHtml), start: as, end: ae });
      html += `<div class="r-block" data-id="${block.id}" data-select="${block.id}">${afterHtml}</div>`;
    }
  }

  // One block for a custom environment (e.g. \\begin{expTable}); each macro call
  // inside it gets a marker so its rendered row is selectable on its own.
  const customEnvBlock = (start, end, parent) => {
    const block = add({ kind: "block", label: "", start, end, parent });
    const callRe = new RegExp(String.raw`\\(${Object.keys(userMacros).filter((k) => userMacros[k].n > 0 && /^[A-Za-z]+$/.test(k)).join("|") || "(?!)"})(?![A-Za-z])`, "g");
    const inserts = [];
    callRe.lastIndex = src.indexOf("}", start) + 1;
    for (let c; (c = callRe.exec(src)) && c.index < end; ) {
      const def = userMacros[c[1]];
      let pos = callRe.lastIndex;
      const args = [];
      let k = 0;
      if (def.def !== undefined) { const opt = readOptAt(src, pos); if (opt) pos = opt.next; k = 1; }
      for (; k < def.n; k++) { const g = readGroup(src, pos); if (!g) break; args.push(src.slice(g.start, g.end)); pos = g.next; }
      const row = add({ kind: "row", label: plain(latexToHtml(args.join(" — "))), start: c.index, end: pos, parent: block.id });
      inserts.push([c.index - start, `\\studiomark{${row.id}}`]);
      callRe.lastIndex = pos;
    }
    let marked = src.slice(start, end);
    for (const [at, text] of inserts.reverse()) marked = marked.slice(0, at) + text + marked.slice(at);
    let blockHtml = latexToHtml(marked);
    // Rows that render as their own table (not a <tr>) get wrapped to be selectable.
    blockHtml = blockHtml
      .replace(/<span data-row="(e\d+)"><\/span>\s*(<table[\s\S]*?<\/table>)/g, '<div data-id="$1" data-select="$1">$2</div>')
      .replace(/<span data-row="e\d+"><\/span>/g, "");
    block.html = blockHtml;
    block.label = blockLabel(blockHtml);
    return block;
  };

  sections.forEach((secStart, si) => {
    const secEnd = sections[si + 1] ?? bodyEnd;
    const titleGroup = readGroup(src, src.indexOf("{", secStart));
    if (!titleGroup) return;
    const title = latexToHtml(src.slice(titleGroup.start, titleGroup.end));
    const [ss, se] = trimRange(src, secStart, secEnd);
    const section = add({ kind: "section", label: plain(title), start: ss, end: se });

    // children: entries, items and free blocks, in source order.
    const children = [];
    let entry = null;
    const target = () => (entry ? entry.children : children);

    let cursor = titleGroup.next;
    const addGap = (from, to) => {
      const [gs, ge] = trimRange(src, from, to);
      if (ge <= gs) return;
      const blockHtml = latexToHtml(src.slice(gs, ge));
      if (!isVisible(blockHtml)) return;
      target().push(add({ kind: "block", label: blockLabel(blockHtml), start: gs, end: ge, parent: entry?.id ?? section.id, html: blockHtml }));
    };

    // Custom macros that take arguments (e.g. a \\expRow{label}{text}) become their own selectable blocks.
    const custom = Object.keys(userMacros).filter((k) => userMacros[k].n > 0 && /^[A-Za-z]+$/.test(k));
    const customAlt = custom.length ? `|\\\\(${custom.join("|")})(?![A-Za-z])` : "";
    const envNames = Object.keys(userEnvs).filter((k) => /^[A-Za-z*]+$/.test(k)).map((k) => k.replace("*", "\\*"));
    const envAlt = envNames.length ? `|\\\\begin\\{(${envNames.join("|")})\\}` : "|(?!)";
    const re = new RegExp(String.raw`\\(resumeSubheading|resumeProjectHeading|resumePOR|resumeItem)(?![A-Za-z])|\\item(?![A-Za-z])|\\begin\{(tabular\*?|tabularx|tabulary|longtable)\}` + customAlt + envAlt, "g");
    re.lastIndex = titleGroup.next;
    for (let m; (m = re.exec(src)) && m.index < secEnd; ) {
      const name = m[1];
      if (m[4]) {
        const close = findMatchingEnd(src, m[4], re.lastIndex);
        addGap(cursor, m.index);
        target().push(customEnvBlock(m.index, close, entry?.id ?? section.id));
        re.lastIndex = cursor = close;
        continue;
      }
      if (m[3]) {
        // A custom macro call: read its arguments to find where it ends.
        const def = userMacros[m[3]];
        let pos = re.lastIndex;
        let k = 0;
        if (def.def !== undefined) { const opt = readOptAt(src, pos); if (opt) pos = opt.next; k = 1; }
        for (; k < def.n; k++) { const g = readGroup(src, pos); if (!g) break; pos = g.next; }
        addGap(cursor, m.index);
        const blockHtml = latexToHtml(src.slice(m.index, pos));
        if (isVisible(blockHtml)) {
          target().push(add({ kind: "block", label: plain(blockHtml), start: m.index, end: pos, parent: entry?.id ?? section.id, html: blockHtml }));
        }
        re.lastIndex = cursor = pos;
        continue;
      }
      if (m[2]) {
        // A table: skip past it so its rows aren't read as \item or macros.
        const endTag = `\\end{${m[2]}}`;
        const close = src.indexOf(endTag, re.lastIndex);
        re.lastIndex = close < 0 ? secEnd : close + endTag.length;
        continue;
      }
      if (name && HEADINGS[name]) {
        const args = [];
        let pos = re.lastIndex;
        for (let k = 0; k < HEADINGS[name]; k++) {
          const g = readGroup(src, pos);
          if (!g) break;
          args.push(latexToHtml(src.slice(g.start, g.end)));
          pos = g.next;
        }
        if (args.length !== HEADINGS[name]) continue;
        addGap(cursor, m.index);
        if (entry) entry.end = trimRange(src, entry.start, m.index)[1];
        entry = add({ kind: "entry", label: plain(args[0]), start: m.index, end: se, parent: section.id, macro: name, args, children: [] });
        children.push(entry);
        re.lastIndex = cursor = pos;
      } else if (name === "resumeItem") {
        const g = readGroup(src, re.lastIndex);
        if (!g) continue;
        addGap(cursor, m.index);
        const body = latexToHtml(src.slice(g.start, g.end));
        target().push(add({ kind: "item", style: "dash", label: plain(body), start: m.index, end: g.next, parent: entry?.id ?? section.id, html: body }));
        re.lastIndex = cursor = g.next;
      } else {
        // Generic \item: content runs to the next \item or \end{itemize}.
        const stop = /\\item(?![A-Za-z])|\\end\{(itemize|enumerate)\}/g;
        stop.lastIndex = re.lastIndex;
        const next = stop.exec(src);
        const [is, ie] = trimRange(src, m.index, Math.min(next ? next.index : secEnd, secEnd));
        addGap(cursor, m.index);
        const body = latexToHtml(src.slice(m.index + 5, ie));
        target().push(add({ kind: "item", style: "bullet", label: plain(body), start: is, end: ie, parent: entry?.id ?? section.id, html: body }));
        re.lastIndex = cursor = ie;
      }
    }
    addGap(cursor, secEnd);

    // Consecutive items of the same style share one list.
    const renderChildren = (list) => {
      let out = "";
      for (let k = 0; k < list.length; k++) {
        const el = list[k];
        if (el.kind === "item") {
          let lis = "";
          let n = k;
          while (n < list.length && list[n].kind === "item" && list[n].style === el.style) {
            lis += `<li data-id="${list[n].id}" data-select="${list[n].id}">${list[n].html}</li>`;
            n++;
          }
          out += `<ul class="r-list ${el.style}">${lis}</ul>`;
          k = n - 1;
        } else if (el.kind === "block") {
          out += `<div class="r-block" data-id="${el.id}" data-select="${el.id}">${el.html}</div>`;
        } else {
          out += renderEntry(el);
        }
      }
      return out;
    };
    const renderEntry = (b) => {
      const a = b.args;
      let out = `<div class="r-entry" data-id="${b.id}"><div class="r-entry-head" data-select="${b.id}">`;
      if (b.macro === "resumeSubheading") {
        out += `<div class="row"><strong>${a[0]}</strong><em class="sz-small">${a[1]}</em></div>`;
        out += `<div class="row"><em class="sz-small">${a[2]}</em><span class="sz-small">${a[3]}</span></div>`;
      } else if (b.macro === "resumeProjectHeading") {
        out += `<div class="row"><span>${a[0]}</span><em class="sz-small">${a[1]}</em></div>`;
      } else {
        out += `<div class="row"><span><strong>${a[0]}</strong>${a[1]}</span><em class="sz-small">${a[2]}</em></div>`;
      }
      return out + "</div>" + renderChildren(b.children) + "</div>";
    };

    html += `<section class="r-section" data-id="${section.id}">`;
    html += `<h2 data-select="${section.id}">${title}</h2>`;
    html += renderChildren(children);
    html += "</section>";
  });

  return { html, elements };
}
