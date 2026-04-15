import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";
import * as plantumlEncoderPkg from "plantuml-encoder";
import "./style.css";

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

const DEFAULT_MD = `# Markdown + PlantUML

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
        <button type="button" id="btn-open-file" class="btn">Open</button>
        <button type="button" id="btn-reopen-file" class="btn" disabled>Reopen</button>
        <button type="button" id="btn-save-file" class="btn">Save</button>
        <div class="toggle-group">
          <button type="button" id="btn-toggle-source" class="btn toggle active" aria-pressed="true">Source</button>
          <button type="button" id="btn-toggle-preview" class="btn toggle active" aria-pressed="true">Preview</button>
        </div>
        <label>
          <input type="checkbox" id="fit-width" checked /> FitWidth
        </label>
        <label>
          <input type="checkbox" id="tab2spaces" checked /> Tab2Spaces
        </label>
        <input type="number" id="tab-spaces-num" value="2" min="1" max="16" aria-label="Tab width" />
        <label>
          <span>Format</span>
          <select id="uml-format" aria-label="PlantUML output format">
            <option value="svg" selected>SVG</option>
            <option value="png">PNG</option>
          </select>
        </label>
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
          <div id="usage-watermark">Drag and Drop a .md file onto the page, or use Open file</div>
          <article id="preview"></article>
        </div>
      </section>
    </main>
  `;

  const source = document.querySelector<HTMLTextAreaElement>("#source")!;
  const preview = document.querySelector<HTMLElement>("#preview")!;
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
  const tabSpacesNum = document.querySelector<HTMLInputElement>("#tab-spaces-num")!;
  const panelSource = document.querySelector<HTMLElement>("#panel-source")!;
  const panelPreview = document.querySelector<HTMLElement>("#panel-preview")!;
  const resizer = document.querySelector<HTMLElement>("#resizer")!;
  const main = document.querySelector<HTMLElement>("main")!;

  let currentFileName = "document.md";
  let fileHandle: FileSystemFileHandle | null = null;
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

  source.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = source.selectionStart;
      const end = source.selectionEnd;
      const insert = tab2spacesCheckbox.checked
        ? " ".repeat(parseInt(tabSpacesNum.value) || 2)
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
            ? new RegExp("^ {1," + (parseInt(tabSpacesNum.value) || 2) + "}")
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

  async function render(): Promise<void> {
    headingCount = {};
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

  function isContentModified(): boolean {
    return source.value !== lastSavedContent;
  }

  function loadFileIntoEditor(file: File): void {
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
        const options: Record<string, unknown> = {
          types: [
            {
              description: "Markdown files",
              accept: { "text/markdown": [".md", ".markdown", ".mdown", ".mkd"] },
            },
          ],
          multiple: false,
        };
        // Use current file handle as startIn to open in same directory
        if (fileHandle) {
          options.startIn = fileHandle;
        }
        const handles = await (window.showOpenFilePicker as (opts: unknown) => Promise<FileSystemFileHandle[]>)(options);
        fileHandle = handles[0];
        const file = await fileHandle.getFile();
        currentFileName = file.name;
        const text = await file.text();
        source.value = text;
        lastSavedContent = text;
        hideWatermark();
        updateFilenameDisplay();
        scheduleRender();
        updateReopenButton();
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
      currentFileName = file.name;
      const text = await file.text();
      source.value = text;
      lastSavedContent = text;
      hideWatermark();
      updateFilenameDisplay();
      scheduleRender();
    } catch (e) {
      console.error("Could not reopen file:", e);
      fileHandle = null;
      updateReopenButton();
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
        return;
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error(e);
        return;
      }
    }

    // Fallback: download
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
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

      // Try to get file handle for reopen support (Chrome/Edge)
      if (e.dataTransfer?.items?.[0]?.getAsFileSystemHandle) {
        try {
          const handle = await e.dataTransfer.items[0].getAsFileSystemHandle();
          if (handle && handle.kind === "file") {
            fileHandle = handle as FileSystemFileHandle;
            const file = await fileHandle.getFile();
            currentFileName = file.name;
            const text = await file.text();
            source.value = text;
            lastSavedContent = text;
            hideWatermark();
            updateFilenameDisplay();
            scheduleRender();
            updateReopenButton();
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

  void render();
}

mount();
