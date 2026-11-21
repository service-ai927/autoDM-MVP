# First-10 Handling-Time Worksheet

> **Optional since automatic timing.** The app now records the time from opening a
> thread to 承認 / 保留 / 返信不要 by itself (`decision_timing` in the export,
> `automaticDecisionTiming` in the weekly report). Use this worksheet only for
> timings the app cannot see — for example the comparison items handled **without**
> the MVP.

This worksheet gives individually handled items an explicit sequence number,
start/end times, and notes.

Rules:
- Fill one numbered row per item, **at the moment you handle it** (contemporaneous).
- Do **not** write message text, contact names, or handles here — thread ID only.
- Never backfill or estimate. If you forgot to start the stopwatch, write
  `not recorded` for that row; do not infer a duration.

| # | Thread ID | Start (ISO, with tz) | End (ISO, with tz) | Duration (s) | In-app recorded? | Notes (no client content) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 2 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 3 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 4 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 5 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 6 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 7 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 8 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 9 |  |  |  |  | ☐ yes ☐ not recorded |  |
| 10 |  |  |  |  | ☐ yes ☐ not recorded |  |

At the end of the window, save the first 10 durations as JSON and pass them to the
report script with `--handling-log` — the script never infers timings from the export,
it only transcribes what you recorded here:

```json
[
  { "entry": 1, "seconds": 184 },
  { "entry": 2, "seconds": 220 }
]
```

```bash
node scripts/evaluate-week.mjs --input <export.json> --start <...> --end <...> --handling-log <handling-log.json>
```

Fewer than 10 entries are reported as "Insufficient data", not estimated. Keep this
worksheet in the same access-controlled folder as the exports.
