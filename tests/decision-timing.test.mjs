/**
 * Unit tests for automatic decision timing (src/decision-timing.mjs):
 * "time from opening a thread until 承認 / 保留 / 返信不要 is pressed".
 * Synthetic fixtures only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_TYPES,
  MAX_SEGMENT_SECONDS,
  SESSION_STALE_SECONDS,
  openSession,
  heartbeatSession,
  closeSession,
  recordDecision,
  currentElapsedSeconds,
  mergeImportedTiming,
  summarizeDecisionTimes,
  isFinalized,
} from "../src/decision-timing.mjs";

const T0 = Date.parse("2026-11-21T09:00:00+09:00");
const sec = (n) => T0 + n * 1000;

function openThread(overrides = {}) {
  return {
    thread: { id: "t1", status: "needs_review" },
    draft: { send_status: "held_for_human" },
    ...overrides,
  };
}

test("open → approve records the elapsed seconds as the first and final decision", () => {
  const t = openThread();
  assert.equal(openSession(t, sec(0)).started, true);
  const entry = recordDecision(t, DECISION_TYPES.approve, sec(95));
  assert.equal(entry.seconds, 95);
  assert.equal(entry.measured, true);
  assert.deepEqual(
    { type: t.decision_timing.first_decision.type, seconds: t.decision_timing.first_decision.seconds },
    { type: "approve", seconds: 95 }
  );
  assert.equal(t.decision_timing.final_decision.seconds, 95);
  assert.equal(t.decision_timing.open_session, null, "the decision closes the session");
});

test("time across several visits accumulates until the decision", () => {
  const t = openThread();
  openSession(t, sec(0));
  closeSession(t, sec(40)); // switched to another thread
  openSession(t, sec(300)); // came back later; the gap is not counted
  const entry = recordDecision(t, DECISION_TYPES.hold, sec(320));
  assert.equal(entry.seconds, 60);
  assert.equal(t.decision_timing.segments, 2);
});

test("hold then approve: first decision is kept, final decision is updated", () => {
  const t = openThread();
  openSession(t, sec(0));
  recordDecision(t, DECISION_TYPES.hold, sec(30));
  t.thread.status = "on_hold";
  openSession(t, sec(100));
  recordDecision(t, DECISION_TYPES.approve, sec(150));
  assert.equal(t.decision_timing.first_decision.type, "hold");
  assert.equal(t.decision_timing.first_decision.seconds, 30);
  assert.equal(t.decision_timing.final_decision.type, "approve");
  assert.equal(t.decision_timing.final_decision.seconds, 80);
});

test("a finalized thread never starts a session, so reopening adds no time", () => {
  const t = openThread();
  openSession(t, sec(0));
  recordDecision(t, DECISION_TYPES.approve, sec(20));
  t.thread.status = "handled";
  t.draft.send_status = "approved";
  assert.equal(isFinalized(t), true);
  assert.deepEqual(openSession(t, sec(500)), { started: false, reason: "finalized" });
  assert.equal(t.decision_timing.open_session, null);
  assert.equal(t.decision_timing.accumulated_seconds, 20);
});

test("a decision without ever opening the thread is recorded as unmeasured (null, not 0)", () => {
  const t = openThread();
  const entry = recordDecision(t, DECISION_TYPES.complete, sec(10));
  assert.equal(entry.measured, false);
  assert.equal(entry.seconds, null);
});

test("a session whose heartbeats stopped ends at the last heartbeat", () => {
  const t = openThread();
  openSession(t, sec(0));
  heartbeatSession(t, sec(30));
  heartbeatSession(t, sec(60));
  // Browser crashed after 60s; the next event arrives an hour later.
  const result = closeSession(t, sec(3600));
  assert.equal(result.stale, true);
  assert.equal(t.decision_timing.accumulated_seconds, 60);
});

test("a leftover session is settled at its last heartbeat when the thread is reopened", () => {
  const t = openThread();
  openSession(t, sec(0));
  heartbeatSession(t, sec(30));
  openSession(t, sec(5000)); // page was closed without a close request
  assert.equal(t.decision_timing.accumulated_seconds, 30);
  assert.ok(t.decision_timing.open_session, "a fresh session is open");
});

test("an interrupted heartbeat restarts the session instead of counting the gap", () => {
  const t = openThread();
  openSession(t, sec(0));
  const late = heartbeatSession(t, sec(SESSION_STALE_SECONDS + 1000));
  assert.equal(late.restarted, true);
  assert.equal(t.decision_timing.accumulated_seconds, 0);
  const entry = recordDecision(t, DECISION_TYPES.hold, sec(SESSION_STALE_SECONDS + 1010));
  assert.equal(entry.seconds, 10);
});

test("one continuous segment is capped and the cap is flagged", () => {
  const t = openThread();
  openSession(t, sec(0));
  for (let s = 30; s <= MAX_SEGMENT_SECONDS + 600; s += 30) heartbeatSession(t, sec(s));
  const entry = recordDecision(t, DECISION_TYPES.approve, sec(MAX_SEGMENT_SECONDS + 600));
  assert.equal(entry.seconds, MAX_SEGMENT_SECONDS);
  assert.equal(entry.capped_segments, 1);
});

test("currentElapsedSeconds adds the live session to the accumulated time", () => {
  const t = openThread();
  openSession(t, sec(0));
  closeSession(t, sec(15));
  openSession(t, sec(100));
  assert.equal(currentElapsedSeconds(t, sec(110)), 25);
});

test("re-import keeps server timing when the import has none, and drops live sessions", () => {
  const existing = openThread();
  openSession(existing, sec(0));
  recordDecision(existing, DECISION_TYPES.hold, sec(12));
  const incoming = mergeImportedTiming({ thread: { id: "t1" }, messages: [] }, existing);
  assert.equal(incoming.decision_timing.first_decision.seconds, 12);

  const withSession = mergeImportedTiming(
    { thread: { id: "t2" }, messages: [], decision_timing: { open_session: { started_at: "x" } } },
    null
  );
  assert.equal(withSession.decision_timing.open_session, null);
});

test("summarizeDecisionTimes: mean/median of measured first decisions, window, flags", () => {
  const make = (id, seconds, decidedAt, extra = {}) => ({
    thread: { id },
    decision_timing: {
      first_decision: { type: "approve", seconds, measured: seconds !== null, decided_at: decidedAt, capped_segments: 0, ...extra },
    },
  });
  const threads = [
    make("a", 60, "2026-11-22T10:00:00+09:00"),
    make("b", 120, "2026-11-23T10:00:00+09:00", { type: "hold" }),
    make("c", 300, "2026-11-24T10:00:00+09:00", { capped_segments: 1 }),
    make("d", null, "2026-11-24T11:00:00+09:00"), // API-only: excluded
    make("e", 999, "2026-11-01T10:00:00+09:00"), // outside the window
    { thread: { id: "f" } }, // never decided
  ];
  const summary = summarizeDecisionTimes(threads, {
    decidedFrom: "2026-11-22T00:00:00+09:00",
    decidedTo: "2026-11-29T00:00:00+09:00",
  });
  assert.equal(summary.measuredCount, 3);
  assert.equal(summary.meanSeconds, 160);
  assert.equal(summary.medianSeconds, 120);
  assert.equal(summary.unmeasuredDecisions, 1);
  assert.equal(summary.itemsWithCappedSegments, 1);
  assert.equal(summary.byType.approve.count, 2);
  assert.equal(summary.byType.hold.meanSeconds, 120);
});
