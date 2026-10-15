// Copyright 2026 Foxel
// SPDX-License-Identifier: Apache-2.0
//
// Foxel rmShield: holds a risky Bash command and shows what it would change.
//
// tool.call (Bash): if the command is risky, work out what it would change, open a
// pane with Proceed and Cancel, and hold the call until one is pressed.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

const PANE_ID = "foxel-rmshield";
const POLL_SECONDS = "0.25";
// Windows: Git for Windows is not on the PATH the host uses, so use its full paths.
const BASH_BIN = "C:/Program Files/Git/bin/bash.exe";
const SLEEP_BIN = "C:/Program Files/Git/usr/bin/sleep.exe";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;
const FILE_CAP = 2000; // rm: files measured one by one; past this only the totals
const PATH_CAP = 200; // rm: expanded targets listed (for git); the totals count them all
// After Proceed: polls of sweep before the command runs, and how long "Done" stays up.
const RUN_PREROLL_POLLS = 2;
// How far the sweep goes before the command has run: modest, since nothing is done yet.
const RUN_PROGRESS = 0.5;
const DONE_SECONDS = "1.2";



// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held = null;

// What the model is told when the guard itself fails before the command runs.
const INTERNAL_DENY = "Foxel rmShield held this command and did not run it: it hit an internal error. Do not retry it unless the user asks you to.";
// What each command that ran answered, by its event, so a failure after the run
// hands that answer back instead of running the command again.
const ran = new WeakMap();

export function register(on) {
  // The host runs the tool when a guard fails, so this one fails closed: any
  // throw before the command runs refuses it, and after it never runs it twice.
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    let isRun = false;
    try {
      return await holdCall($, e, next, () => {
        isRun = true;
      });
    } catch (error) {
      if (isRun) {
        throw error; // the command's own failure, or one after it: its answer stands
      }
      return { deny: INTERNAL_DENY };
    }
  }).catch(($, e, next) => {
    // A budget overrun, or a throw past the try above.
    if (!next.called) {
      return { deny: INTERNAL_DENY };
    }
    if (ran.has(e)) {
      return ran.get(e);
    }
    throw new Error("Foxel rmShield failed after the command started; its answer stands");
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) {
      return next(e);
    }
    return drawFor($.ui.resolve(e), held, e, "pane");
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== "band") {
      return next(e);
    }
    return drawFor($.ui.resolve(e), held, e, "band");
  });
}

/** Holds a Bash call while the user decides; `markRun` is called just before the command runs. */
async function holdCall($, e, next, markRun) {
  const run = async () => {
    markRun();
    const result = await next(e);
    ran.set(e, result);
    return result;
  };
  const risk = classify(String(e.command ?? ""));
  if (risk === null) {
    return run();
  }
  // One hold at a time. If another risky call is already held (a subagent's,
  // say), wait until it is answered. `held` is claimed with no await between
  // the check and the claim, so two waiting calls can't both get through.
  while (held !== null) {
    if (next.signal.aborted) {
      return { deny: "Foxel rmShield held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to." };
    }
    await $.process.run([SLEEP_BIN, POLL_SECONDS], { timeoutMs: 5000 });
  }
  const mine = { command: String(e.command), risk, report: null, decision: null, where: "pane", phase: "held", progress: 0 };
  held = mine;

  let opened = { isPlaced: false };
  let summary = risk.label;
  // Whatever happens from here, the pane closes and the hold is released.
  try {
    try {
      // Measure where the command will run: the session folder, moved by any
      // `cd dir &&` or `git -C dir` earlier in the same command line.
      const sessionCwd = await $.session.cwd();
      const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd;
      mine.report = cwd === null
        ? { summary: `${risk.label} in ${risk.dir}`, lines: [], note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.`, where: baseName(risk.dir) }
        : await measure($, risk, cwd);
      summary = mine.report.summary;

      opened = (await $.ui.open({ id: PANE_ID, title: "Foxel rmShield", focus: true, rows: paneRows(mine) })) ?? { isPlaced: false };
      if (!opened.isPlaced) {
        mine.where = "band";
      }
      $.ui.invalidate("ui.render");

      const startedAt = await $.clock.now();
      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = "interrupted";
          break;
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = "timeout";
          break;
        }
        await $.process.run([SLEEP_BIN, POLL_SECONDS], { timeoutMs: 5000 });
        // The hold's clock, so a redraw continues the CSS animations instead of restarting them.
        mine.tick = (mine.tick ?? 0) + 1;
      }
    } catch {
      // Anything unexpected refuses the command, even if Proceed was pressed meanwhile.
      mine.decision = "error";
    }

    if (mine.decision !== "proceed") {
      const why = {
        cancel: "the user pressed Cancel",
        timeout: "no answer within 10 minutes",
        interrupted: "the turn was interrupted",
        error: "Foxel rmShield hit an error while holding it",
      }[mine.decision] ?? "no answer was recorded";
      return { deny: `Foxel rmShield held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.` };
    }

    try {
      $.ui.toast("Foxel rmShield: running it");
    } catch {
      // a toast is only a courtesy
    }
    // Show the run: a short sweep, then the command; "Done" only once it ran and wasn't refused.
    mine.phase = "deleting";
    for (let i = 0; i < RUN_PREROLL_POLLS; i += 1) {
      mine.tick = (mine.tick ?? 0) + 1;
      mine.progress = ((i + 1) * RUN_PROGRESS) / RUN_PREROLL_POLLS;
      invalidateQuietly($);
      await $.process.run([SLEEP_BIN, POLL_SECONDS], { timeoutMs: 5000 });
      // Checked after each pause, so an interruption during the last one still refuses.
      if (next.signal.aborted) {
        return { deny: `Foxel rmShield held this command and did not run it: the turn was interrupted. It would have: ${summary}. Do not retry it unless the user asks you to.` };
      }
    }
    const result = await run();
    if (result !== null && typeof result === "object" && "deny" in result && result.deny) {
      return result; // refused beneath: no "Done"
    }
    mine.phase = "done";
    mine.progress = 1;
    invalidateQuietly($);
    try {
      await $.process.run([SLEEP_BIN, DONE_SECONDS], { timeoutMs: 5000 });
    } catch {
      // the command already ran; its result matters more than the pause
    }
    return result;
  } finally {
    await closeHeld($, mine, opened);
  }
}

/** Asks for a redraw; a failure to redraw never changes what happens to the command. */
function invalidateQuietly($) {
  try {
    $.ui.invalidate("ui.render");
  } catch {
    // the next redraw catches up
  }
}

// Closes this call's pane, then releases the hold, so the next call's pane
// can't be the one that gets closed. Nothing here can throw.
async function closeHeld($, mine, opened) {
  try {
    if (opened?.isPlaced) {
      await $.ui.close({ id: PANE_ID });
    }
  } catch {
    // the pane is already gone
  }
  if (held === mine) {
    held = null;
  }
  try {
    $.ui.invalidate("ui.render");
  } catch {
    // nothing left to draw
  }
}

// ---- What counts as risky -------------------------------------------------

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git"]);

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir, arg) {
  if (arg === undefined || arg === "~" || arg.startsWith("/") || arg.startsWith("~/")) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** The first risky segment of a shell command, or null. */
function classify(command) {
  let dir = null; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes = []; // dir to restore when a ( subshell ) closes
  const pushed = []; // pushd stack, for popd
  // An unescaped backslash before a newline continues the line, so the shell
  // drops both; an escaped one (`\\`) is a literal backslash and the line ends.
  for (const raw of command.replace(/(?<!\\)((?:\\\\)*)\\\r?\n/g, "$1").split(/&&|\|\||;|\||\n/)) {
    const opens = (raw.match(/^\s*\(+/)?.[0].trim().length) ?? 0;
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const closes = (tail.match(/\)+\s*$/)?.[0].trim().length) ?? 0;
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir);
    }
    const risk = classifySegment(raw, dir, pushed);
    if (risk !== null && risk.cd === undefined) {
      return risk;
    }
    if (risk !== null) {
      dir = risk.cd; // a cd, pushd or popd moved the folder
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop(); // a cd inside ( ... ) doesn't outlive it
    }
  }
  return null;
}

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(["command", "exec", "env", "nohup", "time", "then", "do", "else", "!"]);

/** One segment: a risk, { cd } for a folder change, or null. */
function classifySegment(segment, dir, pushed) {
  {
    // Trailing redirects and & go first, so `(rm -rf build) > log` ends in its ).
    // A digit redirect counts only as a word of its own or right after ), since
    // `build2>log` is the argument build2. Then ( and ) group wherever they
    // stand; { and } only as words of their own, since {a,b} is brace expansion.
    const bare = segment.trim().replace(/(?:(?:\s+|(?<=\)))(?:\d*>>?&?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const words = tokenize(bare.replace(/^\(+\s*/, "").replace(/^\{\s+/, "").replace(/\s*\)+$/, "").replace(/(^|\s)\}+$/, ""));
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      words.shift(); // leading VAR=value
    }
    if (words[0] === "sudo") {
      words.shift();
      while (words.length > 0 && words[0].startsWith("-")) {
        const option = words.shift();
        if (SUDO_VALUE_OPTIONS.has(option)) {
          words.shift();
        }
      }
    }
    while (words.length > 0 && (PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
      words.shift();
    }
    if (words[0] === "nice") {
      words.shift();
      if (words[0] === "-n") {
        words.splice(0, 2);
      } else if (/^-\d+$/.test(words[0] ?? "")) {
        words.shift();
      }
    }
    const [first, ...args] = words;
    if (first === undefined) {
      return null;
    }
    const cmd = first.replace(/^\\/, ""); // \rm skips aliases; it's still rm
    if (cmd === "cd") {
      return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0]) };
    }
    if (cmd === "pushd") {
      pushed.push(dir);
      return { cd: joinDir(dir, args[0]) };
    }
    if (cmd === "popd") {
      return { cd: pushed.length > 0 ? pushed.pop() : "-" };
    }
    if (cmd === "rm" || cmd.endsWith("/rm")) {
      const flags = args.filter((a) => a.startsWith("-"));
      const recursive = flags.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)));
      const force = flags.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")));
      if (recursive || force) {
        const targets = withoutRedirects(args).filter((a) => !a.startsWith("-") || a === "-");
        return { kind: "rm", label: `rm ${flags.join(" ")}`.trim(), targets, dir };
      }
    }
    if (cmd === "git") {
      // Git's own options come before the subcommand; -C moves where it runs.
      let gitDir = dir;
      let i = 0;
      while (i < args.length && args[i].startsWith("-")) {
        if (args[i] === "-C" && i + 1 < args.length) {
          gitDir = joinDir(gitDir, args[i + 1]);
          i += 2;
        } else if (args[i] === "-c" && i + 1 < args.length) {
          i += 2;
        } else {
          i += 1;
        }
      }
      const sub = args[i];
      const rest = args.slice(i + 1);
      if (sub === "reset" && rest.includes("--hard")) {
        return { kind: "git-reset", label: "git reset --hard", args: rest, dir: gitDir };
      }
      if (sub === "clean") {
        return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir };
      }
      if (sub === "push" && rest.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || /^\+/.test(a))) {
        return { kind: "git-push-force", label: "git push --force", args: rest, dir: gitDir };
      }
      const stagedOnly = sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
      if ((sub === "checkout" || sub === "restore") && rest.includes(".") && !stagedOnly) {
        return { kind: "git-checkout", label: `git ${sub} -- .`, args: rest, dir: gitDir };
      }
    }
    const joined = words.join(" ");
    if (/\balembic\s+upgrade\b/.test(joined)) {
      return { kind: "migrate", tool: "alembic", label: "alembic upgrade", dir };
    }
    if (/\bdb:migrate(?!:status\b)/.test(joined)) {
      return { kind: "migrate", tool: "rails", label: "db:migrate", dir };
    }
    if (/\bprisma\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "prisma", label: "prisma migrate", dir };
    }
    if (/\bmanage\.py\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "django", label: "manage.py migrate", dir };
    }
    if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
      return { kind: "migrate", tool: "unknown", label: "migrate", dir };
    }
  }
  return null;
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && { pwd -W 2>/dev/null || pwd -P; }`;

async function resolveDir($, sessionCwd, dir) {
  if (dir === "-") {
    return null; // `cd -` depends on the shell's history
  }
  const run = await $.process.run([BASH_BIN, "-c", CD_SCRIPT, "foxel-rmshield", dir], { cwd: sessionCwd, timeoutMs: 5000 });
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

/** The words left once redirections (`>log`, `2>&1`, `> log`, `x>log`) are taken out. */
function withoutRedirects(words) {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    const at = w.search(/[<>]/);
    if (at < 0) {
      out.push(w);
      continue;
    }
    const before = w.slice(0, at);
    if (before !== "" && before !== "&" && !/^\d+$/.test(before)) {
      out.push(before); // x>log: x is still an argument
    }
    if (/^(?:\d*|&)[<>]+&?$/.test(w)) {
      i += 1; // a bare operator: the next word is where it points
    }
  }
  return out;
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
function tokenize(text) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

// ---- Measuring what the command would change -------------------------------------------

/** { summary, lines, note, where } for the pane. Never throws: a failed read is said, not hidden. */
async function measure($, risk, cwd) {
  let report;
  try {
    if (risk.kind === "rm") {
      report = await measureRm($, risk, cwd);
    } else if (risk.kind === "migrate") {
      report = await measureMigrations($, risk, cwd);
    } else {
      report = await measureGit($, risk, cwd);
    }
  } catch (error) {
    report = { summary: `${risk.label} (could not measure it: ${String(error?.message ?? error).slice(0, 300)})`, lines: [], note: `Could not measure: ${String(error?.message ?? error).slice(0, 200)}` };
  }
  report.where = baseName(cwd);
  return report;
}

/** The last part of a path, Windows or POSIX style. */
function baseName(path) {
  const trimmed = String(path ?? "").replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || String(path ?? "");
}

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "@total 0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*|[A-Za-z]:*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
# The paths reach find on its input, so a glob of thousands can't overflow a command line.
list() { printf '%s\\0' "\${paths[@]}" | find -files0-from - \\( -type f -o -type l \\) "$@" 2>/dev/null; }
# The totals come first, so a cut or a failure later on can't hide them.
echo "@total $(list -printf '%s\\n' | awk '{ n++; s += $1 } END { printf "%d %.0f", n, s }') \${#paths[@]}"
# Where this runs, both spellings, so absolute paths can be shown relative to it.
echo "@cwd $(pwd -W 2>/dev/null)"
echo "@cwd $(pwd)"
for p in "\${paths[@]:0:${PATH_CAP}}"; do echo "@path $p"; done
# Then the files as size<TAB>path, the first ${FILE_CAP}.
list -printf '%s\\t%p\\n' | head -n ${FILE_CAP}
`;

async function measureRm($, risk, cwd) {
  if (risk.targets.length === 0) {
    return { summary: "rm with no paths", lines: [], note: "No paths to expand." };
  }
  // A target the shell still has to expand ($x, `cmd`, {a,b}) can't be measured
  // from its spelling; say so rather than report that nothing matches.
  const expanded = risk.targets.find((t) => /[$`{}]/.test(t));
  if (expanded !== undefined) {
    return { summary: `delete (can't measure: shell expansion in ${expanded})`, lines: [], note: `${expanded} uses shell expansion, so I can't tell which files this would delete.` };
  }
  let run;
  try {
    run = await $.process.run([BASH_BIN, "-c", RM_SCRIPT, "foxel-rmshield", ...risk.targets], { cwd, timeoutMs: 60000 });
  } catch {
    run = null;
  }
  const bases = [];
  const top = [];
  const seen = new Set();
  const entries = [];
  let totals = null;
  // Never "nothing" when the measure failed: a missing total, a cut or a failed script is said as such.
  const failure = run === null ? "it failed or took too long"
    : run.isStdoutTruncated ? "output too large"
      : run.exitCode !== 0 ? "script failed"
        : /^@total \d+ \d+ \d+\r?(\n|$)/.test(run.stdout) ? null : "no totals";
  if (failure !== null) {
    return { summary: `delete files (could not measure: ${failure})`, lines: [], note: `I couldn't measure what ${risk.targets.join(" ")} would delete (${failure}). Whatever it deletes can't be undone.` };
  }
  for (const line of run.stdout.split("\n").map((l) => l.replace(/\r$/, ""))) {
    if (line.startsWith("@cwd ")) {
      if (line.length > 5) {
        bases.push(line.slice(5).replace(/\/$/, "").toLowerCase());
      }
    } else if (line.startsWith("@path ")) {
      top.push(relativeTo(bases, line.slice(6))); // git doesn't read /c/... or /tmp/... paths
    } else if (line.startsWith("@total ") && totals === null) {
      totals = line.slice(7);
    } else if (line.includes("\t")) {
      const tab = line.indexOf("\t");
      const path = relativeTo(bases, line.slice(tab + 1));
      if (!seen.has(path)) {
        seen.add(path); // overlapping targets list a file twice
        const slash = path.lastIndexOf("/");
        entries.push({ path, dir: slash < 0 ? "" : path.slice(0, slash), name: path.slice(slash + 1), bytes: Number(line.slice(0, tab)) || 0 });
      }
    }
  }
  let [files, bytes, found] = totals.split(" ").map(Number);
  if (!found) {
    return { summary: `delete nothing: no file matches ${risk.targets.join(" ")}`, lines: [], note: "The paths don't exist, so rm has nothing to remove." };
  }
  if (!files) {
    return { summary: `delete ${found} ${found === 1 ? "path" : "paths"} with no files in ${found === 1 ? "it" : "them"}`, lines: [], note: `Paths: ${risk.targets.join(" ")}` };
  }
  const capped = files > FILE_CAP;
  if (!capped) {
    files = entries.length;
    bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  }
  return {
    summary: `delete ${files} ${files === 1 ? "file" : "files"} (about ${size(bytes)})`,
    lines: [],
    entries,
    files,
    bytes,
    capped,
    // When the paths were cut, ask git about the whole folder instead.
    tracked: await countTracked($, cwd, top.length < found ? [] : top, entries),
    note: capped ? `Listed the first ${FILE_CAP} of ${files} files; folder totals count only those.` : `Paths: ${risk.targets.join(" ")}`,
  };
}

/** A path from find, relative to the folder it was measured in when it's inside it. */
function relativeTo(bases, path) {
  const plain = path.replace(/^(?:\.\/)+/, ""); // `rm -rf .` lists ././name
  const lower = plain.toLowerCase();
  for (const base of bases) {
    if (base !== "" && lower.startsWith(`${base}/`)) {
      return plain.slice(base.length + 1) || ".";
    }
  }
  return plain || ".";
}

/** How many entries git tracks: a number, null outside a repository, undefined if git couldn't say. */
async function countTracked($, cwd, top, entries) {
  // Too many top-level paths for one command line: list the whole folder instead.
  const spec = top.join(" ").length > 24000 ? [] : top;
  let run;
  try {
    // The paths are already expanded, so git must not read * or : in them.
    run = await $.process.run(["git", "--literal-pathspecs", "ls-files", "-z", "--", ...spec], { cwd, timeoutMs: 15000 });
  } catch {
    return undefined;
  }
  if (run.exitCode !== 0) {
    return /not a git repository/i.test(run.stderr) ? null : undefined;
  }
  const tracked = new Set(run.stdout.split("\0").filter((p) => p !== "").map((p) => p.toLowerCase()));
  return entries.filter((e) => tracked.has(e.path.toLowerCase())).length;
}

async function measureGit($, risk, cwd) {
  if (risk.kind === "git-push-force") {
    return await measurePush($, risk, cwd);
  }
  if (risk.kind === "git-clean") {
    const flags = [];
    const paths = [];
    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i];
      if (a === "--") {
        paths.push(...risk.args.slice(i + 1));
        break;
      }
      if (a === "-e" || a === "--exclude") {
        flags.push(a, risk.args[i + 1] ?? "");
        i += 1;
      } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
        flags.push(a);
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, ""); // -n is added below; -f, -i and -q would change the dry run
        if (kept !== "-") {
          flags.push(kept);
        }
      } else if (!a.startsWith("-")) {
        paths.push(a);
      }
    }
    const run = await $.process.run(["git", "clean", "-n", ...flags, "--", ...paths], { cwd, timeoutMs: 15000 });
    if (run.exitCode !== 0) {
      return { summary: "git clean (could not dry-run it)", lines: [], note: run.stderr.trim().slice(0, 200) };
    }
    const gone = run.stdout.split("\n").filter((l) => l.startsWith("Would remove ")).map((l) => l.slice(13));
    return {
      summary: gone.length === 0 ? "remove nothing: no untracked files match" : `remove ${gone.length} untracked ${gone.length === 1 ? "path" : "paths"}`,
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    };
  }
  const status = await $.process.run(["git", "status", "--porcelain"], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const rows = status.stdout.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const lost = risk.kind === "git-reset" ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run(["git", "diff", "--shortstat", risk.kind === "git-reset" ? "HEAD" : "--"], { cwd, timeoutMs: 15000 });
  return {
    summary: lost.length === 0 ? "discard nothing: no uncommitted changes" : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? "file" : "files"}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== "" ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.` : "From git status --porcelain.",
  };
}

async function measurePush($, risk, cwd) {
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (!branch) {
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  } else if (branch === "HEAD") {
    // `git push origin HEAD` pushes the current branch to its namesake.
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  const ref = `${remote}/${branch}`;
  const known = await $.process.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
  if (known.exitCode !== 0) {
    return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` };
  }
  const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", `${source}..${ref}`], { cwd, timeoutMs: 15000 });
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? "commit" : "commits"}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  };
}

const MIGRATION_LISTERS = {
  django: { argv: ["python3", "manage.py", "showmigrations", "--plan"], pending: (l) => l.startsWith("[ ]"), strip: (l) => l.slice(4) },
  alembic: { argv: ["alembic", "history", "-r", "current:head"], pending: (l) => l.includes("->"), strip: (l) => l },
  rails: { argv: ["bin/rails", "db:migrate:status"], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ["npx", "--no-install", "prisma", "migrate", "status"], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
};

async function measureMigrations($, risk, cwd) {
  const lister = MIGRATION_LISTERS[risk.tool];
  if (lister === undefined) {
    return { summary: "run migrations", lines: [], note: "I can't list the pending migrations for this tool, so the list is not shown." };
  }
  let run;
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 });
  } catch (error) {
    run = { exitCode: -1, stdout: "", stderr: String(error?.message ?? error) };
  }
  if (run.exitCode !== 0) {
    return { summary: `run ${risk.label}`, lines: [], note: `Couldn't list pending migrations (${lister.argv.join(" ")} failed).` };
  }
  const pending = run.stdout.split("\n").filter(lister.pending).map(lister.strip);
  return {
    summary: pending.length === 0 ? `run ${risk.label}: nothing pending` : `apply ${pending.length} pending ${pending.length === 1 ? "migration" : "migrations"}`,
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `From ${lister.argv.join(" ")}.`,
  };
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------
// Tokyo Night (dark), the user's skin palette.
const COLOR = { fg: "#c0caf5", muted: "#737aa2", err: "#f7768e", warn: "#e0af68", ok: "#9ece6a", rule: "#3b4261", accent: "#7aa2f7" };
const PANE_MAX_ROWS = 24;
// The pane can be this narrow and its font proportional, so heights are
// estimated for this width (an over-estimate when the pane is wider).
const NARROW_COLUMNS = 34;
// The terminal's stand-in for Foxel: one shield glyph beside the header.
const MARK = "◈";
const MARK_COLUMNS = 1;
// Text width beside the mark (border + padding 4, mark 1 + margin 1) and for the
// banner (4), less 2 so wider glyphs in a proportional font still fit the estimate.
const HEADER_COLUMNS = NARROW_COLUMNS - 4 - MARK_COLUMNS - 1 - 2;
const BANNER_COLUMNS = NARROW_COLUMNS - 4 - 2;

/** Lines `text` takes when word-wrapped to `columns`. */
function wrappedLines(text, columns) {
  let lines = 1;
  let used = 0;
  for (const word of text.split(" ")) {
    let w = word.length;
    const need = used === 0 ? w : used + 1 + w;
    if (need <= columns) {
      used = need;
      continue;
    }
    if (used > 0) {
      lines += 1;
    }
    while (w > columns) {
      lines += 1; // a word longer than the line is broken
      w -= columns;
    }
    used = w;
  }
  return lines;
}

/** [command, verb, amount] for the header line. */
function headline(state) {
  const { report, risk } = state;
  const subject = shorten((risk.kind === "rm" ? `${risk.label} ${risk.targets.join(" ")}` : risk.label).trim(), 48);
  if (report.entries !== undefined) {
    return [subject, " will delete ", `${report.files} ${report.files === 1 ? "file" : "files"} · ${size(report.bytes)}`];
  }
  return /^(delete|discard|remove|force-push|apply|run)\b/.test(report.summary) ? [subject, " will ", report.summary] : [subject, " · ", report.summary];
}

/**
 * Rows the pane needs besides the list, counted at the narrow width: border 2,
 * header (wrapped line + folder, at least 3), margin 1, banner
 * (wrapped), rule 1, capped note 1, margin 1, buttons 1, hint 1.
 */
function fixedRows(state) {
  const header = Math.max(3, wrappedLines(headline(state).join(""), HEADER_COLUMNS) + 1);
  const warning = wrappedLines(`⚠ ${banner(state).text}`, BANNER_COLUMNS);
  return 2 + header + 1 + warning + 1 + (state.report.capped ? 1 : 0) + 1 + 1 + 1;
}

/** Rows the list may use: the list is what gets cut, never the buttons. */
function listRoom(state) {
  return Math.max(0, PANE_MAX_ROWS - fixedRows(state));
}

function paneRows(state) {
  const rows = listRows(state.report, listRoom(state)).length;
  // With no list there's no rule either.
  const text = fixedRows(state) + rows - (rows === 0 ? 1 : 0);
  // The desktop card, in rows of ROW_PX at the narrowest width, plus the buttons.
  // The surface isn't known yet, so take the larger.
  const svg = Math.ceil(cardLayout(state, 240).height / ROW_PX) + BUTTON_ROWS;
  return Math.min(PANE_MAX_ROWS, Math.max(text, svg));
}

/**
 * The list under the rule, one line per row, cut to `room` rows. rm groups
 * files by folder, largest first; the other kinds show their lines as they are.
 */
function listRows(report, room) {
  if (report.entries === undefined) {
    const lines = report.lines ?? [];
    const hidden = report.more ?? 0;
    const shown = lines.length + (hidden > 0 ? 1 : 0) <= room ? lines.length : Math.max(0, room - 1);
    const rows = lines.slice(0, shown).map((text) => ({ type: "line", text }));
    const more = hidden + lines.length - shown;
    if (more > 0 && room > 0) {
      rows.push({ type: "more", text: `+ ${more} more` });
    }
    return rows;
  }
  const groups = new Map();
  for (const e of report.entries) {
    const g = groups.get(e.dir) ?? { dir: e.dir, bytes: 0, count: 0, shown: [] };
    g.bytes += e.bytes;
    g.count += 1;
    groups.set(e.dir, g);
  }
  // Largest files first, across all folders; a folder's row is paid for by its first file.
  const bySize = [...report.entries].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  let used = 0;
  let shownCount = 0;
  let shownBytes = 0;
  for (const e of bySize) {
    const g = groups.get(e.dir);
    const cost = g.shown.length === 0 ? 2 : 1;
    const left = report.files - shownCount - 1;
    if (shownCount >= LIST_MAX || used + cost + (left > 0 ? 1 : 0) > room) {
      break;
    }
    g.shown.push(e);
    used += cost;
    shownCount += 1;
    shownBytes += e.bytes;
  }
  const rows = [];
  const order = [...groups.values()].filter((g) => g.shown.length > 0).sort((a, b) => b.bytes - a.bytes || a.dir.localeCompare(b.dir));
  for (const g of order) {
    // A capped list only knows its own files, so a folder's count and size are lower bounds.
    rows.push({ type: "group", label: `${g.dir === "" ? "." : g.dir}/`, count: g.count, bytes: g.bytes, atLeast: report.capped === true });
    for (const e of g.shown) {
      rows.push({ type: "file", label: e.name, bytes: e.bytes });
    }
  }
  const more = report.files - shownCount;
  if (more > 0 && room > 0) {
    rows.push({ type: "more", text: `+ ${more} more ${more === 1 ? "file" : "files"} · ${size(Math.max(0, report.bytes - shownBytes))}` });
  }
  return rows;
}

/** The warning under the header: { tone, text }. */
function banner(state) {
  const { report } = state;
  if (report.entries !== undefined) {
    const { tracked } = report;
    const counted = report.capped ? report.entries.length : report.files;
    if (tracked === null) {
      return { tone: COLOR.err, text: "Not in a git repository, so deleted files can't be restored." };
    }
    if (tracked === undefined) {
      return { tone: COLOR.err, text: "Couldn't check these files against git, so assume they can't be restored." };
    }
    if (report.capped) {
      // Only the listed files were checked: say so, and say nothing of the rest.
      const checked = `Checked the first ${counted} of ${report.files} files:`;
      if (tracked === 0) {
        return { tone: COLOR.err, text: `${checked} none are tracked by git, so they can't be restored. The others weren't checked.` };
      }
      return { tone: COLOR.warn, text: `${checked} ${tracked} are tracked by git and can be restored, ${counted - tracked} can't. The others weren't checked.` };
    }
    if (tracked === 0) {
      return { tone: COLOR.err, text: counted === 1 ? "This file isn't tracked by git, so it can't be restored." : "None of these are tracked by git, so they can't be restored." };
    }
    if (tracked >= counted) {
      return { tone: COLOR.warn, text: counted === 1 ? "This file is tracked by git, so its committed version can be restored." : `All ${counted} files are tracked by git, so their committed versions can be restored.` };
    }
    return { tone: COLOR.warn, text: `${tracked} of ${counted} files are tracked by git and can be restored; the other ${counted - tracked} can't.` };
  }
  let text = report.note ?? "";
  if (state.risk.kind === "git-clean") {
    text = text.replace(/^From git clean -n\.\s*/, "");
  }
  if ((state.risk.kind === "git-reset" || state.risk.kind === "git-checkout") && text.startsWith("From git status")) {
    text = "Uncommitted changes can't be recovered.";
  }
  return { tone: COLOR.err, text: text || "Foxel rmShield couldn't tell what this would change." };
}

/** "4 files", or "≥4 files" when the list was capped and the folder may hold more. */
const groupCount = (row) => `${row.atLeast ? "≥" : ""}${row.count} ${row.count === 1 ? "file" : "files"}`;

function buttonLabel(state) {
  const { report } = state;
  const kind = state.risk.kind;
  const count = kind === "rm" ? report.files ?? 0 : kind === "git-clean" ? (report.lines ?? []).length + (report.more ?? 0) : 0;
  if (kind === "rm" || kind === "git-clean") {
    return count > 0 ? `Delete ${count} ${count === 1 ? "file" : "files"}` : "Proceed";
  }
  return { "git-reset": "Discard changes", "git-checkout": "Discard changes", "git-push-force": "Force push", migrate: "Run migration" }[kind] ?? "Proceed";
}

function shorten(text, width) {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function draw(t, state) {
  const { Box, Text, Button } = t;
  const { report, risk } = state;
  const rows = listRows(report, listRoom(state));
  const [subject, verb, amount] = headline(state);
  const warning = banner(state);

  // Each list row is one line of boxes: the name takes what's left and is cut;
  // the count and size keep their width. Nothing is padded with spaces, since
  // the pane's font can be proportional.
  const line = (key, children, extra = {}) => Box({ key, flexDirection: "row", height: 1, overflow: "hidden", ...extra, children });
  const name = (children, indent = 0) => Box({ key: "name", flexGrow: 1, flexShrink: 1, overflow: "hidden", height: 1, paddingLeft: indent, children: Text({ wrap: "truncate-end", children }) });
  // Sizes that hold a fifth or more of the bytes stand out.
  const sizeBox = (bytes, strong, atLeast = false) => Box({ key: "size", flexShrink: 0, width: 8, justifyContent: "flex-end", children: Text({ color: strong ? COLOR.fg : COLOR.muted, bold: strong, children: `${atLeast ? "≥" : ""}${size(bytes)}` }) });
  const big = (bytes) => bytes >= 0.2 * (report.bytes || 1);
  const list = rows.map((row, i) => {
    const key = `r${i}`;
    if (row.type === "group") {
      return line(key, [
        name([Text({ key: "mark", color: COLOR.muted, children: "▸ " }), Text({ key: "dir", color: COLOR.fg, bold: true, children: row.label })]),
        Box({ key: "count", flexShrink: 0, marginLeft: 1, children: Text({ color: COLOR.muted, children: groupCount(row) }) }),
        sizeBox(row.bytes, true, row.atLeast),
      ]);
    }
    if (row.type === "file") {
      return line(key, [name(Text({ color: COLOR.fg, children: row.label }), 2), sizeBox(row.bytes, big(row.bytes))]);
    }
    if (row.type === "more") {
      return line(key, [name(Text({ color: COLOR.muted, children: row.text }))], { paddingLeft: 2 });
    }
    // git status lines start with a two-letter status code.
    if ((risk.kind === "git-reset" || risk.kind === "git-checkout") && /^.. /.test(row.text)) {
      return line(key, [
        Box({ key: "code", flexShrink: 0, width: 3, children: Text({ color: COLOR.warn, children: row.text.slice(0, 2) }) }),
        name(Text({ color: COLOR.fg, children: row.text.slice(3) })),
      ], { paddingLeft: 2 });
    }
    return line(key, [name(Text({ color: COLOR.fg, children: row.text }))], { paddingLeft: 2 });
  });

  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: COLOR.muted,
    paddingX: 1,
    children: [
      Box({
        key: "header",
        flexDirection: "row",
        children: [
          Box({ key: "mark", width: MARK_COLUMNS, flexShrink: 0, marginRight: 1, children: Text({ color: COLOR.accent, bold: true, children: MARK }) }),
          Box({
            key: "what",
            flexDirection: "column",
            flexGrow: 1,
            flexShrink: 1,
            children: [
              Text({
                key: "cost",
                wrap: "wrap",
                children: [
                  Text({ key: "cmd", color: COLOR.fg, bold: true, children: subject }),
                  Text({ key: "verb", color: COLOR.muted, children: verb }),
                  Text({ key: "amount", color: COLOR.err, bold: true, children: amount }),
                ],
              }),
              Text({ key: "where", color: COLOR.muted, wrap: "truncate-end", children: `in ${report.where ?? "this folder"}` }),
            ],
          }),
        ],
      }),
      Box({ key: "banner", marginTop: 1, children: Text({ color: warning.tone, wrap: "wrap", children: `⚠ ${warning.text}` }) }),
      rows.length > 0 ? Box({ key: "rule", height: 1, overflow: "hidden", children: Text({ color: COLOR.rule, wrap: "wrap", children: "─".repeat(200) }) }) : null,
      rows.length > 0 ? Box({ key: "list", flexDirection: "column", children: list }) : null,
      report.capped ? Text({ key: "note", color: COLOR.muted, italic: true, wrap: "truncate-end", children: report.note }) : null,
      // Once answered, the buttons give way to the run's progress, so they can't be pressed twice.
      isHeld(state)
        ? Box({
          key: "buttons",
          marginTop: 1,
          gap: 2,
          children: [
            Button({ key: "proceed", label: buttonLabel(state), hotkey: "1", plain: true, onPress: decide("proceed") }),
            Button({ key: "cancel", label: "Cancel", hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          ],
        })
        : Box({ key: "status", marginTop: 1, children: Text({ color: phaseColor(state), bold: true, wrap: "truncate-end", children: `${pillWord(state)} ${percentOf(state)}` }) }),
      isHeld(state) ? Text({ key: "hint", color: COLOR.muted, wrap: "truncate-end", children: "Held by Foxel rmShield" }) : null,
    ],
  });
}

// ---- Desktop drawing ------------------------------------------------------
//
// The desktop surface draws one SVG card: Foxel, the user's pixel fox, guarding
// the command with a shield, a progress row (pill, dotted track, percent) that
// sweeps when the command runs, the warning and the list. Everything moves by
// CSS, so a held pane needs no redraws. The dither and the text helpers follow
// the savvy-progress band.

const isHeld = (state) => (state.phase ?? "held") === "held";
const pillWord = (state) => {
  const phase = state.phase ?? "held";
  if (phase === "done") {
    return "Done";
  }
  if (phase === "deleting") {
    return state.risk.kind === "rm" || state.risk.kind === "git-clean" ? "Deleting" : "Running";
  }
  return "Held";
};
const phaseColor = (state) => ({ deleting: COLOR.err, done: COLOR.ok }[state.phase] ?? COLOR.accent);
const percentOf = (state) => `${Math.round(Math.max(0, Math.min(1, state.progress ?? 0)) * 100)}%`;

/** The desktop draw when the surface can show SVG, the text draw otherwise. */
function drawFor(t, state, e, where) {
  if (e.surface === "terminal" || !("Svg" in t)) {
    return draw(t, state);
  }
  const columns = e.props?.bodyColumns || 40;
  const W = Math.max(240, Math.min(900, columns * 8 - (where === "band" ? 24 : 8)));
  return drawSvg(t, state, W);
}

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif";
const SVG_HEADER_H = 64;
const SVG_ROW_H = 32;
const BAR_H = 16;
const CELL = 3;
// Rows shown under the banner on the desktop, the "+ K more" row not counted.
const SVG_LIST_ROWS = 6;

// Escapes text for the SVG. Tabs and line breaks become spaces, other control
// characters (an ANSI escape from git or a migration tool) and U+FFFE/U+FFFF
// become U+FFFD, and bidi controls are dropped, so the SVG stays well-formed and
// a file name can't be made to read backwards.
const xml = (s) => String(s)
  .replace(/[\t\n\r]/g, " ")
  .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
  .replace(/[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
  .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

// Rough advance of system UI text, in em; good enough to fit a line.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿！-｠�\u{1F300}-\u{1FAFF}]/u;
const charEm = (ch) => (WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Z@%mw]/.test(ch) ? 0.72 : 0.56);
const textWidth = (s, px) => [...s].reduce((w, ch) => w + charEm(ch) * px, 0);
const fitText = (s, px, maxW) => {
  if (textWidth(s, px) <= maxW) {
    return s;
  }
  let out = "";
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, px) > maxW) {
      break;
    }
    out += ch;
  }
  return `${out}…`;
};

// Deterministic noise, so the dither doesn't shimmer between redraws.
const noise = (x, y) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

// A CSS delay that continues an animation from the hold's clock, so a redraw
// doesn't restart it.
const phaseDelay = (period, clock) => `-${(clock % period).toFixed(2)}s`;

// Foxel with a shield, from the user's foxel-04-tameng.svg: its 1×1 pixels as one
// path per colour per layer, cropped to 52×64. back is the outline colour under
// the shield, so a moving shield never shows a hole; lid covers the eyes for a
// blink; glow is a brighter copy of the shield's check; spark is added.
const FOXEL = {
  back: [
    ["#3b1c0a", "M4 34h4v1h-4zM32 34h4v1h-4zM3 35h6v1h-6zM31 35h5v1h-5zM3 36h6v1h-6zM31 36h6v1h-6zM2 37h35v1h-35zM2 38h35v1h-35zM2 39h35v1h-35zM2 40h35v1h-35zM2 41h35v1h-35zM2 42h35v1h-35zM2 43h35v1h-35zM1 44h36v1h-36zM1 45h36v1h-36zM0 46h38v1h-38zM0 47h38v1h-38zM1 48h36v1h-36zM1 49h36v1h-36zM2 50h30v1h-30zM7 51h25v1h-25zM8 52h22v1h-22zM9 53h20v1h-20zM11 54h17v1h-17zM13 55h13v1h-13zM14 56h11v1h-11zM15 57h9v1h-9zM17 58h6v1h-6zM18 59h3v1h-3zM19 60h1v1h-1z"],
  ],
  body: [
    ["#3b1c0a", "M6 3h1v1h-1zM33 3h1v1h-1zM5 4h1v1h-1zM7 4h1v1h-1zM32 4h1v1h-1zM34 4h2v1h-2zM5 5h1v1h-1zM8 5h1v1h-1zM31 5h1v1h-1zM34 5h2v1h-2zM5 6h1v1h-1zM9 6h1v1h-1zM13 6h3v1h-3zM30 6h1v1h-1zM34 6h2v1h-2zM5 7h1v1h-1zM10 7h3v1h-3zM16 7h1v1h-1zM26 7h4v1h-4zM34 7h2v1h-2zM4 8h1v1h-1zM8 8h3v1h-3zM17 8h4v1h-4zM25 8h1v1h-1zM29 8h3v1h-3zM35 8h1v1h-1zM4 9h1v1h-1zM7 9h1v1h-1zM21 9h3v1h-3zM25 9h1v1h-1zM32 9h1v1h-1zM35 9h1v1h-1zM4 10h1v1h-1zM6 10h1v1h-1zM24 10h1v1h-1zM33 10h1v1h-1zM35 10h1v1h-1zM4 11h1v1h-1zM6 11h1v1h-1zM33 11h1v1h-1zM35 11h1v1h-1zM4 12h2v1h-2zM34 12h1v1h-1zM36 12h1v1h-1zM4 13h1v1h-1zM35 13h2v1h-2zM3 14h2v1h-2zM35 14h2v1h-2zM3 15h1v1h-1zM36 15h1v1h-1zM3 16h1v1h-1zM36 16h1v1h-1zM3 17h1v1h-1zM8 17h10v1h-10zM22 17h10v1h-10zM36 17h1v1h-1zM8 18h1v1h-1zM17 18h1v1h-1zM22 18h1v1h-1zM31 18h1v1h-1zM36 18h1v1h-1zM8 19h1v1h-1zM17 19h1v1h-1zM22 19h1v1h-1zM31 19h1v1h-1zM36 19h1v1h-1zM17 20h1v1h-1zM22 20h1v1h-1zM36 20h1v1h-1zM3 21h1v1h-1zM17 21h1v1h-1zM22 21h1v1h-1zM36 21h1v1h-1zM3 22h1v1h-1zM8 22h1v1h-1zM17 22h1v1h-1zM22 22h1v1h-1zM31 22h1v1h-1zM36 22h2v1h-2zM3 23h2v1h-2zM8 23h1v1h-1zM17 23h1v1h-1zM22 23h1v1h-1zM31 23h1v1h-1zM35 23h1v1h-1zM38 23h1v1h-1zM2 24h1v1h-1zM5 24h1v1h-1zM8 24h1v1h-1zM17 24h1v1h-1zM22 24h1v1h-1zM31 24h1v1h-1zM34 24h1v1h-1zM38 24h1v1h-1zM2 25h1v1h-1zM6 25h1v1h-1zM8 25h1v1h-1zM18 25h4v1h-4zM31 25h1v1h-1zM33 25h1v1h-1zM39 25h1v1h-1zM1 26h1v1h-1zM7 26h1v1h-1zM32 26h1v1h-1zM40 26h1v1h-1zM2 27h4v1h-4zM34 27h6v1h-6zM5 28h1v1h-1zM34 28h1v1h-1zM36 28h1v1h-1zM4 29h1v1h-1zM36 29h1v1h-1zM4 30h1v1h-1zM37 30h1v1h-1zM5 31h3v1h-3zM32 31h5v1h-5zM8 32h2v1h-2zM30 32h2v1h-2zM10 33h2v1h-2zM28 33h2v1h-2zM10 34h1v1h-1zM12 34h1v1h-1zM27 34h1v1h-1zM29 34h1v1h-1zM36 34h1v1h-1zM9 35h1v1h-1zM13 35h2v1h-2zM25 35h2v1h-2zM30 35h1v1h-1zM36 35h1v1h-1zM9 36h22v1h-22zM37 36h1v1h-1zM37 37h1v1h-1zM37 38h1v1h-1zM37 39h1v1h-1zM37 40h1v1h-1zM37 41h1v1h-1zM37 42h1v1h-1zM37 43h1v1h-1zM37 44h1v1h-1zM37 45h1v1h-1zM38 46h1v1h-1zM38 47h1v1h-1zM37 48h1v1h-1zM37 49h1v1h-1zM32 50h5v1h-5zM32 51h1v1h-1zM30 52h2v1h-2zM29 53h1v1h-1zM28 54h1v1h-1zM11 55h2v1h-2zM26 55h3v1h-3zM11 56h1v1h-1zM13 56h1v1h-1zM25 56h1v1h-1zM28 56h1v1h-1zM11 57h1v1h-1zM14 57h1v1h-1zM24 57h1v1h-1zM28 57h1v1h-1zM10 58h2v1h-2zM15 58h2v1h-2zM23 58h1v1h-1zM28 58h2v1h-2zM9 59h1v1h-1zM17 59h1v1h-1zM21 59h2v1h-2zM30 59h1v1h-1zM9 60h1v1h-1zM12 60h1v1h-1zM14 60h1v1h-1zM16 60h1v1h-1zM18 60h1v1h-1zM20 60h1v1h-1zM23 60h1v1h-1zM25 60h1v1h-1zM27 60h1v1h-1zM30 60h1v1h-1zM8 61h1v1h-1zM19 61h1v1h-1zM31 61h1v1h-1zM8 62h1v1h-1zM31 62h1v1h-1zM9 63h22v1h-22z"],
    ["#5a2a0c", "M6 4h1v1h-1zM33 4h1v1h-1zM7 5h1v1h-1zM33 5h1v1h-1zM33 6h1v1h-1zM33 7h1v1h-1zM34 8h1v1h-1zM34 9h1v1h-1zM35 12h1v1h-1zM29 59h1v1h-1zM29 60h1v1h-1zM30 61h1v1h-1zM9 62h22v1h-22z"],
    ["#9a5a2a", "M6 5h1v1h-1zM32 5h1v1h-1zM6 6h1v1h-1zM6 7h1v1h-1zM5 8h1v1h-1zM5 9h1v1h-1zM10 59h2v1h-2zM28 59h1v1h-1zM10 60h1v1h-1zM21 60h1v1h-1zM9 61h1v1h-1zM20 61h1v1h-1z"],
    ["#7a3a12", "M7 6h1v1h-1zM32 6h1v1h-1zM7 7h2v1h-2zM31 7h2v1h-2zM6 8h2v1h-2zM32 8h2v1h-2zM12 59h5v1h-5zM23 59h5v1h-5zM11 60h1v1h-1zM13 60h1v1h-1zM15 60h1v1h-1zM17 60h1v1h-1zM22 60h1v1h-1zM24 60h1v1h-1zM26 60h1v1h-1zM28 60h1v1h-1zM10 61h9v1h-9zM21 61h9v1h-9z"],
    ["#e8691a", "M8 6h1v1h-1zM9 7h1v1h-1zM6 9h1v1h-1zM34 10h1v1h-1zM34 11h1v1h-1zM36 23h2v1h-2zM36 24h2v1h-2zM35 25h4v1h-4zM28 34h1v1h-1zM12 35h1v1h-1zM28 35h2v1h-2zM27 56h1v1h-1zM27 57h1v1h-1zM27 58h1v1h-1z"],
    ["#ffa855", "M31 6h1v1h-1zM30 7h1v1h-1zM5 10h1v1h-1zM5 11h1v1h-1zM9 18h1v1h-1zM13 18h4v1h-4zM23 18h4v1h-4zM30 18h1v1h-1zM3 24h1v1h-1zM35 24h1v1h-1zM11 34h1v1h-1zM10 35h1v1h-1zM27 35h1v1h-1zM12 56h1v1h-1zM26 56h1v1h-1zM12 57h1v1h-1zM25 57h1v1h-1zM12 58h1v1h-1zM24 58h1v1h-1z"],
    ["#eef0fa", "M13 7h3v1h-3zM11 8h2v1h-2zM8 9h3v1h-3zM29 9h1v1h-1zM7 10h1v1h-1zM7 11h1v1h-1zM4 15h1v1h-1zM4 16h1v1h-1zM4 17h1v1h-1zM18 17h1v1h-1zM32 17h1v1h-1zM4 18h1v1h-1zM18 18h1v1h-1zM32 18h1v1h-1zM4 19h1v1h-1zM18 19h1v1h-1zM32 19h1v1h-1zM4 20h1v1h-1zM18 20h1v1h-1zM32 20h1v1h-1zM18 21h1v1h-1zM32 21h1v1h-1zM18 22h1v1h-1zM32 22h1v1h-1zM32 23h1v1h-1z"],
    ["#c9cde0", "M13 8h4v1h-4zM26 8h1v1h-1zM11 9h10v1h-10zM26 9h3v1h-3zM8 10h16v1h-16zM25 10h6v1h-6zM8 11h23v1h-23zM5 15h3v1h-3zM18 15h4v1h-4zM32 15h2v1h-2zM5 16h3v1h-3zM18 16h4v1h-4zM32 16h2v1h-2zM5 17h1v1h-1zM19 17h1v1h-1zM33 17h1v1h-1zM5 18h1v1h-1zM19 18h1v1h-1zM33 18h1v1h-1zM5 19h1v1h-1zM19 19h1v1h-1zM33 19h1v1h-1zM5 20h1v1h-1zM19 20h1v1h-1zM33 20h1v1h-1zM5 21h1v1h-1zM19 21h1v1h-1zM33 21h1v1h-1zM19 22h1v1h-1zM33 22h1v1h-1z"],
    ["#8a90b0", "M27 8h2v1h-2zM30 9h2v1h-2zM31 10h2v1h-2zM31 11h2v1h-2zM8 15h10v1h-10zM22 15h10v1h-10zM34 15h2v1h-2zM8 16h1v1h-1zM11 16h7v1h-7zM22 16h7v1h-7zM31 16h1v1h-1zM34 16h2v1h-2zM6 17h2v1h-2zM20 17h2v1h-2zM34 17h2v1h-2zM6 18h2v1h-2zM20 18h2v1h-2zM34 18h2v1h-2zM6 19h2v1h-2zM20 19h2v1h-2zM34 19h2v1h-2zM6 20h2v1h-2zM20 20h2v1h-2zM34 20h2v1h-2zM4 21h1v1h-1zM6 21h2v1h-2zM20 21h2v1h-2zM34 21h2v1h-2zM4 22h4v1h-4zM20 22h2v1h-2zM34 22h2v1h-2zM5 23h3v1h-3zM18 23h4v1h-4zM33 23h2v1h-2zM6 24h2v1h-2zM18 24h4v1h-4zM32 24h2v1h-2zM7 25h1v1h-1zM32 25h1v1h-1z"],
    ["#ff8a2b", "M33 9h1v1h-1zM9 16h2v1h-2zM29 16h2v1h-2zM9 19h1v1h-1zM13 19h4v1h-4zM23 19h4v1h-4zM30 19h1v1h-1zM8 20h2v1h-2zM13 20h4v1h-4zM23 20h4v1h-4zM30 20h2v1h-2zM8 21h2v1h-2zM13 21h3v1h-3zM24 21h3v1h-3zM30 21h2v1h-2zM9 22h5v1h-5zM26 22h5v1h-5zM9 23h2v1h-2zM29 23h2v1h-2zM11 35h1v1h-1zM13 57h1v1h-1zM26 57h1v1h-1zM13 58h2v1h-2zM25 58h2v1h-2z"],
    ["#ffe47a", "M6 12h1v1h-1zM5 13h1v1h-1zM5 14h1v1h-1z"],
    ["#ffd23f", "M7 12h25v1h-25zM6 13h2v1h-2zM9 13h3v1h-3zM13 13h3v1h-3zM17 13h6v1h-6zM24 13h3v1h-3zM28 13h3v1h-3zM32 13h1v1h-1zM6 14h27v1h-27z"],
    ["#e0a820", "M32 12h2v1h-2zM33 13h2v1h-2zM33 14h2v1h-2z"],
    ["#ffffff", "M8 13h1v1h-1zM12 13h1v1h-1zM16 13h1v1h-1zM23 13h1v1h-1zM27 13h1v1h-1zM31 13h1v1h-1zM10 18h1v1h-1zM29 18h1v1h-1zM11 19h1v1h-1zM6 27h1v1h-1zM6 28h1v1h-1z"],
    ["#2a1a3a", "M11 18h2v1h-2zM27 18h2v1h-2zM10 19h1v1h-1zM12 19h1v1h-1zM27 19h3v1h-3zM10 20h3v1h-3zM27 20h3v1h-3zM10 21h3v1h-3zM27 21h3v1h-3zM18 29h4v1h-4zM19 30h2v1h-2z"],
    ["#fff4e0", "M16 21h1v1h-1zM23 21h1v1h-1zM14 22h3v1h-3zM23 22h3v1h-3zM11 23h6v1h-6zM23 23h6v1h-6zM4 24h1v1h-1zM9 24h8v1h-8zM23 24h8v1h-8zM10 25h8v1h-8zM22 25h8v1h-8zM6 26h1v1h-1zM10 26h20v1h-20zM33 26h1v1h-1zM7 27h25v1h-25zM7 28h25v1h-25zM8 29h10v1h-10zM22 29h10v1h-10zM10 30h9v1h-9zM21 30h9v1h-9zM12 31h16v1h-16zM13 32h14v1h-14zM15 33h10v1h-10zM19 34h2v1h-2z"],
    ["#f0dcb8", "M3 25h3v1h-3zM34 25h1v1h-1zM2 26h4v1h-4zM34 26h6v1h-6zM32 27h2v1h-2zM32 28h2v1h-2zM35 28h1v1h-1zM5 29h3v1h-3zM32 29h4v1h-4zM5 30h5v1h-5zM30 30h7v1h-7zM8 31h4v1h-4zM28 31h4v1h-4zM10 32h3v1h-3zM27 32h3v1h-3zM12 33h3v1h-3zM25 33h3v1h-3zM13 34h6v1h-6zM21 34h6v1h-6zM15 35h10v1h-10z"],
    ["#ff9fb4", "M9 25h1v1h-1zM30 25h1v1h-1zM8 26h2v1h-2zM30 26h2v1h-2z"],
  ],
  lid: [
    ["#ff8a2b", "M10 18h3v1h-3zM27 18h3v1h-3zM10 19h3v1h-3zM27 19h3v1h-3zM10 20h3v1h-3zM27 20h3v1h-3zM10 21h3v1h-3zM27 21h3v1h-3z"],
  ],
  plume: [
    ["#3b1c0a", "M19 0h1v1h-1zM16 1h3v1h-3zM20 1h2v1h-2zM12 2h4v1h-4zM22 2h1v1h-1zM11 3h1v1h-1zM23 3h2v1h-2zM12 4h1v1h-1zM25 4h2v1h-2zM13 5h2v1h-2zM27 5h1v1h-1zM26 6h1v1h-1z"],
    ["#5b3fd6", "M19 1h1v1h-1zM21 2h1v1h-1zM12 3h1v1h-1zM13 4h2v1h-2zM20 4h3v1h-3zM24 4h1v1h-1zM15 5h1v1h-1zM18 5h5v1h-5zM26 5h1v1h-1zM16 6h1v1h-1zM21 6h3v1h-3zM25 6h1v1h-1zM17 7h4v1h-4zM23 7h1v1h-1zM25 7h1v1h-1zM21 8h4v1h-4zM24 9h1v1h-1z"],
    ["#9a86ff", "M16 2h3v1h-3zM20 2h1v1h-1zM13 3h3v1h-3zM23 4h1v1h-1zM25 5h1v1h-1z"],
    ["#7c5cff", "M19 2h1v1h-1zM16 3h6v1h-6zM15 4h5v1h-5zM16 5h2v1h-2zM23 5h2v1h-2zM17 6h4v1h-4zM24 6h1v1h-1zM21 7h2v1h-2zM24 7h1v1h-1z"],
    ["#3f2aa8", "M22 3h1v1h-1z"],
  ],
  tail: [
    ["#3b1c0a", "M37 19h2v1h-2zM39 20h1v1h-1zM37 21h1v1h-1zM40 21h2v1h-2zM42 22h1v1h-1zM43 23h1v1h-1zM43 24h1v1h-1zM44 25h1v1h-1zM45 26h1v1h-1zM46 27h1v1h-1zM47 28h1v1h-1zM48 29h1v1h-1zM48 30h1v1h-1zM49 31h1v1h-1zM35 32h1v1h-1zM49 32h1v1h-1zM36 33h1v1h-1zM49 33h1v1h-1zM49 34h1v1h-1zM37 35h1v1h-1zM50 35h1v1h-1zM50 36h1v1h-1zM50 37h1v1h-1zM50 38h1v1h-1zM51 39h1v1h-1zM51 40h1v1h-1zM51 41h1v1h-1zM51 42h1v1h-1zM51 43h1v1h-1zM50 44h1v1h-1zM50 45h1v1h-1zM50 46h1v1h-1zM49 47h1v1h-1zM49 48h1v1h-1zM49 49h1v1h-1zM49 50h1v1h-1zM48 51h1v1h-1zM48 52h1v1h-1zM47 53h1v1h-1zM46 54h1v1h-1zM45 55h1v1h-1zM44 56h1v1h-1zM43 57h1v1h-1zM42 58h1v1h-1zM41 59h1v1h-1zM39 60h2v1h-2zM32 61h7v1h-7z"],
    ["#f0dcb8", "M37 20h2v1h-2zM38 21h2v1h-2zM40 22h2v1h-2zM41 23h2v1h-2zM41 24h2v1h-2zM42 25h1v1h-1z"],
    ["#fff4e0", "M38 22h2v1h-2zM39 23h2v1h-2zM39 24h2v1h-2zM40 25h2v1h-2zM41 26h2v1h-2zM40 27h2v1h-2zM37 28h5v1h-5zM37 29h3v1h-3z"],
    ["#e8691a", "M43 25h1v1h-1zM43 26h2v1h-2zM44 27h2v1h-2zM45 28h2v1h-2zM46 29h2v1h-2zM46 30h2v1h-2zM47 31h2v1h-2zM36 32h1v1h-1zM47 32h2v1h-2zM37 33h1v1h-1zM47 33h2v1h-2zM37 34h1v1h-1zM47 34h2v1h-2zM48 35h2v1h-2zM48 36h2v1h-2zM48 37h2v1h-2zM48 38h2v1h-2zM49 39h2v1h-2zM49 40h2v1h-2zM49 41h2v1h-2zM49 42h2v1h-2zM49 43h2v1h-2zM48 44h2v1h-2zM48 45h2v1h-2zM48 46h2v1h-2zM47 47h2v1h-2zM47 48h2v1h-2zM47 49h2v1h-2zM47 50h2v1h-2zM46 51h2v1h-2zM46 52h2v1h-2zM45 53h2v1h-2zM44 54h2v1h-2zM43 55h2v1h-2zM42 56h2v1h-2zM41 57h2v1h-2zM39 58h3v1h-3zM31 59h10v1h-10zM31 60h8v1h-8z"],
    ["#ff8a2b", "M42 27h2v1h-2zM42 28h3v1h-3zM40 29h6v1h-6zM38 30h8v1h-8zM38 31h9v1h-9zM37 32h10v1h-10zM38 33h9v1h-9zM38 34h9v1h-9zM39 35h9v1h-9zM39 36h9v1h-9zM39 37h9v1h-9zM39 38h9v1h-9zM38 39h11v1h-11zM38 40h11v1h-11zM38 41h11v1h-11zM38 42h11v1h-11zM38 43h11v1h-11zM38 44h10v1h-10zM38 45h10v1h-10zM39 46h9v1h-9zM39 47h8v1h-8zM39 48h8v1h-8zM38 49h9v1h-9zM38 50h9v1h-9zM37 51h9v1h-9zM33 52h13v1h-13zM32 53h13v1h-13zM30 54h14v1h-14zM29 55h14v1h-14zM29 56h13v1h-13zM29 57h12v1h-12zM30 58h9v1h-9z"],
    ["#ffa855", "M37 31h1v1h-1zM38 35h1v1h-1zM38 36h1v1h-1zM38 37h1v1h-1zM38 38h1v1h-1zM38 48h1v1h-1zM37 50h1v1h-1zM33 51h4v1h-4zM32 52h1v1h-1zM30 53h2v1h-2zM29 54h1v1h-1z"],
  ],
  shield: [
    ["#3b1c0a", "M4 34h4v1h-4zM32 34h4v1h-4zM3 35h1v1h-1zM8 35h1v1h-1zM31 35h1v1h-1zM3 36h1v1h-1zM7 36h2v1h-2zM31 36h2v1h-2zM36 36h1v1h-1zM2 37h1v1h-1zM6 37h1v1h-1zM33 37h1v1h-1zM2 38h1v1h-1zM6 38h1v1h-1zM33 38h1v1h-1zM2 39h1v1h-1zM6 39h1v1h-1zM33 39h1v1h-1zM2 40h1v1h-1zM6 40h1v1h-1zM33 40h1v1h-1zM2 41h1v1h-1zM6 41h1v1h-1zM33 41h1v1h-1zM2 42h1v1h-1zM9 42h1v1h-1zM30 42h1v1h-1zM2 43h8v1h-8zM30 43h7v1h-7zM1 44h1v1h-1zM9 44h1v1h-1zM29 44h1v1h-1zM1 45h1v1h-1zM9 45h1v1h-1zM29 45h1v1h-1zM0 46h1v1h-1zM10 46h1v1h-1zM28 46h1v1h-1zM0 47h1v1h-1zM10 47h1v1h-1zM28 47h1v1h-1zM1 48h1v1h-1zM9 48h1v1h-1zM29 48h1v1h-1zM1 49h1v1h-1zM4 49h1v1h-1zM6 49h1v1h-1zM9 49h1v1h-1zM29 49h1v1h-1zM32 49h1v1h-1zM34 49h1v1h-1zM2 50h7v1h-7zM30 50h2v1h-2zM7 51h1v1h-1zM8 52h1v1h-1zM9 53h2v1h-2zM11 54h1v1h-1z"],
    ["#ffa855", "M4 35h3v1h-3zM32 35h3v1h-3zM4 36h1v1h-1zM3 37h1v1h-1zM3 38h1v1h-1zM3 39h1v1h-1zM3 40h1v1h-1zM3 41h1v1h-1zM3 42h1v1h-1zM31 42h1v1h-1z"],
    ["#e8691a", "M7 35h1v1h-1zM35 35h1v1h-1zM6 36h1v1h-1zM35 36h1v1h-1zM36 37h1v1h-1zM36 38h1v1h-1zM36 39h1v1h-1zM36 40h1v1h-1zM36 41h1v1h-1zM8 42h1v1h-1zM36 42h1v1h-1z"],
    ["#ff8a2b", "M5 36h1v1h-1zM33 36h2v1h-2zM4 37h2v1h-2zM34 37h2v1h-2zM4 38h2v1h-2zM34 38h2v1h-2zM4 39h2v1h-2zM34 39h2v1h-2zM4 40h2v1h-2zM34 40h2v1h-2zM4 41h2v1h-2zM34 41h2v1h-2zM4 42h4v1h-4zM32 42h4v1h-4z"],
    ["#c9cde0", "M7 37h21v1h-21zM7 38h21v1h-21zM7 39h2v1h-2zM7 40h2v1h-2zM7 41h2v1h-2zM9 50h1v1h-1zM8 51h4v1h-4z"],
    ["#8a90b0", "M28 37h5v1h-5zM28 38h5v1h-5zM31 39h2v1h-2zM31 40h2v1h-2zM31 41h2v1h-2zM28 51h4v1h-4zM9 52h4v1h-4zM27 52h3v1h-3zM11 53h3v1h-3zM25 53h4v1h-4zM12 54h3v1h-3zM24 54h4v1h-4zM13 55h4v1h-4zM23 55h3v1h-3zM14 56h4v1h-4zM21 56h4v1h-4zM15 57h4v1h-4zM20 57h4v1h-4zM17 58h6v1h-6zM18 59h3v1h-3zM19 60h1v1h-1z"],
    ["#ffe47a", "M9 39h22v1h-22z"],
    ["#ffd23f", "M9 40h22v1h-22zM9 41h22v1h-22z"],
    ["#7c5cff", "M10 42h10v1h-10zM10 43h10v1h-10zM10 44h10v1h-10zM10 45h10v1h-10zM11 46h2v1h-2zM15 46h4v1h-4zM11 47h2v1h-2zM16 47h2v1h-2zM10 48h4v1h-4zM10 49h5v1h-5zM19 49h1v1h-1zM10 50h6v1h-6zM18 50h2v1h-2zM12 51h8v1h-8zM13 52h7v1h-7zM14 53h6v1h-6zM15 54h5v1h-5zM17 55h3v1h-3zM18 56h2v1h-2zM19 57h1v1h-1z"],
    ["#5b3fd6", "M20 42h3v1h-3zM25 42h5v1h-5zM20 43h2v1h-2zM25 43h5v1h-5zM20 44h1v1h-1zM24 44h5v1h-5zM23 45h6v1h-6zM22 46h6v1h-6zM21 47h7v1h-7zM20 48h9v1h-9zM20 49h9v1h-9zM20 50h10v1h-10zM20 51h8v1h-8zM20 52h7v1h-7zM20 53h5v1h-5zM20 54h4v1h-4zM20 55h3v1h-3zM20 56h1v1h-1z"],
    ["#2fe6d1", "M23 42h2v1h-2zM22 43h1v1h-1zM21 44h1v1h-1zM20 45h1v1h-1zM13 46h2v1h-2zM19 46h1v1h-1zM14 47h2v1h-2zM18 47h1v1h-1zM15 48h3v1h-3zM16 49h1v1h-1z"],
    ["#1fb3a1", "M23 43h2v1h-2zM22 44h2v1h-2zM21 45h2v1h-2zM20 46h2v1h-2zM13 47h1v1h-1zM19 47h2v1h-2zM14 48h1v1h-1zM18 48h2v1h-2zM15 49h1v1h-1zM17 49h2v1h-2zM16 50h2v1h-2z"],
    ["#b36a35", "M2 44h6v1h-6zM30 44h6v1h-6zM2 45h1v1h-1zM30 45h1v1h-1zM1 46h1v1h-1zM29 46h1v1h-1zM2 48h1v1h-1zM30 48h1v1h-1z"],
    ["#5a2a0c", "M8 44h1v1h-1zM36 44h1v1h-1zM8 45h1v1h-1zM36 45h1v1h-1zM9 46h1v1h-1zM37 46h1v1h-1zM1 47h1v1h-1zM9 47h1v1h-1zM29 47h1v1h-1zM37 47h1v1h-1zM8 48h1v1h-1zM36 48h1v1h-1zM2 49h2v1h-2zM5 49h1v1h-1zM7 49h2v1h-2zM30 49h2v1h-2zM33 49h1v1h-1zM35 49h2v1h-2z"],
    ["#8a4a1c", "M3 45h5v1h-5zM31 45h5v1h-5zM2 46h7v1h-7zM30 46h7v1h-7zM2 47h7v1h-7zM30 47h7v1h-7zM3 48h5v1h-5zM31 48h5v1h-5z"],
  ],
  glow: [
    ["#b8fff6", "M23 42h2v1h-2zM22 43h3v1h-3zM21 44h3v1h-3zM20 45h3v1h-3zM13 46h2v1h-2zM19 46h3v1h-3zM13 47h3v1h-3zM18 47h3v1h-3zM14 48h6v1h-6zM15 49h4v1h-4zM16 50h2v1h-2z"],
  ],
  spark: [
    ["#ffe47a", "M6 31h1v1h-1zM5 32h3v1h-3zM6 33h1v1h-1zM35 52h1v1h-1zM3 53h1v1h-1zM34 53h3v1h-3zM2 54h3v1h-3zM35 54h1v1h-1zM3 55h1v1h-1z"],
  ],
};
const FOXEL_W = 52;
const FOXEL_H = 64;

/** Foxel at (x, y), one pixel per unit, in layers the card's CSS animates per phase. */
function foxelSvg(x, y, phase) {
  const layer = (name, cls) => `<g class="${cls}">${FOXEL[name].map(([c, d]) => `<path fill="${c}" d="${d}"/>`).join("")}</g>`;
  const mood = phase === "done" ? "fxd" : phase === "deleting" ? "fxr" : "fxh";
  return `<g transform="translate(${x},${y})" shape-rendering="crispEdges"><g class="fx ${mood}">${layer("back", "fx-back")}${layer("tail", "fx-tail")}<g class="fx-body">${layer("body", "fx-skin")}${layer("lid", "fx-lid")}${layer("plume", "fx-pl")}</g><g class="fx-sh">${layer("shield", "fx-plate")}${layer("glow", "fx-ck")}</g>${layer("spark", "fx-sp")}</g></g>`;
}

// The card's colours follow the theme: Tokyo Night Day on light, Tokyo Night on dark.
// pf is the phase colour (pill and fill), pt the text on the pill.
const THEME_CSS = `
.bg{fill:#eceef3;stroke:#dcdfe8}.fg{fill:#343b58}.mu{fill:#6c7293}.er{fill:#d4375f}.wa{fill:#8c6c3e}
.tk{fill:#c4c8da}.ln{stroke:#d3d6e2}.pt{fill:#ffffff}
.p-held .pf{fill:#2e7de9}.p-deleting .pf{fill:#d4375f}.p-done .pf{fill:#3f7d2c}
.p-held .pk{stroke:#2e7de9}.p-deleting .pk{stroke:#d4375f}.p-done .pk{stroke:#3f7d2c}
@media (prefers-color-scheme: dark){
.bg{fill:#25262e;stroke:#34353f}.fg{fill:#c0caf5}.mu{fill:#8089b3}.er{fill:#f7768e}.wa{fill:#e0af68}
.tk{fill:#3b4261}.ln{stroke:#34353f}.pt{fill:#1f2335}
.p-held .pf{fill:#7aa2f7}.p-deleting .pf{fill:#f7768e}.p-done .pf{fill:#9ece6a}
.p-held .pk{stroke:#7aa2f7}.p-deleting .pk{stroke:#f7768e}.p-done .pk{stroke:#9ece6a}
}`;

// Foxel. Held: the shield bobs a pixel, its check glows, the body breathes, the
// tail sways, the plume flutters, the eyes blink. Deleting: the shield thrusts
// and shakes, the tail whips, sparks flicker, Foxel leans in. Done: a hop, the
// shield lifted, the check flashes, sparks pop. Moves are whole pixels (steps)
// where they translate, so the pixel art stays crisp.
// The bar: pixels twinkle, a sheen glides over the fill, the pill breathes while held.
const cardCss = (clock, fillW) => `<style>${THEME_CSS}
g{transform-box:fill-box}
.fx-lid,.fx-ck,.fx-sp{opacity:0}
.fxh .fx-body{transform-origin:50% 100%;animation:fxbr 2.4s ease-in-out infinite ${phaseDelay(2.4, clock)}}
@keyframes fxbr{50%{transform:scaleY(1.02)}}
.fxh .fx-sh{animation:fxbob 1.6s steps(1) infinite ${phaseDelay(1.6, clock)}}
@keyframes fxbob{0%{transform:translateY(0)}50%{transform:translateY(-1px)}}
.fxh .fx-ck{animation:fxck 1.6s ease-in-out infinite ${phaseDelay(1.6, clock)}}
@keyframes fxck{50%{opacity:.85}}
.fxh .fx-tail{transform-origin:20% 100%;animation:fxsw 2.2s ease-in-out infinite ${phaseDelay(2.2, clock)}}
@keyframes fxsw{25%{transform:rotate(5deg)}75%{transform:rotate(-5deg)}}
.fxh .fx-pl{transform-origin:50% 100%;animation:fxpl 1.2s ease-in-out infinite ${phaseDelay(1.2, clock)}}
@keyframes fxpl{25%{transform:rotate(4deg)}75%{transform:rotate(-4deg)}}
.fxh .fx-lid{animation:fxbl 4s steps(1) infinite ${phaseDelay(4, clock)}}
@keyframes fxbl{0%{opacity:0}94%{opacity:1}97%{opacity:0}}
.fxr{transform:translateX(1px)}
.fxr .fx-sh{transform-origin:50% 50%;animation:fxth .25s steps(1) infinite}
@keyframes fxth{0%{transform:scale(1.05)}50%{transform:scale(1.05) translateX(1px)}}
.fxr .fx-ck{opacity:.6}
.fxr .fx-tail{transform-origin:20% 100%;animation:fxwh .4s ease-in-out infinite ${phaseDelay(0.4, clock)}}
@keyframes fxwh{25%{transform:rotate(9deg)}75%{transform:rotate(-9deg)}}
.fxr .fx-sp{animation:fxsp .3s steps(1) infinite}
@keyframes fxsp{0%{opacity:1}50%{opacity:.15}}
.fxd{animation:fxhop .9s steps(1) infinite ${phaseDelay(0.9, clock)}}
@keyframes fxhop{0%{transform:translateY(0)}30%{transform:translateY(-2px)}60%{transform:translateY(0)}}
.fxd .fx-sh{transform:translateY(-1px)}
.fxd .fx-ck{animation:fxfl .45s steps(1) infinite}
@keyframes fxfl{0%{opacity:.9}50%{opacity:0}}
.fxd .fx-sp{animation:fxpop .9s steps(1) infinite ${phaseDelay(0.9, clock)}}
@keyframes fxpop{0%{opacity:0}30%{opacity:1}70%{opacity:0}}
.t0,.t1,.t2,.t3{animation:tw 2.2s ease-in-out infinite ${phaseDelay(2.2, clock)}}
.t1{animation-duration:2.8s;animation-delay:-.7s}.t2{animation-duration:1.9s;animation-delay:-1.3s}.t3{animation-duration:3.3s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.4}}
.sw{animation:swp 2.4s ease-in-out infinite ${phaseDelay(2.4, clock)}}@keyframes swp{from{transform:translateX(-26px)}to{transform:translateX(${fillW}px)}}
.pk{animation:skt 1s steps(1) infinite}@keyframes skt{50%{opacity:.15}}
.br{animation:brt 2s ease-in-out infinite ${phaseDelay(2, clock)}}@keyframes brt{50%{opacity:.6}}
</style>`;

/** Words wrapped to `maxW` pixels, at most `maxLines` lines, the last cut with an ellipsis. */
function wrapText(text, px, maxW, maxLines) {
  const lines = [];
  let cur = "";
  const words = text.split(" ");
  for (let i = 0; i < words.length; i += 1) {
    const next = cur === "" ? words[i] : `${cur} ${words[i]}`;
    if (textWidth(next, px) <= maxW || cur === "") {
      cur = next;
      continue;
    }
    lines.push(cur);
    cur = words[i];
    if (lines.length === maxLines - 1) {
      cur = words.slice(i).join(" ");
      break;
    }
  }
  lines.push(cur);
  return lines.slice(0, maxLines).map((l) => fitText(l, px, maxW));
}

const PAD = 12;
const LIST_ROW_H = 20;
const BANNER_LINE_H = 16;
const BANNER_PX = 12.5;
// One pane row on the desktop is taken as this many pixels when sizing the pane.
const ROW_PX = 20;
// Rows under the card: the buttons and a margin.
const BUTTON_ROWS = 3;

/** Where everything goes on a card W pixels wide, with the list cut to fit the pane. */
function cardLayout(state, W) {
  const inner = W - PAD * 2;
  const bannerLines = wrapText(`⚠ ${banner(state).text}`, BANNER_PX, inner, 4);
  const top = PAD + SVG_HEADER_H + 4 + SVG_ROW_H + 6 + bannerLines.length * BANNER_LINE_H + 6;
  // A capped list says so on a line of its own under the rows.
  const note = state.report.capped ? BANNER_LINE_H + 4 : 0;
  const maxH = (PANE_MAX_ROWS - BUTTON_ROWS) * ROW_PX;
  const room = Math.max(0, Math.min(SVG_LIST_ROWS + 1, Math.floor((maxH - top - 8 - note - PAD) / LIST_ROW_H)));
  const rows = listRows(state.report, room);
  const listEnd = top + (rows.length > 0 ? 8 + rows.length * LIST_ROW_H : 0);
  const height = listEnd + note + PAD;
  return { inner, bannerLines, top, rows, listEnd, height };
}

/** The whole desktop card as one SVG: header, progress, banner, rule, list. */
function cardSvg(state, W, clock) {
  const { report, risk } = state;
  const phase = state.phase ?? "held";
  const { inner, bannerLines: lines, top, rows, listEnd, height } = cardLayout(state, W);
  const right = PAD + inner;

  // Header: Foxel with the shield, then the command, what it does, and where.
  const [subject, verb, amount] = headline(state);
  const textX = PAD + FOXEL_W + 12;
  const textW = right - textX;
  const verbText = verb.trim();
  const amountText = fitText(amount, 12, Math.max(20, textW - textWidth(`${verbText} `, 12)));
  const foxY = PAD + Math.round((SVG_HEADER_H - FOXEL_H) / 2);
  const header = `${foxelSvg(PAD, foxY, phase)}
<text class="fg" x="${textX}" y="${PAD + 21}" font-size="14" font-weight="600">${xml(fitText(subject, 14, textW))}</text>
<text x="${textX}" y="${PAD + 39}" font-size="12"><tspan class="mu">${xml(verbText)} </tspan><tspan class="er" font-weight="600">${xml(amountText)}</tspan></text>
<text class="mu" x="${textX}" y="${PAD + 54}" font-size="11">${xml(fitText(`in ${report.where ?? "this folder"}`, 11, textW))}</text>`;

  // Progress: a dotted track, the dithered fill with the pill at its head, the percent.
  const ratio = phase === "done" ? 1 : phase === "deleting" ? Math.max(0, Math.min(1, state.progress ?? 0)) : 0;
  const barW = Math.max(60, inner - 48);
  const fillW = Math.round(barW * ratio);
  const barRows = Math.floor(BAR_H / CELL);
  const track = [];
  for (let c = Math.floor(fillW / CELL); c < Math.floor(barW / CELL); c += 2) {
    for (let r = 0; r < barRows; r += 2) {
      track.push(`<rect x="${c * CELL + 1}" y="${r * CELL + 2}" width="2" height="2"/>`);
    }
  }
  const dots = [];
  const cols = Math.floor(fillW / CELL);
  for (let c = 0; c < cols; c += 1) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2);
    for (let r = 0; r < barRows; r += 1) {
      if (noise(c, r) < density) {
        dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`);
      }
    }
  }
  const running = phase === "deleting";
  const sheen = running && fillW > 12
    ? `<g clip-path="url(#brf)"><g class="sw"><rect x="0" width="8" height="${BAR_H}" fill="#fff" opacity=".1"/><rect x="8" width="10" height="${BAR_H}" fill="#fff" opacity=".34"/><rect x="18" width="8" height="${BAR_H}" fill="#fff" opacity=".1"/></g></g>`
    : "";
  const word = pillWord(state);
  const pillW = Math.round(18 + word.length * 6.6);
  const pillX = Math.max(0, Math.min(barW - pillW, fillW - pillW));
  const spark = running && fillW < barW - 30
    ? `<path class="pk" d="M${Math.max(fillW, pillW) + 9} ${BAR_H / 2 - 4}v8M${Math.max(fillW, pillW) + 5} ${BAR_H / 2}h8" stroke-width="1.6" stroke-linecap="round"/>`
    : "";
  const barY = PAD + SVG_HEADER_H + 4 + (SVG_ROW_H - BAR_H) / 2;
  const progress = `<defs><clipPath id="brc"><rect x="0" y="0" width="${barW}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath><clipPath id="brf"><rect x="0" y="0" width="${fillW}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<g class="p-${phase}" transform="translate(${PAD},${barY})">
<g clip-path="url(#brc)"><g class="tk">${track.join("")}</g><g class="pf">${dots.join("")}</g>${sheen}</g>
${spark}
<rect class="pf${phase === "held" ? " br" : ""}" x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<text class="pt" x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-size="11" font-weight="600">${xml(word)}</text>
</g>
<text class="mu" x="${right}" y="${barY + BAR_H / 2 + 4.5}" text-anchor="end" font-size="12.5" font-variant-numeric="tabular-nums">${percentOf({ progress: ratio })}</text>`;

  // Banner: what can't be undone, wrapped to the card.
  const bannerY = PAD + SVG_HEADER_H + 4 + SVG_ROW_H + 6;
  const tone = banner(state).tone === COLOR.warn ? "wa" : "er";
  const bannerSvg = lines.map((l, i) => `<text class="${tone}" x="${PAD}" y="${bannerY + 12 + i * BANNER_LINE_H}" font-size="${BANNER_PX}">${xml(l)}</text>`).join("\n");

  // The list: name at the left, a count column, the size at the right edge.
  const sizeCol = 56;
  const countRight = right - sizeCol - 8;
  const big = (bytes) => bytes >= 0.2 * (report.bytes || 1);
  const listTop = top + 8;
  const list = rows.map((row, i) => {
    const y = listTop + i * LIST_ROW_H + 14;
    if (row.type === "group") {
      const count = groupCount(row);
      const nameW = countRight - textWidth(count, 11.5) - 10 - PAD - textWidth("▸ ", 12);
      return `<text x="${PAD}" y="${y}" font-size="12"><tspan class="mu">▸ </tspan><tspan class="fg" font-weight="600">${xml(fitText(row.label, 12.5, nameW))}</tspan></text>
<text class="mu" x="${countRight}" y="${y}" text-anchor="end" font-size="11.5">${count}</text>
<text class="fg" x="${right}" y="${y}" text-anchor="end" font-size="12" font-weight="600" font-variant-numeric="tabular-nums">${row.atLeast ? "≥" : ""}${size(row.bytes)}</text>`;
    }
    if (row.type === "file") {
      const strong = big(row.bytes);
      return `<text class="fg" x="${PAD + 14}" y="${y}" font-size="12">${xml(fitText(row.label, 12, countRight - PAD - 14))}</text>
<text class="${strong ? "fg" : "mu"}" x="${right}" y="${y}" text-anchor="end" font-size="12"${strong ? ' font-weight="600"' : ""} font-variant-numeric="tabular-nums">${size(row.bytes)}</text>`;
    }
    if (row.type === "more") {
      return `<text class="mu" x="${PAD + 14}" y="${y}" font-size="12">${xml(fitText(row.text, 12, inner - 14))}</text>`;
    }
    if ((risk.kind === "git-reset" || risk.kind === "git-checkout") && /^.. /.test(row.text)) {
      return `<text x="${PAD + 14}" y="${y}" font-size="12" style="white-space:pre"><tspan class="wa" font-family="ui-monospace,Consolas,monospace">${xml(row.text.slice(0, 2))}</tspan><tspan class="fg"> ${xml(fitText(row.text.slice(3), 12, inner - 40))}</tspan></text>`;
    }
    return `<text class="fg" x="${PAD + 14}" y="${y}" font-size="12">${xml(fitText(row.text, 12, inner - 14))}</text>`;
  }).join("\n");
  const note = report.capped ? `<text class="mu" x="${PAD}" y="${listEnd + 14}" font-size="11.5" font-style="italic">${xml(fitText(report.note ?? "", 11.5, inner))}</text>` : "";
  const rule = rows.length > 0 ? `<line class="ln" x1="${PAD}" y1="${top + 0.5}" x2="${right}" y2="${top + 0.5}" stroke-width="1"/>` : "";

  return {
    height,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${FONT}">
${cardCss(clock, fillW)}
<rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="10" stroke-width="1"/>
${header}
${progress}
${bannerSvg}
${rule}
${list}
${note}
</svg>`,
  };
}

const ICON = { rm: "🗑", "git-clean": "🗑", "git-reset": "↺", "git-checkout": "↺", "git-push-force": "⚠", migrate: "▶" };

function drawSvg(t, state, W) {
  const { Box, Text, Button, Svg } = t;
  const { report, risk } = state;
  const clock = (state.tick ?? 0) * Number(POLL_SECONDS);
  const card = cardSvg(state, W, clock);
  const [subject, verb, amount] = headline(state);
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  // Only the buttons and the hint are host elements, in the host's own colours.
  return Box({
    flexDirection: "column",
    children: [
      Svg({ key: "card", source: card.source, alt: `${subject}${verb}${amount}, in ${report.where ?? "this folder"}. ${banner(state).text} ${pillWord(state)} ${percentOf(state)}`, width: W, height: card.height }),
      isHeld(state)
        ? Box({
          key: "buttons",
          flexDirection: "row",
          alignItems: "center",
          gap: 1,
          marginTop: 1,
          paddingX: 1,
          children: [
            Button({ key: "proceed", label: `${ICON[risk.kind] ?? "▶"} ${buttonLabel(state)}`, hotkey: "1", onPress: decide("proceed") }),
            Button({ key: "cancel", label: "✕ Cancel", hotkey: "2", autoFocus: true, onPress: decide("cancel") }),
            Text({ key: "hint", dimColor: true, children: "Held by Foxel rmShield" }),
          ],
        })
        : null,
    ],
  });
}
