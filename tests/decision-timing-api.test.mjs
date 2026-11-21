/**
 * Integration test: automatic decision timing through the real server.
 * Boots server.mjs in production mode on a disposable DATA_DIR and PORT=0
 * (never touches the repository's .data/). Synthetic fixtures only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startServer() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "outreach-timing-test-"));
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: "0",
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    API_AUTH_TOKEN: "",
    ALLOWED_ORIGINS: "",
    RATE_LIMIT_PER_MINUTE: "",
  };
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ["server.mjs"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout}`)), 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/listening on http:\/\/[0-9.]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${stdout}`));
    });
  });
  return {
    base,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function post(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createThread(base, name) {
  const created = await post(base, "/api/threads", {
    contactName: name,
    handle: "@timing",
    messageText: "テストメッセージです。よろしくお願いします。",
  });
  assert.equal(created.status, 200);
  return created.json.thread.thread.id;
}

test("open → hold → reopen → approve is timed automatically by the server", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const id = await createThread(server.base, "相手タイミング");
  const action = (body) => post(server.base, `/api/threads/${id}/action`, body);

  const opened = await action({ action: "open_session" });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.result.started, true);

  await wait(1200);
  const heartbeat = await action({ action: "heartbeat_session" });
  assert.equal(heartbeat.json.result.alive, true);

  const held = await action({ action: "hold" });
  assert.equal(held.status, 200);
  const firstDecision = held.json.thread.decision_timing.first_decision;
  assert.equal(firstDecision.type, "hold");
  assert.equal(firstDecision.measured, true);
  assert.ok(firstDecision.seconds >= 1, `expected >= 1s, got ${firstDecision.seconds}`);
  assert.equal(held.json.thread.decision_timing.open_session, null);

  await action({ action: "open_session" });
  await wait(1100);
  const draft = "ご連絡ありがとうございます。内容を確認のうえ、折り返しご連絡いたします。";
  const approved = await action({ action: "approve", draft });
  assert.equal(approved.status, 200);
  const timing = approved.json.thread.decision_timing;
  assert.equal(timing.first_decision.type, "hold", "first decision is never overwritten");
  assert.equal(timing.final_decision.type, "approve");
  assert.ok(timing.final_decision.seconds >= timing.first_decision.seconds + 1);

  // Reopening a completed thread must not start a measurement.
  const reopened = await action({ action: "open_session" });
  assert.equal(reopened.status, 200, "opening a finished thread is a normal UI event, not an error");
  assert.equal(reopened.json.result.started, false);

  // Exports and the dashboard expose the recorded time.
  const csv = await (await fetch(`${server.base}/api/export/csv`)).text();
  assert.match(csv.split("\n")[0], /"?Decision Time \(s\)"?/);
  assert.match(csv.split("\n")[0], /Final Decision Type/);
  const metrics = await (await fetch(`${server.base}/api/metrics`)).json();
  assert.equal(metrics.handlingTime.source, "automatic-decision-timing");
  assert.ok(metrics.handlingTime.measuredCount >= 1);
  assert.ok(metrics.handlingTime.averageSecondsPerMsg >= 1);
});

test("a decision made without opening the thread in the UI is recorded as unmeasured", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const id = await createThread(server.base, "相手API処理");

  const completed = await post(server.base, `/api/threads/${id}/action`, { action: "complete" });
  assert.equal(completed.status, 200);
  const firstDecision = completed.json.thread.decision_timing.first_decision;
  assert.equal(firstDecision.type, "complete");
  assert.equal(firstDecision.measured, false);
  assert.equal(firstDecision.seconds, null);

  const metrics = await (await fetch(`${server.base}/api/metrics`)).json();
  assert.equal(metrics.handlingTime.measuredCount, 0, "unmeasured decisions never dilute the average");
  assert.equal(metrics.handlingTime.unmeasuredDecisions, 1);
});

test("reclassifying as 返信不要 is recorded as a decision", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const id = await createThread(server.base, "相手分類修正");
  await post(server.base, `/api/threads/${id}/action`, { action: "open_session" });
  const updated = await post(server.base, `/api/threads/${id}/action`, {
    action: "update_classification",
    classification: { action: "skip", category: "返信不要", reason: "担当者判断" },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.thread.decision_timing.first_decision.type, "reclassify_skip");
  assert.equal(updated.json.thread.decision_timing.first_decision.measured, true);
});
