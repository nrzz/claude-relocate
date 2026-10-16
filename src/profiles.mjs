// Shell profiles: the marked block that sets CLAUDE_CONFIG_DIR, written into the profiles of the shells in use
// and taken out again, byte for byte, by `undo`.
//
// The block is three lines. The marker lines are comments in every shell this tool writes for:
//
//   # claude-relocate start
//   export CLAUDE_CONFIG_DIR='/home/me/.config/claude'      (bash, zsh, sh)
//   set -gx CLAUDE_CONFIG_DIR '/home/me/.config/claude'     (fish)
//   $env:CLAUDE_CONFIG_DIR = 'D:\Claude'                    (PowerShell)
//   # claude-relocate end
import fs from "node:fs";
import path from "node:path";
import { exists, fileStamp, statOf, uniquePath, writeFileAtomic, fail } from "./util.mjs";
import { shellInUse } from "./env.mjs";

export const START = "# claude-relocate start";
export const END = "# claude-relocate end";
export const VARIABLE = "CLAUDE_CONFIG_DIR";

// ---------------------------------------------------------------------------------------------
// Quoting: a value with spaces, quotes or a dollar sign must come out of the shell as it went in.
// ---------------------------------------------------------------------------------------------

// POSIX shells: single quotes, and a single quote inside is '\''.
export const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// fish: single quotes, with \\ and \' as the only escapes inside them.
export const fishQuote = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
// PowerShell: single quotes, and a quote inside is doubled. PowerShell treats the typographic single quotes
// (U+2018, U+2019, U+201A, U+201B) as quotes too, so they are doubled as well.
export const psQuote = (s) => `'${String(s).replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`;

const QUOTE = { posix: shQuote, fish: fishQuote, powershell: psQuote };
const ASSIGN = {
  posix: (v) => `export ${VARIABLE}=${shQuote(v)}`,
  fish: (v) => `set -gx ${VARIABLE} ${fishQuote(v)}`,
  powershell: (v) => `$env:${VARIABLE} = ${psQuote(v)}`,
};
export const quoteFor = (syntax) => QUOTE[syntax];

export function blockLines(syntax, value) {
  if (/[\r\n\0]/.test(value)) fail("The folder name has a line break or a null character in it; a shell profile cannot hold that.", "bad-folder-name");
  return [START, ASSIGN[syntax](value), END];
}

// The value a block's assignment line sets, or null if the line is not ours.
export function parseAssignment(syntax, line) {
  const t = String(line).trim();
  if (syntax === "posix") {
    const m = /^export CLAUDE_CONFIG_DIR=(.*)$/.exec(t);
    if (!m) return null;
    let out = "";
    const rest = m[1];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "'") {
        const end = rest.indexOf("'", i + 1);
        if (end < 0) return null;
        out += rest.slice(i + 1, end);
        i = end;
      } else if (rest[i] === "\\" && rest[i + 1] === "'") { out += "'"; i++; } else return null;
    }
    return out;
  }
  if (syntax === "fish") {
    const m = /^set -gx CLAUDE_CONFIG_DIR '((?:[^'\\]|\\.)*)'$/.exec(t);
    return m ? m[1].replace(/\\(['\\])/g, "$1") : null;
  }
  const m = /^\$env:CLAUDE_CONFIG_DIR = '((?:[^'\u2018\u2019\u201a\u201b]|(['\u2018\u2019\u201a\u201b])\2)*)'$/.exec(t);
  return m ? m[1].replace(/(['\u2018\u2019\u201a\u201b])\1/g, "$1") : null;
}

// ---------------------------------------------------------------------------------------------
// Finding the block in a file's text
// ---------------------------------------------------------------------------------------------

const lineEnd = (line) => (line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "");

// { start, end, lines } with offsets into `text` (end is after the closing line's line break), or null.
export function findBlock(text) {
  const parts = text.split(/(?<=\n)/);
  let offset = 0;
  let start = -1;
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].replace(/^\uFEFF/, "").trim();
    if (start < 0 && t === START) start = offset;
    else if (start >= 0 && t === END) return { start, end: offset + parts[i].length, text: text.slice(start, offset + parts[i].length) };
    offset += parts[i].length;
  }
  return null;
}

function eolOf(text, fallback) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  if (!crlf && !lf) return fallback;
  return crlf > lf ? "\r\n" : "\n";
}

// Puts the block into the text: replaces ours if it is there, else adds it at the end.
// Returns { text, action: "replace" | "append" | "create", previous: the old block's text or null, sepAdded }.
export function applyBlock(text, syntax, value, { defaultEol = "\n" } = {}) {
  const eol = eolOf(text, defaultEol);
  const block = blockLines(syntax, value).join(eol) + eol;
  const found = findBlock(text);
  if (found) return { text: text.slice(0, found.start) + block + text.slice(found.end), action: "replace", previous: found.text, sepAdded: false };
  const sep = text.length && !text.endsWith("\n") ? eol : "";
  return { text: text + sep + block, action: text.length ? "append" : "create", previous: null, sepAdded: sep !== "" };
}

// Takes our block out. `entry` is what applyBlock returned when it was put in: a block that replaced an older one
// of ours is put back as it was; a block that was added at the end of a file without a final line break takes
// that line break with it. Returns { text, removed }.
export function undoBlock(text, entry = {}) {
  const found = findBlock(text);
  if (!found) return { text, removed: false };
  if (entry.action === "replace" && entry.previous) return { text: text.slice(0, found.start) + entry.previous + text.slice(found.end), removed: true };
  let out = text.slice(0, found.start) + text.slice(found.end);
  if (entry.sepAdded && found.start === out.length) out = out.replace(/\r?\n$/, "");
  return { text: out, removed: true };
}

// Lines outside our block that also set CLAUDE_CONFIG_DIR, which the block may or may not win against
// (the later line wins): [{ line, text }].
const OTHER = /(?:^|[\s;])(?:export\s+)?CLAUDE_CONFIG_DIR\s*=|\$env:CLAUDE_CONFIG_DIR\s*=|\bset\s+(?:--?[\w-]+\s+)*CLAUDE_CONFIG_DIR\b|\bsetenv\s+CLAUDE_CONFIG_DIR\b/;
export function otherAssignments(text) {
  const found = findBlock(text);
  const out = [];
  let offset = 0;
  text.split(/(?<=\n)/).forEach((line, i) => {
    const inBlock = found && offset >= found.start && offset < found.end;
    const t = line.trim();
    if (!inBlock && !t.startsWith("#") && OTHER.test(t)) out.push({ line: i + 1, text: t.slice(0, 160) });
    offset += line.length;
  });
  return out;
}

// The value our block in this text sets, or null when there is no block (or it was edited past reading).
export function blockValue(text, syntax) {
  const found = findBlock(text);
  if (!found) return null;
  for (const line of found.text.split(/\r?\n/)) {
    const v = parseAssignment(syntax, line);
    if (v !== null) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Which profile files
// ---------------------------------------------------------------------------------------------

// The profile files this tool knows, for this machine: [{ shell, syntax, file }].
export function profileCandidates(env, { home, platform = process.platform }) {
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, ".config");
  const list = [
    { shell: "bash", syntax: "posix", file: path.join(home, ".bashrc") },
    { shell: "bash", syntax: "posix", file: path.join(home, ".bash_profile") },
    { shell: "sh", syntax: "posix", file: path.join(home, ".profile") },
    { shell: "zsh", syntax: "posix", file: path.join(home, ".zshrc") },
    { shell: "zsh", syntax: "posix", file: path.join(home, ".zshenv") },
    { shell: "fish", syntax: "fish", file: path.join(xdg, "fish", "config.fish") },
  ];
  if (platform === "win32") {
    list.push({ shell: "pwsh", syntax: "powershell", file: path.join(home, "Documents", "PowerShell", "profile.ps1") });
    list.push({ shell: "powershell", syntax: "powershell", file: path.join(home, "Documents", "WindowsPowerShell", "profile.ps1") });
  }
  return list;
}

// The file to create for a shell that has none: bash gets ~/.bashrc (~/.bash_profile on macOS, whose Terminal
// starts login shells), zsh ~/.zshrc, fish its config.fish.
function primaryFor(shell, candidates, platform) {
  if (shell === "bash") return candidates.find((c) => c.file.endsWith(platform === "darwin" ? ".bash_profile" : ".bashrc"));
  if (shell === "zsh") return candidates.find((c) => c.file.endsWith(".zshrc"));
  if (shell === "fish") return candidates.find((c) => c.shell === "fish");
  return undefined;
}

// What `move` will do to profiles: [{ shell, syntax, file, exists, action: "append" | "replace" | "create" }].
// Every candidate that exists gets the block. A profile is created only for the shell in use ($SHELL) when none of
// that shell's files exists, and not at all on Windows, where the user environment reaches every shell.
export function planProfiles(env, { home, platform = process.platform }) {
  const candidates = profileCandidates(env, { home, platform });
  const plan = [];
  for (const c of candidates) {
    const st = statOf(c.file);
    if (!st) continue;
    let action = "append";
    try { if (findBlock(fs.readFileSync(c.file, "utf8"))) action = "replace"; } catch { /* unreadable: the write will say so */ }
    plan.push({ ...c, exists: true, action });
  }
  if (platform !== "win32") {
    const shell = shellInUse(env);
    if (shell && !plan.some((p) => (shell === "bash" ? ["bash", "sh"].includes(p.shell) : p.shell === shell))) {
      const primary = primaryFor(shell, candidates, platform);
      if (primary) plan.push({ ...primary, exists: false, action: "create" });
    }
  }
  return plan;
}

// Folders that do not exist yet above a file, the one nearest to the top first. They are all made by writing the
// file, so they are all ours to remove again (when they are empty).
function missingParents(file) {
  const out = [];
  let dir = path.dirname(file);
  while (!exists(dir) && dir !== path.dirname(dir)) { out.push(dir); dir = path.dirname(dir); }
  return out.reverse();
}

// Writes the block into one profile. Backs an existing file up first (next to it, `<file>.bak-claude-relocate-<time>`).
// Returns the record the manifest keeps: { file, shell, syntax, action, previous, sepAdded, created, mkdirs, backup }.
export function writeProfile(p, value, { home, now = Date.now() } = {}) {
  const isNew = !exists(p.file);
  let text = "";
  let backup = null;
  if (!isNew) {
    text = fs.readFileSync(p.file, "utf8");
    backup = uniquePath(`${p.file}.bak-claude-relocate-${fileStamp(now)}`);
    fs.copyFileSync(p.file, backup);
  }
  const defaultEol = p.syntax === "powershell" && process.platform === "win32" ? "\r\n" : "\n";
  const applied = applyBlock(text, p.syntax, value, { defaultEol });
  const mkdirs = isNew ? missingParents(p.file) : [];
  let out = applied.text;
  // Windows PowerShell 5.1 reads a profile without a byte-order mark as ANSI: a new file with a non-ASCII path needs one.
  if (isNew && p.syntax === "powershell" && /[^\x00-\x7f]/.test(out)) out = `\uFEFF${out}`;
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  writeFileAtomic(p.file, out);
  return { file: p.file, shell: p.shell, syntax: p.syntax, action: applied.action, previous: applied.previous, sepAdded: applied.sepAdded, created: isNew, mkdirs, backup };
}

// Takes our block out of one profile, using the manifest's record of how it went in. Backs the file up first.
// A file that this tool created and that is empty afterwards is deleted, with the folders it created.
// Returns { file, removed, deleted, backup }.
export function removeProfile(rec, { now = Date.now() } = {}) {
  const st = statOf(rec.file);
  if (!st) return { file: rec.file, removed: false, deleted: false, backup: null, note: "the file is gone" };
  const text = fs.readFileSync(rec.file, "utf8");
  const undone = undoBlock(text, rec);
  if (!undone.removed) return { file: rec.file, removed: false, deleted: false, backup: null, note: "no claude-relocate block in it" };
  if (rec.created && undone.text.replace(/^\uFEFF/, "").trim() === "") {
    // a file this tool made, with nothing else in it: no backup is worth keeping
    fs.rmSync(rec.file, { force: true });
    for (const d of [...(rec.mkdirs || [])].reverse()) { try { fs.rmdirSync(d); } catch { /* not empty: not ours to remove */ } }
    return { file: rec.file, removed: true, deleted: true, backup: null };
  }
  const backup = uniquePath(`${rec.file}.bak-claude-relocate-${fileStamp(now)}`);
  fs.copyFileSync(rec.file, backup);
  writeFileAtomic(rec.file, undone.text);
  return { file: rec.file, removed: true, deleted: false, backup };
}

// What a profile says now: { file, shell, exists, block: value | null, others: [...] } for every candidate.
export function readProfiles(env, { home, platform = process.platform }) {
  return profileCandidates(env, { home, platform }).map((c) => {
    const st = statOf(c.file);
    if (!st) return { ...c, exists: false, block: null, others: [] };
    let text = "";
    try { text = fs.readFileSync(c.file, "utf8"); } catch { return { ...c, exists: true, block: null, others: [], unreadable: true }; }
    return { ...c, exists: true, hasBlock: !!findBlock(text), block: blockValue(text, c.syntax), others: otherAssignments(text) };
  });
}
