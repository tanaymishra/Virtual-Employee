import fs from "fs";
import path from "path";
import { config } from "./config";
import { log } from "./logger";

export interface QueuedJob {
  from: string;
  text: string;
  receivedAt: string;
}

export interface CurrentTask extends QueuedJob {
  projectAlias: string;
  startedAt: string;
}

/**
 * Persisted across restarts: the per-project Claude session ids (so a project's ongoing
 * conversation survives a redeploy) and which project was most recently active (so an
 * unqualified follow-up keeps talking to the same project). The queue and the currently
 * running task are intentionally NOT persisted - a restart kills any in-flight Claude
 * process, and replaying a half-run queue could double-execute work.
 */
interface PersistedState {
  sessions: Record<string, string>; // projectAlias -> Claude session id
  lastProjectAlias: string | null;
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

class StateStore {
  private persisted: PersistedState = { sessions: {}, lastProjectAlias: null };

  // Runtime-only (never persisted):
  private running = false;
  private currentTask: CurrentTask | null = null;
  private queue: QueuedJob[] = [];

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(config.stateFile)) {
        const raw = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
        this.persisted = {
          sessions: raw.sessions || {},
          lastProjectAlias: raw.lastProjectAlias ?? null,
        };
      }
    } catch (err) {
      log("state_load_failed", { error: String(err) });
    }
  }

  private persist() {
    try {
      ensureDir(config.stateFile);
      fs.writeFileSync(config.stateFile, JSON.stringify(this.persisted, null, 2));
    } catch (err) {
      log("state_persist_failed", { error: String(err) });
    }
  }

  // --- run state ---
  isRunning(): boolean {
    return this.running;
  }
  setRunning(v: boolean) {
    this.running = v;
  }
  getCurrentTask(): CurrentTask | null {
    return this.currentTask;
  }
  setCurrentTask(t: CurrentTask | null) {
    this.currentTask = t;
  }

  // --- queue ---
  enqueue(job: QueuedJob) {
    this.queue.push(job);
  }
  /** Puts a job at the front of the queue - used when a stopped task's owner gives a replacement. */
  enqueueFront(job: QueuedJob) {
    this.queue.unshift(job);
  }
  /** Folds text into the most recent queued job from the same sender (so rapid-fire follow-up
   *  messages become ONE next turn instead of several). Returns false if they have none queued. */
  appendToLastJobFrom(from: string, text: string): boolean {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].from === from) {
        this.queue[i].text += "\n" + text;
        return true;
      }
    }
    return false;
  }
  dequeue(): QueuedJob | undefined {
    return this.queue.shift();
  }
  queueLength(): number {
    return this.queue.length;
  }

  // --- callers waiting for us to free up (their messages are NOT queued; we ping them when idle) ---
  private waiting: string[] = [];
  addWaiting(from: string) {
    if (!this.waiting.includes(from)) this.waiting.push(from);
  }
  drainWaiting(): string[] {
    const w = this.waiting;
    this.waiting = [];
    return w;
  }

  // --- per-project Claude sessions ---
  getSession(alias: string): string | null {
    return this.persisted.sessions[alias] ?? null;
  }
  setSession(alias: string, sessionId: string) {
    this.persisted.sessions[alias] = sessionId;
    this.persist();
  }
  clearSession(alias: string) {
    delete this.persisted.sessions[alias];
    this.persist();
  }

  // --- last active project (for unqualified follow-ups) ---
  getLastProject(): string | null {
    return this.persisted.lastProjectAlias;
  }
  setLastProject(alias: string) {
    if (this.persisted.lastProjectAlias !== alias) {
      this.persisted.lastProjectAlias = alias;
      this.persist();
    }
  }
}

export const stateStore = new StateStore();
