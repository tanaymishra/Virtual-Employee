import crypto from "crypto";
import { ChildProcess, spawn } from "child_process";
import { ProjectConfig, config } from "./config";
import { log } from "./logger";

export interface ClaudeResult {
  ok: boolean;
  summary: string;
  cancelled?: boolean;
  sessionId?: string; // the session to resume next time for this project
}

/** The persistent guardrails, injected via --append-system-prompt on every turn so they hold
 *  regardless of session state. Project-specific because it lists that project's member repos. */
function buildSystemPrompt(project: ProjectConfig): string {
  const repoLines = project.repos.map(
    (r) => `- ${r.subdir}/ -> git repo "${r.name}", pull requests target its "${r.stagingBranch}" branch`
  );
  return [
    `You are Superset, an autonomous virtual engineer reachable over WhatsApp, working inside the "${project.alias}" project.`,
    `Your working directory contains these git repos as subfolders:`,
    ...repoLines,
    `This is an ongoing conversation: later messages are follow-ups to earlier ones. Continue prior`,
    `work when relevant - check out the branch you were already using (its remotes have just been`,
    `fetched for you) rather than starting over.`,
    ``,
    `Hard rules, no exceptions:`,
    `- Never commit or push to "main" or any production branch in any repo. Branch protection will`,
    `  reject it anyway; do not use --force or attempt admin overrides.`,
    `- For each repo you change: work on a feature branch, then open (or update) a pull request`,
    `  targeting THAT repo's staging branch using the gh CLI.`,
    `- It's fine and expected to touch more than one repo in a single task (e.g. a backend change`,
    `  plus its frontend caller).`,
    `- If the task is unclear or you get blocked, stop and say what you need instead of guessing.`,
    `- Finish with a short plain-English summary (2-5 sentences) of what changed in each repo and`,
    `  the PR URL(s). It is sent to a human over WhatsApp, so keep it concise - no step-by-step log.`,
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
  project: ProjectConfig,
  sessionId: string | null
): Promise<ClaudeResult> {
  const system = buildSystemPrompt(project);
  const generatedId = sessionId || crypto.randomUUID();

  const args = [
    "-p",
    userText,
    "--output-format",
    "json",
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
    // stdin = "ignore" (/dev/null): a tool that tries to read stdin gets EOF and moves on, instead
    // of blocking on an empty pipe forever with no human to type an answer.
    const child = spawn(config.claude.bin, args, {
      cwd: project.path,
      env: buildChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const handle = { child, cancelled: false };
    active = handle;

    let stdout = "";
    let stderr = "";
    let settled = false;

    const clearActive = () => {
      if (active === handle) active = null;
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      clearActive();
      log("claude_timeout", { project: project.alias });
      resolve({
        ok: false,
        summary: `Timed out after ${config.claude.taskTimeoutMs / 1000}s working on ${project.alias}.`,
        sessionId: generatedId,
      });
    }, config.claude.taskTimeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearActive();
      log("claude_spawn_failed", { project: project.alias, error: String(err) });
      resolve({ ok: false, summary: `Couldn't start Claude Code: ${err.message}`, sessionId: generatedId });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearActive();
      log("claude_exit", {
        project: project.alias,
        code,
        cancelled: handle.cancelled,
        stderrTail: stderr.slice(-2000),
      });

      if (handle.cancelled) {
        resolve({
          ok: false,
          cancelled: true,
          summary: `Stopped work on "${project.alias}" as requested.`,
          sessionId: generatedId,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          ok: false,
          summary: `Claude Code exited with an error while working on ${project.alias}. ${stderr.slice(-500) || ""}`.trim(),
          sessionId: generatedId,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        const summary = parsed?.result ?? parsed?.summary ?? stdout;
        const returnedId = parsed?.session_id || generatedId;
        resolve({ ok: true, summary: String(summary).trim(), sessionId: returnedId });
      } catch {
        resolve({ ok: true, summary: stdout.trim() || "Done, but no summary was returned.", sessionId: generatedId });
      }
    });
  });
}
