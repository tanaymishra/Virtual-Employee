import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/** A single git repo living as a subfolder inside a project's parent working directory. */
export interface MemberRepo {
  name: string; // e.g. "tanaymishra/fitdesk-backend"
  subdir: string; // path relative to the project's parent dir, e.g. "backend"; use "." if the project path IS this repo's root
  stagingBranch: string;
}

/**
 * A project is what someone names on WhatsApp (e.g. "fitdesk"). Claude's working directory is
 * set to `path` - the parent folder - so a single task can see and touch every member repo
 * underneath it (e.g. a backend API change plus its frontend caller) in one session.
 */
export interface ProjectConfig {
  alias: string;
  path: string;
  repos: MemberRepo[];
  /** Extra environment variables injected into the Claude subprocess for this project's tasks. */
  env?: Record<string, string>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function loadProjects(projectsFile: string): ProjectConfig[] {
  const resolved = path.resolve(projectsFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Project config file not found at ${resolved}. Copy config/projects.example.json to config/projects.json and edit it.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${resolved} must be a non-empty JSON array of project configs.`);
  }
  for (const project of raw) {
    for (const field of ["alias", "path", "repos"]) {
      if (!project[field]) {
        throw new Error(`Project config entry missing "${field}": ${JSON.stringify(project)}`);
      }
    }
    if (!Array.isArray(project.repos) || project.repos.length === 0) {
      throw new Error(`Project "${project.alias}" must have a non-empty "repos" array.`);
    }
    for (const repo of project.repos) {
      for (const field of ["name", "subdir", "stagingBranch"]) {
        if (!repo[field]) {
          throw new Error(
            `Project "${project.alias}" has a repo entry missing "${field}": ${JSON.stringify(repo)}`
          );
        }
      }
    }
    if (project.env !== undefined) {
      if (typeof project.env !== "object" || project.env === null || Array.isArray(project.env)) {
        throw new Error(`Project "${project.alias}" has an "env" field that is not an object of string values.`);
      }
      for (const [key, value] of Object.entries(project.env)) {
        if (typeof value !== "string") {
          throw new Error(
            `Project "${project.alias}" env var "${key}" must be a string, got ${typeof value}.`
          );
        }
      }
    }
  }
  return raw as ProjectConfig[];
}

// --- posix path helpers (config paths are always the Linux container's, e.g. /data/repos/...) ---
function posixDirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}
function posixRelative(from: string, to: string): string {
  const f = from.replace(/\/+$/, "");
  if (to === f) return ".";
  if (to.startsWith(f + "/")) return to.slice(f.length + 1);
  return to; // not under `from` - fall back to the absolute path
}

const projects = loadProjects(process.env.PROJECTS_FILE || "./config/projects.json");

/** The single folder that contains every project (the common parent of all project paths). In
 *  "unified" mode Claude works here and sees all repos at once. Override with WORKSPACE_PATH. */
function computeWorkspacePath(): string {
  if (process.env.WORKSPACE_PATH) return process.env.WORKSPACE_PATH;
  const parents = [...new Set(projects.map((p) => posixDirname(p.path)))];
  return parents.length === 1 ? parents[0] : "/data/repos";
}

export const config = {
  whatsapp: {
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    accessToken: required("WHATSAPP_ACCESS_TOKEN"),
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
    // Security-critical: without it, a forged webhook could set `from` to an allow-listed
    // number and inject tasks. The allow-list only means anything if payloads are authenticated.
    appSecret: required("WHATSAPP_APP_SECRET"),
  },
  allowedSenders: (process.env.ALLOWED_SENDER_NUMBERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  github: {
    token: process.env.GITHUB_TOKEN || "",
  },
  // Identity stamped on every commit the agent makes. Optional: when unset, git falls back to
  // whatever user.name/user.email is configured on the server account.
  git: {
    authorName: process.env.GIT_AUTHOR_NAME || "",
    authorEmail: process.env.GIT_AUTHOR_EMAIL || "",
  },
  claude: {
    bin: process.env.CLAUDE_BIN || "claude",
    taskTimeoutMs: Number(process.env.CLAUDE_TASK_TIMEOUT_MS || 30 * 60 * 1000),
  },
  server: {
    port: Number(process.env.PORT || 3000),
  },
  // What the agent calls itself in conversation. Configurable so the same code can be a
  // differently-named "employee".
  agentName: process.env.AGENT_NAME || "Virtual Employee",
  // "unified" (default): one folder with every repo, one continuous conversation, no routing -
  //   Claude figures out which repo(s) a message is about, and can just chat.
  // "project": route each message to a named project (mention its alias), one session per project.
  workspaceMode: (process.env.WORKSPACE_MODE || "unified").toLowerCase() === "project" ? "project" : "unified",
  workspacePath: computeWorkspacePath(),
  logFile: process.env.LOG_FILE || "./data/virtual-employee.log",
  stateFile: process.env.STATE_FILE || "./data/state.json",
  projects,
};

export function findProjectByAlias(alias: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.alias.toLowerCase() === alias.toLowerCase());
}

/** A concrete thing Claude runs against: a working directory + the repos visible under it. */
export interface WorkTarget {
  cwd: string;
  repos: MemberRepo[]; // subdir is relative to cwd
  label: string; // for logs / the busy message
  sessionKey: string; // key under which this target's Claude session id is stored
  env: Record<string, string>; // extra env vars injected into the Claude subprocess
}

const WORKSPACE_SESSION_KEY = "__workspace__";

/** Unified mode: the whole workspace, all repos, one shared session. */
export function workspaceTarget(): WorkTarget {
  const repos: MemberRepo[] = [];
  const env: Record<string, string> = {};
  for (const project of config.projects) {
    for (const repo of project.repos) {
      const abs = repo.subdir === "." ? project.path : `${project.path}/${repo.subdir}`;
      repos.push({
        name: repo.name,
        subdir: posixRelative(config.workspacePath, abs), // e.g. "fixifit/frontend"
        stagingBranch: repo.stagingBranch,
      });
    }
    // All projects share one session here, so merge every project's env; on a key clash the
    // project listed later in projects.json wins.
    Object.assign(env, project.env);
  }
  return { cwd: config.workspacePath, repos, label: "workspace", sessionKey: WORKSPACE_SESSION_KEY, env };
}

/** Project mode: a single project's folder and its member repos. */
export function projectTarget(project: ProjectConfig): WorkTarget {
  return {
    cwd: project.path,
    repos: project.repos,
    label: project.alias,
    sessionKey: project.alias,
    env: { ...project.env },
  };
}
