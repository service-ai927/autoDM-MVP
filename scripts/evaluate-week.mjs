#!/usr/bin/env node
import fs from "node:fs";
import { summarizeDecisionTimes } from "../src/decision-timing.mjs";

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") options.input = argv[++i];
    else if (arg === "--start") options.start = argv[++i];
    else if (arg === "--end") options.end = argv[++i];
    else if (arg === "--target-correction-max") options.targetCorrectionMax = argv[++i];
    else if (arg === "--target-usability-min") options.targetUsabilityMin = argv[++i];
    else if (arg === "--min-rated-drafts") options.minRatedDrafts = argv[++i];
    else if (arg === "--handling-log") options.handlingLog = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// ISO 8601 date/time with an explicit timezone offset ("Z" or ±HH:MM).
// Timezone-less values ("2026-10-28T00:00:00") and bare dates are rejected:
// JavaScript would silently interpret them as local time or UTC, which can
// shift a whole evaluation window by hours.
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

function validDate(value, name) {
  const raw = String(value ?? "").trim();
  if (!ISO_WITH_TIMEZONE.test(raw)) {
    throw new Error(
      `--${name} must be an ISO 8601 date/time with an explicit timezone offset (e.g. 2026-10-28T00:00:00+09:00 or 2026-10-28T00:00:00Z)`
    );
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`--${name} must be a valid ISO date/time`);
  return date;
}

function validThreshold(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`--${name} must be a number between 0 and 100`);
  }
  return parsed;
}

function validMinCount(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Parse export-file text into the payload object. A leading UTF-8 BOM is
 * stripped first: Windows PowerShell (`Set-Content -Encoding UTF8`,
 * `Out-File`) writes one by default, and JSON.parse rejects a BOM-prefixed
 * document. Real API exports never carry a BOM, so stripping is a no-op there.
 */
export function parseExportPayload(raw) {
  const text = typeof raw === "string" && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(text);
}

const MAX_HANDLING_SECONDS = 86_400; // mirrors the server's per-record cap
const FIRST_TEN_SAMPLE_SIZE = 10;

/**
 * Validate normalized `{ entry, seconds }` rows for the first-10 sample.
 * Shared by parseHandlingLog (raw JSON input) and buildEvaluationReport
 * (already-parsed input), so both paths enforce the same rules:
 *   - every row must state its entry number explicitly (no positional default),
 *   - entry must be an integer from 1 through 10,
 *   - each entry number may appear exactly once (no duplicates),
 *   - at most 10 rows in total.
 * Anything else aborts the report rather than silently shrinking or faking
 * the first-10 sample.
 */
export function validateHandlingEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('Handling log must be a JSON array of { "entry", "seconds" } objects (or { "entries": [...] })');
  }
  if (entries.length > FIRST_TEN_SAMPLE_SIZE) {
    throw new Error(
      `Handling log has ${entries.length} entries; the first-10 sample allows at most ${FIRST_TEN_SAMPLE_SIZE}.`
    );
  }
  const seen = new Set();
  return entries.map((item, index) => {
    const entry = item?.entry;
    const seconds = item?.seconds;
    if (entry === undefined || entry === null) {
      throw new Error(
        `Handling log entry ${index + 1}: "entry" is required — every log line must state its sequence number (1-${FIRST_TEN_SAMPLE_SIZE}); entry numbers are never inferred from position.`
      );
    }
    if (!Number.isInteger(entry) || entry < 1 || entry > FIRST_TEN_SAMPLE_SIZE) {
      throw new Error(
        `Handling log entry ${index + 1}: "entry" must be an integer from 1 to ${FIRST_TEN_SAMPLE_SIZE} (got ${JSON.stringify(entry)})`
      );
    }
    if (seen.has(entry)) {
      throw new Error(
        `Handling log: duplicate entry number ${entry} — each of entries 1-${FIRST_TEN_SAMPLE_SIZE} may appear exactly once.`
      );
    }
    seen.add(entry);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_HANDLING_SECONDS) {
      throw new Error(`Handling log entry ${index + 1}: "seconds" must be a finite number > 0 and <= ${MAX_HANDLING_SECONDS}`);
    }
    return { entry, seconds };
  });
}

/**
 * Validate the operator's contemporaneous handling-time log. Accepts a JSON
 * array of `{ entry, seconds }` objects (or `{ "entries": [...] }`). Only the
 * operator's own recorded seconds are ever used — nothing is inferred from
 * the export. Invalid values abort the report rather than silently shrinking
 * the first-10 sample.
 */
export function parseHandlingLog(raw) {
  const entries = Array.isArray(raw) ? raw : raw?.entries;
  return validateHandlingEntries(entries);
}

function inWindow(timestamp, start, end) {
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
}

function classificationCorrected(item) {
  const original = item?.original_classification;
  const current = item?.classification;
  if (!original?.action || !current?.action) return false;
  // Only operator-made changes are corrections. Machine-made changes (a later
  // rule/LLM re-triage or a safety-gate escalation) never count, so the metric
  // cannot be inflated by the system changing its own mind.
  if (String(current.decided_by ?? "").trim() !== "human") return false;
  return String(original.action).trim() !== String(current.action).trim()
    || String(original.category ?? "").trim() !== String(current.category ?? "").trim();
}

const KNOWN_RATINGS = ["helpful", "minor_edit", "poor"];

export function buildEvaluationReport(payload, startValue, endValue, options = {}) {
  const start = validDate(startValue, "start");
  const end = validDate(endValue, "end");
  if (end <= start) throw new Error("--end must be later than --start");

  const targetCorrectionMax = validThreshold(options.targetCorrectionMax, 15, "target-correction-max");
  const targetUsabilityMin = validThreshold(options.targetUsabilityMin, 70, "target-usability-min");
  // Client criterion: usability is judged only on at least 20 rated drafts.
  const minRatedDrafts = validMinCount(options.minRatedDrafts, 20, "min-rated-drafts");

  const threads = Array.isArray(payload) ? payload : payload?.threads;
  if (!Array.isArray(threads)) throw new Error("Input JSON must be an array or an object with a threads array");

  // A repeated thread.id would be counted twice and inflate both numerator
  // and denominator; keep the first occurrence and report the duplication.
  const seenIds = new Set();
  const uniqueThreads = [];
  let duplicateThreadIds = 0;
  for (const entry of threads) {
    const id = entry && typeof entry === "object" ? entry?.thread?.id : undefined;
    if (id) {
      if (seenIds.has(id)) {
        duplicateThreadIds += 1;
        continue;
      }
      seenIds.add(id);
    }
    uniqueThreads.push(entry);
  }

  const reviewed = uniqueThreads.filter((item) => inWindow(item?.human_reviewed_at, start, end)
    && item?.original_classification?.action
    && item?.classification?.action);

  const corrected = reviewed.filter(classificationCorrected);
  const strictCandidates = reviewed.filter((item) =>
    item?.human_reviewed_via === "update_classification"
    && item?.classification?.decided_by === "human");
  const strictCorrected = strictCandidates.filter(classificationCorrected);

  // Ratings have their own timestamp; do not infer rating time from classification review.
  const rated = uniqueThreads.filter((item) =>
    inWindow(item?.quality_rated_at, start, end)
    && KNOWN_RATINGS.includes(item?.quality_rating));
  const helpful = rated.filter((item) => item.quality_rating === "helpful").length;
  const minorEdit = rated.filter((item) => item.quality_rating === "minor_edit").length;
  const poor = rated.filter((item) => item.quality_rating === "poor").length;

  // Ratings recorded without a quality_rated_at (before the field existed)
  // cannot be placed in any window. They are excluded, never silently counted.
  const ratingsMissingTimestamp = uniqueThreads.filter(
    (item) => KNOWN_RATINGS.includes(item?.quality_rating) && !item?.quality_rated_at
  ).length;

  // Handling times come only from the operator's contemporaneous log passed via
  // --handling-log. The export itself has no per-recording timestamp or item
  // sequence, so nothing is ever inferred from it. Validation runs again here
  // (defense in depth for direct callers): explicit entry numbers 1-10, no
  // duplicates, no more than 10 rows — never a positional default or a slice.
  const handlingLogEntries = Array.isArray(options.handlingLog)
    ? validateHandlingEntries(options.handlingLog)
    : [];
  const timingValues = handlingLogEntries.map((item) => item.seconds);
  // Complete only when entries 1..10 are each present exactly once.
  const presentEntries = new Set(handlingLogEntries.map((item) => item.entry));
  const sampleComplete =
    handlingLogEntries.length === FIRST_TEN_SAMPLE_SIZE &&
    presentEntries.size === FIRST_TEN_SAMPLE_SIZE &&
    Array.from({ length: FIRST_TEN_SAMPLE_SIZE }, (_, i) => i + 1).every((n) => presentEntries.has(n));

  // Automatically recorded time from opening a thread to its first decision
  // (承認 / 保留 / 返信不要), windowed by the decision timestamp. Decisions
  // made without opening the thread in the UI are excluded and counted.
  const automatic = summarizeDecisionTimes(uniqueThreads, {
    decidedFrom: start.toISOString(),
    decidedTo: end.toISOString(),
  });

  const percent = (n, d) => d ? Math.round((n / d) * 1000) / 10 : null;
  return {
    period: { start: start.toISOString(), end: end.toISOString(), endExclusive: true },
    classification: {
      headline: { eligible: reviewed.length, corrected: corrected.length, ratePercent: percent(corrected.length, reviewed.length), targetPercentMax: targetCorrectionMax, targetMet: reviewed.length > 0 ? percent(corrected.length, reviewed.length) <= targetCorrectionMax : null },
      strictExplicitClassificationReview: { eligible: strictCandidates.length, corrected: strictCorrected.length, ratePercent: percent(strictCorrected.length, strictCandidates.length), targetPercentMax: targetCorrectionMax, targetMet: strictCandidates.length > 0 ? percent(strictCorrected.length, strictCandidates.length) <= targetCorrectionMax : null },
      excludedFromStrictBecauseEvidenceIsNotExplicitOrCurrent: reviewed.length - strictCandidates.length,
    },
    // Usable = drafts used as-is or with only minor edits, i.e. the 👍 rating
    // (`helpful`, "そのまま使用・軽微な修正"). `minor_edit` is the ✏️ rating
    // "大幅な手動修正が必要" (needs substantial manual editing) and is NOT
    // usable, despite its historical key name. `poor` is not usable either.
    draftUsability: {
      ratedCount: rated.length, helpful, minorEdit, poor,
      usableCount: helpful,
      usablePercent: percent(helpful, rated.length),
      targetPercentMin: targetUsabilityMin,
      minRatedDrafts,
      sampleSufficient: rated.length >= minRatedDrafts,
      // Not judged (null) until the agreed minimum number of drafts is rated.
      targetMet: rated.length >= minRatedDrafts ? percent(helpful, rated.length) >= targetUsabilityMin : null,
      definition: "helpful / all rated drafts (minor_edit = needs substantial manual editing, counted as not usable)",
      warning: rated.length < minRatedDrafts
        ? `Only ${rated.length} rated draft(s); the usability target is judged on at least ${minRatedDrafts}.`
        : null,
    },
    automaticDecisionTiming: {
      definition: "seconds from opening a thread in the UI until its first decision (approve / hold / not needed), recorded by the server",
      measuredCount: automatic.measuredCount,
      meanSeconds: automatic.meanSeconds,
      medianSeconds: automatic.medianSeconds,
      byDecisionType: automatic.byType,
      unmeasuredDecisions: automatic.unmeasuredDecisions,
      itemsWithCappedSegments: automatic.itemsWithCappedSegments,
      warning: automatic.measuredCount === 0
        ? "No automatically timed decisions in this window."
        : automatic.itemsWithCappedSegments > 0
          ? `${automatic.itemsWithCappedSegments} item(s) include a viewing segment capped at 30 minutes (thread left open); review them before reporting.`
          : null,
    },
    handlingTime: {
      source: handlingLogEntries.length ? "operator-log" : "not-available",
      itemsWithVerifiedEvaluationTimings: timingValues.length,
      seconds: timingValues,
      meanSeconds: timingValues.length ? Math.round(timingValues.reduce((a, b) => a + b, 0) / timingValues.length * 10) / 10 : null,
      medianSeconds: timingValues.length ? (() => { const sorted = [...timingValues].sort((a, b) => a - b); const m = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; })() : null,
      targetSampleSize: FIRST_TEN_SAMPLE_SIZE,
      sampleComplete,
      warning: handlingLogEntries.length === 0
        ? "Not calculated from this export: handling_time_seconds has no per-recording timestamp or item sequence. Calculate the first-10 sample from the operator's contemporaneous log, or use automaticDecisionTiming."
        : !sampleComplete
          ? `Insufficient data: only ${presentEntries.size} of ${FIRST_TEN_SAMPLE_SIZE} contemporaneous handling-time entries were provided. Do not report handling-time results.`
          : null,
    },
    dataQuality: {
      totalThreadsInExport: threads.length,
      duplicateThreadIds,
      duplicateThreadIdsWarning: duplicateThreadIds > 0
        ? `${duplicateThreadIds} duplicate thread.id record(s) were ignored (first occurrence kept); the export should not contain duplicates.`
        : null,
      reviewedInWindowWithOriginalAiClassification: reviewed.length,
      reviewedInWindowWithoutOriginalOrCurrentAction: uniqueThreads.filter((item) => inWindow(item?.human_reviewed_at, start, end)).length - reviewed.length,
      staleStrictEvidence: reviewed.filter((item) => item?.human_reviewed_via === "update_classification" && item?.classification?.decided_by !== "human").length,
      ratingsOutsideKnownValues: uniqueThreads.filter((item) => inWindow(item?.human_reviewed_at, start, end) && item?.quality_rating && !KNOWN_RATINGS.includes(item.quality_rating)).length,
      ratingsMissingTimestamp,
      ratingsMissingTimestampWarning: ratingsMissingTimestamp > 0
        ? `${ratingsMissingTimestamp} rated item(s) carry no quality_rated_at (rated before the timestamp existed) and are excluded from every window. Verify them manually against the rating UI before judging usability.`
        : null,
      lowSampleWarning: reviewed.length < 10 ? "Fewer than 10 eligible reviewed items; treat the correction rate as indicative, not conclusive." : null,
    },
    privacy: "Report contains aggregate counts only; no contact names, message text, handles, or thread IDs.",
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/evaluate-week.mjs --input <export.json> --start <ISO 8601 with timezone> --end <ISO 8601 with timezone>\n" +
        "       [--target-correction-max <0-100, default 15>] [--target-usability-min <0-100, default 70>]\n" +
        "       [--min-rated-drafts <n, default 20>]  usability is only judged on at least n rated drafts\n" +
        "       [--handling-log <log.json>]  operator's first-10 timings: [{\"entry\":1,\"seconds\":42}, ...]\n"
    );
    return;
  }
  if (!options.input) throw new Error("--input is required");
  const payload = parseExportPayload(fs.readFileSync(options.input, "utf8"));
  const handlingLog = options.handlingLog
    ? parseHandlingLog(parseExportPayload(fs.readFileSync(options.handlingLog, "utf8")))
    : undefined;
  const report = buildEvaluationReport(payload, options.start, options.end, {
    targetCorrectionMax: options.targetCorrectionMax,
    targetUsabilityMin: options.targetUsabilityMin,
    minRatedDrafts: options.minRatedDrafts,
    handlingLog,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname) {
  try { main(); } catch (error) { process.stderr.write(`Evaluation failed: ${error.message}\n`); process.exitCode = 1; }
}
