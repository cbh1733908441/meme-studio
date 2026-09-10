import test from "node:test";
import assert from "node:assert/strict";
import { eventMessage } from "../lib/runner.mjs";

test("connection retries and terminal errors are visible without leaking tokens", () => {
  assert.equal(
    eventMessage({
      type: "error",
      message:
        "Reconnecting... 3/5 (stream disconnected before completion: tls handshake eof)",
    }),
    "Codex 连接中断，正在重连（3/5）",
  );
  const failure = eventMessage({
    type: "turn.failed",
    error: { message: "request failed Bearer abc123 sk-secretExample" },
  });
  assert.match(failure, /执行异常/);
  assert.ok(!failure.includes("abc123"));
  assert.ok(!failure.includes("secretExample"));
  assert.equal(
    eventMessage({
      type: "item.completed",
      item: { type: "agent_message", text: '{"meme":"测试"}' },
    }),
    undefined,
  );
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCodex } from "../lib/runner.mjs";

test("real process timeout starts at spawn, records searches and kills descendants even when parent exits", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meme-runner-")),
    bin = path.join(dir, "fake-codex");
  const original = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  t.after(() => {
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(
    bin,
    `#!${process.execPath}\nimport fs from 'node:fs';import {spawn} from 'node:child_process';
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync('descendant.pid',String(child.pid));
 console.log(JSON.stringify({type:'item.completed',item:{id:'q1',type:'web_search',action:{type:'search',queries:['actual query']}}}));
 process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
    { mode: 0o755 },
  );
  let starts = 0;
  const searches = [];
  const start = Date.now();
  await assert.rejects(
    runCodex({
      stage: "research",
      prompt: "test",
      schema: { type: "object" },
      dir,
      timeoutMs: 1000,
      onStart: () => starts++,
      onSearch: (q) => searches.push(q),
    }),
    { code: "STAGE_TIMEOUT" },
  );
  assert.equal(starts, 1);
  assert.ok(Date.now() - start >= 1000);
  assert.ok(
    searches.length,
    fs.readFileSync(path.join(dir, "events.jsonl"), "utf8") +
      fs.readFileSync(path.join(dir, "stderr.log"), "utf8"),
  );
  assert.deepEqual(searches[0].queries, ["actual query"]);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "execution-budget.json")))
      .timeoutMs,
    1000,
  );
  const pid = Number(fs.readFileSync(path.join(dir, "descendant.pid")));
  await delay(100);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "descendant must be dead");
});
test("cancellation stops the process without reporting budget timeout", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meme-cancel-")),
    bin = path.join(dir, "fake-codex"),
    old = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  t.after(() => {
    if (old === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(bin, `#!${process.execPath}\nsetInterval(()=>{},1000);`, {
    mode: 0o755,
  });
  const controller = new AbortController();
  await assert.rejects(
    runCodex({
      stage: "research",
      prompt: "test",
      schema: { type: "object" },
      dir,
      signal: controller.signal,
      timeoutMs: 5000,
      onStart: () => setTimeout(() => controller.abort(), 50),
    }),
    /已取消/,
  );
});

test("CLI terminal error is shown instead of unrelated diagnostic warnings", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meme-cli-error-")),
    bin = path.join(dir, "fake-codex"),
    old = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  t.after(() => {
    if (old === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(
    bin,
    `#!${process.execPath}\nconsole.error('unrelated diagnostic warning');console.log(JSON.stringify({type:'turn.failed',error:{message:'usage limit reached'}}));process.exitCode=1;`,
    { mode: 0o755 },
  );
  await assert.rejects(
    runCodex({
      stage: "research",
      prompt: "test",
      schema: { type: "object" },
      dir,
      timeoutMs: 5000,
    }),
    (e) =>
      e.message.includes("usage limit reached") &&
      !e.message.includes("unrelated diagnostic"),
  );
});
