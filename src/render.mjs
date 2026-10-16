// The text the commands print. Plain sentences, no emoji. JSON output is built in cli.mjs from the same models.
import { KIND_LABEL } from "./inventory.mjs";
import { count, localDay, plural, size } from "./util.mjs";
import { VERSION } from "./version.mjs";

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function names(entries, max = 4) {
  const shown = entries.slice(0, max).join(", ");
  return entries.length > max ? `${shown}, ... (${entries.length - max} more)` : shown;
}

export function header(command, c) {
  return `${c.bold(`claude-relocate ${VERSION}`)}  ${command}`;
}

// ---------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------

export function renderPlan(model, { c }) {
  const o = model.origin;
  const lines = [header("what would move", c)];
  lines.push(`config folder   ${o.configDir}  (${o.source === "default" ? "the default: CLAUDE_CONFIG_DIR is not set" : "from CLAUDE_CONFIG_DIR"}${o.isLink ? `; a link${o.linkTarget ? ` to ${o.linkTarget}` : ""}` : ""}${!o.exists && !o.isLink ? "; it does not exist" : ""})`);
  lines.push(`.claude.json    ${o.claudeJson}  (${o.claudeJsonInside ? "inside the config folder, because CLAUDE_CONFIG_DIR is set" : "next to the config folder, because CLAUDE_CONFIG_DIR is not set"}${o.claudeJsonExists ? "" : "; it does not exist"})`);
  if (o.relocated) lines.push("                This folder is itself the destination of an earlier move (relocate-manifest.json is in it).");
  const T = model.destination;
  if (model.entries.length) {
    lines.push("");
    lines.push(c.dim(`  ${pad("KIND", 18)}${lpad("SIZE", 9)}${lpad("FILES", 9)}  ${T ? pad("GOES TO", 22) : ""}WHAT`));
    for (const k of model.kinds) {
      if (!k.entries.length && k.kind !== "claudeJson") continue;
      const what = k.kind === "claudeJson" ? (o.claudeJsonInside ? "(inside the config folder)" : "(next to the config folder)") : names(k.entries.map((e) => ((model.entries.find((x) => x.name === e) || {}).type === "dir" ? `${e}/` : e)));
      lines.push(`  ${pad(KIND_LABEL[k.kind], 18)}${lpad(size(k.bytes), 9)}${lpad(count(k.files), 9)}  ${T ? pad(k.destination || "", 22) : ""}${what}`);
    }
    lines.push(`  ${pad("total", 18)}${lpad(size(model.total.bytes), 9)}${lpad(count(model.total.files), 9)}`);
    if (model.total.links) lines.push(`  ${plural(model.total.links, "link")} inside: moved as links, never followed.`);
  }
  if (T) {
    lines.push("");
    if (T.mode === "xdg-split") {
      const part = (area) => T.parts.filter((p) => p.area === area).map((p) => p.path).join(", ") || "nothing";
      lines.push(`Destination   config  ${T.config}${T.existedBefore ? "  (exists, empty)" : ""}`);
      lines.push(`              state   ${T.state}   (${part("state")})`);
      lines.push(`              cache   ${T.cache}   (${part("cache")})`);
      lines.push("              Each state and cache part is replaced inside the config folder by a symbolic link.");
    } else lines.push(`Destination   ${T.config}${T.existedBefore ? "  (exists, empty)" : "  (new)"}`);
    lines.push(`Method        ${T.method === "rename" ? "rename: the destination is on the same drive, so nothing is copied" : T.method === "copy" ? "copy, check the copy, then delete the original: the destination is on another drive" : "rename where the drive is the same, copy where it is not"}`);
    for (const s of model.space) {
      lines.push(`Room          ${s.path}: ${s.copy ? `about ${size(s.needBytes)} needed` : "no copy needed"}, ${s.freeBytes === null ? "free space unknown" : `${size(s.freeBytes)} free`}${s.ok ? "" : "  NOT ENOUGH"}`);
    }
    const w = model.env.profiles.map((p) => `${p.file} (${p.action === "create" ? "created" : p.action === "replace" ? "block updated, backup first" : "block added, backup first"})`);
    if (model.env.registry) w.push(`the Windows user environment (${model.env.registry.key})`);
    if (w.length) {
      lines.push(`Also written  CLAUDE_CONFIG_DIR=${T.config} in:`);
      for (const x of w) lines.push(`                ${x}`);
    } else lines.push(`Also written  ${model.env.skipped ? "nothing" : `no profile (none of the known ones exists, and none is created for your shell): set CLAUDE_CONFIG_DIR=${T.config} yourself`}`);
    for (const l of model.links || []) lines.push(`Link left     ${l.path} -> ${l.target}`);
  } else if (model.origin.exists) {
    lines.push("");
    lines.push(c.dim("Pass --to <folder> or --xdg to see where it would go, and the room there."));
  }
  if (model.warnings.length || model.problems.length) lines.push("");
  for (const w of model.warnings) lines.push(`${c.yellow("note")}  ${w}`);
  for (const p of model.problems) lines.push(`${c.red("✗")} ${p.message}`);
  if (model.references.length) {
    lines.push("");
    lines.push("Mentions of the config folder's path:");
    for (const r of model.references.slice(0, 8)) lines.push(`  ${r.file}:${r.line}  ${r.text}`);
    if (model.references.length > 8) lines.push(`  ... and ${model.references.length - 8} more`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// move and undo
// ---------------------------------------------------------------------------------------------

export function renderProblems(title, problems, { c }) {
  return [`${c.red("✗")} ${title}`, ...problems.map((p) => `  - ${p.message}`), "Nothing was changed."].join("\n");
}

export function renderSteps(command, r, { c, dryRun, needsYes }) {
  const lines = [];
  lines.push(dryRun ? "With --dry-run, this is what would happen:" : "This will:");
  // the parts a split sends to the state and cache folders are listed under the step that moves them, not numbered
  let n = 0;
  for (const s of r.steps) lines.push(s.action === "split" ? `       ${s.text.trim()}` : `  ${++n}. ${s.text}`);
  if (r.plan && r.plan.warnings.length) { lines.push(""); for (const w of r.plan.warnings) lines.push(`${c.yellow("note")}  ${w}`); }
  if (r.problems && r.problems.length) { lines.push(""); lines.push(`${c.red("✗")} It would be refused:`); for (const p of r.problems) lines.push(`  - ${p.message}`); }
  lines.push("");
  lines.push(dryRun ? "Nothing was changed (--dry-run)." : needsYes ? "Nothing was changed. Run it again with --yes to do this." : "");
  return lines.join("\n");
}

export function renderMoved(r, { c }) {
  const T = r.plan.destination;
  const lines = [];
  lines.push(`${c.green("Moved")} ${r.plan.origin.configDir} to ${T.config}`);
  lines.push(`  ${r.method === "rename" ? "renamed, not copied: both are on the same drive" : r.method === "copy" ? "copied and checked, then the original was removed" : "renamed where the drive is the same, copied where it is not"}`);
  lines.push(`  ${size(r.bytes)} in ${plural(r.files, "file")}: same files, same sizes, file times kept (checked)`);
  if (r.stale) lines.push(`  The folder's own older .claude.json is kept as ${r.stale} next to the live one.`);
  lines.push(`  manifest: ${r.manifest}`);
  for (const w of r.warnings) lines.push(`${c.yellow("note")}  ${w}`);
  lines.push("");
  lines.push(r.incomplete ? `${c.red("✗")} The move is done, but not everything around it worked (see the notes above).` : "Open a new terminal (this one keeps the environment it started with), then run: claude-relocate verify");
  lines.push("To put everything back: claude-relocate undo");
  return lines.join("\n");
}

export function renderUndone(r, { c }) {
  const lines = [];
  lines.push(`${c.green("Undone.")} ${r.destination} is back at ${r.origin}`);
  lines.push(`  ${r.method === "rename" ? "renamed, not copied: both are on the same drive" : "copied and checked, then the copy in the new place was removed"}`);
  for (const w of r.warnings) lines.push(`${c.yellow("note")}  ${w}`);
  lines.push("");
  lines.push(r.incomplete ? `${c.red("✗")} The folder is back, but not everything around it could be undone (see the notes above).` : "Open a new terminal. If this terminal has CLAUDE_CONFIG_DIR set, it still points at the old place: unset it here too.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// verify and status
// ---------------------------------------------------------------------------------------------

export function renderVerify(r, { c }) {
  const lines = [header("verify", c)];
  const tag = { ok: c.green("ok  "), fail: c.red("FAIL"), warn: c.yellow("warn"), info: c.dim("info"), skip: c.dim("skip") };
  for (const k of r.checks) {
    lines.push(`  ${tag[k.level]}  ${k.message}`);
    for (const extra of k.lines || []) lines.push(`        ${extra}`);
  }
  const failed = r.checks.filter((k) => k.level === "fail").length;
  lines.push("");
  lines.push(r.ok ? "Every check passed." : `${c.red("✗")} ${failed} check${failed === 1 ? "" : "s"} failed.`);
  lines.push("Open a new terminal so that it starts with CLAUDE_CONFIG_DIR, then start claude there. Terminals that were open before the move keep the old environment.");
  return lines.join("\n");
}

export function renderStatus(s, { c }) {
  const lines = [header("status", c)];
  lines.push(`config folder   ${s.configDir.path}  (${s.thisTerminal.source === "default" ? "the default: CLAUDE_CONFIG_DIR is not set in this terminal" : "CLAUDE_CONFIG_DIR in this terminal"}${s.configDir.isLink ? (s.configDir.resolvesTo ? `; a link to ${s.configDir.resolvesTo}` : "; a link that leads nowhere") : s.configDir.exists ? "" : "; it does not exist"})`);
  lines.push(`.claude.json    ${s.claudeJson.path}  (${s.claudeJson.exists ? (s.claudeJson.size === null ? "a link" : size(s.claudeJson.size)) : "does not exist"}; ${s.claudeJson.inside ? "inside the config folder" : "next to the config folder"})`);
  if (s.moved) {
    lines.push(`moved           ${s.moved.from} to ${s.moved.to} on ${localDay(Date.parse(s.moved.date))} (${s.moved.mode === "xdg-split" ? "split into config, state and cache folders" : "one folder"}, by ${s.moved.method})`);
    lines.push(`                manifest: ${s.moved.manifest}`);
  } else lines.push("moved           no relocate-manifest.json found: not moved by claude-relocate, or it is gone");
  for (const l of s.links) lines.push(`link            ${l.path} -> ${l.target}  (${l.resolves ? "resolves" : l.isLink ? "does not resolve" : "is not a link now"})`);
  lines.push("");
  lines.push("A terminal started now will have:");
  const nameWidth = Math.max(9, ...s.newTerminals.map((r) => r.name.length + 2));
  for (const r of s.newTerminals) lines.push(`  ${pad(r.name, nameWidth)}${r.value !== null ? `CLAUDE_CONFIG_DIR=${r.value}` : "CLAUDE_CONFIG_DIR not set"}  (${r.from})`);
  if (!s.newTerminals.length) lines.push("  nothing from claude-relocate");
  for (const p of s.profiles) for (const o of p.others) lines.push(`${c.yellow("note")}  ${p.file} line ${o.line} also sets CLAUDE_CONFIG_DIR: ${o.text}`);
  lines.push(`This terminal: ${s.thisTerminal.variable !== null ? `CLAUDE_CONFIG_DIR=${s.thisTerminal.variable}` : "CLAUDE_CONFIG_DIR is not set"}.`);
  return lines.join("\n");
}

