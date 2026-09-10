import crypto from "crypto";
import { ChildProcess, spawn } from "child_process";
import { WorkTarget, config } from "./config";
import { log } from "./logger";

export interface ClaudeResult {
  ok: boolean;
  summary: string;
  cancelled?: boolean;
  sessionId?: string; // the session to resume next time for this project
  relayedAny?: boolean; // whether any of Claude's messages were already streamed to the user
}

/** Callback used to relay Claude's own messages to the user as they stream in. */
export type OnMessage = (text: string) => void;

/** Callback invoked for each SEND_FILE: line Claude emits - delivers that file to the user. */
export type OnFile = (filePath: string) => void;

// A line of exactly "SEND_FILE: <path>" in Claude's output means "deliver this file to the user
// as a WhatsApp attachment". Parsed out of the text so the marker itself is never relayed.
const SEND_FILE_PATTERN = /^\s*SEND_FILE:\s*(\S.*?)\s*$/;

/** The persistent guardrails, injected via --append-system-prompt on every turn so they hold
 *  regardless of session state. Lists the repos visible under the target's working directory. */
function buildSystemPrompt(target: WorkTarget): string {
  const repoLines = target.repos.map(
    (r) => `- ${r.subdir}/ -> git repo "${r.name}" (staging branch: "${r.stagingBranch}")`
  );
  return [
    `You are ${config.agentName}, an autonomous engineer reachable over WhatsApp.`,
    `Your working directory contains these git repos as subfolders:`,
    ...repoLines,
    `Each repo folder may contain a ready-made .env file with that project's environment variables`,
    `(database URLs, API keys, service endpoints) - use it for running migrations, seeds, tests and`,
    `local servers. It's excluded from git; never commit it or paste its secrets into code or PRs.`,
    ``,
    `Work out from the conversation which repo(s) a request is about - you don't need the human to`,
    `name it every time. It's fine and expected to touch more than one repo in a single task`,
    `(e.g. a backend change plus its frontend caller).`,
    ``,
    `This is an ongoing conversation: later messages are follow-ups. Continue prior work when`,
    `relevant - check out the branch you were already using (remotes have just been fetched for`,
    `you) rather than starting over.`,
    ``,
    `How changes ship, per repo you modify (no exceptions):`,
    `1. Start from the latest staging branch (it has just been fetched). Create a short-lived`,
    `   feature branch, make the change, and commit it.`,
    `2. MERGE that feature branch into the repo's staging branch (named above) - staging is the`,
    `   ONLY branch you may merge into directly - then push staging. This deploys the change to the`,
    `   test site where stakeholders review it.`,
    `3. Only merge if it applies cleanly. If merging into staging hits a conflict, do NOT force it:`,
    `   resolve it if it's trivial, otherwise stop and tell me exactly what conflicts.`,
    `4. After staging is updated, open (or update) a pull request FROM staging INTO the repo's`,
    `   default production branch (\`gh pr create\` targets the default branch automatically; reuse`,
    `   the existing staging->production PR if one is already open). This queues the change for a`,
    `   human to promote to production.`,
    ``,
    `Never merge or push to main/master (or any production branch) yourself - only a human merges`,
    `the staging->production PR. Never use --force or attempt admin / branch-protection overrides.`,
    `If a request is unclear, ask a clarifying question instead of guessing.`,
    ``,
    `Reviewing code or a pull request (yours or someone else's) - be exhaustive, not agreeable:`,
    `- Read every changed file end to end, plus the surrounding code the change depends on. Never`,
    `  review from the diff alone or from the PR description.`,
    `- Work through the cases the change has to survive: happy path, empty/null/zero, boundaries and`,
    `  off-by-one, malformed or hostile input, concurrency and re-entry, partial failure and retries,`,
    `  large inputs, and every error path. Say which ones you actually checked.`,
    `- Flag EVERY bad practice you find, however small - unhandled errors, swallowed exceptions,`,
    `  race conditions, injection or unvalidated input, leaked secrets or credentials in code/logs,`,
    `  missing or wrong tests, dead code, copy-paste duplication, magic values, misleading names,`,
    `  wrong or absent types, unbounded loops and queries, N+1s, missing indexes, resource leaks,`,
    `  breaking API changes, and anything that contradicts the conventions already in that repo.`,
    `  Do not stay silent about a small issue to keep the review short.`,
    `- Only approve if you are genuinely confident the change is correct AND you found no bad`,
    `  practice at all. Anything less than that is "changes requested" - list the findings plainly,`,
    `  worst first, each with the file and line and what would actually go wrong. If you couldn't`,
    `  verify something (no tests, can't run it, missing context), say so instead of approving.`,
    ``,
    `You are talking to a human over WhatsApp - every message you write is sent to them directly.`,
    `So talk like a colleague on chat:`,
    `- Not every message is a coding task. If they just greet you, chat, or ask a question, reply`,
    `  naturally and briefly - only start changing code when they actually ask for work.`,
    `- When you do take on work: open with a one-line acknowledgement, send short progress notes at`,
    `  meaningful milestones (not every command), and end with a brief summary + the PR URL(s).`,
    `- Keep each message short and conversational; no markdown headings, no step-by-step logs.`,
    `- Review findings are the exception: send the complete list even if it's long. Never drop or`,
    `  soften a finding to keep a message short.`,
    ``,
    `Files over WhatsApp:`,
    `- When the human sends you a file (image, PDF, voice note, ...), it's already downloaded and`,
    `  the message shows its saved path - just read/use that file as part of the task.`,
    `- To send the human a file yourself (a PDF you generated, a report, an image, ...), write a`,
    `  line by itself containing exactly: SEND_FILE: /absolute/path/to/file`,
    `  That file is then delivered to them as a WhatsApp attachment (100MB max). Any surrounding`,
    `  text is still sent as a normal message; never mention the SEND_FILE marker itself.`,
  ].join("\n");
}

/**
 * Builds a minimal environment for the Claude child. Critically, this does NOT forward the
 * WhatsApp secrets (access token, app secret) into a process running with
 * --dangerously-skip-permissions, where a prompt-injection payload could otherwise read and
 * exfiltrate them. Only the GitHub token (if explicitly configured) and the target's own
 * project-level env vars (the "env" field in projects.json) are passed through; otherwise
 * gh uses its own stored auth, reachable via HOME.
 */
function buildChildEnv(target: WorkTarget): NodeJS.ProcessEnv {
  const passthrough = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "TMPDIR",
    "USERPROFILE", // Windows dev only
    "SystemRoot", // Windows dev only
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of passthrough) {
    if (process.env[key]) env[key] = process.env[key];
  }

  // Forward Claude Code's OWN auth/config (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR,
  // ANTHROPIC_API_KEY, model/base-url overrides, ...). These are the agent's own credentials -
  // NOT the WhatsApp secrets we deliberately withhold - so without them the child has no login.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLAUDE_") || key.startsWith("ANTHROPIC_")) {
      env[key] = process.env[key];
    }
  }

  if (config.github.token) {
    env.GH_TOKEN = config.github.token;
    env.GITHUB_TOKEN = config.github.token;
  }

  // Commit identity: git reads these env vars directly, so every commit the agent makes is
  // attributed to the configured person without touching any repo's .git/config.
  if (config.git.authorName) {
    env.GIT_AUTHOR_NAME = config.git.authorName;
    env.GIT_COMMITTER_NAME = config.git.authorName;
  }
  if (config.git.authorEmail) {
    env.GIT_AUTHOR_EMAIL = config.git.authorEmail;
    env.GIT_COMMITTER_EMAIL = config.git.authorEmail;
  }

  // Project-specific env vars from projects.json (the "env" field) - e.g. API keys or service
  // URLs a project's tests/tooling need. Applied before the non-interactive overrides below so
  // a project can't accidentally re-enable an interactive prompt.
  Object.assign(env, target.env);

  // Nobody is present to answer a prompt, so force every subtool to be non-interactive: any
  // credential prompt, editor, or pager that would otherwise block forever (until the task
  // timeout SIGKILLs it) instead fails fast with an error Claude can see and react to.
  env.GIT_TERMINAL_PROMPT = "0"; // git never asks for username/password - it errors instead
  env.GCM_INTERACTIVE = "never"; // Git Credential Manager never pops a prompt
  env.GIT_EDITOR = "true"; // no editor hang on commit messages / rebases
  env.EDITOR = "true";
  env.VISUAL = "true";
  env.GIT_PAGER = "cat"; // no pager waiting on a keypress
  env.PAGER = "cat";
  env.GH_PAGER = "cat";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.CI = "1"; // many CLIs treat this as "assume non-interactive, take defaults"

  return env;
}

let active: { child: ChildProcess; cancelled: boolean } | null = null;

/** Kills whatever Claude Code process is currently running, if any. Returns false if nothing ran. */
export function cancelActive(): boolean {
  if (!active) return false;
  active.cancelled = true;
  active.child.kill("SIGKILL");
  return true;
}

/**
 * Runs one turn of the project's Claude Code conversation, headless.
 * - cwd = the project's parent folder, so the model can see/edit every member repo in one session.
 * - When sessionId is given, resumes that conversation (--resume); otherwise starts a new one
 *   with a self-generated id (--session-id) so we know the id even if this turn is cancelled
 *   before producing output.
 * Returns the session id to persist for the next follow-up.
 */
export function runClaude(
  userText: string,
  target: WorkTarget,
  sessionId: string | null,
  onMessage: OnMessage,
  onFile: OnFile = () => {}
): Promise<ClaudeResult> {
  const system = buildSystemPrompt(target);
  const generatedId = sessionId || crypto.randomUUID();

  // stream-json emits one JSON event per line as Claude works (assistant text, tool use, result),
  // so we can relay Claude's own messages live instead of a single blob at the end. --verbose is
  // required by the CLI when combining -p with stream-json.
  const args = [
    "-p",
    userText,
    "--model",
    config.claude.model,
    "--effort",
    config.claude.effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    system,
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", generatedId);
  }

  return new Promise((resolve) => {
    const child = spawn(config.claude.bin, args, {
      cwd: target.cwd,
      env: buildChildEnv(target),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const handle = { child, cancelled: false };
    active = handle;

    let buffer = "";
    let stderr = "";
    let settled = false;
    let relayedAny = false;
    let resolvedSessionId = generatedId;
    let finalResult: any = null;

    const clearActive = () => {
      if (active === handle) active = null;
    };

    const handleEvent = (ev: any) => {
      if (ev?.session_id) resolvedSessionId = ev.session_id;

      if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block?.type === "text" && block.text?.trim()) {
            // Pull out SEND_FILE: lines (delivered as attachments); relay the rest as text.
            const kept: string[] = [];
            for (const line of block.text.split("\n")) {
              const fileMatch = line.match(SEND_FILE_PATTERN);
              if (fileMatch) {
                relayedAny = true;
                log("claude_send_file", { target: target.label, filePath: fileMatch[1] });
                onFile(fileMatch[1]);
              } else {
                kept.push(line);
              }
            }
            const text = kept.join("\n").trim();
            if (text) {
              relayedAny = true;
              log("claude_message", { target: target.label, text: text.slice(0, 400) });
              onMessage(text);
            }
          } else if (block?.type === "tool_use") {
            // Log tool activity for visibility, but don't spam the user with it.
            log("claude_tool", { target: target.label, tool: block.name });
          }
        }
      } else if (ev?.type === "result") {
        finalResult = ev;
      } else if (ev?.type === "system") {
        log("claude_system", { target: target.label, subtype: ev.subtype });
      }
    };

    child.stdout.on("data", (d) => {
      buffer += d.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          /* ignore non-JSON noise */
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearActive();
      log("claude_spawn_failed", { target: target.label, error: String(err) });
      resolve({ ok: false, summary: `Couldn't start Claude Code: ${err.message}`, sessionId: resolvedSessionId, relayedAny });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearActive();

      // Flush a trailing partial line, if any.
      const rem = buffer.trim();
      if (rem) {
        try {
          handleEvent(JSON.parse(rem));
        } catch {
          /* ignore */
        }
      }

      log("claude_exit", {
        target: target.label,
        code,
        cancelled: handle.cancelled,
        relayedAny,
        resultSubtype: finalResult?.subtype,
        stderrTail: stderr.slice(-3000),
      });

      if (handle.cancelled) {
        resolve({ ok: false, cancelled: true, summary: `Stopped work on "${target.label}" as requested.`, sessionId: resolvedSessionId, relayedAny });
        return;
      }

      const isError = code !== 0 || finalResult?.is_error || finalResult?.subtype === "error";
      if (isError) {
        const detail =
          finalResult?.result ||
          finalResult?.error ||
          stderr.trim() ||
          `exited with code ${code}`;
        resolve({
          ok: false,
          summary: `Claude hit an error on "${target.label}": ${String(detail).trim()}`.slice(0, 1500),
          sessionId: resolvedSessionId,
          relayedAny,
        });
        return;
      }

      // The result text duplicates Claude's final streamed message, so any SEND_FILE lines in it
      // were already delivered as attachments - strip them so the marker never reaches the user.
      const summary = String(finalResult?.result ?? "")
        .split("\n")
        .filter((line) => !SEND_FILE_PATTERN.test(line))
        .join("\n")
        .trim();
      resolve({ ok: true, summary, sessionId: resolvedSessionId, relayedAny });
    });
  });
}
