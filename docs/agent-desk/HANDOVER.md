# Agent Desk on T3 Code: handover

Read this first if you are a new Claude session picking up this work.
Hindie switched Claude accounts on 2026-10-21, so the session that started this is gone.
Everything you need is in this file, the design files next to it, and the repos below.

## What Hindie wants

Hindie runs many Claude Code agents on hindie-box and is overwhelmed by their questions, which come in as free text across many sessions.
He wants one web app on the box with:

1. **A Decisions tab.** One queue of every open decision from every agent.
   Each decision has a title, context, media (playable render videos with sound, screenshots), 2 to 4 options with the agent's recommendation preselected, whether it can be undone, and whether it blocks the agent.
   He picks an option or chats back with the agent from the card, and the answer goes back to that agent's thread.
2. **An orchestrator.** One central agent that can list, start, message and stop the other threads, like Canopy's orchestrator.
3. **Multiple Claude accounts with balancing.** He has two accounts and hates logging in and out when the weekly limit is full.
   New threads should start on the account with the most room left, and a thread should move to the other account when its account hits a limit.

## Decisions already made (do not reopen)

- **Base: a fork of T3 Code**, this repo, NE1NN/t3code, branch `agent-desk`.
  We first tried CloudCLI (NE1NN/agent-desk, a fork of siteboon/claudecodeui).
  Hindie chose T3 because the orchestrator (its MCP server for outside agents), multiple Claude accounts, a usage page, visual replies and worktrees already exist.
- **Fork, not stock T3.** Hindie explicitly wants a real Decisions tab with a queue, not an orchestrator thread used as an inbox.
  Accepted costs: the tab only shows in the web app we build and host, not the App Store app; upstream changes daily, so rebase about weekly.
- **Runs on hindie-box over Tailscale only.** Not Vercel or Railway: the server runs `claude` and needs the box's repos.
- **Turn off CloudCLI** (`systemctl --user disable --now agent-desk`) once the T3 fork is up.

## Design

The approved UI mockup is the "T3 fork" page of this canvas: https://claude.ai/artifact/1SzakHdTWCuV4vVZ6ga8V8
That link is private to Hindie's first Claude account, so use the copies in [`design/`](design/):

- `T3Decisions.dc.html`: desktop Decisions tab. Sidebar entry "Decisions" with a violet count above the thread list; threads waiting on a decision show "Decision" in violet. Queue on the left with filters (All, Blocking, Can't undo), blocking first. Detail on the right: tags, "from <thread> · <account> · <age>", title, context, media cards with playable video and a one-line "Passes." or "Fails: ..." caption, T3's numbered option picker with the recommendation preselected, the conversation, and a composer with "Ask agent" and "Submit · <option>".
- `T3PhoneQueue.dc.html`, `T3PhoneDecision.dc.html`: the same at phone width.
- `T3Accounts.dc.html`: Settings › Accounts with each account's 5-hour and weekly usage, a "Balance across accounts" switch, "New threads start on", and a log of recent moves.

The `.dc.html` files are HTML with inline styles; open them in a browser to read the layout, but build with T3's own components and theme tokens.
T3's real tokens, read from the running app: background `oklch(99.2% 0 0)`, foreground `oklch(27.4% .006 286.033)`, primary `oklch(48.8% .217 264)`, border `oklch(92% .004 286.32)`, muted foreground `oklch(55.2% .016 285.938)`, system font.

## Plan for the fork

Read `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` and `docs/internals/overview.md` first, then `effect-services.md`, `providers.md`, `web-ui.md`, `server-updates.md` and `remote.md` as needed.
Find how T3 already gives agents its own tools (agents in T3 threads have `html_render` and `html_preview`), and add the decision tools the same way.

1. **Decisions in the server** (`apps/server`): a decisions table and messages table through the server's migration list, media copied into T3's data folder at request time, and an API plus live push to the web app the same way threads update.
2. **Agent tools**: `request_decision` (title, context, options, recommended option, can-be-undone, blocking, media file paths) and `reply_to_decision` (adds a message, can replace the options). The tool knows its own thread, so the agent never names it. Tell agents when and how to ask through the tool descriptions.
3. **Answers back**: picking an option or sending a reply posts a message into the agent's thread. If the thread is busy, queue it until the turn ends rather than cutting the turn off.
4. **Decisions tab in the web app** (`apps/web`), matching the design, including the sidebar entry and the "Decision" thread status. Video plays in `<video controls>` with sound.
5. **Balancing**: two Claude instances sharing one config directory, each with its own `CLAUDE_CODE_OAUTH_TOKEN` (made with `claude setup-token`), so threads can switch between them and keep history (see `docs/user/providers-claude.md`). New threads pick the instance with the lowest load (the higher of its 5-hour and weekly use; an instance with no reading counts as unused). A running thread moves only when its account is limited or 25 or more points ahead on weekly use, because switching loses the prompt cache. Read where T3 already gets usage limits for its Usage page.
6. **Updates**: our server must not be replaced by the official npm release. Turn off the in-app server update for this build (see `docs/internals/server-updates.md`).
7. **Orchestrator**: T3's MCP server already lets an outside agent list, start, message and stop threads (`docs/user/outside-agents.md`). Set up an orchestrator Claude session with Full access to it; nothing to build unless a gap shows up.
8. **Deploy on the box**: build from source (Node 24 and `vp`, see the README), run it as a systemd user service in place of the ad hoc `t3 serve`, bound to the tailnet address `100.74.186.66:3773`. Never use `--tailscale-serve` or change Tailscale.
9. **End-to-end test on the box**: an agent thread posts a decision with two real renders, it shows in the queue with playable video, picking an option reaches the thread, and the agent carries on.

## State of the box right now

- Reach it with `ssh -o ProxyCommand=none ubuntu@100.74.186.66` (Tailscale). `ssh hindie-box` goes through AWS SSM and needs `aws login --profile lyra`.
- **Official T3 v0.1.0** is running ad hoc: `~/.local/bin/t3 serve --host 100.74.186.66 --no-browser`, started with nohup from `~/Projects`, log `~/t3-serve.log`, data in `~/.t3`. One headless browser was paired. A demo thread holds a sample decision. Pair a new browser with `t3 pair` on the box.
- **CloudCLI** runs as `agent-desk.service` (systemd user unit) on port 3001 from `~/Projects/agent-desk`. Its login is in `~/agent-desk-login.txt`. Disable it once the fork is up.
- **Keepalive**: the box powers off one hour after the last activity (`/usr/local/sbin/idle-shutdown`). A loop touching `~/.canopy/2b444c97/box/busy` every 10 minutes keeps it on until about 2026-10-21 00:00 UTC. Its pid is in `~/.agent-desk-keepalive.pid`. Kill it when the overnight work is done.
- Demo media: `~/agent-desk-demo/` on the box. Two 540p renders for testing are on the Mac in the Claude scratchpad, and the originals are `~/Documents/PR-screenshots/pr-1454-20261008-1533/render-60s-a1.mp4` and `render-60s.mp4` (casual car ride content type; take 1 runs 60s with the product from 0:54, take 2 ends at 0:50).
- The box runs Node 22 by default; T3 from source needs Node 24.
- Box memory is 61 GB with no swap, shared with Hindie's other agent rows. Check `free -g` before big builds and keep to one build at a time.
- Never stop, restart or reconfigure Tailscale, and never reboot the box without Hindie's OK (see the box rules in solis-v1 `AGENTS.md`).

## What Hindie does once

1. Run `claude setup-token` for each Claude account, signed in as that account, and paste the tokens into Settings › Accounts.
2. Open `http://100.74.186.66:3773` and pair the browser.

## Status

Update this list as work lands, and commit and push it.

- [x] Fork pingdotgg/t3code to NE1NN/t3code, branch `agent-desk`, this handover
- [ ] Read the internals docs and find how agent tools, threads, migrations and usage limits work
- [ ] Decisions server: tables, agent tools, media, answers back to threads
- [ ] Decisions tab in the web app
- [ ] Balancing across Claude accounts
- [ ] Server update turned off for this build
- [ ] Build and run the fork on the box as a service on :3773, CloudCLI off
- [ ] End-to-end test on the box
- [ ] Orchestrator session set up against T3's MCP
