/**
 * Human classification correction tracking.
 *
 * The AI assigns a classification (machine rules or Gemini) and the operator may
 * override it afterwards. To measure how often the AI needs a human correction,
 * the first AI-assigned classification is snapshotted into `original_classification`
 * and is never overwritten by later human edits or re-triage.
 *
 * Correction Rate = (corrected eligible items / eligible human-reviewed items) * 100
 *
 * Eligible items have an available original AI classification AND completed human
 * review (`human_reviewed_at`). Records without an original classification are
 * excluded entirely: for older records the original value may simply be unknown,
 * and they must not be counted as uncorrected items.
 *
 * Audit trail: how review was evidenced is recorded in `human_reviewed_via`
 * ("update_classification" = the operator explicitly saved the classification
 * panel; "approve"/"complete" = the item was completed, which evidences review
 * of the whole item including its classification; records created before this
 * field existed carry no value). `computeCorrectionRate` keeps the headline
 * definition unchanged and additionally reports the `reviewEvidence` split so
 * the denominator can be audited.
 */

const AI_DECIDED_BY = new Set(["rule", "llm"]);
const REVIEW_EVIDENCE = {
  CLASSIFICATION_UPDATE: "update_classification",
};
const REVIEW_EVIDENCE_BUCKETS = ["classificationUpdate", "completion", "unspecified"];

function clone(value) {
  return value === undefined || value === null ? value : structuredClone(value);
}

function normalized(value) {
  return String(value ?? "").trim();
}

/** Which review-evidence bucket an item belongs to (audit split only). */
function reviewEvidenceBucket(item) {
  const via = normalized(item?.human_reviewed_via);
  if (via === REVIEW_EVIDENCE.CLASSIFICATION_UPDATE) return "classificationUpdate";
  return via ? "completion" : "unspecified";
}

/** True when a preserved original AI classification is available for this item. */
export function hasOriginalClassification(item) {
  const original = item?.original_classification;
  return Boolean(original && normalized(original.action));
}

/** True when the item completed human review (`human_reviewed_at` is recorded). */
export function isHumanReviewed(item) {
  return Boolean(normalized(item?.human_reviewed_at));
}

/**
 * Snapshot the current classification into `original_classification`, but only the
 * first time and only when the classification was produced by the AI pipeline
 * (`decided_by` of "rule" or "llm"). Existing snapshots are never overwritten, so
 * re-triage and human edits cannot destroy the original value. Records whose
 * classification was made by a human (or another non-AI source) keep no original
 * classification, because the AI value is unknown for them.
 */
export function ensureOriginalClassification(item) {
  if (!item || hasOriginalClassification(item)) return item;
  if (!AI_DECIDED_BY.has(item.classification?.decided_by)) return item;
  item.original_classification = clone(item.classification);
  return item;
}

/**
 * Mark the item as having completed human review. Idempotent: the first
 * completion timestamp wins, so repeated actions never reset review state.
 *
 * `via` records which action evidenced the review ("update_classification",
 * "approve", "complete") for the audit split. The evidence source only
 * upgrades: an explicit classification review replaces completion evidence,
 * never the other way around. Records without `via` stay in the "unspecified"
 * bucket (backward compatible with data saved before this field existed).
 */
export function markHumanReviewed(item, via) {
  if (!item) return item;
  const source = normalized(via);
  if (!isHumanReviewed(item)) {
    item.human_reviewed_at = new Date().toISOString();
  }
  if (source) {
    const current = normalized(item.human_reviewed_via);
    if (
      !current ||
      (source === REVIEW_EVIDENCE.CLASSIFICATION_UPDATE &&
        current !== REVIEW_EVIDENCE.CLASSIFICATION_UPDATE)
    ) {
      item.human_reviewed_via = source;
    }
  }
  return item;
}

/**
 * Apply a human classification edit. The preserved original AI classification is
 * left untouched and the item is marked human-reviewed. Repeated edits only update
 * the current classification, and corrections are derived from the final value, so
 * multiple edits can never inflate the correction count.
 *
 * The caller is responsible for validating `payload.action`.
 */
export function applyHumanClassification(item, payload = {}) {
  if (!item) return item;
  item.classification = {
    ...item.classification,
    action: payload.action,
    category: normalized(payload.category),
    reason: normalized(payload.reason),
    decided_by: "human",
    rule_hit: null,
  };
  return markHumanReviewed(item, REVIEW_EVIDENCE.CLASSIFICATION_UPDATE);
}

/**
 * Prepare an incoming (imported) thread. Keeps an original snapshot and review
 * flag already stored for the same thread id, otherwise derives the original from
 * the current classification when it is still marked as AI-decided. Never invents
 * an original classification for records where it is unavailable.
 *
 * An operator's decision survives re-import: when the existing record was
 * human-decided and the incoming one is machine-decided (or undecided), the
 * human classification is kept — a stale AI value must not silently overwrite
 * the correction (it would also erase it from the correction-rate metric).
 * An incoming *human* decision still wins, so corrections made elsewhere are
 * not lost.
 */
export function prepareImportedThread(incoming, existing) {
  const merged = structuredClone(incoming);
  if (!hasOriginalClassification(merged) && hasOriginalClassification(existing)) {
    merged.original_classification = clone(existing.original_classification);
  }
  if (
    normalized(existing?.classification?.decided_by) === "human" &&
    normalized(merged.classification?.decided_by) !== "human"
  ) {
    merged.classification = clone(existing.classification);
  }
  if (!isHumanReviewed(merged) && isHumanReviewed(existing)) {
    merged.human_reviewed_at = existing.human_reviewed_at;
    if (normalized(existing.human_reviewed_via)) {
      merged.human_reviewed_via = existing.human_reviewed_via;
    }
  }
  return ensureOriginalClassification(merged);
}

/**
 * True when the final classification differs from the preserved original AI
 * classification (action or category; reasons are free text and ignored).
 * Always false when the original is unavailable or the final value is missing.
 *
 * Only an operator decision counts: the current classification must have been
 * set by a human (`decided_by === "human"`). Machine-made changes — a later
 * rule/LLM re-triage or a safety-gate escalation — are not human corrections
 * and must never inflate the correction rate.
 */
export function isCorrectedClassification(item) {
  if (!hasOriginalClassification(item)) return false;
  const current = item?.classification;
  if (!normalized(current?.action)) return false;
  if (normalized(current?.decided_by) !== "human") return false;
  const original = item.original_classification;
  return (
    normalized(original.action) !== normalized(current.action) ||
    normalized(original.category) !== normalized(current.category)
  );
}

/**
 * Correction rate over eligible items: original AI classification available and
 * human review completed. Items without an original classification are skipped, so
 * they never count as uncorrected. Returns `ratePercent: null` when there is
 * nothing to measure, so callers never display NaN or Infinity.
 *
 * The headline numbers keep the original definition. `reviewEvidence` splits the
 * same eligible items by how review was evidenced (classificationUpdate /
 * completion / unspecified; the three always sum to the headline totals) so the
 * denominator can be audited — e.g. the strict "classification was explicitly
 * reviewed" subset is `classificationUpdate`.
 */
export function computeCorrectionRate(items) {
  let eligibleReviewedItems = 0;
  let correctedItems = 0;
  const reviewEvidence = Object.fromEntries(
    REVIEW_EVIDENCE_BUCKETS.map((bucket) => [bucket, { eligibleItems: 0, correctedItems: 0 }])
  );

  for (const item of Array.isArray(items) ? items : []) {
    if (!hasOriginalClassification(item) || !isHumanReviewed(item)) continue;
    if (!normalized(item?.classification?.action)) continue;
    eligibleReviewedItems += 1;
    const bucket = reviewEvidence[reviewEvidenceBucket(item)];
    bucket.eligibleItems += 1;
    if (isCorrectedClassification(item)) {
      correctedItems += 1;
      bucket.correctedItems += 1;
    }
  }

  const ratePercent =
    eligibleReviewedItems > 0
      ? Math.round((correctedItems / eligibleReviewedItems) * 1000) / 10
      : null;

  return { eligibleReviewedItems, correctedItems, ratePercent, reviewEvidence };
}
