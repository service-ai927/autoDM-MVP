import test from "node:test";
import assert from "node:assert/strict";

// Unit tests for the strict LLM-response and draft-quality validators.
// No key: these functions are pure and must never trigger a network call.
delete process.env.GEMINI_API_KEY;

const { validateLlmClassification, validateDraftQuality } = await import("../src/ai-service.mjs");

// --- validateLlmClassification ---------------------------------------------

test("accepts a well-formed auto classification with a draft", () => {
  const result = validateLlmClassification({
    action: " auto ",
    category: "お礼への返信",
    reason: "返信可能",
    draft: "  ご連絡ありがとうございます。  ",
  });
  assert.deepEqual(result, {
    action: "auto",
    category: "お礼への返信",
    reason: "返信可能",
    draft: "ご連絡ありがとうございます。",
  });
});

test("accepts escalate and skip without requiring a draft", () => {
  for (const action of ["escalate", "skip"]) {
    const result = validateLlmClassification({ action, category: "日程・MTGの日時", reason: "要確認" });
    assert.equal(result.action, action);
    assert.equal(result.draft, null);
  }
});

test("rejects non-object responses instead of defaulting them", () => {
  for (const bad of [null, undefined, "auto", 42, []]) {
    assert.throws(() => validateLlmClassification(bad), /JSON object/, String(bad));
  }
});

test("rejects a missing or unknown action rather than guessing", () => {
  assert.throws(() => validateLlmClassification({ category: "x", draft: "本文です" }), /"action" must be one of/);
  assert.throws(() => validateLlmClassification({ action: "reply", draft: "本文です" }), /"action" must be one of/);
  assert.throws(() => validateLlmClassification({ action: 7 }), /"action" must be one of/);
});

test('rejects "auto" without a reply draft (a dead end for the operator)', () => {
  assert.throws(() => validateLlmClassification({ action: "auto", category: "x" }), /no reply draft/);
  assert.throws(
    () => validateLlmClassification({ action: "auto", category: "x", draft: "   " }),
    /no reply draft/
  );
});

test("caps runaway category and reason text from the model", () => {
  const result = validateLlmClassification({
    action: "escalate",
    category: "あ".repeat(500),
    reason: "い".repeat(5_000),
  });
  assert.equal(result.category.length, 200);
  assert.equal(result.reason.length, 1_000);
});

// --- validateDraftQuality ---------------------------------------------------

const GOOD_DRAFT = "ご連絡ありがとうございます。詳細は折り返しご連絡いたします。";

test("accepts a normal same-language draft", () => {
  assert.deepEqual(validateDraftQuality(GOOD_DRAFT, "ご相談の件、よろしくお願いします。"), {
    ok: true,
    reason: "",
  });
  // No source text available: only the length checks apply.
  assert.equal(validateDraftQuality(GOOD_DRAFT).ok, true);
});

test("rejects empty and too-short drafts", () => {
  assert.equal(validateDraftQuality("", "元メッセージです").ok, false);
  assert.equal(validateDraftQuality("  \n ", "元メッセージです").ok, false);
  const short = validateDraftQuality("了解", "元メッセージです");
  assert.equal(short.ok, false);
  assert.match(short.reason, /短すぎます/);
});

test("rejects drafts that are too long to be a sane reply", () => {
  const long = "あ".repeat(2_500);
  const result = validateDraftQuality(long, "元メッセージです");
  assert.equal(result.ok, false);
  assert.match(result.reason, /長すぎます/);
});

test("rejects a draft in a different script than the incoming message", () => {
  const result = validateDraftQuality("Thanks, got it. I will follow up shortly.", "ご相談の件、よろしくお願いします。");
  assert.equal(result.ok, false);
  assert.match(result.reason, /言語が一致していません/);
});

test("rejects a verbatim echo of the counterpart's message", () => {
  const source = "ご相談の件、よろしくお願いします。";
  const result = validateDraftQuality(source, source);
  assert.equal(result.ok, false);
  assert.match(result.reason, /焼き直し/);
});

test("non-string draft input is rejected, never coerced", () => {
  for (const bad of [null, undefined, 42, { text: "x" }]) {
    assert.equal(validateDraftQuality(bad, "元メッセージ").ok, false, String(bad));
  }
});

// --- FIX 2: bidirectional, ratio-based script consistency + echo detection --

test("English source + English draft is accepted", () => {
  const result = validateDraftQuality(
    "Thank you for reaching out. I will review the proposal and get back to you.",
    "Thanks for your message about the collaboration opportunity."
  );
  assert.deepEqual(result, { ok: true, reason: "" });
});

test("English source + Japanese draft is rejected (reverse direction)", () => {
  const result = validateDraftQuality(
    "ご連絡ありがとうございます。折り返しご連絡いたします。",
    "Thank you for your message about the collaboration opportunity."
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /言語が一致していません/);
});

test("Japanese source + Japanese draft is accepted", () => {
  const result = validateDraftQuality(GOOD_DRAFT, "ご相談の件、お世話になっております。");
  assert.equal(result.ok, true);
});

test("Chinese source + Chinese draft is accepted", () => {
  const result = validateDraftQuality(
    "感谢您的来信。关于合作事宜，我们会尽快回复您。",
    "谢谢您的邮件。关于合作的事宜，我们已经收到。"
  );
  assert.equal(result.ok, true);
});

test("Chinese source + Japanese draft is NOT rejected (documented JA/ZH limitation)", () => {
  // JA and ZH share the CJK script; without a language model they cannot be
  // told apart. The validator stays deliberately permissive here instead of
  // guessing (documented limitation in validateDraftQuality).
  const result = validateDraftQuality(
    "ご連絡ありがとうございます。折り返しご連絡いたします。",
    "谢谢您的邮件。关于合作的事宜，我们已经收到。"
  );
  assert.equal(result.ok, true);
});

test("a single stray CJK (or Latin) character never decides the outcome", () => {
  // One full-width punctuation-like CJK letter in an otherwise-English reply
  // must not trip the check (ratio-based, not single-codepoint).
  const result = validateDraftQuality(
    "Thanks for reaching out、I will follow up shortly.",
    "Thanks for your message about the collaboration opportunity."
  );
  assert.equal(result.ok, true);
});

test("CJK source + mostly-English draft with one CJK character is still rejected", () => {
  const result = validateDraftQuality(
    "Thanks, got it. I will follow up shortly. 了解。",
    "ご相談の件、よろしくお願いします。"
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /言語が一致していません/);
});

test("short valid Japanese acknowledgement is accepted (conservative minimum)", () => {
  // 9 characters incl. trailing period — a legitimate acknowledgement that the
  // old MIN_DRAFT_CHARS=10 wrongly rejected.
  const result = validateDraftQuality("ありがとうございます。", "ご連絡ありがとうございます。");
  assert.equal(result.ok, true);
});

test("normal short English response is accepted", () => {
  const result = validateDraftQuality("Thank you! I will check and reply.", "Thanks for your interest.");
  assert.equal(result.ok, true);
});

test("mixed-language draft against an English source is rejected when J-dominant", () => {
  const result = validateDraftQuality(
    "ご連絡ありがとうございます。We will check and reply in detail soon.",
    "Thanks for your message about the collaboration opportunity."
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /言語が一致していません/);
});

test("rejects a meaningful partial echo of the source (verbatim run)", () => {
  const source = "お世話になっております。先日のご提案について検討いたしました。";
  const copiedRun = source.slice(0, 18); // >= ECHO_MIN_CHARS verbatim run
  const result = validateDraftQuality(`ご連絡ありがとうございます。${copiedRun}ご返信いたします。`, source);
  assert.equal(result.ok, false);
  assert.match(result.reason, /コピー/);
});

test("short shared phrases are not flagged as echoes (documented limitation)", () => {
  // Courtesy openings shorter than ECHO_MIN_CHARS are allowed in both texts.
  const source = "お世話になっております。ご相談の件でご連絡しました。";
  const result = validateDraftQuality("お世話になっております。確認のうえご連絡いたします。", source);
  assert.equal(result.ok, true);
});
