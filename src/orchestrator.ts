import fs from "fs";
import path from "path";
import { config, workspaceTarget, projectTarget, WorkTarget } from "./config";
import { log } from "./logger";
import { resolveProject } from "./projectRouter";
import { runClaude, cancelActive } from "./claudeRunner";
import { fetchTargetRepos } from "./git";
import { sendText, sendFile, downloadMedia, IncomingMedia } from "./whatsapp";
import { transcribeAudio } from "./transcribe";
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

/** Downloads a received WhatsApp file into the inbox dir and returns the message text with the
 *  saved path appended, so Claude can read/use the file from disk. */
async function absorbMedia(from: string, text: string, media: IncomingMedia): Promise<string> {
  const dir = path.resolve(config.inboxDir);
  fs.mkdirSync(dir, { recursive: true });
  // Prefer the real filename (documents); otherwise derive an extension from the mime type.
  const fallbackExt = (media.mimeType.split("/")[1] || "bin").split(";")[0];
  const rawName = media.filename || `${media.mimeType.split("/")[0]}.${fallbackExt}`;
  const safeName = rawName.replace(/[^\w.\-]+/g, "_");
  const dest = path.join(dir, `${Date.now()}-${safeName}`);
  const bytes = await downloadMedia(media);
  fs.writeFileSync(dest, bytes);
  log("media_received", { from, dest, mimeType: media.mimeType, bytes: bytes.length });

  // Voice notes: transcribe locally (whisper.cpp) so spoken instructions work like typed ones.
  if (media.mimeType.startsWith("audio/")) {
    const transcript = await transcribeAudio(dest);
    if (transcript) {
      const note = `[Voice note from me, transcribed: "${transcript}"] (audio file saved at ${dest})`;
      return text ? `${text}\n${note}` : note;
    }
  }

  const note = `[I sent you a file over WhatsApp; it's saved at: ${dest} (${media.mimeType})]`;
  return text ? `${text}\n${note}` : note;
}

export async function handleIncomingMessage(
  from: string,
  text: string,
  messageId?: string,
  media?: IncomingMedia
): Promise<void> {
  log("message_received", { from, text, messageId, hasMedia: Boolean(media) });

  if (!isAllowed(from)) {
    // Silent: unlisted numbers get no reply, so the bot isn't advertised to strangers.
    log("message_ignored_unauthorized", { from });
    return;
  }

  if (alreadySeen(messageId)) {
    log("message_ignored_duplicate", { from, messageId });
    return;
  }

  if (media) {
    try {
      text = await absorbMedia(from, text, media);
    } catch (err) {
      log("media_download_failed", { from, error: String(err) });
      await safeSend(from, `I couldn't download the file you sent, sorry. Mind sending it again?`);
      if (!text) return; // nothing else to act on
    }
  }

  // "/new" - start a fresh Claude session (like /clear in Claude Code).
  const newMatch = text.match(NEW_PATTERN);
  if (newMatch) {
    const rest = newMatch[1]?.trim();

    if (config.workspaceMode === "unified") {
      // One shared conversation: reset it. Any text after "/new" then runs on the fresh session.
      stateStore.clearSession(workspaceTarget().sessionKey);
      log("session_reset", { from, mode: "unified" });
      if (!rest) {
        await safeSend(from, `Fresh start — I've cleared our conversation. What would you like to do?`);
        return;
      }
      text = rest;
    } else {
      // Project mode: reset a specific project's session.
      if (!rest) {
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
      const resolution = resolveProject(rest, stateStore.getLastProject());
      if (resolution.kind === "resolved") {
        stateStore.clearSession(resolution.project.alias);
        log("session_reset", { from, project: resolution.project.alias });
      }
      text = rest;
    }
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
    const current = stateStore.getCurrentTask();

    if (current && current.from === from) {
      // Follow-up from the person whose task is RUNNING. The in-flight Claude turn can't take
      // new input mid-stream, so fold this message in as the very next turn of the SAME session:
      // front of the queue, merged with any other follow-ups they've sent since. Claude then sees
      // it with full context of the work it just finished.
      if (!stateStore.appendToLastJobFrom(from, text)) {
        stateStore.enqueueFront(job);
      }
      log("followup_folded_in", { from, text });
      await safeSend(
        from,
        `Got it, I'll fold that in right after the current step. (Send "stop" if you want me to drop what I'm doing instead.)`
      );
      return;
    }

    // Someone else's task is running. Their message is deliberately NOT queued (running a stale
    // request minutes later without them present is worse than asking again) - we just note who
    // reached out and ping them once we're free, so they can tell us then.
    stateStore.addWaiting(from);
    log("caller_waiting", { from });
    await safeSend(
      from,
      `I'm in the middle of something right now. I'll message you as soon as I'm free.`
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
    stateStore.addWaiting(from);
    await safeSend(
      from,
      `Only the person who started the current task ("${current.projectAlias}") can stop it. ` +
        `I'll message you as soon as I'm free.`
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

  // Now that we're free, ping everyone who reached out while we were busy so they can send
  // their request fresh (their earlier message was intentionally not queued).
  for (const from of stateStore.drainWaiting()) {
    await safeSend(from, `Hi, I'm free now. What would you like me to do?`);
  }
}

/** Resolve which target (workspace or a specific project) a job runs against. Returns null if the
 *  job can't be routed yet (project mode only) - the reply has already been sent in that case. */
async function resolveTarget(job: QueuedJob): Promise<WorkTarget | null> {
  if (config.workspaceMode === "unified") {
    // No routing: one shared workspace + conversation, Claude figures out the rest.
    return workspaceTarget();
  }

  const resolution = resolveProject(job.text, stateStore.getLastProject());
  if (resolution.kind === "unknown") {
    const aliases = config.projects.map((p) => p.alias).join(", ");
    await safeSend(job.from, `Which project is this for? Mention one of: ${aliases}`);
    return null;
  }
  if (resolution.kind === "ambiguous") {
    await safeSend(job.from, `That could mean more than one project (${resolution.aliases.join(", ")}). Please specify.`);
    return null;
  }
  stateStore.setLastProject(resolution.project.alias);
  return projectTarget(resolution.project);
}

async function processJob(job: QueuedJob): Promise<void> {
  const target = await resolveTarget(job);
  if (!target) return; // couldn't route (project mode); user was already told

  stateStore.setCurrentTask({ ...job, projectAlias: target.label, startedAt: new Date().toISOString() });
  log("task_started", { from: job.from, target: target.label, text: job.text });

  await fetchTargetRepos(target);

  // Relay Claude's own messages to the user as they stream in, in order. We chain the sends so
  // they arrive sequentially without blocking the stream parser. No hardcoded "on it" ack -
  // Claude speaks for itself; our own messages are reserved for control/failure states.
  let sendChain: Promise<void> = Promise.resolve();
  const relay = (text: string) => {
    sendChain = sendChain.then(() => safeSend(job.from, text));
  };
  // Files Claude asks to deliver (SEND_FILE: lines) ride the same chain so attachments arrive
  // in order with the surrounding messages. A failed send becomes an apology text, not a crash.
  const relayFile = (filePath: string) => {
    sendChain = sendChain.then(async () => {
      try {
        await sendFile(job.from, filePath);
      } catch (err) {
        log("send_file_failed", { to: job.from, filePath, error: String(err) });
        await safeSend(job.from, `(I tried to send you the file ${filePath} but it failed: ${String(err).slice(0, 300)})`);
      }
    });
  };

  const priorSession = stateStore.getSession(target.sessionKey);
  const result = await runClaude(job.text, target, priorSession, relay, relayFile);
  await sendChain; // make sure every streamed message has been sent before we finish up

  log("task_finished", {
    from: job.from,
    target: target.label,
    ok: result.ok,
    cancelled: result.cancelled,
    relayedAny: result.relayedAny,
  });

  // Session bookkeeping: if a RESUME failed (not merely cancelled), drop the stored session so the
  // next message starts a clean one instead of repeatedly failing to resume a broken conversation.
  if (!result.ok && !result.cancelled && priorSession) {
    stateStore.clearSession(target.sessionKey);
    log("session_cleared_after_failure", { target: target.label });
  } else if (result.sessionId) {
    stateStore.setSession(target.sessionKey, result.sessionId);
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
