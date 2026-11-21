import { GoogleGenAI } from "@google/genai";
import { evaluateMachineRules, evaluateContentGate } from "./rules-engine.mjs";

let aiClient = null;

const ALLOWED_ACTIONS = new Set(["auto", "escalate", "skip"]);
const MAX_CATEGORY_CHARS = 200; // mirrors server LIMITS.category
const MAX_REASON_CHARS = 1_000; // mirrors server LIMITS.reason
// Short acknowledgements ("了解です。", "ありがとうございます") are legitimate
// outreach replies — only clearly unusable stubs are rejected.
const MIN_DRAFT_CHARS = 4;
const MAX_DRAFT_CHARS = 2_000;
// Kana + CJK ideographs: the script shared by Japanese and Chinese. This is a
// SCRIPT check, not a language identifier — JA and ZH cannot be distinguished
// without a language model (documented limitation), so validation below only
// rejects clear script mismatches in either direction and stays permissive
// in the ambiguous middle.
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿]/;
// A verbatim run of at least this many source characters counts as copying.
// Long enough not to flag normal courtesy phrases; for sources shorter than
// this only exact/normalized echoes are detectable (documented limitation).
const ECHO_MIN_CHARS = 18;
// Letter-share thresholds for the bidirectional script-consistency check.
// Letters only (punctuation/digits/emoji ignored); a deliberate permissive
// zone exists between the two bounds.
const CJK_DOMINANT_RATIO = 0.25; // source at/above → draft must contain CJK letters
const DRAFT_MIN_CJK_RATIO = 0.15; // CJK-dominant source rejects a near-pure-Latin draft
const DRAFT_MAX_CJK_RATIO = 0.15; // Latin source rejects a draft at/above this CJK share

/** Letter counts and CJK share of a text (0 letters → ratio 0). */
function scriptRatios(text) {
  const letters = String(text).match(/\p{L}/gu) || [];
  if (letters.length === 0) return { letterCount: 0, cjkRatio: 0 };
  let cjk = 0;
  for (const ch of letters) {
    if (CJK_PATTERN.test(ch)) cjk += 1;
  }
  return { letterCount: letters.length, cjkRatio: cjk / letters.length };
}

/**
 * Strictly validate a parsed LLM classification response.
 *
 * The model must state the action explicitly: a missing or unknown action is
 * rejected (never silently defaulted), and "auto" must come with a reply draft
 * — an auto-classified thread without a draft is a dead end for the operator.
 * Throws with a descriptive reason; callers treat a throw as an LLM failure and
 * fall back to the conservative rule-based heuristics.
 */
export function validateLlmClassification(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM response must be a JSON object");
  }
  const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`LLM response "action" must be one of auto/escalate/skip (got ${JSON.stringify(parsed.action ?? null)})`);
  }
  const category = typeof parsed.category === "string" && parsed.category.trim()
    ? parsed.category.trim().slice(0, MAX_CATEGORY_CHARS)
    : "General inquiry";
  const reason = typeof parsed.reason === "string"
    ? parsed.reason.trim().slice(0, MAX_REASON_CHARS)
    : "";
  let draft = null;
  if (action === "auto") {
    if (typeof parsed.draft !== "string" || !parsed.draft.trim()) {
      throw new Error('LLM response classified "auto" but returned no reply draft');
    }
    draft = parsed.draft.trim();
  }
  return { action, category, reason, draft };
}

/**
 * Programmatic draft-quality checks the prompt alone cannot guarantee:
 * non-empty, within sane length bounds, script-consistent with the incoming
 * message (bidirectional, ratio-based — never a single-character claim), and
 * free of verbatim source copying (exact, whitespace-normalized, or any run of
 * >= ECHO_MIN_CHARS source characters). Returns { ok, reason }; callers surface
 * the reason in logs and fall back instead of showing a poor draft to the
 * operator. Limitations: this cannot distinguish Japanese from Chinese (both
 * are CJK-script), and partial copying is only detected for sources of at
 * least ECHO_MIN_CHARS characters.
 */
export function validateDraftQuality(draftText, sourceText = "") {
  const draft = typeof draftText === "string" ? draftText.trim() : "";
  if (!draft) return { ok: false, reason: "返信案が空です" };
  if (draft.length < MIN_DRAFT_CHARS) {
    return { ok: false, reason: `返信案が短すぎます（${draft.length}文字 / 最低${MIN_DRAFT_CHARS}文字）` };
  }
  if (draft.length > MAX_DRAFT_CHARS) {
    return { ok: false, reason: `返信案が長すぎます（${draft.length}文字 / 上限${MAX_DRAFT_CHARS}文字）` };
  }

  const source = String(sourceText || "").trim();
  if (!source) return { ok: true, reason: "" };

  // Script consistency, both directions, based on letter shares — one stray
  // CJK (or Latin) character can never decide the outcome.
  const sourceScript = scriptRatios(source);
  const draftScript = scriptRatios(draft);
  if (sourceScript.letterCount > 0 && draftScript.letterCount > 0) {
    if (sourceScript.cjkRatio >= CJK_DOMINANT_RATIO && draftScript.cjkRatio < DRAFT_MIN_CJK_RATIO) {
      return {
        ok: false,
        reason: "元メッセージと返信案の言語が一致していません（日本語・中国語の元メッセージに対する返信にCJK文字が含まれていません）",
      };
    }
    if (sourceScript.cjkRatio < CJK_DOMINANT_RATIO && draftScript.cjkRatio >= DRAFT_MAX_CJK_RATIO) {
      return {
        ok: false,
        reason: "元メッセージと返信案の言語が一致していません（英語の元メッセージに対する返信に日本語・中国語の文字が混じっています）",
      };
    }
  }

  // Echo detection: exact, whitespace-insensitive, then any meaningful
  // verbatim run of the source inside the draft.
  const normalize = (text) => text.replace(/\s+/g, "");
  if (draft === source || normalize(draft) === normalize(source)) {
    return { ok: false, reason: "返信案が元メッセージの焼き直しになっています" };
  }
  if (source.length >= ECHO_MIN_CHARS) {
    for (let i = 0; i + ECHO_MIN_CHARS <= source.length; i += 1) {
      if (draft.includes(source.slice(i, i + ECHO_MIN_CHARS))) {
        return {
          ok: false,
          reason: `返信案が元メッセージの文面をそのままコピーしています（${ECHO_MIN_CHARS}文字以上の一致を検出）`,
        };
      }
    }
  }
  return { ok: true, reason: "" };
}

function getAiClient() {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    try {
      aiClient = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
    } catch (e) {
      console.warn("Failed to initialize GoogleGenAI client:", e);
    }
  }
  return aiClient;
}

/**
 * Executes the three-stage pipeline:
 * Stage 1: Machine Rules (Regex & keyword filters)
 * Stage 2: LLM (Gemini 3.8 Flash for nuanced classification & reply drafting)
 * Stage 3: Content / Safety Gate (Inspects draft before handing to human operator)
 */
export async function triageThread(thread, options = {}) {
  const messages = thread?.messages || [];
  const counterpartMessages = messages.filter((m) => m.from !== "me");
  const lastIncoming = counterpartMessages.length > 0 
    ? counterpartMessages[counterpartMessages.length - 1].text 
    : (messages[messages.length - 1]?.text || "");
  
  const counterpart = thread?.counterpart || {};
  const tone = options.tone || "warm"; // warm, concise, professional, consultative

  // STAGE 1: Machine Rules Check
  const ruleMatch = evaluateMachineRules(lastIncoming);
  if (ruleMatch) {
    // If rule mandates skip or escalation:
    return {
      classification: {
        action: ruleMatch.action,
        category: ruleMatch.category,
        reason: ruleMatch.reason,
        decided_by: "rule",
        rule_hit: ruleMatch.rule_hit,
      },
      draft: {
        generated: null,
        edited: null,
        gate: ruleMatch.action === "skip" ? "-" : "要本人承認",
        send_status: ruleMatch.action === "skip" ? "not_needed" : "held_for_human",
      },
    };
  }

  // STAGE 2: LLM Evaluation via Gemini 3.8 Flash
  const ai = getAiClient();
  if (ai) {
    try {
      const historyText = messages
        .slice(-5)
        .map((m) => `${m.from === "me" ? "Me" : "Counterpart"}: ${m.text}`)
        .join("\n");

      const prompt = `
Analyze this conversation thread for an outreach reply management system.

Counterpart Context:
Name: ${counterpart.id || "Unknown"}
Handle: ${counterpart.handle || ""}
Memo/Notes: ${counterpart.memo || "None"}

Conversation History (latest messages):
${historyText}

Latest Incoming Message:
"${lastIncoming}"

Goal:
1. Classify the message into an action:
   - "auto": Can be handled by an AI reply draft (advice, gratitude, routine follow-up, progress update without contractual commitments).
   - "escalate": Requires operator's own judgment (schedule, price, complaint, custom partnership terms, OR questions asking for our performance numbers such as downloads, sales, revenue, follower counts).
   - "skip": No response required (spam, unsolicited promo, link only, or the counterpart explicitly states no reply is needed).
2. Category: Short descriptive category (e.g., "お礼への返信", "マーケ相談", "進捗報告", "協業打診", "カジュアルな質問", "動画相談").
3. Reason: Concise explanation of why this action and category were chosen.
4. If action is "auto", generate an appropriate reply draft in the same language as the latest incoming message (typically Japanese).
   Tone guideline: ${tone === "concise" ? "Short, direct, friendly" : tone === "professional" ? "Polite and formal" : "Warm, empathetic, helpful"}.
   DRAFT QUALITY RULES:
   - First sentence: acknowledge the specific point, question, or update in the latest incoming message. Refer to its actual subject; do not use a generic opener alone.
   - Answer the actual question directly when it is a routine advice or information request. Give one or two concrete, relevant suggestions grounded in the message rather than generic advice that could fit any conversation.
   - For progress updates, reflect the specific progress the counterpart shared; do not claim that you reviewed files, understood specifications, or agreed to a direction unless the thread proves it.
   - Use recent conversation history to avoid repeating advice, asking for information already provided, or repeating earlier replies. If this is a continuation, move the conversation forward.
   - Keep the reply concise: usually 2-3 natural DM sentences. A short acknowledgment should stay short. Avoid stiff corporate boilerplate, excessive praise, filler, and unnecessary follow-up questions.
   - Use only facts present in the conversation. Do NOT invent prior interactions, deliverables, schedules, prices, results, metrics, or commitments.
   - Prefer "auto" for routine, low-risk messages that can be answered safely with the available context. Escalate only when the operator must make a real decision (scheduling coordination, commercial terms, complaint/decline, sensitive relationship context, or a factual business metric we do not know). Do not escalate merely because a message mentions a meeting, contract, date, metric, or progress in passing.
   CRITICAL SAFETY CONSTRAINTS FOR DRAFT:
   - Do NOT promise future deliverables (do not say "初稿をお送りします", "作成します").
   - Do NOT offer specific dates or times (no "9/15", "◯時").
   - Do NOT quote prices or fees.
   - Do NOT include URLs or links of any kind.
   - Do NOT mention internal workflow terms (classification, review status, escalation).
5. If you cannot reply responsibly (ambiguous request, missing information, sensitive trade-off), return "action": "escalate" and "draft": null instead of guessing.

Output format: Return strictly valid JSON with keys:
{
  "action": "auto" | "escalate" | "skip",
  "category": "string",
  "reason": "string",
  "draft": "string or null"
}
`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(response.text.trim());

      // Strict validation: an unusable response (missing/unknown action, or an
      // "auto" decision without a draft) must not become a silent classification.
      // It throws into the catch below and falls back to the conservative
      // rule-based heuristics instead.
      const validated = validateLlmClassification(parsed);
      let action = validated.action;
      let category = validated.category;
      let reason = validated.reason || "Processed by LLM";
      let draftText = validated.draft;

      // Draft quality: same language as the incoming message, sane length, not
      // an echo. A poor draft is a fallback case, not something to hand over.
      if (action === "auto" && draftText) {
        const quality = validateDraftQuality(draftText, lastIncoming);
        if (!quality.ok) throw new Error(`draft quality check failed: ${quality.reason}`);
      }

      // STAGE 3: Content Gate
      let gate = "合格";
      let sendStatus = "held_for_human";

      if (action === "skip") {
        draftText = null;
        gate = "-";
        sendStatus = "not_needed";
      } else if (action === "escalate") {
        draftText = null;
        gate = "-";
        sendStatus = "held_for_human";
      } else if (draftText) {
        const gateCheck = evaluateContentGate(draftText);
        gate = gateCheck.gate;
        if (!gateCheck.passed) {
          // Do not surface a draft that failed the content gate.
          action = "escalate";
          draftText = null;
          reason = `${reason} (文面ゲート要確認: ${gateCheck.reason})`;
        }
      }

      return {
        classification: {
          action,
          category,
          reason,
          decided_by: "llm",
          rule_hit: null,
        },
        draft: {
          generated: draftText,
          edited: null,
          gate,
          send_status: sendStatus,
        },
      };
    } catch (err) {
      console.warn("Gemini LLM call failed or timed out, using fallback heuristics:", err);
    }
  }

  // Graceful rule-based fallback when LLM is unavailable or unauthenticated
  return fallbackHeuristics(lastIncoming, counterpart, tone);
}

/**
 * Tone-aware template picker. consultative shares the professional wording.
 */
function pickToneVariant(tone, variants) {
  if (tone === "concise") return variants.concise;
  if (tone === "professional" || tone === "consultative") return variants.professional;
  return variants.warm;
}

/**
 * Builds an "auto" fallback result. Every template draft is validated by the
 * same content gate as LLM drafts; a failing template escalates instead of
 * surfacing an unsafe reply.
 */
function fallbackAutoResult(category, reason, draftText) {
  const gateCheck = evaluateContentGate(draftText);
  if (!gateCheck.passed) {
    return {
      classification: {
        action: "escalate",
        category: "要本人判断",
        reason: "定型文が文面ゲートを通過できなかったため、オペレーターの目視確認にルーティング",
        decided_by: "rule",
        rule_hit: null,
      },
      draft: {
        generated: null,
        edited: null,
        gate: "要確認",
        send_status: "held_for_human",
      },
    };
  }
  return {
    classification: {
      action: "auto",
      category,
      reason,
      decided_by: "rule",
      rule_hit: null,
    },
    draft: {
      generated: draftText,
      edited: null,
      gate: gateCheck.gate,
      send_status: "held_for_human",
    },
  };
}

/**
 * Short, question-free acknowledgments ("了解です！楽しみにしてます。").
 * Anything with a question stays on the conservative default (escalate / LLM).
 */
function safeContextSnippet(text, maxLength = 48) {
  return String(text || "")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .split(" ")
    .filter((part) => !part.startsWith("http://") && !part.startsWith("https://") && !part.includes("@"))
    .join(" ")
    .trim()
    .slice(0, maxLength);
}

function isBenignAcknowledgment(text) {
  const trimmed = (text || "").trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (/[?？]|ですか|ませんか|でしょうか|どう|いつ|いくら|どの|どれ|教えて|なぜ/.test(trimmed)) {
    return false;
  }
  return /(了解|承知しました|かしこまりました|わかりました|お疲れ様|楽しみにして|助かりました|助かります)/.test(
    trimmed
  );
}

/**
 * Intelligent fallback heuristic engine adhering to the client's decision examples
 */
function fallbackHeuristics(text, counterpart, tone) {
  const lower = (text || "").toLowerCase();

  // If acknowledgment or gratitude
  if (/助言|ありがとう|感謝|お礼|thanks|thank you|参考|嬉しい/i.test(lower)) {
    const draftText = pickToneVariant(tone, {
      warm: "温かいお言葉をいただきありがとうございます✨ 少しでも参考になりましたら幸いです。また何か気になる点があればいつでも気軽にお声がけください！",
      concise: "役に立てて何よりです！引き続き応援しております。",
      professional:
        "温かいお言葉をいただきありがとうございます。少しでも参考になりましたら幸いです。今後ともどうぞよろしくお願いいたします。",
    });

    return fallbackAutoResult(
      "お礼への返信",
      "助言や前回のやり取りに対するお礼。日程・金額なしのため相槌で返信可能",
      draftText
    );
  }

  // If consulting about advice/marketing/games (incl. how-to questions)
  if (/相談|何から|どうすれば|何をすれば|どうやって|アドバイス|おすすめ|教えて|動画|見てもらい|工夫/i.test(lower)) {
    const context = safeContextSnippet(text, 42);
    const reference = context ? `「${context}」についてですね。` : "";
    const draftText = pickToneVariant(tone, {
      warm: `ご相談ありがとうございます。${reference}まずは対象を絞って小さく試し、反応を見ながら一つずつ調整するのがおすすめです。`,
      concise: `ご相談ありがとうございます。${reference}まずは小さく試し、反応を見て調整するのがおすすめです。`,
      professional: `ご相談いただきありがとうございます。${reference}対象を絞って小さく検証し、反応を踏まえて段階的に調整する方法がよいかと思います。`,
    });

    return fallbackAutoResult(
      "マーケ相談",
      "日程・金額の提示なし。実行可能な助言・知見の共有で対応可能",
      draftText
    );
  }

  // If progress report (incl. growth statements like "登録者が伸びました")
  if (/スクショ|進捗|作成中|公開|実装|仕様|共有|伸びました|伸びて|達成/i.test(lower)) {
    const context = safeContextSnippet(text, 42);
    const reference = context ? `「${context}」という点、把握しました。` : "共有いただいた内容を確認しました。";
    const draftText = pickToneVariant(tone, {
      warm: `共有ありがとうございます。${reference}引き続き状況に合わせて進めていければと思います。`,
      concise: `共有ありがとうございます。${reference}`,
      professional: `共有いただきありがとうございます。${reference}引き続きよろしくお願いいたします。`,
    });

    return fallbackAutoResult(
      "進捗報告",
      "進捗や画面の共有への確認。約束事なしのため通常返信可能",
      draftText
    );
  }

  // Short benign acknowledgments need only a short acknowledgment back
  if (isBenignAcknowledgment(text)) {
    const draftText = pickToneVariant(tone, {
      warm: "ご連絡ありがとうございます。承知しました。",
      concise: "承知しました。",
      professional: "ご連絡いただきありがとうございます。承知いたしました。",
    });

    return fallbackAutoResult(
      "簡潔な確認返信",
      "短い確認メッセージ。日程・金額・約束事なしのため相槌で返信可能",
      draftText
    );
  }

  // Default safe response
  return {
    classification: {
      action: "escalate",
      category: "要本人判断",
      reason: "定型外の個別メッセージのため、オペレーターの目視確認にルーティング",
      decided_by: "rule",
      rule_hit: null,
    },
    draft: {
      generated: null,
      edited: null,
      gate: "要確認",
      send_status: "held_for_human",
    },
  };
}

/**
 * Regenerate reply draft on demand with custom tone or operator guidance
 */
export async function generateCustomDraft(thread, promptGuidance = "", tone = "warm") {
  const messages = thread?.messages || [];
  const counterpartMessages = messages.filter((m) => m.from !== "me");
  const lastIncoming = counterpartMessages.length > 0 
    ? counterpartMessages[counterpartMessages.length - 1].text 
    : (messages[messages.length - 1]?.text || "");
  
  const counterpart = thread?.counterpart || {};
  const ai = getAiClient();

  if (ai) {
    try {
      const historyText = messages
        .slice(-6)
        .map((m) => `${m.from === "me" ? "Me" : "Counterpart"}: ${m.text}`)
        .join("\n");

      const prompt = `
You are drafting a reply message for an outreach management workflow.

Context:
Counterpart Name: ${counterpart.id || "Unknown"} (${counterpart.handle || ""})
Internal Note: ${counterpart.memo || "None"}

Thread:
${historyText}

Latest Message from Counterpart:
"${lastIncoming}"

Operator Instructions:
${promptGuidance ? `Special instruction: "${promptGuidance}"` : "Generate a polite, helpful reply."}
Tone: ${tone} (Options: warm, professional, concise, consultative)

SAFETY RULES (MANDATORY):
1. Do NOT make unauthorized promises to deliver work by a certain date.
2. Do NOT mention specific dates or hours.
3. Do NOT mention pricing or money amounts.
4. Keep within 2-4 natural sentences.

Output strictly valid JSON:
{
  "draft": "the reply text"
}
`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const parsed = JSON.parse(response.text.trim());
      // A draft must exist, be a sane length, match the incoming language, and
      // not echo the counterpart. Anything else throws into the catch below and
      // falls back to the sanitized template instead of surfacing a poor draft.
      if (!parsed || typeof parsed !== "object" || typeof parsed.draft !== "string" || !parsed.draft.trim()) {
        throw new Error("LLM returned no usable draft text");
      }
      const draftText = parsed.draft.trim();
      const quality = validateDraftQuality(draftText, lastIncoming);
      if (!quality.ok) throw new Error(`draft quality check failed: ${quality.reason}`);
      const gateCheck = evaluateContentGate(draftText);

      return {
        ok: true,
        draft: gateCheck.passed ? draftText : "",
        gate: gateCheck.gate,
        gatePassed: gateCheck.passed,
        reason: gateCheck.reason,
        source: "gemini",
      };
    } catch (e) {
      console.warn("Custom draft generation failed:", e);
    }
  }

  // Fallback: acknowledge the operator's guidance without inventing content.
  // Guidance is sanitized (URLs stripped, capped) so quoting it can never
  // trip the content gate into returning an empty draft.
  const safeGuidance = String(promptGuidance || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const concise = tone === "concise";
  const opener = concise ? "ご連絡ありがとうございます。" : "ご連絡いただきありがとうございます。";
  const ack = concise ? "承知しました。" : "承知いたしました。";
  const fallbackText = safeGuidance
    ? `${opener}「${safeGuidance}」の件、${ack}`
    : `${opener}内容を${concise ? "確認しました" : "確認いたしました"}。少しでもお力になれれば幸いです。`;

  const gateCheck = evaluateContentGate(fallbackText);
  return {
    ok: true,
    draft: gateCheck.passed ? fallbackText : "",
    gate: gateCheck.gate,
    gatePassed: gateCheck.passed,
    reason: gateCheck.reason,
    source: "template_fallback",
  };
}
