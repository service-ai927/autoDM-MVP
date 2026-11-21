# Outreach Pipeline MVP — Client Delivery Guide

Repository baseline at this delivery update: `69aa879060a2f8f1e29453909e27ba2ef8c8da07` (branch `main`; verify the deployed SHA separately before a live evaluation).
Date: 2026-10-30. Local verification environment: Windows 11, Node 24, Chrome.

## 1. How to start the app (Windows)

```powershell
cd C:\Users\USER\Desktop\outreach-pipeline-mvp
npm install        # first time only
npm start          # production mode, serves the built UI from dist/
```

For development with hot reload use `npm run dev` instead (same port, no build needed).
`npm run build` must be run at least once before `npm start` if `dist/` is missing.

## 2. Local app URL

- App: http://127.0.0.1:3000
- Health check (no auth needed, loopback only): http://127.0.0.1:3000/api/health

The server binds to loopback (`127.0.0.1`) by default, so only this machine can reach it.

## 3. Required environment variables

None are required for local use — the app runs fully with defaults.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | No | unset | Enables live AI classification and draft generation (see §4) |
| `PORT` | No | `3000` | HTTP port |
| `HOST` | No | `127.0.0.1` | Bind address. Non-loopback in production requires `API_AUTH_TOKEN` |
| `NODE_ENV` | No | unset | `production` serves the built `dist/` bundle |
| `API_AUTH_TOKEN` | No | unset | Bearer token required for non-loopback API access |
| `ALLOWED_ORIGINS` | No | unset | Comma-separated origins granted CORS. None get CORS by default |
| `RATE_LIMIT_PER_MINUTE` | No | `300` | Per-address API request budget |
| `MAX_THREADS` | No | `5000` | Cap on stored conversations |
| `ALLOW_SAMPLE_RESET` | No | unset | Must be `true` to enable the destructive reset endpoint |
| `DATA_DIR` | No | `.data` | Where `threads.json` is persisted |

## 4. How to configure Gemini securely

Set the key in the server's environment **before** starting; it is read from the process
environment only (no `.env` loader — do not place keys in tracked files):

```powershell
# PowerShell (per session)
$env:GEMINI_API_KEY = "YOUR_GEMINI_API_KEY"
npm start
```

```bash
# bash / zsh
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
npm start
```

Rules:
- Never paste the key into chat, issues, screenshots, or Git.
- Confirm the key loaded: `http://127.0.0.1:3000/api/health` must show `"hasGeminiKey": true`.
- The key is never returned by any endpoint. Keep it only in the server process environment or hosting secret store; never commit it.

## 5. Supported workflows

1. **Receive / add** a conversation (inbox, or the 受信メッセージを追加 button).
2. **Classify** — built-in rules always run; with a Gemini key the LLM also decides.
   Scheduling, pricing/contract, performance-metric asks, complaints, and acquaintance
   contact are always routed to human review (確認が必要).
3. **Generate a draft** — AI draft with content-safety gate; gate failures are withheld
   and escalated for review. The draft header shows its source badge
   (テンプレート案（AI未使用） vs Gemini生成) so a template is never mistaken for AI output.
4. **Review and approve** — edit, rate (そのまま・軽微な修正 / 大幅な修正が必要 / 要修正), return for revision, hold,
   or approve and complete (承認して対応完了にする). Approval re-runs the content gate on
   the exact text: a gate-failing draft is **refused (HTTP 400)** until you edit it to a
   gate-passing version — there is no bypass or acknowledgement shortcut.
5. **Bulk triage** (すべてを振り分け) and per-thread re-triage (再振り分け) never
   overwrite a human-saved classification (the latter returns HTTP 409).
6. **Export** JSON / CSV for backup and evaluation; **import** JSON to load conversations.
7. **Metrics dashboard** (5日間の検証・ベンチマーク) shows live counts.

## 6. Human review and approval

- Approval is **always manual**. There is no auto-send and no connection to X, LinkedIn,
  or any email provider: approving a draft only marks the conversation complete in this app.
- Approving requires a non-empty draft **that passes the content gate**; otherwise the
  server returns HTTP 400 and you must fix the text first.
- Regenerating a draft clears its previous quality rating (the rating must describe the
  current text); editing the draft text in the panel does the same. A rating call without
  a valid rating value is rejected (no phantom timestamps).
- Draft quality ratings and the automatically recorded decision times feed the
  evaluation script.
- Handling time is recorded **automatically by the server**: from opening a thread on
  screen until 承認 / 保留 / 返信不要として完了 is pressed. There is no stopwatch to
  operate; reopening a completed thread adds no time (see README, "Handling time").

## 7. Template fallback during Gemini outages

If the key is missing, invalid, rate-limited, or Google returns an error (e.g. HTTP 503
"high demand"), the server **falls back to a labelled template draft** instead of failing:
- Check the draft source: `template_fallback` = template, `gemini` = real AI output.
- The UI and API never present a template as Gemini output.
- Provider errors are logged server-side only; API responses stay generic.
- A draft appearing is **not** proof the model ran — always check the source label.

## 8. Known limitations

- Local JSON file storage (`threads.json`), no automatic backups — copying the data
  directory is the backup mechanism. Do not run on hosts with ephemeral disks.
- No user accounts: anyone who can reach the API sees all conversations. Keep loopback
  or put an authenticated reverse proxy in front.
- No external message delivery by design.
- Gemini free tier is shared capacity: drafts may be slow or temporarily fall back to
  templates during demand spikes (verified: Google 503s observed, fallback engaged).
- Live evaluation metrics (correction rate, usability, handling time) are **unmeasured**
  until a real operator week is completed; sample size is currently zero.

## 9. Deployment requirements

- Node.js 22+ on the host; `npm install`, `npm run build`, `npm start`.
- Set `HOST=0.0.0.0` **and** a strong `API_AUTH_TOKEN`, or keep loopback behind a VPN /
  authenticated reverse proxy. Production startup **fails closed** if exposed without a token.
- Set `GEMINI_API_KEY` in the host's secret store (never on disk in the repo).
- Use persistent storage for `DATA_DIR`; take regular copies as backups.
- Do **not** set `ALLOW_SAMPLE_RESET=true` outside disposable test instances.
- Record the exact deployed commit SHA. The repository baseline documented above is not proof that a host is running that commit.

## 10. One-week evaluation instructions

1. Record start date/time with timezone, operator name, deployed commit, and Gemini state.
2. For each item handled: save your classification correction (if any) via 分類を修正,
   rate every draft you review, and record handling seconds for the first 10 items
   **at the time you handle them** (keep a separate timing log — the export cannot
   reconstruct handling times).
3. At the end of the week: export JSON from the UI (or `GET /api/export`) and run:

```bash
node scripts/evaluate-week.mjs --input <export.json> --start 2026-11-06T09:00:00+09:00 --end 2026-11-13T09:00:00+09:00
```

4. Targets: classification correction rate ≤ 15%, draft usability (helpful only —
   as-is or minor edits) ≥ 70% on at least 20 rated drafts, handling time from the
   automatic open-to-decision recording.
5. Report targets as met / not met / **insufficient data** — never infer results.

Opening the window (`scripts/evaluation-start.mjs --operator "Name"`) verifies the running
build automatically: `/api/health` now reports the server's `commitSha` (boot-time git HEAD
or `APP_COMMIT_SHA`), so `--app-commit` is only needed when health exposes none (e.g.
deployments outside a git checkout). A reported SHA that does not match your checkout
aborts the start record instead of silently mixing builds.
