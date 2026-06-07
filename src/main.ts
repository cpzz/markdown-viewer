import DOMPurify from "dompurify";
import JSZip from "jszip";
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

/** Process common escape sequences: \n \t \r \\ \" \' */
function processEscapeSequences(s: string): string {
  return s
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t")
    .replaceAll("\\r", "\r")
    .replaceAll('\\"', '"')
    .replaceAll("\\'", "'")
    .replaceAll("\\\\", "\\");
}

/** Fenced code (non-diagram): icon copy of rendered / highlighted text (`textContent`). */
const CODE_BLOCK_CLIPBOARD_ICON = `<span class="code-block__copy-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></span>`;
const CODE_BLOCK_CHECK_ICON = `<span class="code-block__copy-done" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>`;
const CODE_BLOCK_FORMAT_ICON = `<span class="code-block__format-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/></svg></span>`;
const CODE_BLOCK_FORMAT_DONE_ICON = `<span class="code-block__format-done" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>`;

function codeBlockWithCopyButton(langClass: string, escapedBody: string): string {
  return `<div class="code-block-wrap"><button type="button" class="code-block__copy btn btn--icon" aria-label="Copy code" title="Copy code">${CODE_BLOCK_CLIPBOARD_ICON}${CODE_BLOCK_CHECK_ICON}</button><button type="button" class="code-block__format btn btn--icon" aria-label="Format code" title="Format code">${CODE_BLOCK_FORMAT_ICON}${CODE_BLOCK_FORMAT_DONE_ICON}</button><pre><code${langClass}>${escapedBody}</code></pre></div>`;
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

/** Whole-file PlantUML source (not parsed as Markdown). */
const PLANTUML_DOCUMENT_EXTENSIONS = new Set(["puml", "plantuml"]);

function isPlantUmlDocumentPath(pathOrName: string): boolean {
  const ext = pathFileExtension(pathOrName);
  return Boolean(ext) && PLANTUML_DOCUMENT_EXTENSIONS.has(ext);
}

/** XMind mind-map files (ZIP containing content.xml or content.json). */
const XMIND_DOCUMENT_EXTENSIONS = new Set(["xmind"]);

/** Pre-computed SVG/markdown for XMind render; set when a .xmind file is loaded. */
let xmindRenderContent: string | null = null;

/** Pretty-print XML by inserting newlines and indentation. */
function prettyPrintXml(xml: string): string {
  let indent = 0;
  const TAB = "  ";
  return xml
    .replace(/></g, ">\n<")
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return "";
      const isClose = /^<\//.test(t);
      const isSelfClose = /\/>$/.test(t) || /^<\?/.test(t) || /^<!/.test(t);
      const isBalanced = t.startsWith("<") && !isClose && !isSelfClose && t.includes("</");
      const isOpen = t.startsWith("<") && !isClose && !isSelfClose && !isBalanced;
      if (isClose) indent = Math.max(0, indent - 1);
      const result = TAB.repeat(indent) + t;
      if (isOpen) indent++;
      return result;
    })
    .filter((l) => l !== "")
    .join("\n");
}

function isXmindDocumentPath(pathOrName: string): boolean {
  const ext = pathFileExtension(pathOrName);
  return Boolean(ext) && XMIND_DOCUMENT_EXTENSIONS.has(ext);
}

/** Parse an XMind file (ArrayBuffer); returns pretty source for display.
 *  Stores the rendered SVG/markdown in `xmindRenderContent` for the preview. */
async function parseXmindToMarkdown(data: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);

  // Try new format (content.json) first, then old format (content.xml)
  const jsonFile = zip.file("content.json");
  if (jsonFile) {
    const text = await jsonFile.async("string");
    const sheets = JSON.parse(text) as XmindJsonSheet[];
    xmindRenderContent = xmindSheetsToMermaid(sheets.map(sheetJsonToTree));
    // Pretty-print JSON for source display
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }

  const xmlFile = zip.file("content.xml");
  if (xmlFile) {
    const text = await xmlFile.async("string");
    xmindRenderContent = xmindXmlToMermaid(text);
    return prettyPrintXml(text);
  }

  throw new Error("No content.xml or content.json found in .xmind file");
}

// ── Shared tree type ──

interface XmindNode {
  title: string;
  children: XmindNode[];
}

type XmindLayout = "mindmap" | "flowchart-lr" | "flowchart-rl" | "flowchart-td" | "tree-down-right" | "tree-down-left" | "fishbone-right" | "fishbone-left" | "svg-table" | "markdown-table";

interface XmindSheet {
  title: string;
  root: XmindNode | null;
  layout: XmindLayout;
}

/** Map `structure-class` attribute to a rendering layout. */
function structureClassToLayout(sc: string | null): XmindLayout {
  if (!sc) return "mindmap";
  if (sc.includes("logic.right")) return "flowchart-lr";
  if (sc.includes("logic.left")) return "flowchart-rl";
  if (sc.includes("tree.right")) return "tree-down-right";
  if (sc.includes("tree.left")) return "tree-down-left";
  if (sc.includes("fishbone.rightHeaded")) return "fishbone-right";
  if (sc.includes("fishbone.leftHeaded")) return "fishbone-left";
  if (sc.includes("org-chart")) return "flowchart-td";
  if (sc.includes("timeline")) return "flowchart-lr";
  if (sc.includes("matrix") || sc.includes("table")) return "svg-table";
  // map.unbalanced, map.clockwise, map.anticlockwise, unknown
  return "mindmap";
}

/** Build SVG/Markdown source from sheet trees, choosing diagram type per sheet. */
function xmindSheetsToMermaid(sheets: XmindSheet[]): string {
  const blocks: string[] = [];
  for (const sheet of sheets) {
    if (!sheet.root) continue;
    if (sheet.layout === "markdown-table") {
      blocks.push(renderMarkdownTable(sheet.root));
    } else if (sheet.layout === "svg-table") {
      blocks.push(renderSvgTable(sheet.root));
    } else if (sheet.layout === "tree-down-right" || sheet.layout === "tree-down-left") {
      blocks.push(renderTreeDownSvg(sheet.root, sheet.layout));
    } else if (sheet.layout === "fishbone-right" || sheet.layout === "fishbone-left") {
      blocks.push(renderFishboneSvg(sheet.root, sheet.layout));
    } else if (sheet.layout === "mindmap") {
      blocks.push(renderMindmapSvg(sheet.root));
    } else {
      blocks.push(renderBusTreeSvg(sheet.root, sheet.layout));
    }
  }
  return blocks.join("\n\n");
}

// ── Markdown table renderer (matrix / table types) ──

function renderMarkdownTable(root: XmindNode): string {
  const lines: string[] = [`## ${root.title}`];
  const rows = root.children;
  if (rows.length === 0) return lines.join("\n");

  // Determine max column count across all rows
  let maxCols = 0;
  for (const row of rows) {
    if (row.children.length > maxCols) maxCols = row.children.length;
  }

  if (maxCols === 0) {
    // No sub-children: render as a single-column table
    lines.push("");
    lines.push("| Item |");
    lines.push("| --- |");
    for (const row of rows) {
      lines.push(`| ${mdTableEscape(row.title)} |`);
    }
    return lines.join("\n");
  }

  // First row's children titles become column headers
  // Row titles become the first column
  const headers = [""]; // first col = row label
  for (let c = 0; c < maxCols; c++) {
    headers.push(rows[0].children[c]?.title ?? `Col ${c + 1}`);
  }
  lines.push("");
  lines.push("| " + headers.map(mdTableEscape).join(" | ") + " |");
  lines.push("| " + headers.map(() => "---").join(" | ") + " |");

  for (const row of rows) {
    const cells = [row.title];
    for (let c = 0; c < maxCols; c++) {
      const child = row.children[c];
      if (child) {
        // If the cell has its own children, join them with commas
        const sub = child.children.map((n) => n.title).filter(Boolean);
        cells.push(sub.length > 0 ? `${child.title} (${sub.join(", ")})` : child.title);
      } else {
        cells.push("");
      }
    }
    lines.push("| " + cells.map(mdTableEscape).join(" | ") + " |");
  }
  return lines.join("\n");
}

function mdTableEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

// ── SVG Mindmap renderer (radial / map types) ──

function renderMindmapSvg(root: XmindNode): string {
  const FS = 13, PAD_X = 10, PAD_Y = 5, MIN_W = 40;
  const V_GAP = 6, H_GAP = 20, BUS2C = 20, RX = 4;
  const ROOT_RX = 16;

  interface MNode {
    title: string; children: MNode[];
    w: number; h: number; subH: number;
    x: number; y: number; depth: number;
  }

  function measure(node: XmindNode, depth: number = 1): MNode {
    const h = depth === 1 ? FS + PAD_Y * 2 + 4 : FS + PAD_Y * 2;
    const w = Math.max(MIN_W, estimateTextWidth(node.title, FS) + PAD_X * 2);
    const children = node.children.map(c => measure(c, depth + 1));
    let subH = h;
    if (children.length > 0) {
      let t = 0;
      for (const c of children) t += c.subH;
      t += V_GAP * (children.length - 1);
      subH = Math.max(h, t);
    }
    return { title: node.title, children, w, h, subH, x: 0, y: 0, depth };
  }

  function layoutSide(nodes: MNode[], startX: number, centerY: number, goRight: boolean): void {
    let totalH = 0;
    for (const n of nodes) totalH += n.subH;
    totalH += V_GAP * (nodes.length - 1);
    let cur = centerY - totalH / 2;
    for (const n of nodes) {
      const cy = cur + n.subH / 2;
      n.x = goRight ? startX : startX - n.w;
      n.y = cy - n.h / 2;
      if (n.children.length > 0) {
        const childX = goRight ? n.x + n.w + H_GAP + BUS2C : n.x - H_GAP - BUS2C;
        layoutSide(n.children, childX, cy, goRight);
      }
      cur += n.subH + V_GAP;
    }
  }

  const svgLines: string[] = [];
  const svgRects: string[] = [];
  const svgTexts: string[] = [];

  function drawNodeBox(n: MNode, ci: number): void {
    const st = branchColor(ci);
    const d = n.depth;
    let fill = st.fill, fillAttr = "", strokeW = "1", fw = "normal";
    if (d <= 1) { strokeW = "1.5"; fw = "bold"; }
    else if (d === 2) { fillAttr = ' fill-opacity="0.4"'; }
    else { fill = "none"; strokeW = "0.8"; }
    svgRects.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${RX}" ry="${RX}" fill="${fill}"${fillAttr} stroke="${st.stroke}" stroke-width="${strokeW}"/>`);
    svgTexts.push(`<text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}" font-weight="${fw}" fill="currentColor">${escapeHtml(n.title)}</text>`);
    for (const c of n.children) drawNodeBox(c, ci);
  }

  function drawBusConn(n: MNode, ci: number, goRight: boolean): void {
    if (n.children.length === 0) return;
    const lineColor = branchColor(ci).line;
    const sw = n.depth <= 1 ? "1.5" : "1";
    const exitX = goRight ? n.x + n.w : n.x;
    const busX = goRight ? n.x + n.w + H_GAP : n.x - H_GAP;
    const ny = n.y + n.h / 2;

    if (n.children.length === 1) {
      const c = n.children[0];
      const entryX = goRight ? c.x : c.x + c.w;
      svgLines.push(`<line x1="${exitX}" y1="${ny}" x2="${entryX}" y2="${c.y + c.h / 2}" stroke="${lineColor}" stroke-width="${sw}"/>`);
    } else {
      svgLines.push(`<line x1="${exitX}" y1="${ny}" x2="${busX}" y2="${ny}" stroke="${lineColor}" stroke-width="${sw}"/>`);
      const fc = n.children[0], lc = n.children[n.children.length - 1];
      svgLines.push(`<line x1="${busX}" y1="${fc.y + fc.h / 2}" x2="${busX}" y2="${lc.y + lc.h / 2}" stroke="${lineColor}" stroke-width="${sw}"/>`);
      for (const c of n.children) {
        const entryX = goRight ? c.x : c.x + c.w;
        svgLines.push(`<line x1="${busX}" y1="${c.y + c.h / 2}" x2="${entryX}" y2="${c.y + c.h / 2}" stroke="${lineColor}" stroke-width="${sw}"/>`);
      }
    }
    for (const c of n.children) drawBusConn(c, ci, goRight);
  }

  // Measure all children
  const kids = root.children.map(c => measure(c));

  // Split children: first half → right, second half → left
  const half = Math.ceil(kids.length / 2);
  const rightKids = kids.slice(0, half);
  const leftKids = kids.slice(half);

  // Measure root
  const rootW = Math.max(MIN_W + 20, estimateTextWidth(root.title, FS + 2) + PAD_X * 3);
  const rootH = FS + PAD_Y * 3;

  // Compute total height for centering
  let rTotalH = 0;
  for (const n of rightKids) rTotalH += n.subH;
  rTotalH += V_GAP * Math.max(0, rightKids.length - 1);
  let lTotalH = 0;
  for (const n of leftKids) lTotalH += n.subH;
  lTotalH += V_GAP * Math.max(0, leftKids.length - 1);
  const maxH = Math.max(rTotalH, lTotalH, rootH);
  const centerY = maxH / 2;

  // Root position: centered
  const rootX = -rootW / 2;
  const rootY = centerY - rootH / 2;

  // Layout children on each side
  const rightStartX = rootW / 2 + H_GAP + BUS2C;
  const leftStartX = -rootW / 2 - H_GAP - BUS2C;
  layoutSide(rightKids, rightStartX, centerY, true);
  layoutSide(leftKids, leftStartX, centerY, false);

  // Draw root → right children connections
  if (rightKids.length > 0) {
    const busX = rootW / 2 + H_GAP;
    svgLines.push(`<line x1="${rootW / 2}" y1="${centerY}" x2="${busX}" y2="${centerY}" stroke="#888" stroke-width="1.5"/>`);
    if (rightKids.length >= 2) {
      svgLines.push(`<line x1="${busX}" y1="${rightKids[0].y + rightKids[0].h / 2}" x2="${busX}" y2="${rightKids[rightKids.length - 1].y + rightKids[rightKids.length - 1].h / 2}" stroke="#888" stroke-width="1.5"/>`);
    }
    for (let i = 0; i < rightKids.length; i++) {
      const c = rightKids[i];
      svgLines.push(`<line x1="${busX}" y1="${c.y + c.h / 2}" x2="${c.x}" y2="${c.y + c.h / 2}" stroke="${branchColor(i).line}" stroke-width="1.5"/>`);
    }
  }

  // Draw root → left children connections
  if (leftKids.length > 0) {
    const busX = -rootW / 2 - H_GAP;
    svgLines.push(`<line x1="${-rootW / 2}" y1="${centerY}" x2="${busX}" y2="${centerY}" stroke="#888" stroke-width="1.5"/>`);
    if (leftKids.length >= 2) {
      svgLines.push(`<line x1="${busX}" y1="${leftKids[0].y + leftKids[0].h / 2}" x2="${busX}" y2="${leftKids[leftKids.length - 1].y + leftKids[leftKids.length - 1].h / 2}" stroke="#888" stroke-width="1.5"/>`);
    }
    for (let i = 0; i < leftKids.length; i++) {
      const c = leftKids[i];
      svgLines.push(`<line x1="${busX}" y1="${c.y + c.h / 2}" x2="${c.x + c.w}" y2="${c.y + c.h / 2}" stroke="${branchColor(half + i).line}" stroke-width="1.5"/>`);
    }
  }

  // Draw root node (rounded pill shape)
  svgRects.push(`<rect x="${rootX}" y="${rootY}" width="${rootW}" height="${rootH}" rx="${ROOT_RX}" ry="${ROOT_RX}" fill="${ROOT_STYLE.fill}" stroke="${ROOT_STYLE.stroke}" stroke-width="1.5"/>`);
  svgTexts.push(`<text x="${rootX + rootW / 2}" y="${rootY + rootH / 2 + (FS + 2) * 0.35}" text-anchor="middle" font-size="${FS + 2}" font-weight="bold" fill="currentColor">${escapeHtml(root.title)}</text>`);

  // Draw branch subtrees
  for (let i = 0; i < rightKids.length; i++) {
    drawBusConn(rightKids[i], i, true);
    drawNodeBox(rightKids[i], i);
  }
  for (let i = 0; i < leftKids.length; i++) {
    drawBusConn(leftKids[i], half + i, false);
    drawNodeBox(leftKids[i], half + i);
  }

  // Calculate bounds
  let bx0 = rootX, by0 = rootY, bx1 = rootX + rootW, by1 = rootY + rootH;
  function calcBounds(nodes: MNode[]): void {
    for (const n of nodes) {
      bx0 = Math.min(bx0, n.x); by0 = Math.min(by0, n.y);
      bx1 = Math.max(bx1, n.x + n.w); by1 = Math.max(by1, n.y + n.h);
      calcBounds(n.children);
    }
  }
  calcBounds(rightKids);
  calcBounds(leftKids);
  // Account for bus lines extending beyond nodes
  if (leftKids.length > 0) bx0 = Math.min(bx0, -rootW / 2 - H_GAP - BUS2C);

  const pad = 12;
  const w = bx1 - bx0 + pad * 2, h = by1 - by0 + pad * 2;
  const tx = -bx0 + pad, ty = -by0 + pad;

  return `<div class="xmind-tree-svg"><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<g transform="translate(${tx},${ty})">` +
    svgLines.join("") + svgRects.join("") + svgTexts.join("") +
    `</g></svg></div>`;
}

// ── SVG Bus-tree renderer (logic / tree / org-chart types) ──

const BRANCH_COLORS = [
  { stroke: "#4285f4", fill: "rgba(66,133,244,0.10)", line: "#4285f4" },   // blue
  { stroke: "#ea4335", fill: "rgba(234,67,53,0.10)", line: "#ea4335" },    // red
  { stroke: "#34a853", fill: "rgba(52,168,83,0.10)", line: "#34a853" },    // green
  { stroke: "#fbbc05", fill: "rgba(251,188,5,0.15)", line: "#cc9900" },    // yellow
  { stroke: "#8e24aa", fill: "rgba(142,36,170,0.10)", line: "#8e24aa" },   // purple
  { stroke: "#e67c00", fill: "rgba(230,124,0,0.10)", line: "#e67c00" },    // orange
  { stroke: "#00acc1", fill: "rgba(0,172,193,0.10)", line: "#00acc1" },    // cyan
  { stroke: "#d81b60", fill: "rgba(216,27,96,0.10)", line: "#d81b60" },    // pink
];
const ROOT_STYLE = { stroke: "#555", fill: "rgba(80,80,80,0.12)" };

function branchColor(idx: number) { return BRANCH_COLORS[idx % BRANCH_COLORS.length]; }

function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    w += ch.charCodeAt(0) > 0x2e7f ? fontSize : fontSize * 0.55;
  }
  return w;
}

function renderBusTreeSvg(root: XmindNode, layout: XmindLayout): string {
  const FS = 13, PAD_X = 10, PAD_Y = 5, MIN_W = 40;
  const V_GAP = 8, H_GAP = 20, BUS2C = 20, RX = 4;
  type Dir = "LR" | "RL" | "TD";
  const dir: Dir = layout === "flowchart-rl" ? "RL" : layout === "flowchart-td" ? "TD" : "LR";

  interface LNode {
    title: string; children: LNode[];
    pE: number; sE: number; subS: number; pP: number; sC: number;
  }

  function build(node: XmindNode): LNode {
    const nw = Math.max(MIN_W, estimateTextWidth(node.title, FS) + PAD_X * 2);
    const nh = FS + PAD_Y * 2;
    const children = node.children.map(build);
    const pE = dir === "TD" ? nh : nw;
    const sE = dir === "TD" ? nw : nh;
    let subS = sE;
    if (children.length > 0) {
      let t = 0; for (const c of children) t += c.subS;
      t += V_GAP * (children.length - 1);
      subS = Math.max(sE, t);
    }
    return { title: node.title, children, pE, sE, subS, pP: 0, sC: 0 };
  }

  function pos(n: LNode, pP: number, sC: number): void {
    n.pP = pP; n.sC = sC;
    if (n.children.length === 0) return;
    const childP = pP + n.pE + H_GAP + BUS2C;
    let t = 0; for (const c of n.children) t += c.subS;
    t += V_GAP * (n.children.length - 1);
    let cur = sC - t / 2;
    for (const c of n.children) { pos(c, childP, cur + c.subS / 2); cur += c.subS + V_GAP; }
  }

  function pt(p: number, s: number): [number, number] {
    if (dir === "TD") return [s, p];
    if (dir === "RL") return [-p, s];
    return [p, s];
  }

  const lr = build(root);
  pos(lr, 0, lr.subS / 2);

  const svgLines: string[] = [];
  const svgRects: string[] = [];
  const svgTexts: string[] = [];

  function drawNode(n: LNode, ci: number): void {
    const [rx, ry] = dir === "TD" ? [n.sC - n.sE / 2, n.pP] : dir === "RL" ? [-(n.pP + n.pE), n.sC - n.sE / 2] : [n.pP, n.sC - n.sE / 2];
    const [rw, rh] = dir === "TD" ? [n.sE, n.pE] : [n.pE, n.sE];
    const st = ci < 0 ? ROOT_STYLE : branchColor(ci);
    svgRects.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${RX}" ry="${RX}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1"/>`);
    svgTexts.push(`<text x="${rx + rw / 2}" y="${ry + rh / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}" fill="currentColor">${escapeHtml(n.title)}</text>`);
    for (const c of n.children) drawNode(c, ci);
  }

  function drawConn(n: LNode, ci: number): void {
    if (n.children.length === 0) return;
    const busP = n.pP + n.pE + H_GAP;
    const lineColor = ci < 0 ? "#888" : branchColor(ci).line;
    if (n.children.length === 1) {
      const c = n.children[0];
      const [x1, y1] = pt(n.pP + n.pE, n.sC);
      const [x2, y2] = pt(c.pP, c.sC);
      svgLines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${lineColor}" stroke-width="1.5"/>`);
    } else {
      const [ax, ay] = pt(n.pP + n.pE, n.sC);
      const [bx, by] = pt(busP, n.sC);
      svgLines.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${lineColor}" stroke-width="1.5"/>`);
      const fc = n.children[0], lc = n.children[n.children.length - 1];
      const [tx, ty] = pt(busP, fc.sC);
      const [ux, uy] = pt(busP, lc.sC);
      svgLines.push(`<line x1="${tx}" y1="${ty}" x2="${ux}" y2="${uy}" stroke="${lineColor}" stroke-width="1.5"/>`);
      for (const c of n.children) {
        const [cx1, cy1] = pt(busP, c.sC);
        const [cx2, cy2] = pt(c.pP, c.sC);
        svgLines.push(`<line x1="${cx1}" y1="${cy1}" x2="${cx2}" y2="${cy2}" stroke="${lineColor}" stroke-width="1.5"/>`);
      }
    }
    for (const c of n.children) drawConn(c, ci);
  }

  // Root uses neutral style; each top-level branch gets a color index
  drawConn(lr, -1);
  drawNode(lr, -1);
  // Override: re-draw top-level children with their branch colors
  // Actually, we draw root first, then each branch subtree with its color
  // Clear and redraw properly:
  svgLines.length = 0; svgRects.length = 0; svgTexts.length = 0;
  // Draw root connections (root → bus → top children)
  {
    const busP = lr.pP + lr.pE + H_GAP;
    if (lr.children.length === 1) {
      const c = lr.children[0];
      const [x1, y1] = pt(lr.pP + lr.pE, lr.sC);
      const [x2, y2] = pt(c.pP, c.sC);
      svgLines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#888" stroke-width="1.5"/>`);
    } else if (lr.children.length >= 2) {
      const [ax, ay] = pt(lr.pP + lr.pE, lr.sC);
      const [bx, by] = pt(busP, lr.sC);
      svgLines.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#888" stroke-width="1.5"/>`);
      const fc = lr.children[0], lc = lr.children[lr.children.length - 1];
      const [tx, ty] = pt(busP, fc.sC);
      const [ux, uy] = pt(busP, lc.sC);
      svgLines.push(`<line x1="${tx}" y1="${ty}" x2="${ux}" y2="${uy}" stroke="#888" stroke-width="1.5"/>`);
      for (let i = 0; i < lr.children.length; i++) {
        const c = lr.children[i];
        const [cx1, cy1] = pt(busP, c.sC);
        const [cx2, cy2] = pt(c.pP, c.sC);
        svgLines.push(`<line x1="${cx1}" y1="${cy1}" x2="${cx2}" y2="${cy2}" stroke="${branchColor(i).line}" stroke-width="1.5"/>`);
      }
    }
  }
  // Draw root node
  {
    const [rx, ry] = dir === "TD" ? [lr.sC - lr.sE / 2, lr.pP] : dir === "RL" ? [-(lr.pP + lr.pE), lr.sC - lr.sE / 2] : [lr.pP, lr.sC - lr.sE / 2];
    const [rw, rh] = dir === "TD" ? [lr.sE, lr.pE] : [lr.pE, lr.sE];
    svgRects.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${RX}" ry="${RX}" fill="${ROOT_STYLE.fill}" stroke="${ROOT_STYLE.stroke}" stroke-width="1.5"/>`);
    svgTexts.push(`<text x="${rx + rw / 2}" y="${ry + rh / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}" font-weight="bold" fill="currentColor">${escapeHtml(lr.title)}</text>`);
  }
  // Draw each branch subtree with its color
  for (let i = 0; i < lr.children.length; i++) {
    drawConn(lr.children[i], i);
    drawNode(lr.children[i], i);
  }

  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  (function calcB(n: LNode) {
    const [rx, ry] = dir === "TD" ? [n.sC - n.sE / 2, n.pP] : dir === "RL" ? [-(n.pP + n.pE), n.sC - n.sE / 2] : [n.pP, n.sC - n.sE / 2];
    const [rw, rh] = dir === "TD" ? [n.sE, n.pE] : [n.pE, n.sE];
    b.x0 = Math.min(b.x0, rx); b.y0 = Math.min(b.y0, ry);
    b.x1 = Math.max(b.x1, rx + rw); b.y1 = Math.max(b.y1, ry + rh);
    for (const c of n.children) calcB(c);
  })(lr);

  const pad = 10;
  const w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2;
  const tx = -b.x0 + pad, ty = -b.y0 + pad;

  return `<div class="xmind-tree-svg"><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<g transform="translate(${tx},${ty})">` +
    svgLines.join("") + svgRects.join("") + svgTexts.join("") +
    `</g></svg></div>`;
}

// ── Fishbone (Ishikawa) renderer ──

function renderFishboneSvg(root: XmindNode, layout: XmindLayout): string {
  const FS = 13, PAD_X = 10, PAD_Y = 5, MIN_W = 40, RX = 4;
  const SPINE_EXTRA = 40;       // extra spine beyond last rib
  const RIB_SPACING = 160;      // horizontal distance between ribs along spine
  const RIB_ANGLE_DX = 50;      // horizontal component of diagonal rib
  const RIB_ANGLE_DY = 60;      // vertical component of diagonal rib
  const rightHeaded = layout !== "fishbone-left";

  const ribs = root.children;
  const spineLen = ribs.length > 0 ? (ribs.length - 1) * RIB_SPACING + SPINE_EXTRA * 2 : 200;

  // Head (root) position: at right end of spine for rightHeaded, left end for leftHeaded
  const headW = Math.max(MIN_W, estimateTextWidth(root.title, FS) + PAD_X * 2);
  const headH = FS + PAD_Y * 2;

  const svgLines: string[] = [];
  const svgRects: string[] = [];
  const svgTexts: string[] = [];

  // Spine y = 0, spine runs along x-axis
  const spineY = 0;
  let spineLeft: number, spineRight: number;

  if (rightHeaded) {
    spineRight = spineLen;
    spineLeft = 0;
  } else {
    spineRight = 0;
    spineLeft = -spineLen;
  }

  // Draw spine line
  svgLines.push(`<line x1="${spineLeft}" y1="${spineY}" x2="${spineRight}" y2="${spineY}" stroke="#888" stroke-width="2"/>`);

  // Draw arrowhead at the head end
  const arrowEnd = rightHeaded ? spineRight : spineLeft;
  const arrowDir = rightHeaded ? 1 : -1;
  svgLines.push(`<line x1="${arrowEnd - arrowDir * 12}" y1="${spineY - 6}" x2="${arrowEnd}" y2="${spineY}" stroke="#888" stroke-width="2"/>`);
  svgLines.push(`<line x1="${arrowEnd - arrowDir * 12}" y1="${spineY + 6}" x2="${arrowEnd}" y2="${spineY}" stroke="#888" stroke-width="2"/>`);

  // Draw root label at the head
  const headX = rightHeaded ? spineRight + 5 : spineLeft - headW - 5;
  svgRects.push(`<rect x="${headX}" y="${spineY - headH / 2}" width="${headW}" height="${headH}" rx="${RX}" ry="${RX}" fill="${ROOT_STYLE.fill}" stroke="${ROOT_STYLE.stroke}" stroke-width="1.5"/>`);
  svgTexts.push(`<text x="${headX + headW / 2}" y="${spineY + FS * 0.35}" text-anchor="middle" font-size="${FS}" font-weight="bold" fill="currentColor">${escapeHtml(root.title)}</text>`);

  // Place ribs along spine, alternating above/below
  for (let i = 0; i < ribs.length; i++) {
    const rib = ribs[i];
    const bc = branchColor(i);
    // x position along spine: spread evenly, starting from SPINE_EXTRA
    const ribBaseX = rightHeaded
      ? spineLeft + SPINE_EXTRA + i * RIB_SPACING
      : spineRight - SPINE_EXTRA - i * RIB_SPACING;

    // Alternate: even index → above (negative y), odd → below (positive y)
    const above = i % 2 === 0;
    const dy = above ? -RIB_ANGLE_DY : RIB_ANGLE_DY;
    const dx = rightHeaded ? RIB_ANGLE_DX : -RIB_ANGLE_DX;

    const ribEndX = ribBaseX + dx;
    const ribEndY = spineY + dy;

    // Diagonal rib line from spine to rib label
    svgLines.push(`<line x1="${ribBaseX}" y1="${spineY}" x2="${ribEndX}" y2="${ribEndY}" stroke="${bc.line}" stroke-width="1.5"/>`);

    // Rib label box
    const ribW = Math.max(MIN_W, estimateTextWidth(rib.title, FS) + PAD_X * 2);
    const ribH = FS + PAD_Y * 2;
    const ribBoxX = ribEndX - ribW / 2;
    const ribBoxY = above ? ribEndY - ribH : ribEndY;
    svgRects.push(`<rect x="${ribBoxX}" y="${ribBoxY}" width="${ribW}" height="${ribH}" rx="${RX}" ry="${RX}" fill="${bc.fill}" stroke="${bc.stroke}" stroke-width="1"/>`);
    svgTexts.push(`<text x="${ribBoxX + ribW / 2}" y="${ribBoxY + ribH / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}" fill="currentColor">${escapeHtml(rib.title)}</text>`);

    // Sub-causes: small horizontal lines off the diagonal rib
    if (rib.children.length > 0) {
      const subFS = 11;
      for (let j = 0; j < rib.children.length; j++) {
        const sub = rib.children[j];
        // Position along the diagonal
        const t = (j + 1) / (rib.children.length + 1);
        const sx = ribBaseX + dx * t;
        const sy = spineY + dy * t;

        // Horizontal line extending from the diagonal
        const subW = Math.max(30, estimateTextWidth(sub.title, subFS) + 8);
        const subLineLen = subW + 6;
        const subEndX = sx + (rightHeaded ? -subLineLen : subLineLen);
        svgLines.push(`<line x1="${sx}" y1="${sy}" x2="${subEndX}" y2="${sy}" stroke="${bc.line}" stroke-width="1" opacity="0.6"/>`);
        const textX = rightHeaded ? subEndX - 3 : subEndX + 3;
        const anchor = rightHeaded ? "end" : "start";
        svgTexts.push(`<text x="${textX}" y="${sy + subFS * 0.35}" text-anchor="${anchor}" font-size="${subFS}" fill="${bc.stroke}">${escapeHtml(sub.title)}</text>`);
      }
    }
  }

  // Calculate bounds
  let bx0 = spineLeft - 10, bx1 = spineRight + 10;
  let by0 = -10, by1 = 10;
  // Account for head label
  bx0 = Math.min(bx0, headX); bx1 = Math.max(bx1, headX + headW);
  by0 = Math.min(by0, spineY - headH / 2); by1 = Math.max(by1, spineY + headH / 2);

  for (let i = 0; i < ribs.length; i++) {
    const rib = ribs[i];
    const ribBaseX = rightHeaded
      ? spineLeft + SPINE_EXTRA + i * RIB_SPACING
      : spineRight - SPINE_EXTRA - i * RIB_SPACING;
    const above = i % 2 === 0;
    const dy = above ? -RIB_ANGLE_DY : RIB_ANGLE_DY;
    const dx = rightHeaded ? RIB_ANGLE_DX : -RIB_ANGLE_DX;
    const ribEndX = ribBaseX + dx;
    const ribEndY = spineY + dy;
    const ribW = Math.max(MIN_W, estimateTextWidth(rib.title, FS) + PAD_X * 2);
    const ribH = FS + PAD_Y * 2;
    const ribBoxX = ribEndX - ribW / 2;
    const ribBoxY = above ? ribEndY - ribH : ribEndY;
    bx0 = Math.min(bx0, ribBoxX); bx1 = Math.max(bx1, ribBoxX + ribW);
    by0 = Math.min(by0, ribBoxY); by1 = Math.max(by1, ribBoxY + ribH);

    if (rib.children.length > 0) {
      const subFS = 11;
      for (let j = 0; j < rib.children.length; j++) {
        const sub = rib.children[j];
        const t = (j + 1) / (rib.children.length + 1);
        const sx = ribBaseX + dx * t;
        const sy = spineY + dy * t;
        const subW = Math.max(30, estimateTextWidth(sub.title, subFS) + 8);
        const subLineLen = subW + 6;
        const subEndX = sx + (rightHeaded ? -subLineLen : subLineLen);
        bx0 = Math.min(bx0, Math.min(sx, subEndX) - subW);
        bx1 = Math.max(bx1, Math.max(sx, subEndX) + subW);
        by0 = Math.min(by0, sy - subFS); by1 = Math.max(by1, sy + subFS);
      }
    }
  }

  const pad = 15;
  const w = bx1 - bx0 + pad * 2, h = by1 - by0 + pad * 2;
  const tx = -bx0 + pad, ty = -by0 + pad;

  return `<div class="xmind-tree-svg"><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<g transform="translate(${tx},${ty})">` +
    svgLines.join("") + svgRects.join("") + svgTexts.join("") +
    `</g></svg></div>`;
}

// ── Tree-down renderer (tree.right / tree.left: vertical trunk, side branches) ──

function renderTreeDownSvg(root: XmindNode, layout: XmindLayout): string {
  const FS = 13, PAD_X = 10, PAD_Y = 5, MIN_W = 40;
  const V_GAP = 6, TRUNK_GAP = 15, BRANCH_LEN = 25, RX = 4;
  const side: "right" | "left" = layout === "tree-down-left" ? "left" : "right";

  interface TNode {
    title: string; children: TNode[];
    w: number; h: number; subtreeH: number;
    x: number; y: number;
  }

  function measure(node: XmindNode): TNode {
    const w = Math.max(MIN_W, estimateTextWidth(node.title, FS) + PAD_X * 2);
    const h = FS + PAD_Y * 2;
    const children = node.children.map(measure);
    let subtreeH = h;
    if (children.length > 0) {
      let ch = 0;
      for (const c of children) ch += c.subtreeH;
      ch += V_GAP * (children.length - 1);
      subtreeH = h + TRUNK_GAP + ch;
    }
    return { title: node.title, children, w, h, subtreeH, x: 0, y: 0 };
  }

  function position(n: TNode, x: number, y: number): void {
    n.x = x; n.y = y;
    if (n.children.length === 0) return;
    const trunkX = x + n.w / 2;
    let curY = y + n.h + TRUNK_GAP;
    for (const c of n.children) {
      const cx = side === "right" ? trunkX + BRANCH_LEN : trunkX - BRANCH_LEN - c.w;
      position(c, cx, curY);
      curY += c.subtreeH + V_GAP;
    }
  }

  const svgLines: string[] = [];
  const svgRects: string[] = [];
  const svgTexts: string[] = [];

  function drawNode(n: TNode, ci: number): void {
    const st = ci < 0 ? ROOT_STYLE : branchColor(ci);
    const fw = ci < 0 ? " font-weight=\"bold\"" : "";
    svgRects.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${RX}" ry="${RX}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1"/>`);
    svgTexts.push(`<text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}"${fw} fill="currentColor">${escapeHtml(n.title)}</text>`);
    for (const c of n.children) drawNode(c, ci);
  }

  function drawConn(n: TNode, ci: number): void {
    if (n.children.length === 0) return;
    const trunkX = n.x + n.w / 2;
    const trunkTop = n.y + n.h;
    const last = n.children[n.children.length - 1];
    const trunkBot = last.y + last.h / 2;
    const lineColor = ci < 0 ? "#888" : branchColor(ci).line;
    svgLines.push(`<line x1="${trunkX}" y1="${trunkTop}" x2="${trunkX}" y2="${trunkBot}" stroke="${lineColor}" stroke-width="1.5"/>`);
    for (const c of n.children) {
      const by = c.y + c.h / 2;
      const bEnd = side === "right" ? c.x : c.x + c.w;
      svgLines.push(`<line x1="${trunkX}" y1="${by}" x2="${bEnd}" y2="${by}" stroke="${lineColor}" stroke-width="1.5"/>`);
    }
    for (const c of n.children) drawConn(c, ci);
  }

  const tree = measure(root);
  position(tree, 0, 0);
  // Draw root trunk connections with neutral color, then per-branch colors
  {
    const trunkX = tree.x + tree.w / 2;
    const trunkTop = tree.y + tree.h;
    if (tree.children.length > 0) {
      const last = tree.children[tree.children.length - 1];
      const trunkBot = last.y + last.h / 2;
      svgLines.push(`<line x1="${trunkX}" y1="${trunkTop}" x2="${trunkX}" y2="${trunkBot}" stroke="#888" stroke-width="1.5"/>`);
      for (let i = 0; i < tree.children.length; i++) {
        const c = tree.children[i];
        const by = c.y + c.h / 2;
        const bEnd = side === "right" ? c.x : c.x + c.w;
        svgLines.push(`<line x1="${trunkX}" y1="${by}" x2="${bEnd}" y2="${by}" stroke="${branchColor(i).line}" stroke-width="1.5"/>`);
      }
    }
  }
  // Draw root node
  drawNode(tree, -1);
  // Override: redraw children with branch colors
  svgRects.length = 1; svgTexts.length = 1; // keep root rect+text
  for (let i = 0; i < tree.children.length; i++) {
    drawConn(tree.children[i], i);
    drawNode(tree.children[i], i);
  }

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  (function bounds(n: TNode) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
    for (const c of n.children) bounds(c);
  })(tree);

  const pad = 10;
  const w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
  const tx = -x0 + pad, ty = -y0 + pad;

  return `<div class="xmind-tree-svg"><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<g transform="translate(${tx},${ty})">` +
    svgLines.join("") + svgRects.join("") + svgTexts.join("") +
    `</g></svg></div>`;
}

// ── SVG Table renderer (matrix / table types) ──

function renderSvgTable(root: XmindNode): string {
  const FS = 13, PAD_X = 8, PAD_Y = 6, MIN_W = 60;
  const ROW_H = FS + PAD_Y * 2;
  const rows = root.children;
  if (rows.length === 0) {
    return `<div class="xmind-tree-svg"><p>${escapeHtml(root.title)}: (empty)</p></div>`;
  }

  let maxCols = 0;
  for (const r of rows) if (r.children.length > maxCols) maxCols = r.children.length;

  // Column widths: col 0 = row labels, col 1..n = data
  const colW: number[] = [];
  let labelW = MIN_W;
  for (const r of rows) labelW = Math.max(labelW, estimateTextWidth(r.title, FS) + PAD_X * 2);
  colW.push(labelW);
  for (let c = 0; c < maxCols; c++) {
    let w = MIN_W;
    for (const r of rows) {
      if (r.children[c]) w = Math.max(w, estimateTextWidth(r.children[c].title, FS) + PAD_X * 2);
    }
    colW.push(w);
  }

  const totalW = colW.reduce((a, b) => a + b, 0);
  const headerH = ROW_H;
  const totalH = headerH + ROW_H * rows.length;
  const parts: string[] = [];

  // Title header
  parts.push(`<rect x="0" y="0" width="${totalW}" height="${headerH}" fill="rgba(128,128,128,0.15)" stroke="#999" stroke-width="1"/>`);
  parts.push(`<text x="${totalW / 2}" y="${headerH / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}" font-weight="bold" fill="currentColor">${escapeHtml(root.title)}</text>`);

  for (let r = 0; r < rows.length; r++) {
    const y = headerH + r * ROW_H;
    let x = 0;
    // Row label
    parts.push(`<rect x="${x}" y="${y}" width="${colW[0]}" height="${ROW_H}" fill="rgba(128,128,128,0.08)" stroke="#999" stroke-width="1"/>`);
    parts.push(`<text x="${x + colW[0] / 2}" y="${y + ROW_H / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}" fill="currentColor">${escapeHtml(rows[r].title)}</text>`);
    x += colW[0];
    // Data cells
    for (let c = 0; c < maxCols; c++) {
      const cell = rows[r].children[c];
      const cellText = cell ? cell.title : "";
      parts.push(`<rect x="${x}" y="${y}" width="${colW[c + 1]}" height="${ROW_H}" fill="none" stroke="#999" stroke-width="1"/>`);
      parts.push(`<text x="${x + colW[c + 1] / 2}" y="${y + ROW_H / 2 + FS * 0.35}" text-anchor="middle" font-size="${FS}" fill="currentColor">${escapeHtml(cellText)}</text>`);
      x += colW[c + 1];
    }
  }

  const pad = 10;
  const w = totalW + pad * 2, h = totalH + pad * 2;

  return `<div class="xmind-tree-svg"><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<g transform="translate(${pad},${pad})">` +
    parts.join("") +
    `</g></svg></div>`;
}

// ── XMind JSON format (XMind 8+) ──

interface XmindJsonTopic {
  title?: string;
  children?: { attached?: XmindJsonTopic[] };
  structureClass?: string;
}

interface XmindJsonSheet {
  title?: string;
  rootTopic?: XmindJsonTopic;
}

function jsonTopicToTree(t: XmindJsonTopic): XmindNode {
  return {
    title: t.title ?? "",
    children: (t.children?.attached ?? []).map(jsonTopicToTree),
  };
}

function sheetJsonToTree(sheet: XmindJsonSheet): XmindSheet {
  const sc = sheet.rootTopic?.structureClass ?? null;
  return {
    title: sheet.title ?? "Untitled",
    root: sheet.rootTopic ? jsonTopicToTree(sheet.rootTopic) : null,
    layout: structureClassToLayout(sc),
  };
}

// ── XMind XML format (classic) ──

function xmlTopicToTree(topic: Element): XmindNode {
  const title = topic.querySelector(":scope > title")?.textContent ?? "";
  const children: XmindNode[] = [];
  const attached = topic.querySelector(":scope > children > topics[type='attached']");
  if (attached) {
    attached.querySelectorAll(":scope > topic").forEach((child) => {
      children.push(xmlTopicToTree(child));
    });
  }
  return { title, children };
}

function xmindXmlToMermaid(xmlText: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const sheets = doc.querySelectorAll("sheet");
  const sheetTrees: XmindSheet[] = [];

  sheets.forEach((sheet) => {
    const rootTopic = sheet.querySelector(":scope > topic");
    const sc = rootTopic?.getAttribute("structure-class") ?? null;
    sheetTrees.push({
      title: sheet.querySelector(":scope > title")?.textContent ?? "Untitled",
      root: rootTopic ? xmlTopicToTree(rootTopic) : null,
      layout: structureClassToLayout(sc),
    });
  });

  return xmindSheetsToMermaid(sheetTrees);
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
  mts: "typescript",
  cts: "typescript",
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

// ── Minified code detection & chunk-based highlighting ──

/** Max line length before we consider code as "minified/compressed" */
const MINIFIED_LINE_THRESHOLD = 5000;

/** Check if source code is likely minified (has very long lines) */
function isMinifiedCode(source: string): boolean {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    if (lines[i].length > MINIFIED_LINE_THRESHOLD) return true;
  }
  return false;
}

/** Try to format code using js-beautify (loaded via CDN) based on language */
function tryFormatCode(code: string, lang: string): string | null {
  // js-beautify is loaded as global in index.html
  const win = window as unknown as Record<string, unknown>;
  const jsBeautify = win.js_beautify as ((code: string, opts: Record<string, unknown>) => string) | undefined;
  const cssBeautify = win.css_beautify as ((code: string, opts: Record<string, unknown>) => string) | undefined;

  if (!jsBeautify && !cssBeautify) return null;

  const opts: Record<string, unknown> = { indent_size: 2, space_in_empty_paren: true };
  try {
    if (lang === "javascript" || lang === "typescript" || lang === "jsx" || lang === "tsx") {
      if (jsBeautify) return jsBeautify(code, opts);
    }
    if (lang === "css") {
      if (cssBeautify) return cssBeautify(code, opts);
    }
    if (lang === "json") {
      const parsed = JSON.parse(code);
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Formatting failed
  }
  return null;
}

/** Highlight code with Prism, returns HTML string */
function highlightWithPrism(code: string, lang: string): string {
  if (typeof Prism === "undefined" || !Prism.languages[lang]) {
    return escapeHtml(code);
  }
  try {
    return Prism.highlight(code, Prism.languages[lang], lang);
  } catch {
    return escapeHtml(code);
  }
}

interface CodeChunk {
  text: string;
  isCode: boolean;
}

/** Split code into chunks at natural boundaries to avoid long lines */
function splitCodeIntoChunks(code: string): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  let current = "";
  let i = 0;
  const maxChunkLen = 2000;

  while (i < code.length) {
    const c = code[i];

    // Track string literals to avoid splitting inside them
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      current += c;
      i++;
      while (i < code.length) {
        if (code[i] === "\\") {
          current += code[i] + (code[i + 1] || "");
          i += 2;
          continue;
        }
        current += code[i];
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Track line comments
    if (c === "/" && code[i + 1] === "/") {
      if (current.length > maxChunkLen) {
        chunks.push({ text: current, isCode: true });
        current = "";
      }
      while (i < code.length && code[i] !== "\n") {
        current += code[i];
        i++;
      }
      chunks.push({ text: current, isCode: true });
      current = "";
      continue;
    }

    // Track block comments
    if (c === "/" && code[i + 1] === "*") {
      if (current.length > maxChunkLen) {
        chunks.push({ text: current, isCode: true });
        current = "";
      }
      current += "/*";
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) {
        current += code[i];
        i++;
      }
      if (i < code.length) {
        current += "*/";
        i += 2;
      }
      chunks.push({ text: current, isCode: true });
      current = "";
      continue;
    }

    // Natural split points: semicolons, braces, newlines
    if (c === ";" || c === "{" || c === "}" || c === "\n") {
      current += c;
      if (current.length > 100 || current.length > maxChunkLen) {
        chunks.push({ text: current, isCode: true });
        current = "";
      }
      i++;
      continue;
    }

    current += c;
    i++;

    // Force chunk break if too long
    if (current.length > maxChunkLen) {
      chunks.push({ text: current, isCode: true });
      current = "";
    }
  }

  if (current.length > 0) {
    chunks.push({ text: current, isCode: true });
  }

  return chunks;
}

/** Chunk-based highlighting: split code at natural boundaries, highlight each chunk */
function highlightByChunks(code: string, lang: string): string {
  const chunks = splitCodeIntoChunks(code);
  let result = "";
  for (const chunk of chunks) {
    result += chunk.isCode ? highlightWithPrism(chunk.text, lang) : escapeHtml(chunk.text);
  }
  return result;
}

/**
 * Main entry for minified code highlighting.
 * Tries to format first, then highlights the formatted code.
 * Falls back to chunk-based highlighting if formatting fails.
 */
function highlightMinifiedCode(code: string, lang: string): string {
  const formatted = tryFormatCode(code, lang);
  if (formatted !== null) {
    return highlightWithPrism(formatted, lang);
  }
  return highlightByChunks(code, lang);
}

/** Map shorthand language names to Prism language keys */
const LANG_SHORTHAND_MAP: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  yml: "yaml",
};

function resolvePrismLang(lang: string): string {
  return LANG_SHORTHAND_MAP[lang] || lang;
}

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

/** C-style line scan: line comments, strings, and block-comment depth (slash-star … star-slash). */
function updateBlockCommentDepthForLine(line: string, depth: number): number {
  let d = depth;
  let i = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escape = false;

  while (i < line.length) {
    const c = line[i];
    if (inString) {
      if (escape) {
        escape = false;
        i++;
        continue;
      }
      if (c === "\\") {
        escape = true;
        i++;
        continue;
      }
      if (c === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    if (c === "/" && line[i + 1] === "/") {
      break;
    }
    if (c === "/" && line[i + 1] === "*") {
      d++;
      i += 2;
      continue;
    }
    if (c === "*" && line[i + 1] === "/") {
      d = Math.max(0, d - 1);
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      i++;
      continue;
    }
    i++;
  }
  return d;
}

/** First line from startLineIdx that is a closing fence (trim equals fence) and not inside a C-style block comment. */
function findClosingFenceLineIndexInLines(lines: string[], startLineIdx: number, fenceLen: number): number {
  const fence = "`".repeat(fenceLen);
  let blockCommentDepth = 0;
  for (let li = startLineIdx; li < lines.length; li++) {
    const line = lines[li];
    if (blockCommentDepth === 0 && line.trim() === fence) {
      return li;
    }
    blockCommentDepth = updateBlockCommentDepthForLine(line, blockCommentDepth);
  }
  return -1;
}

function findClosingFenceCharIndex(text: string, contentStartChar: number, fenceLen: number): number {
  const t = text.replace(/\r\n/g, "\n");
  const lines = t.split("\n");
  let off = 0;
  let startLine = 0;
  while (startLine < lines.length - 1) {
    const lineLen = lines[startLine].length;
    const rowEnd = off + lineLen;
    if (contentStartChar <= rowEnd) break;
    off = rowEnd + 1;
    startLine++;
  }
  const closeLine = findClosingFenceLineIndexInLines(lines, startLine, fenceLen);
  if (closeLine === -1) return -1;
  off = 0;
  for (let i = 0; i < closeLine; i++) {
    off += lines[i].length + 1;
  }
  return off;
}

/**
 * If the fenced body contains a line that is only backticks of length >= opening fence length
 * (e.g. ``` inside ``` … ```), lengthen the fence so CommonMark/marked does not end the block early.
 */
function rewrapFenceForNestedBacktickLines(block: string): string {
  const lines = block.split("\n");
  if (lines.length < 2) return block;
  const openMatch = lines[0].match(/^(`{3,})([^`]*)$/);
  if (!openMatch) return block;
  const f = openMatch[1].length;
  const info = openMatch[2];
  let maxBt = 0;
  for (let li = 1; li < lines.length - 1; li++) {
    const t = lines[li].trim();
    const m = t.match(/^(`+)$/);
    if (m) {
      maxBt = Math.max(maxBt, m[1].length);
    }
  }
  if (maxBt < f) return block;
  const nf = maxBt + 1;
  const fence = "`".repeat(nf);
  return [fence + info, ...lines.slice(1, -1), fence].join("\n");
}

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
    return findClosingFenceCharIndex(text.replace(/\r\n/g, "\n"), startIndex, backtickCount);
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
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const fenced: string[] = [];
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const open = lines[i].match(/^(`{3,})([^`]*)$/);
      if (!open) {
        out.push(lines[i]);
        i++;
        continue;
      }
      const fenceLen = open[1].length;
      const closeLine = findClosingFenceLineIndexInLines(lines, i + 1, fenceLen);
      if (closeLine === -1) {
        out.push(lines[i]);
        i++;
        continue;
      }
      let blockText = lines.slice(i, closeLine + 1).join("\n");
      blockText = rewrapFenceForNestedBacktickLines(blockText);
      fenced.push(blockText);
      out.push("\x00FENCED" + (fenced.length - 1) + "\x00");
      i = closeLine + 1;
    }
    const placeholder = out.join("\n");
    const wrapped = placeholder.replace(
      /^([ \t]*)@start(uml|ditaa|mindmap|wbs|gantt|salt|json|yaml|ebnf|regex|chronology|board)\b[^\n]*\n[\s\S]*?@end\2\b/gm,
      (match, indent: string) => {
        return indent + "```plantuml\n" + match.trim() + "\n" + indent + "```";
      },
    );
    return wrapped.replace(/\x00FENCED(\d+)\x00/g, (_, j) => fenced[Number(j)] ?? "");
  }

  let result = markdown.replace(/\r\n/g, "\n");
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
      return codeBlockWithCopyButton(langClass, escaped);
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
        <input type="file" id="file-open" accept=".md,.markdown,.mdown,.mkd,.puml,.plantuml,.xmind,text/markdown,text/plain" hidden />
        <button type="button" id="btn-open-file" class="btn btn--icon" aria-label="Open file" title="Open file">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button type="button" id="btn-reopen-file" class="btn btn--icon" aria-label="Reopen file" title="Reopen file" disabled>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M21 21v-5h-5"/></svg>
        </button>
        <button type="button" id="btn-format-file" class="btn btn--icon" aria-label="Format file" title="Format file">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
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
          <div id="usage-watermark">Drag a .md, .puml, or .xmind file or a project folder onto the page, or use Open file</div>
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
  const btnFormatFile = document.querySelector<HTMLButtonElement>("#btn-format-file")!;
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

  /** Make each plantuml-block focusable and scrollable via arrow keys. */
  function activatePlantumlBlocks(): void {
    preview.querySelectorAll<HTMLElement>(".plantuml-block").forEach((block) => {
      block.tabIndex = 0;
      block.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          block.scrollLeft += e.key === "ArrowRight" ? 200 : -200;
        }
      });
    });
  }

  async function render(): Promise<void> {
    headingCount = {};
    mermaidQueue = [];

    if (isPlantUmlDocumentPath(currentFileName)) {
      const sanitizeOpts = {
        ADD_TAGS: ["img", "button", "div", "article", "section", "figure", "figcaption", "pre", "code"],
        ADD_ATTR: ["loading", "target", "rel", "id", "role", "aria-selected", "data-tab", "data-tabset", "class"],
      };
      try {
        const fig = renderPlantUmlBlock(source.value, plantumlOutputFormat);
        preview.innerHTML = DOMPurify.sanitize(`<article class="preview-plantuml-file">${fig}</article>`, sanitizeOpts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        preview.innerHTML = DOMPurify.sanitize(
          `<article class="preview-plantuml-file"><p class="plantuml-error">PlantUML encode error: ${escapeHtml(msg)}</p></article>`,
          sanitizeOpts,
        );
      }
      activatePlantumlBlocks();
      return;
    }

    if (!isMarkdownDocumentPath(currentFileName) && !isXmindDocumentPath(currentFileName)) {
      const lang = prismLangForSourcePreview(currentFileName, source.value);
      let displayContent = source.value;
      const ext = pathFileExtension(currentFileName);
      if (ext === "json" || ext === "yaml" || ext === "yml") {
        displayContent = processEscapeSequences(displayContent);
      }
      const langClass = lang ? ` class="language-${lang}"` : "";

      // Check if code is minified (has very long lines)
      if (lang && isMinifiedCode(displayContent)) {
        // Use chunk-based highlighting for minified code to avoid Prism backtracking
        const highlighted = highlightMinifiedCode(displayContent, lang);
        preview.innerHTML = DOMPurify.sanitize(
          `<article class="preview-non-markdown">${codeBlockWithCopyButton(langClass, highlighted)}</article>`,
          {
            ADD_TAGS: ["img", "button", "div", "article", "section", "figure", "figcaption", "pre", "code", "svg", "path", "rect", "polyline", "span"],
            ADD_ATTR: [
              "loading",
              "target",
              "rel",
              "id",
              "role",
              "aria-selected",
              "data-tab",
              "data-tabset",
              "class",
              "title",
              "type",
              "viewBox",
              "xmlns",
              "fill",
              "stroke",
              "stroke-width",
              "stroke-linecap",
              "stroke-linejoin",
              "d",
              "x",
              "y",
              "width",
              "height",
              "rx",
              "ry",
              "points",
              "aria-hidden",
            ],
          },
        );
      } else {
        const escaped = escapeHtml(displayContent);
        preview.innerHTML = DOMPurify.sanitize(
          `<article class="preview-non-markdown">${codeBlockWithCopyButton(langClass, escaped)}</article>`,
          {
            ADD_TAGS: ["img", "button", "div", "article", "section", "figure", "figcaption", "pre", "code", "svg", "path", "rect", "polyline", "span"],
            ADD_ATTR: [
              "loading",
              "target",
              "rel",
              "id",
              "role",
              "aria-selected",
              "data-tab",
              "data-tabset",
              "class",
              "title",
              "type",
              "viewBox",
              "xmlns",
              "fill",
              "stroke",
              "stroke-width",
              "stroke-linecap",
              "stroke-linejoin",
              "d",
              "x",
              "y",
              "width",
              "height",
              "rx",
              "ry",
              "points",
              "aria-hidden",
            ],
          },
        );
        if (typeof Prism !== "undefined") {
          preview.querySelectorAll("pre code").forEach((block) => {
            Prism.highlightElement(block);
          });
        }
      }
      return;
    }

    const markdownContent = isXmindDocumentPath(currentFileName) && xmindRenderContent != null
      ? xmindRenderContent
      : source.value;
    const preprocessed = preprocessMyST(markdownContent);
    const raw = await marked.parse(preprocessed);
    preview.innerHTML = DOMPurify.sanitize(raw, {
      ADD_TAGS: ["img", "button", "div", "article", "section", "figure", "figcaption", "svg", "g", "path", "rect", "polyline", "line", "text", "span"],
      ADD_ATTR: [
        "loading",
        "target",
        "rel",
        "id",
        "role",
        "aria-selected",
        "data-tab",
        "data-tabset",
        "class",
        "title",
        "type",
        "viewBox",
        "xmlns",
        "fill",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "d",
        "x",
        "y",
        "x1",
        "y1",
        "x2",
        "y2",
        "width",
        "height",
        "rx",
        "ry",
        "points",
        "aria-hidden",
        "text-anchor",
        "font-size",
        "font-weight",
        "transform",
        "opacity",
      ],
    });

    // Apply Prism syntax highlighting
    if (typeof Prism !== "undefined") {
      preview.querySelectorAll("pre code").forEach((block) => {
        const text = block.textContent || "";
        const langClass = block.className || "";
        const langMatch = langClass.match(/language-(\w+)/);
        if (langMatch && isMinifiedCode(text)) {
          // Use chunk-based highlighting for minified code
          const prismLang = resolvePrismLang(langMatch[1]);
          const highlighted = highlightMinifiedCode(text, prismLang);
          block.innerHTML = highlighted;
        } else {
          Prism.highlightElement(block);
        }
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

    activatePlantumlBlocks();
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
    let text: string;
    if (isXmindDocumentPath(h.name)) {
      const buf = await file.arrayBuffer();
      text = await parseXmindToMarkdown(buf);
    } else {
      text = await file.text();
    }
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
      const copyBtn = (e.target as HTMLElement | null)?.closest?.(".code-block__copy");
      if (copyBtn && preview.contains(copyBtn)) {
        e.preventDefault();
        e.stopPropagation();
        const wrap = copyBtn.closest(".code-block-wrap");
        const codeEl = wrap?.querySelector("pre code");
        if (!codeEl) return;
        const text = codeEl.textContent ?? "";
        void navigator.clipboard.writeText(text).then(
          () => {
            copyBtn.setAttribute("data-copied", "");
            copyBtn.setAttribute("aria-label", "Copied");
            window.setTimeout(() => {
              copyBtn.removeAttribute("data-copied");
              copyBtn.setAttribute("aria-label", "Copy code");
            }, 2000);
          },
          () => {
            alert("Could not copy to clipboard.");
          },
        );
        return;
      }

      const formatBtn = (e.target as HTMLElement | null)?.closest?.(".code-block__format");
      if (formatBtn && preview.contains(formatBtn)) {
        e.preventDefault();
        e.stopPropagation();
        const wrap = formatBtn.closest(".code-block-wrap");
        const codeEl = wrap?.querySelector("pre code");
        if (!codeEl) return;
        const text = codeEl.textContent ?? "";
        const langClass = codeEl.className || "";
        const langMatch = langClass.match(/language-(\w+)/);
        const lang = langMatch ? resolvePrismLang(langMatch[1]) : "";

        const formatted = tryFormatCode(text, lang);
        if (formatted === null) {
          alert("Could not format this code. Language may not be supported.");
          return;
        }

        // Re-highlight the formatted code
        const highlighted = highlightWithPrism(formatted, lang);
        codeEl.innerHTML = highlighted;
        formatBtn.setAttribute("data-formatted", "");
        formatBtn.setAttribute("aria-label", "Formatted");
        window.setTimeout(() => {
          formatBtn.removeAttribute("data-formatted");
          formatBtn.setAttribute("aria-label", "Format code");
        }, 2000);
        return;
      }

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
    if (isXmindDocumentPath(currentFileName)) {
      void file.arrayBuffer().then((buf) => parseXmindToMarkdown(buf)).then((text) => {
        source.value = text;
        lastSavedContent = text;
        hideWatermark();
        updateFilenameDisplay();
        scheduleRender();
      });
    } else {
      void file.text().then((text) => {
        source.value = text;
        lastSavedContent = text;
        hideWatermark();
        updateFilenameDisplay();
        scheduleRender();
      });
    }
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
            {
              description: "PlantUML diagrams",
              accept: { "text/plain": [".puml", ".plantuml"] },
            },
            {
              description: "XMind mind maps",
              accept: { "application/octet-stream": [".xmind"] },
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
        let text: string;
        if (isXmindDocumentPath(currentFileName)) {
          const buf = await file.arrayBuffer();
          text = await parseXmindToMarkdown(buf);
        } else {
          text = await file.text();
        }
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
      let text: string;
      if (isXmindDocumentPath(currentFileName)) {
        const buf = await file.arrayBuffer();
        text = await parseXmindToMarkdown(buf);
      } else {
        text = await file.text();
      }
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

  /** Format content based on file type. */
  function formatFile(): void {
    const ext = pathFileExtension(currentFileName);
    let formatted = source.value;

    switch (ext) {
      case "json":
        try {
          formatted = JSON.stringify(JSON.parse(source.value), null, 2);
        } catch {
          alert("Invalid JSON — cannot format.");
          return;
        }
        break;

      case "yaml":
      case "yml":
        // Normalize: trim trailing whitespace, ensure final newline
        formatted = source.value
          .split("\n")
          .map((l) => l.trimEnd())
          .join("\n")
          .replace(/\n{3,}/g, "\n\n");
        break;

      case "toml":
        // Normalize: trim trailing whitespace, ensure final newline
        formatted = source.value
          .split("\n")
          .map((l) => l.trimEnd())
          .join("\n")
          .replace(/\n{3,}/g, "\n\n");
        break;

      case "xml":
      case "svg":
      case "html":
      case "htm":
        formatted = prettyPrintXml(source.value);
        break;

      case "md":
      case "markdown":
      case "mdx":
      case "mdown":
      case "mkd":
      case "qmd":
      case "rmd":
      case "mdc":
        // Normalize markdown: trim trailing whitespace, collapse excessive blank lines
        formatted = source.value
          .split("\n")
          .map((l) => l.trimEnd())
          .join("\n")
          .replace(/\n{3,}/g, "\n\n");
        break;

      case "puml":
      case "plantuml":
        // Normalize PlantUML: ensure @startuml/@enduml, trim
        const trimmed = source.value.trim();
        if (!trimmed.includes("@startuml")) {
          formatted = `@startuml\n${trimmed}\n@enduml`;
        } else {
          formatted = trimmed;
        }
        break;

      default:
        // Generic: trim trailing whitespace per line, collapse excessive blank lines
        formatted = source.value
          .split("\n")
          .map((l) => l.trimEnd())
          .join("\n")
          .replace(/\n{3,}/g, "\n\n");
        break;
    }

    if (formatted !== source.value) {
      source.value = formatted;
      scheduleRender();
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
  btnFormatFile.addEventListener("click", () => formatFile());
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
            let text: string;
            if (isXmindDocumentPath(currentFileName)) {
              const buf = await file.arrayBuffer();
              text = await parseXmindToMarkdown(buf);
            } else {
              text = await file.text();
            }
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
