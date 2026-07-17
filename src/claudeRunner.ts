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

/** The persistent guardrails, injected via --append-system-prompt on every turn so they hold
 *  regardless of session state. Lists the repos visible under the target's working directory. */
function buildSystemPrompt(target: WorkTarget): string {
  const repoLines = target.repos.map(
    (r) => `- ${r.subdir}/ -> git repo "${r.name}", pull requests target its "${r.stagingBranch}" branch`
  );
  return [
    `You are ${config.agentName}, an autonomous engineer reachable over WhatsApp.`,
    `Your working directory contains these git repos as subfolders:`,
    ...repoLines,
    `Work out from the conversation which repo(s) a request is about - you don't need the human to`,
    `name it every time. It's fine and expected to touch more than one repo in a single task`,
    `(e.g. a backend change plus its frontend caller).`,
    ``,
    `This is an ongoing conversation: later messages are follow-ups. Continue prior work when`,
    `relevant - check out the branch you were already using (remotes have just been fetched for`,
    `you) rather than starting over.`,
    ``,
    `Hard rules, no exceptions:`,
    `- Never commit or push to "main" or any production branch in any repo. Branch protection will`,
    `  reject it anyway; do not use --force or attempt admin overrides.`,
    `- For each repo you change: work on a feature branch, then open (or update) a pull request`,
    `  targeting THAT repo's staging branch using the gh CLI.`,
    `- If a request is unclear, ask a clarifying question instead of guessing.`,
    ``,
    `You are talking to a human over WhatsApp - every message you write is sent to them directly.`,
    `So talk like a colleague on chat:`,
    `- Not every message is a coding task. If they just greet you, chat, or ask a question, reply`,
    `  naturally and briefly - only start changing code when they actually ask for work.`,
    `- When you do take on work: open with a one-line acknowledgement, send short progress notes at`,
    `  meaningful milestones (not every command), and end with a brief summary + the PR URL(s).`,
    `- Keep each message short and conversational; no markdown headings, no step-by-step logs.`,
  ].join("\n");
}

/**
 * Builds a minimal environment for the Claude child. Critically, this does NOT forward the
 * WhatsApp secrets (access token, app secret) into a process running with
 * --dangerously-skip-permissions, where a prompt-injection payload could otherwise read and
 * exfiltrate them. Only the GitHub token (if explicitly configured) is passed through; otherwise
 * gh uses its own stored auth, reachable via HOME.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
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
  onMessage: OnMessage
): Promise<ClaudeResult> {
  const system = buildSystemPrompt(target);
  const generatedId = sessionId || crypto.randomUUID();

  // stream-json emits one JSON event per line as Claude works (assistant text, tool use, result),
  // so we can relay Claude's own messages live instead of a single blob at the end. --verbose is
  // required by the CLI when combining -p with stream-json.
  const args = [
    "-p",
    userText,
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
      env: buildChildEnv(),
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
            relayedAny = true;
            log("claude_message", { target: target.label, text: block.text.slice(0, 400) });
            onMessage(block.text.trim());
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

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      clearActive();
      log("claude_timeout", { target: target.label });
      resolve({
        ok: false,
        summary: `Timed out after ${Math.round(config.claude.taskTimeoutMs / 1000)}s working on ${target.label}.`,
        sessionId: resolvedSessionId,
        relayedAny,
      });
    }, config.claude.taskTimeoutMs);

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
      clearTimeout(timer);
      clearActive();
      log("claude_spawn_failed", { target: target.label, error: String(err) });
      resolve({ ok: false, summary: `Couldn't start Claude Code: ${err.message}`, sessionId: resolvedSessionId, relayedAny });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

      const summary = String(finalResult?.result ?? "").trim();
      resolve({ ok: true, summary, sessionId: resolvedSessionId, relayedAny });
    });
  });
}
