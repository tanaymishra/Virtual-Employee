# Virtual Employee

An autonomous engineer you talk to over WhatsApp. It's Claude Code, adapted: WhatsApp (Meta Cloud
API) <-> this orchestrator <-> headless Claude Code <-> GitHub, restricted to opening PRs against
each repo's staging branch. One task runs at a time; anyone who messages while it's busy gets told
what it's working on and gets a reply once it's free. The person who started the current task can
interrupt it by sending "stop".

## How it works

1. Meta sends incoming WhatsApp messages to `POST /webhook`. The `X-Hub-Signature-256` is
   verified against `WHATSAPP_APP_SECRET` on every request (required), and duplicate
   redeliveries (Meta delivers at-least-once) are dropped by message id.
2. The sender is checked against `ALLOWED_SENDER_NUMBERS`. Unlisted numbers are **silently
   ignored** - no reply, so the bot's existence isn't advertised to strangers and no WhatsApp
   conversation gets opened with them.
3. If the message is "stop"/"cancel"/"abort" (optionally followed by a new instruction, e.g.
   `stop, do X instead`):
   - from whoever started the currently-running task -> the in-flight Claude Code process is
     killed immediately; if a replacement instruction was included it jumps to the front of the
     queue and runs next, otherwise it just goes idle.
   - from anyone else -> they're told only the task's owner can stop it.
4. Otherwise, if it's mid-task, the message is queued and the sender is told what's in
   progress.
5. The message text picks a **project** (see below) from `config/projects.json`.
6. Claude Code runs headless (`claude -p ... --dangerously-skip-permissions`) with its working
   directory set to the project's **parent folder**, under a persistent system prompt
   (`--append-system-prompt`) that hard-forbids touching `main`/production and requires opening a
   PR against each touched repo's own staging branch via `gh`.
7. The result summary is sent back over WhatsApp (split into chunks if it exceeds WhatsApp's
   4096-char limit); the next queued job (if any) starts. An unclear or rejected message is
   skipped without stranding the jobs queued behind it.

**The staging-only rule is enforced twice**: once by the prompt, and for real by GitHub branch
protection (below) so the bot's GitHub identity is technically incapable of pushing to `main` even
if it were instructed to.

### It's one continuous conversation per project

It does not treat each WhatsApp message as an isolated task. Each **project** has its own
persistent Claude Code session (tracked by session id and resumed with `--resume`), so messages
are **follow-ups** in an ongoing conversation - exactly like using Claude Code normally, with
WhatsApp as the transport. "Fix the login bug" then "actually also log the failures" continues
the same session, with the same memory of what it just did. Before each turn the project's repos
are `git fetch`ed (non-destructively - in-progress work is never wiped) so branches/PRs build on
current refs.

Once you've named a project, plain follow-ups that don't name one keep talking to that same
project (the most-recently-active one), so you don't have to prefix every message.

### Fully unattended (no one to answer prompts)

It runs with no human present, so nothing is allowed to block on a prompt:

- Claude Code runs with `--dangerously-skip-permissions` (and `-p` print mode), so it never
  stops to ask for tool approval.
- The subprocess gets its **stdin from `/dev/null`** - any tool that tries to read input gets EOF
  and moves on instead of blocking on an empty pipe.
- The child environment forces every subtool non-interactive: `GIT_TERMINAL_PROMPT=0` and
  `GCM_INTERACTIVE=never` (git/credential-manager error instead of prompting for a password),
  `GIT_EDITOR=true`/`EDITOR`/`VISUAL` (no editor hang on commit messages or rebases), and
  `GIT_PAGER`/`PAGER`/`GH_PAGER=cat` (no pager waiting on a keypress).
- The per-task timeout (`CLAUDE_TASK_TIMEOUT_MS`, default 30 min) is the final backstop: if
  something still wedges, it's SIGKILLed and the failure is reported over WhatsApp.

Because it runs unattended with skip-permissions, it MUST run in the sandboxed devcontainer +
firewall (the `.devcontainer/` setup at the repo root), so a mistake or a prompt-injection can't
reach beyond the container or the allow-listed network destinations.

### Secrets are kept out of the agent's reach

Claude runs with `--dangerously-skip-permissions` (no human is present to approve tool calls), so
it is handed a **minimal environment** - the WhatsApp access token and app secret are deliberately
NOT passed into it, so a prompt-injection payload in a repo/issue can't read and exfiltrate them.
Only a GitHub token is exposed, and only if you set one explicitly (otherwise `gh` uses its own
stored auth).

## Projects = a parent folder of sibling repos

A "project" is what gets mentioned on WhatsApp (e.g. `fitdesk`). Its `path` is a parent directory
that can contain **one or more git repos as subfolders** - e.g. a `fitdesk` project with
`backend/` and `frontend/` living side by side:

```
/home/agent/repos/fitdesk/
  backend/     <- git repo, remote tanaymishra/fitdesk-backend
  frontend/    <- git repo, remote tanaymishra/fitdesk-frontend
```

Claude Code's working directory is set to the **parent folder**, not a single repo, so one WhatsApp
request like `fitdesk: the workout API returns the wrong units, fix it end to end` can see both
repos, figure out which one(s) actually need changes, and open a separate PR per touched repo
against that repo's own staging branch. A single-repo project just lists one entry with
`"subdir": "."`. See `config/projects.example.json`.

## One-time setup

### 1. Meta / WhatsApp Cloud API

1. Create an app at [developers.facebook.com](https://developers.facebook.com/), add the
   **WhatsApp** product.
2. Grab the **Phone number ID** and a permanent **access token** (System User token, not the
   24h temporary one) → `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`.
3. Under App Settings → Basic, copy the **App Secret** → `WHATSAPP_APP_SECRET`.
4. Under WhatsApp → Configuration, set the webhook URL to `https://<your-server>/webhook`
   (must be HTTPS - use a reverse proxy / Caddy / nginx with a real cert, or ngrok while testing),
   set the verify token to match `WHATSAPP_VERIFY_TOKEN`, and subscribe to the `messages` field.
5. Set `ALLOWED_SENDER_NUMBERS` to the E.164 digits (no "+") of every number allowed to talk to
   it - anyone else is invisible to it.

### 2. GitHub bot identity

1. Create a dedicated GitHub account for the bot (e.g. `ve-bot`) and add it as a collaborator
   (or org member) on each repo it should touch.
2. On the server, `gh auth login` as that account (or set `GITHUB_TOKEN` to a fine-grained PAT
   scoped only to the needed repos with contents/PR write access).
3. **Protect `main`** on every repo (Settings → Branches → branch protection rule): require a pull
   request before merging, require review, disallow force pushes, and do **not** grant the bot
   account admin/bypass rights. This is what actually stops it from ever landing on `main`,
   independent of what any prompt says.
4. Clone each member repo locally on the server under its project's parent folder (see layout
   above), with `origin` reachable using the bot's `gh`/git credentials.

### 3. Server

Requires Node.js 18.17+, the `gh` CLI, and the `claude` CLI logged into your Max subscription
(`claude login` once, interactively, from the same user account this service runs as - the
session persists after that). The `deploy/virtual-employee.service` unit assumes the repo is
cloned at `/home/agent/Virtual-Employee` and runs as user `agent`; adjust both if you use a
different account or path.

```bash
cp .env.example .env                # fill in WhatsApp + GitHub values
cp config/projects.example.json config/projects.json   # list your projects, member repos, staging branches
npm install
npm run build
sudo cp deploy/virtual-employee.service /etc/systemd/system/virtual-employee.service
sudo systemctl daemon-reload
sudo systemctl enable --now virtual-employee
```

### 4. Test

Message the WhatsApp number from an allow-listed number, mentioning a project alias from
`config/projects.json`, e.g. `fitdesk: fix the broken footer link`. While it's working, send
`stop` to cancel it, optionally followed by a new instruction.

While a task is running, follow-up messages from the person who started it are folded into the
same conversation: they run as the very next turn of that session (merged into one message if
several arrive), so context carries over. Messages from anyone else are not queued: they get a
brief "I'll message you as soon as I'm free" reply (which doesn't reveal what the current task
is), and once the agent is free it pings them to ask what they need.

## Configuration reference

Everything identity-specific lives outside the code so the same service can be repointed to a
different WhatsApp number, GitHub bot account, or project list without touching source:

| What | Where |
|---|---|
| WhatsApp number/credentials | `.env` |
| Allow-listed sender numbers | `.env` (`ALLOWED_SENDER_NUMBERS`) |
| GitHub bot token (optional override) | `.env` (`GITHUB_TOKEN`) |
| Commit author name/email | `.env` (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`) |
| Projects, member repos, subdirs, staging branch names | `config/projects.json` |
| Per-project env vars injected into Claude tasks | `config/projects.json` (optional `env` object per project) |
| Per-task timeout | `.env` (`CLAUDE_TASK_TIMEOUT_MS`) |

## Known limitations (phase 1)

- **Single worker**: one task at a time, matching a single Claude Max login. Concurrent
  multi-project work needs either accepting the queue delay or a second Claude account.
- **Meta's 24-hour window**: the Cloud API only permits free-form messages within 24h of the
  user's last inbound message. A task that runs (or sits queued) longer than that means its
  completion summary can't be delivered as free-form text - it would need a pre-approved message
  template. Proactive messages (e.g. the phase-2 staging-deploy pings) must be templates too.
  Fine for quick turnarounds; a real constraint for long jobs.
- **Max plan usage caps** aren't handled yet - if a task hits a cap mid-run, Claude Code errors
  out and the failure message goes back over WhatsApp as-is. A graceful fallback (e.g. to a
  metered API key) is a good phase-2 addition.
- **No staging-deploy webhook yet** (CI → WhatsApp notification on successful staging deploy) -
  add a GitHub Actions step on the staging branch that POSTs to a small new endpoint here once
  your CI is wired up. Remember it'll need a message template (see the 24h window above).
- **Restart mid-task**: the in-flight job and the in-memory queue are dropped on restart (a
  restart kills the underlying Claude process, and replaying a half-run queue could double-execute
  work). Per-project session ids and the last-active project ARE persisted, so conversations
  resume - but the requester of an interrupted job isn't auto-notified; check `data/virtual-employee.log`.
- **"stop" is a keyword match** (stop/cancel/abort), not an NLU intent - a task description that
  happens to start with one of those words is treated as a stop command.
