/**
 * Automatic decision timing: "time from opening a thread on screen until the
 * operator presses a decision button" (承認 / 保留 / 返信不要として完了).
 *
 * All timestamps come from the SERVER clock, so the measurement does not depend
 * on the browser's timers (which are throttled in background tabs) and the
 * operator never starts, pauses, or stops anything by hand.
 *
 * Model (stored on each thread as `decision_timing`):
 *   - Opening a thread in the UI starts a viewing session (`open_session`).
 *     The UI sends a heartbeat while the thread stays open and closes the
 *     session when the operator switches threads or leaves the page.
 *   - Closed session time accumulates in `accumulated_seconds`, so time spent
 *     across several visits before deciding is included.
 *   - A decision action closes the session and stamps the elapsed total:
 *       first_decision  — set once, never overwritten (the headline figure)
 *       final_decision  — updated on every decision (e.g. 保留 → later 承認)
 *   - Once a thread is finalized (approved / completed / not needed), no new
 *     sessions start: reopening a finished thread never adds time.
 *   - A thread decided without ever being opened in the UI (API-only
 *     processing) records the decision with `seconds: null`, never 0, so it
 *     cannot dilute the average.
 *
 * Safety limits:
 *   - If heartbeats stop (browser crash, sleep, network loss) the session is
 *     closed at the last heartbeat, not at the time it is discovered.
 *   - A single viewing segment is capped at MAX_SEGMENT_SECONDS; capped
 *     segments are counted in `capped_segments` so reports can flag them.
 */

export const DECISION_TYPES = Object.freeze({
  approve: "approve", // 承認して対応完了
  hold: "hold", // 保留
  complete: "complete", // 返信不要として完了
  reclassify_skip: "reclassify_skip", // 分類を「返信不要」に修正して完了
});

/** Heartbeat interval the UI uses (documented here so tests and UI agree). */
export const HEARTBEAT_INTERVAL_SECONDS = 30;
/** A session whose last heartbeat is older than this is treated as abandoned. */
export const SESSION_STALE_SECONDS = 180;
/** Upper bound for one continuous viewing segment. */
export const MAX_SEGMENT_SECONDS = 30 * 60;

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

/** Thread states in which the item is finished and must not accrue time. */
export function isFinalized(thread) {
  const status = thread?.thread?.status;
  const sendStatus = thread?.draft?.send_status;
  return (
    status === "handled" ||
    sendStatus === "approved" ||
    sendStatus === "not_needed" ||
    sendStatus === "sent"
  );
}

function emptyTiming() {
  return {
    open_session: null,
    accumulated_seconds: 0,
    segments: 0,
    capped_segments: 0,
    first_decision: null,
    final_decision: null,
  };
}

/** Returns the thread's timing record, creating a well-formed one if needed. */
export function ensureTiming(thread) {
  const current = thread.decision_timing;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    thread.decision_timing = emptyTiming();
    return thread.decision_timing;
  }
  const base = emptyTiming();
  for (const key of Object.keys(base)) {
    if (current[key] === undefined) current[key] = base[key];
  }
  if (!Number.isFinite(current.accumulated_seconds) || current.accumulated_seconds < 0) {
    current.accumulated_seconds = 0;
  }
  return current;
}

/**
 * Close the open session (if any) and add its elapsed time.
 * Ends at `nowMs`, or at the last heartbeat when the session went stale.
 */
export function closeSession(thread, nowMs) {
  const timing = ensureTiming(thread);
  const session = timing.open_session;
  if (!session) return { closed: false, addedSeconds: 0 };

  const startedMs = toMs(session.started_at);
  const lastSeenMs = toMs(session.last_seen_at) ?? startedMs;
  timing.open_session = null;
  if (startedMs === null) return { closed: true, addedSeconds: 0 };

  const stale = lastSeenMs !== null && nowMs - lastSeenMs > SESSION_STALE_SECONDS * 1000;
  const endMs = stale ? lastSeenMs : nowMs;
  let seconds = Math.max(0, Math.round((endMs - startedMs) / 1000));
  if (seconds > MAX_SEGMENT_SECONDS) {
    seconds = MAX_SEGMENT_SECONDS;
    timing.capped_segments += 1;
  }
  timing.accumulated_seconds += seconds;
  timing.segments += 1;
  return { closed: true, addedSeconds: seconds, stale };
}

/** Start a viewing session when the thread is opened in the UI. */
export function openSession(thread, nowMs) {
  if (isFinalized(thread)) return { started: false, reason: "finalized" };
  const timing = ensureTiming(thread);
  // A leftover session (e.g. the page was closed without a close request)
  // is settled first, ending at its last heartbeat if it went stale.
  if (timing.open_session) closeSession(thread, nowMs);
  timing.open_session = { started_at: iso(nowMs), last_seen_at: iso(nowMs) };
  return { started: true };
}

/** Keep the open session alive while the thread stays on screen. */
export function heartbeatSession(thread, nowMs) {
  const timing = ensureTiming(thread);
  const session = timing.open_session;
  if (!session) return { alive: false };
  const lastSeenMs = toMs(session.last_seen_at);
  if (lastSeenMs !== null && nowMs - lastSeenMs > SESSION_STALE_SECONDS * 1000) {
    // Heartbeats were interrupted (sleep, network loss): settle the old
    // session at its last heartbeat and start a fresh one from now.
    closeSession(thread, nowMs);
    if (isFinalized(thread)) return { alive: false };
    timing.open_session = { started_at: iso(nowMs), last_seen_at: iso(nowMs) };
    return { alive: true, restarted: true };
  }
  session.last_seen_at = iso(nowMs);
  return { alive: true };
}

/**
 * Stamp a decision. Must be called BEFORE the decision mutates the thread's
 * status, so a decision on an already-finalized thread is recognisable.
 */
export function recordDecision(thread, type, nowMs) {
  if (!Object.values(DECISION_TYPES).includes(type)) {
    throw new Error(`Unknown decision type: ${type}`);
  }
  const timing = ensureTiming(thread);
  closeSession(thread, nowMs);

  const measured = timing.segments > 0;
  const entry = {
    type,
    decided_at: iso(nowMs),
    seconds: measured ? timing.accumulated_seconds : null,
    measured,
    capped_segments: timing.capped_segments,
  };
  if (!timing.first_decision) timing.first_decision = { ...entry };
  timing.final_decision = { ...entry };
  return entry;
}

/** Elapsed seconds for display: accumulated time plus the live session. */
export function currentElapsedSeconds(thread, nowMs) {
  const timing = thread?.decision_timing;
  if (!timing) return 0;
  let seconds = Number.isFinite(timing.accumulated_seconds) ? timing.accumulated_seconds : 0;
  const startedMs = toMs(timing.open_session?.started_at);
  if (startedMs !== null) seconds += Math.max(0, Math.round((nowMs - startedMs) / 1000));
  return seconds;
}

/**
 * Keep the server's timing record when an import does not carry one, and
 * never import a live session (it would be stale on this server).
 */
export function mergeImportedTiming(incoming, existing) {
  if (!incoming.decision_timing && existing?.decision_timing) {
    incoming.decision_timing = structuredClone(existing.decision_timing);
  }
  if (incoming.decision_timing && typeof incoming.decision_timing === "object") {
    incoming.decision_timing.open_session = null;
  }
  return incoming;
}

/**
 * Summarise first-decision timings (used by the dashboard and the weekly
 * evaluation). Only measured decisions are included; `decidedFrom`/`decidedTo`
 * optionally restrict to a [from, to) window on first_decision.decided_at.
 */
export function summarizeDecisionTimes(threads, { decidedFrom = null, decidedTo = null } = {}) {
  const fromMs = decidedFrom ? toMs(decidedFrom) : null;
  const toMsValue = decidedTo ? toMs(decidedTo) : null;
  const values = [];
  const byType = {};
  let unmeasuredDecisions = 0;
  let itemsWithCappedSegments = 0;

  for (const item of threads || []) {
    const first = item?.decision_timing?.first_decision;
    if (!first) continue;
    const decidedMs = toMs(first.decided_at);
    if (fromMs !== null && (decidedMs === null || decidedMs < fromMs)) continue;
    if (toMsValue !== null && (decidedMs === null || decidedMs >= toMsValue)) continue;
    if (!first.measured || !Number.isFinite(first.seconds)) {
      unmeasuredDecisions += 1;
      continue;
    }
    values.push(first.seconds);
    if (first.capped_segments > 0) itemsWithCappedSegments += 1;
    const bucket = (byType[first.type] ||= { count: 0, totalSeconds: 0 });
    bucket.count += 1;
    bucket.totalSeconds += first.seconds;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const round1 = (n) => Math.round(n * 10) / 10;
  for (const bucket of Object.values(byType)) {
    bucket.meanSeconds = round1(bucket.totalSeconds / bucket.count);
  }
  return {
    measuredCount: values.length,
    meanSeconds: values.length ? round1(values.reduce((a, b) => a + b, 0) / values.length) : null,
    medianSeconds: values.length
      ? sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2
      : null,
    byType,
    unmeasuredDecisions,
    itemsWithCappedSegments,
  };
}
