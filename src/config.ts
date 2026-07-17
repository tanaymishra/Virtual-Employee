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
  }
  return raw as ProjectConfig[];
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
  claude: {
    bin: process.env.CLAUDE_BIN || "claude",
    taskTimeoutMs: Number(process.env.CLAUDE_TASK_TIMEOUT_MS || 30 * 60 * 1000),
  },
  server: {
    port: Number(process.env.PORT || 3000),
  },
  logFile: process.env.LOG_FILE || "./data/virtual-employee.log",
  stateFile: process.env.STATE_FILE || "./data/state.json",
  projects: loadProjects(process.env.PROJECTS_FILE || "./config/projects.json"),
};

export function findProjectByAlias(alias: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.alias.toLowerCase() === alias.toLowerCase());
}
