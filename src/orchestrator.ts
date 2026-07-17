import { config } from "./config";
import { log } from "./logger";
import { resolveProject } from "./projectRouter";
import { runClaude, cancelActive } from "./claudeRunner";
import { fetchProjectRepos } from "./git";
import { sendText } from "./whatsapp";
import { stateStore, QueuedJob } from "./state";

// Matches "stop"/"cancel"/"abort" (optionally "/stop"), optionally followed by a replacement
// instruction, e.g. "stop, do X instead" -> group 2 captures "do X instead".
const STOP_PATTERN = /^\s*\/?(stop|cancel|abort)\b[,:\s-]*(.*)$/i;

// Matches the "/new" command ONLY when the message starts with it as a whole word - so a stray
// "/new" inside a sentence (e.g. "i need a page named /new") does NOT reset the session.
// Group 1 captures any task text after it, e.g. "/new fixifit: do X".
const NEW_PATTERN = /^\/new(?:\s+([\s\S]*))?$/i;

// Meta delivers webhooks at-least-once; remember recent message ids to drop redeliveries.
const recentMessageIds = new Set<string>();
const RECENT_ID_CAP = 1000;

function alreadySeen(messageId: string | undefined): boolean {
  if (!messageId) return false;
  if (recentMessageIds.has(messageId)) return true;
  recentMessageIds.add(messageId);
  if (recentMessageIds.size > RECENT_ID_CAP) {
    const oldest = recentMessageIds.values().next().value;
    if (oldest !== undefined) recentMessageIds.delete(oldest);
  }
  return false;
}

function isAllowed(from: string): boolean {
  // No allow-list configured -> fail closed rather than open.
  if (config.allowedSenders.length === 0) return false;
  return config.allowedSenders.includes(from);
}

async function safeSend(to: string, body: string) {
  try {
    await sendText(to, body);
  } catch (err) {
    log("send_failed", { to, error: String(err) });
  }
}

export async function handleIncomingMessage(from: string, text: string, messageId?: string): Promise<void> {
  log("message_received", { from, text, messageId });

  if (!isAllowed(from)) {
    // Silent: unlisted numbers get no reply, so the bot isn't advertised to strangers.
    log("message_ignored_unauthorized", { from });
    return;
  }

  if (alreadySeen(messageId)) {
    log("message_ignored_duplicate", { from, messageId });
    return;
  }

  // "/new" - start a fresh Claude session for a project (like /clear in Claude Code).
  const newMatch = text.match(NEW_PATTERN);
  if (newMatch) {
    const rest = newMatch[1]?.trim();
    if (!rest) {
      // Bare "/new": reset the currently-active project's session.
      const last = stateStore.getLastProject();
      if (last) {
        stateStore.clearSession(last);
        log("session_reset", { from, project: last });
        await safeSend(from, `Started a fresh session for "${last}". Your next message begins a new conversation.`);
      } else {
        const aliases = config.projects.map((p) => p.alias).join(", ");
        await safeSend(from, `No active project yet. Say e.g. "/new ${config.projects[0]?.alias ?? "project"}: <task>". Projects: ${aliases}`);
      }
      return;
    }
    // "/new <task>": reset that project's session, then run the task fresh.
    const resolution = resolveProject(rest, stateStore.getLastProject());
    if (resolution.kind === "resolved") {
      stateStore.clearSession(resolution.project.alias);
      log("session_reset", { from, project: resolution.project.alias });
    }
    text = rest;
  }

  const stopMatch = text.match(STOP_PATTERN);
  if (stopMatch) {
    if (stateStore.isRunning()) {
      await handleStop(from, stopMatch[2]?.trim());
      return;
    }
    // Nothing running: if a real instruction followed "stop", treat it as a fresh task;
    // otherwise just confirm there's nothing to stop.
    if (!stopMatch[2]?.trim()) {
      await safeSend(from, "Nothing's running right now.");
      return;
    }
    text = stopMatch[2].trim();
  }

  const job: QueuedJob = { from, text, receivedAt: new Date().toISOString() };

  if (stateStore.isRunning()) {
    stateStore.enqueue(job);
    const current = stateStore.getCurrentTask();
    const desc = current ? `"${current.text}" (${current.projectAlias})` : "another task";
    await safeSend(
      from,
      `Still working on ${desc}. I'll get to yours next (queue position: ${stateStore.queueLength()}). ` +
        `Send "stop" if you started the current task and want to cancel it.`
    );
    return;
  }

  stateStore.enqueue(job);
  runLoop().catch((err) => log("run_loop_failed", { error: String(err) }));
}

async function handleStop(from: string, replacementText: string | undefined): Promise<void> {
  const current = stateStore.getCurrentTask();
  if (!current) return; // isRunning() was true but between tasks; nothing concrete to cancel

  if (current.from !== from) {
    await safeSend(
      from,
      `Only the person who started the current task ("${current.projectAlias}") can stop it. ` +
        `Send your own request and it'll be queued.`
    );
    return;
  }

  cancelActive();
  log("task_cancelled_by_owner", { from, project: current.projectAlias });

  if (replacementText) {
    // Jump the replacement to the front so the drain loop runs it as soon as the killed turn unwinds.
    stateStore.enqueueFront({ from, text: replacementText, receivedAt: new Date().toISOString() });
    await safeSend(from, `Stopped what I was doing on "${current.projectAlias}". Starting your new request next.`);
  } else {
    await safeSend(from, `Stopped what I was doing on "${current.projectAlias}". Send me what you'd like next.`);
  }
}

/**
 * Drains the queue one job at a time. A single loop owns the "running" flag, so an unclear or
 * rejected job no longer strands everything queued behind it - it just gets skipped and the loop
 * moves on.
 */
async function runLoop(): Promise<void> {
  if (stateStore.isRunning()) return; // re-entrancy guard
  stateStore.setRunning(true);
  try {
    let job: QueuedJob | undefined;
    while ((job = stateStore.dequeue())) {
      await processJob(job);
    }
  } finally {
    stateStore.setCurrentTask(null);
    stateStore.setRunning(false);
  }
}

async function processJob(job: QueuedJob): Promise<void> {
  const resolution = resolveProject(job.text, stateStore.getLastProject());

  if (resolution.kind === "unknown") {
    const aliases = config.projects.map((p) => p.alias).join(", ");
    await safeSend(job.from, `Which project is this for? Mention one of: ${aliases}`);
    return;
  }
  if (resolution.kind === "ambiguous") {
    await safeSend(job.from, `That could mean more than one project (${resolution.aliases.join(", ")}). Please specify.`);
    return;
  }

  const project = resolution.project;
  stateStore.setLastProject(project.alias);
  stateStore.setCurrentTask({ ...job, projectAlias: project.alias, startedAt: new Date().toISOString() });

  log("task_started", { from: job.from, project: project.alias, text: job.text });

  await fetchProjectRepos(project);

  // Relay Claude's own messages to the user as they stream in, in order. We chain the sends so
  // they arrive sequentially without blocking the stream parser. No hardcoded "on it" ack -
  // Claude speaks for itself; our own messages are reserved for control/failure states.
  let sendChain: Promise<void> = Promise.resolve();
  const relay = (text: string) => {
    sendChain = sendChain.then(() => safeSend(job.from, text));
  };

  const priorSession = stateStore.getSession(project.alias);
  const result = await runClaude(job.text, project, priorSession, relay);
  await sendChain; // make sure every streamed message has been sent before we finish up

  log("task_finished", {
    from: job.from,
    project: project.alias,
    ok: result.ok,
    cancelled: result.cancelled,
    relayedAny: result.relayedAny,
  });

  // Session bookkeeping: if a RESUME failed (not merely cancelled), drop the stored session so the
  // next message starts a clean one instead of repeatedly failing to resume a broken conversation.
  if (!result.ok && !result.cancelled && priorSession) {
    stateStore.clearSession(project.alias);
    log("session_cleared_after_failure", { project: project.alias });
  } else if (result.sessionId) {
    stateStore.setSession(project.alias, result.sessionId);
  }

  if (!result.cancelled) {
    if (!result.ok) {
      // Failure fallback - Claude may not have streamed anything before erroring.
      await safeSend(job.from, result.summary);
    } else if (!result.relayedAny && result.summary) {
      // Success but Claude produced no streamed text (e.g. only tool calls) - send the summary.
      await safeSend(job.from, result.summary);
    }
    // Success WITH streamed messages: the final summary was already sent as the last one.
  }

  stateStore.setCurrentTask(null);
}
