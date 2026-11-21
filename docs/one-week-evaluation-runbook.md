# One-week evaluation runbook

This procedure is read-only with respect to the repository and uses JSON exports. Do not reset sample data, re-import exports, or modify `.data/threads.json` for evaluation. The server also enforces this: `POST /api/reset-samples` is refused unless the server was deliberately started with `ALLOW_SAMPLE_RESET=true` (disposable instances only).

## Before the window starts

1. Have the PR reviewed and merged through the normal review process; verify the intended commit is actually running in the environment being evaluated.
2. Confirm `GET /api/health` reports `ok: true`. Check `hasGeminiKey` without exposing the key. A configured key alone does not prove Gemini calls succeeded; verify the draft source on a small, approved test conversation using non-sensitive synthetic text first.
3. Record the start time in ISO 8601 with timezone, the running Git SHA, operator, and environment. Do not put credentials in the log.
4. Save a restricted-access JSON export from `GET /api/export` as the start snapshot. The export contains sensitive conversation data; do not commit or email it.

## During the seven-day window

- Process messages normally; keep human approval mandatory.
- For every evaluated draft, rate it in the app: 👍 `helpful` (usable as-is or with minor edits), ✏️ `minor_edit` (substantial manual editing needed), or 👎 `poor` (complete rewrite/unusable). The app records `quality_rated_at` when a rating is saved, and the report uses that timestamp to include ratings from this window. Avoid leaving ratings blank. Rate after the final regeneration: regenerating a draft clears the previous rating, because a rating must describe the draft text it judged.
- Handling time is recorded automatically: open each thread in the app and press 承認 / 保留 / 返信不要として完了 as usual. No stopwatch is needed. Process items **in the app UI** — decisions made only through the API or by an automated reviewer are stored as unmeasured and excluded from the time figures.
- Do not bulk re-triage reviewed threads, re-import old exports, or reset demo data.

## At the end

1. Record end timestamp (exclusive), timezone, and running SHA.
2. Save a restricted-access JSON export from `GET /api/export`.
3. Run the read-only report script against the end export:

```bash
node scripts/evaluate-week.mjs --input /secure/path/outreach-threads-end.json --start 2026-10-28T00:00:00+05:30 --end 2026-11-04T00:00:00+05:30 > /secure/path/evaluation-report.json
```

Use the actual recorded start/end timestamps, not the example dates. `--start` and `--end` must include an explicit timezone offset (`Z` or `±HH:MM`); timezone-less values are rejected rather than silently interpreted. The client-agreed thresholds are the defaults; if the agreed values change, pass `--target-correction-max <0-100>` and `--target-usability-min <0-100>` instead of editing the script. Keep exports and report in an access-controlled local folder.

## Metric definitions and cautions

- Headline correction rate: among items whose `human_reviewed_at` falls inside the window and that have both an original AI action and a current action, count items whose final action or category differs from `original_classification`. Target ≤15%.
- Strict correction rate: same comparison, but only where `human_reviewed_via === "update_classification"` and current `classification.decided_by === "human"`. This avoids treating approvals/completions as proof that classification was explicitly inspected. Show both rates and denominators.
- Draft usability: ratings whose `quality_rated_at` falls inside the window; `helpful / all rated drafts × 100`, where 👍 `helpful` = used as-is or with minor edits. ✏️ `minor_edit` means *substantial manual editing needed* (despite the key name) and is **not** usable; 👎 `poor` is not usable either. Target ≥70% on **at least 20 rated drafts** (`--min-rated-drafts`, default 20); below that the report sets `targetMet: null` (not judged).
- Handling time: `automaticDecisionTiming` in the report — server-recorded seconds from opening a thread to its first decision (承認 / 保留 / 返信不要), windowed by the decision time. Report `measuredCount`, mean and median, and check `unmeasuredDecisions` and `itemsWithCappedSegments` (a viewing segment capped at 30 minutes) before quoting numbers. Do not claim time savings without a measured baseline.
- The script cannot establish whether Gemini actually generated each draft. Validate generator/source separately and note fallback drafts in the report.
- If a denominator is zero, report N/A, not 0%. If fewer than 10 eligible reviewed items exist, mark the correction rate as indicative.
- The script deduplicates repeated thread IDs (first occurrence wins, reported in `dataQuality`) and excludes rated items that carry no `quality_rated_at` (rated before the timestamp existed) from every window; both are surfaced as data-quality warnings, so check `dataQuality` before quoting any number.
- Never include raw messages, contact names, handles, or thread IDs in a client-facing summary.

## Client report template

- Evaluation period / timezone:
- Running commit SHA:
- Operator:
- Number of eligible reviewed classifications:
- Headline correction rate: corrected / eligible = __% (target ≤15%)
- Strict correction rate: corrected / explicitly reviewed eligible = __%
- Draft ratings: helpful __, minor edit __, poor __; usability = (helpful + minor edit) / all rated = __% (target ≥70%)
- First 10 handling times (seconds): __; median __; mean __
- Gemini vs template fallback notes:
- Data-quality warnings / sample-size limitations:
- Conclusion: target met / not met / insufficient data for each metric.
