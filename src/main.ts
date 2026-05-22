import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";
import * as plantumlEncoderPkg from "plantuml-encoder";
import "./style.css";

type MermaidAPI = typeof import("mermaid").default;

/** Lazy-load Mermaid (~hundreds of KB); keeps the main chunk small when docs have no diagrams. */
let mermaidLoadPromise: Promise<MermaidAPI> | null = null;

function ensureMermaid(): Promise<MermaidAPI> {
  mermaidLoadPromise ??= import("mermaid").then((mod) => {
    const api = mod.default;
    api.initialize({ startOnLoad: false });
    return api;
  });
  return mermaidLoadPromise;
}

/** CJS interop varies by bundler; resolve `encode` from named export or `default.encode`. */
function resolvePlantumlEncode(): (diagram: string) => string {
  const mod = plantumlEncoderPkg as unknown as Record<string, unknown>;

  if (typeof mod.encode === "function") {
    return mod.encode as (diagram: string) => string;
  }
  const d = mod.default;
  if (typeof d === "function") {
    return d as (diagram: string) => string;
  }
  if (d && typeof d === "object") {
    const dObj = d as Record<string, unknown>;
    if (typeof dObj.encode === "function") {
      return dObj.encode as (diagram: string) => string;
    }
  }
  throw new Error("plantuml-encoder: could not resolve encode()");
}

const plantumlEncode = resolvePlantumlEncode();

const PLANTUML_BASE = "https://www.plantuml.com/plantuml";

/** Current PlantUML image format; read by the markdown renderer. */
let plantumlOutputFormat: "svg" | "png" = "svg";

/** Queue of mermaid diagrams to render after marked.parse(); cleared at the start of each render(). */
let mermaidQueue: Array<{ id: string; source: string }> = [];
let mermaidRenderSeq = 0;

function normalizePlantUmlSource(text: string): string {
  const t = text.trim();
  if (t.includes("@startuml")) return t;
  return `@startuml\n${t}\n@enduml`;
}

function plantumlDataUrl(source: string, format: "svg" | "png"): string {
  const encoded = plantumlEncode(normalizePlantUmlSource(source));
  return `${PLANTUML_BASE}/${format}/${encoded}`;
}

function renderPlantUmlBlock(source: string, format: "svg" | "png"): string {
  const url = plantumlDataUrl(source, format);
  const safeUrl = DOMPurify.sanitize(url, { ALLOWED_URI_REGEXP: /^https?:/i });
  const alt = "PlantUML diagram (rendered via plantuml.com)";
  return `<figure class="plantuml-block">
  <img src="${safeUrl}" alt="${alt}" loading="lazy" />
</figure>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** File path / name → basename (handles `/` and `\\`). */
function pathBasename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

/** Extension without dot; dotfiles like `.gitignore` → `gitignore`. */
function pathFileExtension(pathOrName: string): string {
  const base = pathBasename(pathOrName);
  if (base.startsWith(".") && base.length > 1) {
    const rest = base.slice(1);
    if (!rest.includes(".")) return rest.toLowerCase();
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot >= base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** When true, preview uses Markdown (MyST + marked). Otherwise preview shows raw source with Prism only. */
const MARKDOWN_DOCUMENT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "mdown",
  "mkd",
  "qmd",
  "rmd",
  "mdc",
]);

function isMarkdownDocumentPath(pathOrName: string): boolean {
  const ext = pathFileExtension(pathOrName);
  return Boolean(ext) && MARKDOWN_DOCUMENT_EXTENSIONS.has(ext);
}

const MDV_TRANSFER_DB = "mdv-fs-transfer";
const MDV_TRANSFER_STORE = "pending";

function posixDirname(p: string): string {
  const n = p.replaceAll("\\", "/").replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  return i === -1 ? "" : n.slice(0, i);
}

function encodePathSegmentsForFakeUrl(dir: string): string {
  return dir
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function normalizePathDotDot(segments: string[]): string[] | null {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out;
}

/**
 * Resolve a relative href (path part only, no `#fragment`) against the directory that contains
 * `currentWorkspacePath` (POSIX-style path segments relative to a workspace root).
 */
function resolveRelativeLinkToWorkspacePath(currentWorkspacePath: string, hrefPathPart: string): string | null {
  const raw = hrefPathPart.trim();
  if (!raw) return null;
  const normalizedCurrent = currentWorkspacePath.replaceAll("\\", "/");
  const dir = posixDirname(normalizedCurrent);
  const baseUrl =
    dir === "" ? "http://mdv.invalid/" : `http://mdv.invalid/${encodePathSegmentsForFakeUrl(dir)}/`;
  try {
    const u = new URL(raw, baseUrl);
    if (u.hostname !== "mdv.invalid") return null;
    const pathname = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const parts = pathname.split("/").filter(Boolean);
    const norm = normalizePathDotDot(parts);
    return norm ? norm.join("/") : null;
  } catch {
    return null;
  }
}

function hasNonHttpUrlScheme(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href);
}

function idbOpenTransferDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MDV_TRANSFER_DB, 1);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(MDV_TRANSFER_STORE)) {
        req.result.createObjectStore(MDV_TRANSFER_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbPutFileHandle(id: string, handle: FileSystemFileHandle): Promise<void> {
  const db = await idbOpenTransferDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MDV_TRANSFER_STORE, "readwrite");
      tx.objectStore(MDV_TRANSFER_STORE).put(handle, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("idb put failed"));
    });
  } finally {
    db.close();
  }
}

async function idbTakeFileHandle(id: string): Promise<FileSystemFileHandle | undefined> {
  const db = await idbOpenTransferDb();
  try {
    return await new Promise<FileSystemFileHandle | undefined>((resolve, reject) => {
      let out: FileSystemFileHandle | undefined;
      const tx = db.transaction(MDV_TRANSFER_STORE, "readwrite");
      const store = tx.objectStore(MDV_TRANSFER_STORE);
      const g = store.get(id);
      g.onsuccess = () => {
        out = g.result as FileSystemFileHandle | undefined;
        if (out !== undefined) store.delete(id);
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error ?? new Error("idb take failed"));
    });
  } finally {
    db.close();
  }
}

async function getFileHandleForRelativePath(
  root: FileSystemDirectoryHandle,
  posixPath: string,
): Promise<FileSystemFileHandle> {
  const segments = posixPath.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error("empty path");
  let dir = root;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i]!);
  }
  return dir.getFileHandle(segments[segments.length - 1]!);
}

/** Firefox / Safari: no `FileSystemFileHandle` from the file picker, so linked local files cannot work. */
function browserSupportsFileSystemAccessPickers(): boolean {
  return typeof window.showOpenFilePicker === "function";
}

/** Whole-file preview: exact basename (any path) → Prism id. */
const SOURCE_BASENAME_TO_PRISM: Record<string, string> = {
  dockerfile: "docker",
  containerfile: "docker",
  jenkinsfile: "groovy",
  makefile: "bash",
  gnumakefile: "bash",
  "cmakelists.txt": "cmake",
};

const SOURCE_EXT_TO_PRISM: Record<string, string> = {
  py: "python",
  pyw: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  /** Automake `Makefile.am` and similar */
  am: "makefile",
  /** RPM spec (Prism has no rpm; use YAML highlighting) */
  spec: "yaml",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  mdown: "markdown",
  mkd: "markdown",
};

const PRISM_LOADED_LANG = new Set([
  "python",
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "css",
  "json",
  "yaml",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "sql",
  "bash",
  "powershell",
  "markdown",
  "docker",
  "nginx",
  "toml",
  "makefile",
  "cmake",
  "groovy",
]);

/** First non-empty line after optional UTF-8 BOM (for shebang when suffix is missing or not mapped). */
function firstNonEmptySourceLine(source: string): string {
  let s = source;
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return "";
}

/** Map `#!/usr/bin/bash`, `#!/usr/bin/env python3`, etc. to a loaded Prism grammar id. */
function prismLangFromShebangLine(line: string): string | null {
  if (!line.startsWith("#!")) return null;
  const rest = line.slice(2).trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  let i = 0;
  const head = parts[0] ?? "";
  if (head === "env" || head.endsWith("/env")) {
    i = 1;
    while (i < parts.length && (parts[i].includes("=") || parts[i].startsWith("-"))) i++;
  }
  const exe = parts[i] ?? "";
  const bin = pathBasename(exe).toLowerCase();
  if (!bin) return null;

  if (bin === "sh" || bin === "bash" || bin === "dash" || bin === "zsh" || bin === "fish") return "bash";
  if (bin === "python" || bin.startsWith("python")) return "python";
  if (bin === "node" || bin === "nodejs" || bin.startsWith("node")) return "javascript";
  if (bin === "ts-node" || bin.startsWith("ts-node")) return "typescript";
  if (bin === "tsx") return "tsx";
  if (bin === "pwsh" || bin === "powershell") return "powershell";
  if (bin === "go") return "go";

  return null;
}

/** Prism grammar for whole-file preview: basename map, then suffix map, then shebang if suffix missing or unknown. */
function prismLangForSourcePreview(pathOrName: string, source: string): string | null {
  const baseLower = pathBasename(pathOrName).toLowerCase();
  const byBase = SOURCE_BASENAME_TO_PRISM[baseLower];
  if (byBase) return PRISM_LOADED_LANG.has(byBase) ? byBase : null;

  const ext = pathFileExtension(pathOrName);
  let fromSuffix: string | null = null;
  if (ext) {
    const mapped = SOURCE_EXT_TO_PRISM[ext];
    if (mapped !== undefined) {
      if (PRISM_LOADED_LANG.has(mapped)) fromSuffix = mapped;
    } else if (PRISM_LOADED_LANG.has(ext)) {
      fromSuffix = ext;
    }
  }
  if (fromSuffix) return fromSuffix;

  const bang = prismLangFromShebangLine(firstNonEmptySourceLine(source));
  if (bang && PRISM_LOADED_LANG.has(bang)) return bang;

  return null;
}

/** Generate slug for heading IDs (GitHub-style) */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\w\s\u4e00-\u9fff-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

let headingCount: Record<string, number> = {};

/**
 * MyST (Markedly Structured Text) preprocessor
 * Converts MyST directives to HTML before Markdown parsing:
 * - {tab-set} / {tab-item} -> tab panels
 * - {grid} / {grid-item} -> grid layout
 */
function preprocessMyST(markdown: string): string {
  let tabSetId = 0;

  function parseDirectiveOptions(content: string): { options: Record<string, string>; body: string } {
    const lines = content.split("\n");
    const options: Record<string, string> = {};
    let bodyStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const optMatch = line.match(/^:(\w[\w-]*):\s*(.*)$/);
      if (optMatch) {
        options[optMatch[1]] = optMatch[2].trim();
        bodyStart = i + 1;
      } else if (line.trim() === "") {
        bodyStart = i + 1;
      } else {
        break;
      }
    }

    return { options, body: lines.slice(bodyStart).join("\n") };
  }

  function findClosingFence(text: string, startIndex: number, backtickCount: number): number {
    const fence = "`".repeat(backtickCount);
    let idx = startIndex;
    while (idx < text.length) {
      const lineEnd = text.indexOf("\n", idx);
      const line = lineEnd === -1 ? text.slice(idx) : text.slice(idx, lineEnd);
      if (line.trim() === fence) {
        return idx;
      }
      idx = lineEnd === -1 ? text.length : lineEnd + 1;
    }
    return -1;
  }

  function processGridItems(content: string, backtickCount: number): string {
    const fence = "`".repeat(backtickCount);
    const itemStart = fence + "{grid-item}";
    const items: Array<{ options: Record<string, string>; body: string }> = [];

    let idx = 0;
    while (idx < content.length) {
      const start = content.indexOf(itemStart, idx);
      if (start === -1) break;

      const afterStart = start + itemStart.length;
      const contentStart = content.indexOf("\n", afterStart);
      if (contentStart === -1) break;

      const closeIdx = findClosingFence(content, contentStart + 1, backtickCount);
      if (closeIdx === -1) break;

      const itemContent = content.slice(contentStart + 1, closeIdx);
      items.push(parseDirectiveOptions(itemContent));

      idx = closeIdx + fence.length;
      const nextNewline = content.indexOf("\n", idx);
      idx = nextNewline === -1 ? content.length : nextNewline + 1;
    }

    let html = "";
    for (const item of items) {
      const columns = item.options["columns"] || "auto";
      const outline = "outline" in item.options;
      const colClass = columns !== "auto" ? ` myst-grid-col-${columns}` : "";
      const outlineClass = outline ? " myst-grid-item-outline" : "";
      html += `<div class="myst-grid-item${colClass}${outlineClass}">\n\n${item.body.trim()}\n\n</div>\n`;
    }

    return html;
  }

  function processGrid(content: string, columns: string, backtickCount: number): string {
    const innerBackticks = backtickCount - 1;
    const processedItems = processGridItems(content, innerBackticks);
    const colCount = parseInt(columns) || 2;
    return `<div class="myst-grid myst-grid-cols-${colCount}">\n\n${processedItems}\n\n</div>\n`;
  }

  function processNestedGrids(content: string): string {
    let result = content;
    const gridPattern = /^(`{4,})\{grid\}\s*(\d*)\s*$/m;

    let match;
    while ((match = gridPattern.exec(result)) !== null) {
      const fence = match[1];
      const cols = match[2] || "2";
      const startIdx = match.index;
      const contentStart = result.indexOf("\n", startIdx) + 1;
      const closeIdx = findClosingFence(result, contentStart, fence.length);

      if (closeIdx === -1) break;

      const gridContent = result.slice(contentStart, closeIdx);
      const closeEnd = result.indexOf("\n", closeIdx);
      const endIdx = closeEnd === -1 ? result.length : closeEnd + 1;

      const processed = processGrid(gridContent, cols, fence.length);
      result = result.slice(0, startIdx) + processed + result.slice(endIdx);
    }

    return result;
  }

  function processTabItems(content: string, backtickCount: number, setId: number): string {
    const fence = "`".repeat(backtickCount);
    const itemStart = fence + "{tab-item}";
    const tabs: Array<{ label: string; content: string; id: string }> = [];

    let idx = 0;
    while (idx < content.length) {
      const start = content.indexOf(itemStart, idx);
      if (start === -1) break;

      const afterStart = start + itemStart.length;
      const lineEnd = content.indexOf("\n", afterStart);
      if (lineEnd === -1) break;

      const label = content.slice(afterStart, lineEnd).trim() || `Tab ${tabs.length + 1}`;
      const contentStart = lineEnd + 1;
      const closeIdx = findClosingFence(content, contentStart, backtickCount);
      if (closeIdx === -1) break;

      let tabContent = content.slice(contentStart, closeIdx);
      tabContent = processNestedGrids(tabContent);

      tabs.push({
        label,
        content: tabContent.trim(),
        id: `tab-${setId}-${tabs.length}`,
      });

      idx = closeIdx + fence.length;
      const nextNewline = content.indexOf("\n", idx);
      idx = nextNewline === -1 ? content.length : nextNewline + 1;
    }

    if (tabs.length === 0) return content;

    let html = `<div class="myst-tab-set" data-tabset="${setId}">\n`;
    html += `<div class="myst-tab-buttons" role="tablist">\n`;

    tabs.forEach((tab, i) => {
      const active = i === 0 ? " active" : "";
      const selected = i === 0 ? "true" : "false";
      html += `<button class="myst-tab-btn${active}" role="tab" aria-selected="${selected}" data-tab="${tab.id}">${escapeHtml(tab.label)}</button>\n`;
    });

    html += `</div>\n<div class="myst-tab-panels">\n`;

    tabs.forEach((tab, i) => {
      const active = i === 0 ? " active" : "";
      html += `<div class="myst-tab-panel${active}" role="tabpanel" data-tab="${tab.id}">\n\n${tab.content}\n\n</div>\n`;
    });

    html += `</div>\n</div>\n`;
    return html;
  }

  function processTabSets(text: string): string {
    let result = text;
    const tabSetPattern = /^(`{6,})\{tab-set\}\s*$/m;

    let match;
    while ((match = tabSetPattern.exec(result)) !== null) {
      const fence = match[1];
      const startIdx = match.index;
      const contentStart = result.indexOf("\n", startIdx) + 1;
      const closeIdx = findClosingFence(result, contentStart, fence.length);

      if (closeIdx === -1) break;

      const tabSetContent = result.slice(contentStart, closeIdx);
      const closeEnd = result.indexOf("\n", closeIdx);
      const endIdx = closeEnd === -1 ? result.length : closeEnd + 1;

      tabSetId++;
      const innerBackticks = fence.length - 1;
      const processed = processTabItems(tabSetContent, innerBackticks, tabSetId);

      result = result.slice(0, startIdx) + processed + result.slice(endIdx);
    }

    return result;
  }

  function wrapBarePlantUml(text: string): string {
    const fenced: string[] = [];
    const placeholder = text.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, (m) => {
      fenced.push(m);
      return "\x00FENCED" + (fenced.length - 1) + "\x00";
    });
    const wrapped = placeholder.replace(
      /^([ \t]*)@start(uml|ditaa|mindmap|wbs|gantt|salt|json|yaml|ebnf|regex|chronology|board)\b[^\n]*\n[\s\S]*?@end\2\b/gm,
      (match, indent: string) => {
        return indent + "```plantuml\n" + match.trim() + "\n" + indent + "```";
      }
    );
    return wrapped.replace(/\x00FENCED(\d+)\x00/g, (_, i) => fenced[i]);
  }

  let result = markdown;
  result = wrapBarePlantUml(result);
  result = processTabSets(result);
  result = processNestedGrids(result);

  return result;
}

marked.use({
  renderer: {
    heading(token: Tokens.Heading): string {
      const text = this.parser.parseInline(token.tokens);
      const rawText = token.text;
      let slug = slugify(rawText);

      if (headingCount[slug] !== undefined) {
        headingCount[slug]++;
        slug = slug + "-" + headingCount[slug];
      } else {
        headingCount[slug] = 0;
      }

      return `<h${token.depth} id="${slug}">${text}</h${token.depth}>\n`;
    },
    code(token: Tokens.Code): string | false {
      const lang = (token.lang ?? "").toLowerCase().split(/\s+/)[0];
      if (lang === "plantuml" || lang === "puml" || lang === "{uml}") {
        try {
          return renderPlantUmlBlock(token.text, plantumlOutputFormat);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return `<p class="plantuml-error">PlantUML encode error: ${escapeHtml(msg)}</p>`;
        }
      }
      if (lang === "mermaid") {
        const id = `mermaid-block-${mermaidQueue.length}`;
        mermaidQueue.push({ id, source: token.text });
        return `<figure class="mermaid-block" id="${id}"></figure>`;
      }
      const langClass = lang ? ` class="language-${lang}"` : "";
      const escaped = escapeHtml(token.text);
      return `<pre><code${langClass}>${escaped}</code></pre>`;
    },
  },
});

marked.setOptions({
  gfm: true,
  breaks: false,
});

const DEFAULT_MD = `# Markdown + PlantUML + Mermaid

## PlantUML

Use a fenced block with language \`plantuml\` or \`puml\`:

\`\`\`plantuml
@startuml
Alice -> Bob: hello
Bob --> Alice: hi
@enduml
\`\`\`

You can omit \`@startuml\` / \`@enduml\`; they are added automatically:

\`\`\`puml
participant "API" as api
api -> api : validate
\`\`\`

## Mermaid

Use a fenced block with language \`mermaid\`:

\`\`\`mermaid
flowchart LR
  A[Open file] --> B{Valid markdown?}
  B -- Yes --> C[Render preview]
  B -- No --> D[Show error]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant User
  participant App
  User->>App: Open .md file
  App->>App: Parse markdown
  App-->>User: Render preview
\`\`\`

Regular **markdown** and \`inline code\` work as usual.
`;

function mount(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("#app missing");

  app.innerHTML = `
    <header>
      <h1>Markdown Viewer</h1>
      <p class="hint" id="filename-display"></p>
      <div class="controls">
        <input type="file" id="file-open" accept=".md,.markdown,.mdown,.mkd,text/markdown,text/plain" hidden />
        <button type="button" id="btn-open-file" class="btn btn--icon" aria-label="Open file" title="Open file">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button type="button" id="btn-reopen-file" class="btn btn--icon" aria-label="Reopen file" title="Reopen file" disabled>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M21 21v-5h-5"/></svg>
        </button>
        <button type="button" id="btn-save-file" class="btn btn--icon" aria-label="Save file" title="Save file">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        </button>
        <div class="toggle-group">
          <button type="button" id="btn-toggle-source" class="btn btn--icon toggle active" aria-pressed="true" aria-label="Show source panel" title="Source">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
          </button>
          <button type="button" id="btn-toggle-preview" class="btn btn--icon toggle active" aria-pressed="true" aria-label="Show preview panel" title="Preview">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        <button type="button" id="btn-settings" class="btn btn--icon" aria-label="Open settings" title="Settings">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <button type="button" id="btn-theme" class="btn btn--icon" aria-label="Toggle dark mode" title="Toggle dark mode">☀</button>
      </div>
    </header>
    <main>
      <section class="panel" id="panel-source">
        <label for="source">Markdown source</label>
        <textarea id="source" spellcheck="false" aria-label="Markdown source"></textarea>
      </section>
      <div class="resizer" id="resizer"></div>
      <section class="panel" id="panel-preview">
        <label for="preview-wrap">Preview</label>
        <div id="preview-wrap" tabindex="-1">
          <div id="usage-watermark">Drag a .md file or a project folder onto the page, or use Open file</div>
          <article id="preview"></article>
        </div>
      </section>
    </main>
    <dialog id="settings-dialog" class="settings-dialog" aria-labelledby="settings-dialog-title">
      <div class="settings-dialog__aligner">
        <div class="settings-dialog__panel">
        <div class="settings-dialog__header">
          <h2 id="settings-dialog-title" class="settings-dialog__title">Settings</h2>
          <button type="button" id="btn-settings-close" class="btn btn--icon" aria-label="Close settings">\u00D7</button>
        </div>
        <div class="settings-dialog__body">
          <label class="settings-row settings-row--switch" for="fit-width">
            <span class="settings-row__label">Fit to Width</span>
            <input type="checkbox" id="fit-width" checked />
          </label>
          <label class="settings-row settings-row--switch" for="tab2spaces">
            <span class="settings-row__label">Convert Tabs to Spaces</span>
            <input type="checkbox" id="tab2spaces" checked />
          </label>
          <div class="settings-row" role="group" aria-labelledby="tab-size-label">
            <span id="tab-size-label" class="settings-row__label">Tab Size</span>
            <div class="settings-row__control">
              <select id="tab-spaces-num" aria-labelledby="tab-size-label" aria-label="Tab size">
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4" selected>4</option>
                <option value="6">6</option>
                <option value="8">8</option>
              </select>
            </div>
          </div>
          <div class="settings-row" role="group" aria-labelledby="image-format-label">
            <span id="image-format-label" class="settings-row__label">Image Format</span>
            <div class="settings-row__control">
              <select id="uml-format" aria-labelledby="image-format-label" aria-label="Diagram image format">
                <option value="svg" selected>SVG</option>
                <option value="png">PNG</option>
              </select>
            </div>
          </div>
        </div>
        </div>
      </div>
    </dialog>
  `;

  const source = document.querySelector<HTMLTextAreaElement>("#source")!;
  const preview = document.querySelector<HTMLElement>("#preview")!;
  const previewWrap = document.querySelector<HTMLElement>("#preview-wrap")!;
  const formatSelect = document.querySelector<HTMLSelectElement>("#uml-format")!;
  const fileOpenInput = document.querySelector<HTMLInputElement>("#file-open")!;
  const btnOpenFile = document.querySelector<HTMLButtonElement>("#btn-open-file")!;
  const btnReopenFile = document.querySelector<HTMLButtonElement>("#btn-reopen-file")!;
  const btnSaveFile = document.querySelector<HTMLButtonElement>("#btn-save-file")!;
  const btnToggleSource = document.querySelector<HTMLButtonElement>("#btn-toggle-source")!;
  const btnTogglePreview = document.querySelector<HTMLButtonElement>("#btn-toggle-preview")!;
  const filenameDisplay = document.querySelector<HTMLElement>("#filename-display")!;
  const usageWatermark = document.querySelector<HTMLElement>("#usage-watermark")!;
  const fitWidthCheckbox = document.querySelector<HTMLInputElement>("#fit-width")!;
  const tab2spacesCheckbox = document.querySelector<HTMLInputElement>("#tab2spaces")!;
  const tabSpacesNum = document.querySelector<HTMLSelectElement>("#tab-spaces-num")!;
  const panelSource = document.querySelector<HTMLElement>("#panel-source")!;
  const panelPreview = document.querySelector<HTMLElement>("#panel-preview")!;
  const resizer = document.querySelector<HTMLElement>("#resizer")!;
  const main = document.querySelector<HTMLElement>("main")!;
  const btnTheme = document.querySelector<HTMLButtonElement>("#btn-theme")!;
  const settingsDialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
  const settingsAligner = settingsDialog.querySelector<HTMLElement>(".settings-dialog__aligner")!;
  const settingsPanel = settingsDialog.querySelector<HTMLElement>(".settings-dialog__panel")!;
  const btnSettings = document.querySelector<HTMLButtonElement>("#btn-settings")!;
  const btnSettingsClose = document.querySelector<HTMLButtonElement>("#btn-settings-close")!;

  btnSettings.addEventListener("click", () => {
    settingsDialog.showModal();
  });
  btnSettingsClose.addEventListener("click", () => {
    settingsDialog.close();
  });
  settingsAligner.addEventListener("click", () => {
    settingsDialog.close();
  });
  settingsPanel.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // ── Theme toggle ────────────────────────────────────────
  function applyTheme(dark: boolean): void {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    btnTheme.textContent = dark ? "\u263E" : "\u2600";
    btnTheme.title = dark ? "Switch to light mode" : "Switch to dark mode";
  }

  (function initTheme(): void {
    const stored = localStorage.getItem("md-viewer-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(stored ? stored === "dark" : prefersDark);
  })();

  btnTheme.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(!isDark);
    localStorage.setItem("md-viewer-theme", !isDark ? "dark" : "light");
    // Re-render so Mermaid diagrams use the new theme
    scheduleRender();
  });
  // ────────────────────────────────────────────────────────

  let currentFileName = "document.md";
  let fileHandle: FileSystemFileHandle | null = null;
  /** When set, relative preview links resolve under this directory (via `resolve(currentFileHandle)`). */
  let workspaceRootHandle: FileSystemDirectoryHandle | null = null;
  /** Path of the active file relative to `workspaceRootHandle`, using `/` separators. */
  let currentRelPathInWorkspace: string | null = null;
  let fileOpened = false;

  function updateFilenameDisplay(): void {
    filenameDisplay.textContent = fileOpened ? currentFileName : "";
  }

  function hideWatermark(): void {
    if (!fileOpened) {
      fileOpened = true;
      usageWatermark.style.display = "none";
      updateFilenameDisplay();
    }
  }

  source.value = DEFAULT_MD;
  updateFilenameDisplay();
  preview.classList.add("fit-width");
  plantumlOutputFormat = "svg";

  fitWidthCheckbox.addEventListener("change", () => {
    preview.classList.toggle("fit-width", fitWidthCheckbox.checked);
  });

  function syncTabSizeControl(): void {
    tabSpacesNum.disabled = !tab2spacesCheckbox.checked;
  }
  tab2spacesCheckbox.addEventListener("change", syncTabSizeControl);
  syncTabSizeControl();

  source.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = source.selectionStart;
      const end = source.selectionEnd;
      const insert = tab2spacesCheckbox.checked
        ? " ".repeat(parseInt(tabSpacesNum.value, 10) || 4)
        : "\t";

      if (start === end) {
        source.value = source.value.substring(0, start) + insert + source.value.substring(end);
        source.selectionStart = source.selectionEnd = start + insert.length;
      } else {
        const val = source.value;
        const before = val.substring(0, start);
        const selected = val.substring(start, end);
        const after = val.substring(end);

        if (e.shiftKey) {
          const pattern = tab2spacesCheckbox.checked
            ? new RegExp("^ {1," + (parseInt(tabSpacesNum.value, 10) || 4) + "}")
            : /^\t/;
          const dedented = selected.split("\n").map((line) => line.replace(pattern, ""));
          const newSelected = dedented.join("\n");
          source.value = before + newSelected + after;
          source.selectionStart = start;
          source.selectionEnd = start + newSelected.length;
        } else {
          const indented = selected.split("\n").map((line) => insert + line).join("\n");
          source.value = before + indented + after;
          source.selectionStart = start;
          source.selectionEnd = start + indented.length;
        }
      }
      scheduleRender();
    }
  });

  function updateLayout(): void {
    const showSource = btnToggleSource.classList.contains("active");
    const showPreview = btnTogglePreview.classList.contains("active");

    panelSource.style.display = showSource ? "" : "none";
    panelPreview.style.display = showPreview ? "" : "none";
    resizer.style.display = showSource && showPreview ? "" : "none";

    if (showSource && showPreview) {
      main.classList.remove("single-panel");
    } else {
      main.classList.add("single-panel");
    }
  }

  // Resizer drag logic
  let isResizing = false;
  resizer.addEventListener("mousedown", (e) => {
    isResizing = true;
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const mainRect = main.getBoundingClientRect();
    const isVertical = window.innerWidth <= 900;

    if (isVertical) {
      const offsetY = e.clientY - mainRect.top;
      let percent = (offsetY / mainRect.height) * 100;
      percent = Math.max(15, Math.min(85, percent));
      panelSource.style.flex = `0 0 ${percent}%`;
      panelPreview.style.flex = "1";
    } else {
      const offsetX = e.clientX - mainRect.left;
      let percent = (offsetX / mainRect.width) * 100;
      percent = Math.max(15, Math.min(85, percent));
      panelSource.style.flex = `0 0 ${percent}%`;
      panelPreview.style.flex = "1";
    }
  });

  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });

  btnToggleSource.addEventListener("click", () => {
    btnToggleSource.classList.toggle("active");
    btnToggleSource.setAttribute("aria-pressed", btnToggleSource.classList.contains("active").toString());
    updateLayout();
  });

  btnTogglePreview.addEventListener("click", () => {
    btnTogglePreview.classList.toggle("active");
    btnTogglePreview.setAttribute("aria-pressed", btnTogglePreview.classList.contains("active").toString());
    updateLayout();
  });

  function getMermaidTheme(): "dark" | "default" {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
  }

  async function render(): Promise<void> {
    headingCount = {};
    mermaidQueue = [];

    if (!isMarkdownDocumentPath(currentFileName)) {
      const lang = prismLangForSourcePreview(currentFileName, source.value);
      const escaped = escapeHtml(source.value);
      const langClass = lang ? ` class="language-${lang}"` : "";
      preview.innerHTML = DOMPurify.sanitize(
        `<article class="preview-non-markdown"><pre><code${langClass}>${escaped}</code></pre></article>`,
        {
          ADD_TAGS: ["img", "button", "div", "article", "section", "figure", "figcaption", "pre", "code"],
          ADD_ATTR: ["loading", "target", "rel", "id", "role", "aria-selected", "data-tab", "data-tabset", "class"],
        },
      );
      if (typeof Prism !== "undefined") {
        preview.querySelectorAll("pre code").forEach((block) => {
          Prism.highlightElement(block);
        });
      }
      return;
    }

    const preprocessed = preprocessMyST(source.value);
    const raw = await marked.parse(preprocessed);
    preview.innerHTML = DOMPurify.sanitize(raw, {
      ADD_TAGS: ["img", "button", "div", "article", "section", "figure", "figcaption"],
      ADD_ATTR: ["loading", "target", "rel", "id", "role", "aria-selected", "data-tab", "data-tabset", "class"],
    });

    // Apply Prism syntax highlighting
    if (typeof Prism !== "undefined") {
      preview.querySelectorAll("pre code").forEach((block) => {
        Prism.highlightElement(block);
      });
    }

    // Render Mermaid diagrams via mermaid.render() → SVG string approach (reliable across themes)
    if (mermaidQueue.length > 0) {
      const mermaid = await ensureMermaid();
      mermaid.initialize({ startOnLoad: false, theme: getMermaidTheme() });
      const seq = ++mermaidRenderSeq;
      for (let i = 0; i < mermaidQueue.length; i++) {
        const item = mermaidQueue[i];
        const el = preview.querySelector<HTMLElement>(`#${item.id}`);
        if (!el) continue;
        try {
          const svgId = `mermaid-svg-${seq}-${i}`;
          const { svg } = await mermaid.render(svgId, item.source);
          el.innerHTML = svg;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          el.innerHTML = `<p class="mermaid-error">Mermaid error: ${escapeHtml(msg)}</p>`;
        }
      }
    }

    // External links open in new tab
    preview.querySelectorAll("a[href]").forEach((link) => {
      const href = link.getAttribute("href");
      if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
      }
    });

    // Tab switching logic
    preview.querySelectorAll(".myst-tab-set").forEach((tabSet) => {
      const buttons = tabSet.querySelectorAll(".myst-tab-btn");
      const panels = tabSet.querySelectorAll(".myst-tab-panel");

      buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const tabId = btn.getAttribute("data-tab");

          buttons.forEach((b) => {
            b.classList.remove("active");
            b.setAttribute("aria-selected", "false");
          });
          panels.forEach((p) => p.classList.remove("active"));

          btn.classList.add("active");
          btn.setAttribute("aria-selected", "true");
          const panel = tabSet.querySelector(`.myst-tab-panel[data-tab="${tabId}"]`);
          if (panel) panel.classList.add("active");
        });
      });
    });
  }

  let t: ReturnType<typeof setTimeout> | undefined;
  function scheduleRender(): void {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      void render();
    }, 120);
  }

  source.addEventListener("input", scheduleRender);
  formatSelect.addEventListener("change", () => {
    plantumlOutputFormat = formatSelect.value === "png" ? "png" : "svg";
    scheduleRender();
  });

  /** `types` may be a DOMStringList (no `.includes`) in some browsers. */
  function hasFilePayload(dt: DataTransfer | null): boolean {
    if (!dt?.types?.length) return false;
    for (let i = 0; i < dt.types.length; i++) {
      if (dt.types[i] === "Files") return true;
    }
    return false;
  }

  function pickMarkdownFile(files: FileList | null): File | null {
    if (!files?.length) return null;
    const list = Array.from(files);
    const byName = list.find((f) => /\.(md|markdown|mdown|mkd)$/i.test(f.name));
    if (byName) return byName;
    const byType = list.find((f) => f.type.startsWith("text/"));
    if (byType) return byType;
    return list[0];
  }

  let lastSavedContent = DEFAULT_MD;

  function updateReopenButton(): void {
    btnReopenFile.disabled = !fileHandle;
  }

  async function refreshWorkspacePath(): Promise<void> {
    if (!fileHandle) {
      currentRelPathInWorkspace = null;
      return;
    }
    if (!workspaceRootHandle) {
      currentRelPathInWorkspace = null;
      return;
    }
    try {
      const segs = await workspaceRootHandle.resolve(fileHandle);
      if (!segs) {
        currentRelPathInWorkspace = null;
        currentFileName = fileHandle.name;
        updateFilenameDisplay();
      } else {
        currentRelPathInWorkspace = segs.join("/");
        currentFileName = currentRelPathInWorkspace;
        updateFilenameDisplay();
      }
    } catch (e) {
      console.warn(e);
      currentRelPathInWorkspace = null;
    }
  }

  async function bindWorkspaceFromPicker(): Promise<boolean> {
    if (!window.showDirectoryPicker) {
      alert("Folder linking is not available in this browser. Try Chrome or Edge.");
      return false;
    }
    try {
      const opts: DirectoryPickerOptions = fileHandle ? { startIn: fileHandle } : {};
      const dir = await window.showDirectoryPicker(opts);
      if (fileHandle) {
        const segs = await dir.resolve(fileHandle);
        if (!segs) {
          alert(
            "That folder does not contain the file you have open. Pick a parent folder (for example your project root) that contains this file.",
          );
          return false;
        }
        workspaceRootHandle = dir;
        currentRelPathInWorkspace = segs.join("/");
        currentFileName = currentRelPathInWorkspace;
        updateFilenameDisplay();
        return true;
      }
      workspaceRootHandle = dir;
      currentRelPathInWorkspace = null;
      alert("Folder linked. Use Open file — the dialog will start in this folder.");
      return true;
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error(e);
      return false;
    }
  }

  async function ensureWorkspaceForRelativeLinks(): Promise<boolean> {
    if (!browserSupportsFileSystemAccessPickers()) {
      alert(
        "Opening linked local files is not available in this browser. Firefox and Safari do not implement the File System Access API (file handles and folder linking). Use Chrome, Edge, or another Chromium-based browser for this feature.",
      );
      return false;
    }
    if (!fileHandle) {
      alert(
        'Use the "Open file" button and pick your document in the system file dialog. That is required so the app receives a file handle.',
      );
      return false;
    }
    if (workspaceRootHandle) {
      try {
        const segs = await workspaceRootHandle.resolve(fileHandle);
        if (segs) {
          currentRelPathInWorkspace = segs.join("/");
          currentFileName = currentRelPathInWorkspace;
          updateFilenameDisplay();
          return true;
        }
      } catch (e) {
        console.warn(e);
      }
      const relink = confirm(
        "The file you have open is not inside your linked folder.\n\nClick OK to open the folder picker and choose a folder that contains this file. Click Cancel to stop.",
      );
      if (!relink) return false;
      return await bindWorkspaceFromPicker();
    }
    const proceed = confirm(
      "Link a folder so relative file links can be resolved.\n\nClick OK to open the system folder picker now and choose a folder that contains your current file. Click Cancel to try later (you can also drag a project folder onto the page).",
    );
    if (!proceed) return false;
    return await bindWorkspaceFromPicker();
  }

  async function applyFileHandleOpen(h: FileSystemFileHandle): Promise<void> {
    fileHandle = h;
    const file = await h.getFile();
    const text = await file.text();
    source.value = text;
    lastSavedContent = text;
    hideWatermark();
    updateReopenButton();
    await refreshWorkspacePath();
    if (!currentRelPathInWorkspace) {
      currentFileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || h.name;
      updateFilenameDisplay();
    }
    scheduleRender();
  }

  async function consumePendingTransferFromUrl(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const openId = params.get("mdvOpen");
    if (!openId) return;
    let h: FileSystemFileHandle | undefined;
    try {
      h = await idbTakeFileHandle(openId);
    } catch (e) {
      console.warn("Could not read transferred file handle:", e);
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("mdvOpen");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    if (h) await applyFileHandleOpen(h);
  }

  async function openLinkedFileInNewWindow(targetHandle: FileSystemFileHandle): Promise<void> {
    const id = crypto.randomUUID();
    try {
      await idbPutFileHandle(id, targetHandle);
    } catch (e) {
      console.error(e);
      alert("Could not stage the file for a new window (IndexedDB may be unavailable).");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("mdvOpen", id);
    const child = window.open(url.toString(), "_blank");
    if (!child) {
      const useHere = confirm("Popup blocked. Open the linked file in this window instead?");
      if (useHere) await applyFileHandleOpen(targetHandle);
    }
  }

  previewWrap.addEventListener(
    "click",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!el || !preview.contains(el)) return;
      const href = el.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (href.startsWith("//")) return;
      if (href.startsWith("http://") || href.startsWith("https://")) return;
      if (hasNonHttpUrlScheme(href)) return;

      e.preventDefault();
      void (async () => {
        try {
          if (!(await ensureWorkspaceForRelativeLinks())) return;
          const base = currentRelPathInWorkspace;
          if (!base || !workspaceRootHandle) return;
          const pathPart = href.split("#")[0] ?? "";
          const resolved = resolveRelativeLinkToWorkspacePath(base, pathPart);
          if (!resolved) {
            alert("Could not resolve that link path from the current file.");
            return;
          }
          const target = await getFileHandleForRelativePath(workspaceRootHandle, resolved);
          await openLinkedFileInNewWindow(target);
        } catch (err) {
          console.error(err);
          alert(
            "Could not open the linked file. Check that the path exists and stays inside the folder you granted access to.",
          );
        }
      })();
    },
    true,
  );

  function isContentModified(): boolean {
    return source.value !== lastSavedContent;
  }

  function loadFileIntoEditor(file: File): void {
    fileHandle = null;
    workspaceRootHandle = null;
    currentRelPathInWorkspace = null;
    currentFileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name || "document.md";
    void file.text().then((text) => {
      source.value = text;
      lastSavedContent = text;
      hideWatermark();
      updateFilenameDisplay();
      scheduleRender();
    });
  }

  async function openFileWithPicker(): Promise<void> {
    if (window.showOpenFilePicker) {
      try {
        const options: OpenFilePickerOptions = {
          types: [
            {
              description: "Markdown files",
              accept: { "text/markdown": [".md", ".markdown", ".mdown", ".mkd"] },
            },
          ],
          multiple: false,
        };
        if (fileHandle) {
          options.startIn = fileHandle;
        } else if (workspaceRootHandle) {
          options.startIn = workspaceRootHandle;
        }
        const handles = await window.showOpenFilePicker(options);
        fileHandle = handles[0]!;
        const file = await fileHandle.getFile();
        currentFileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const text = await file.text();
        source.value = text;
        lastSavedContent = text;
        hideWatermark();
        updateFilenameDisplay();
        scheduleRender();
        updateReopenButton();
        await refreshWorkspacePath();
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error(e);
      }
    } else {
      fileOpenInput.click();
    }
  }

  async function reopenFile(): Promise<void> {
    if (!fileHandle) return;

    if (isContentModified()) {
      const confirmed = confirm("You have unsaved changes. Reopen will discard them. Continue?");
      if (!confirmed) return;
    }

    try {
      const file = await fileHandle.getFile();
      currentFileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const text = await file.text();
      source.value = text;
      lastSavedContent = text;
      hideWatermark();
      updateFilenameDisplay();
      scheduleRender();
      await refreshWorkspacePath();
    } catch (e) {
      console.error("Could not reopen file:", e);
      fileHandle = null;
      updateReopenButton();
      void refreshWorkspacePath();
    }
  }

  async function saveFile(): Promise<void> {
    const content = source.value;

    // Try to save directly to original file
    if (fileHandle) {
      const confirmed = confirm(`Save changes to "${currentFileName}"?`);
      if (!confirmed) return;

      try {
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        lastSavedContent = content;
        return;
      } catch (e) {
        console.warn("Could not save to original file:", e);
      }
    }

    // Try "Save As" with File System Access API
    if (window.showSaveFilePicker) {
      try {
        const newHandle = await window.showSaveFilePicker({
          suggestedName: currentFileName,
          startIn: workspaceRootHandle ?? fileHandle ?? undefined,
          types: [
            {
              description: "Markdown files",
              accept: { "text/markdown": [".md"] },
            },
          ],
        });
        fileHandle = newHandle;
        currentFileName = newHandle.name;
        updateFilenameDisplay();
        const writable = await newHandle.createWritable();
        await writable.write(content);
        await writable.close();
        lastSavedContent = content;
        updateReopenButton();
        await refreshWorkspacePath();
        return;
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error(e);
        return;
      }
    }

    // Fallback: download
    const blob = new Blob([content], {
      type: isMarkdownDocumentPath(currentFileName) ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    lastSavedContent = content;
  }

  btnOpenFile.addEventListener("click", () => void openFileWithPicker());
  btnReopenFile.addEventListener("click", () => void reopenFile());
  btnSaveFile.addEventListener("click", () => void saveFile());
  fileOpenInput.addEventListener("change", () => {
    const file = fileOpenInput.files?.[0];
    const inputPath = fileOpenInput.value;
    fileOpenInput.value = "";
    if (file) {
      fileHandle = null;
      if (inputPath && !inputPath.includes("fakepath")) {
        currentFileName = inputPath;
      }
      updateReopenButton();
      loadFileIntoEditor(file);
    }
  });

  /** Document-level drag: avoids missed drops on children (e.g. textarea) and satisfies browser drop rules. */
  let fileDragDepth = 0;
  document.addEventListener(
    "dragenter",
    (e) => {
      if (!hasFilePayload(e.dataTransfer)) return;
      e.preventDefault();
      fileDragDepth += 1;
      app.classList.add("drag-active");
    },
    true,
  );
  document.addEventListener(
    "dragleave",
    (e) => {
      if (!hasFilePayload(e.dataTransfer)) return;
      e.preventDefault();
      fileDragDepth -= 1;
      if (fileDragDepth <= 0) {
        fileDragDepth = 0;
        app.classList.remove("drag-active");
      }
    },
    true,
  );
  document.addEventListener(
    "dragover",
    (e) => {
      if (!hasFilePayload(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    },
    true,
  );
  document.addEventListener(
    "drop",
    async (e) => {
      if (!hasFilePayload(e.dataTransfer)) return;
      e.preventDefault();
      fileDragDepth = 0;
      app.classList.remove("drag-active");

      // Try directory or file handle (Chrome/Edge)
      if (e.dataTransfer?.items?.[0]?.getAsFileSystemHandle) {
        try {
          const handle = await e.dataTransfer.items[0].getAsFileSystemHandle();
          if (handle && handle.kind === "directory") {
            workspaceRootHandle = handle as FileSystemDirectoryHandle;
            await refreshWorkspacePath();
            updateFilenameDisplay();
            updateReopenButton();
            scheduleRender();
            alert("Project folder linked. Use Open file to choose a file inside this folder.");
            return;
          }
          if (handle && handle.kind === "file") {
            fileHandle = handle as FileSystemFileHandle;
            const file = await fileHandle.getFile();
            currentFileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
            const text = await file.text();
            source.value = text;
            lastSavedContent = text;
            hideWatermark();
            updateFilenameDisplay();
            scheduleRender();
            updateReopenButton();
            await refreshWorkspacePath();
            return;
          }
        } catch (err) {
          console.warn("Could not get file handle:", err);
        }
      }

      // Fallback: use regular file (no reopen support)
      const file = pickMarkdownFile(e.dataTransfer?.files ?? null);
      if (file) {
        fileHandle = null;
        updateReopenButton();
        loadFileIntoEditor(file);
      }
    },
    true,
  );

  window.addEventListener("dragend", () => {
    fileDragDepth = 0;
    app.classList.remove("drag-active");
  });

  void (async () => {
    await consumePendingTransferFromUrl();
    await refreshWorkspacePath();
    void render();
  })();
}

mount();
