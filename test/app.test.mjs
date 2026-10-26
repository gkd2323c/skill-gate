import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import app from "../index.js";
import { REMINDER_TYPE } from "../lib/gate-core.js";

function registration() {
  const dispose = () => {};
  dispose.ready = Promise.resolve();
  dispose.disposeAsync = async () => {};
  return dispose;
}

function fixture(rejectWord = null) {
  const tools = new Map();
  const decisions = new Map();
  const events = new Map();
  const context = {
    dataDir: "/unused/app-data/skill-gate",
    bus: { request: async () => { throw new Error("本 App 不应调用会话或模型 API"); } },
    tools: { register(tool) { tools.set(tool.name, tool); return registration(); } },
    hooks: {
      onDecision(word, handler) {
        if (word === rejectWord) return Promise.reject(new Error("钩子注册被拒绝"));
        decisions.set(word, handler);
        return registration();
      },
      on(word, handler) { events.set(word, handler); return registration(); },
    },
    storage: { global: {}, agent: () => ({}) },
    models: {}, media: {}, providers: {},
  };
  return { context, tools, decisions, events };
}

const session = { sessionId: "session-a", sessionPath: "/sessions/a.jsonl" };
const user = Object.freeze({ role: "user", content: "查看目录", timestamp: 1 });
const messages = Object.freeze([
  user,
  Object.freeze({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ls", arguments: {} }], timestamp: 2 }),
  Object.freeze({ role: "toolResult", toolName: "ls", toolCallId: "c1", content: [{ type: "text", text: "原始数据" }], timestamp: 3 }),
]);

test("真实 App 入口经随包 SDK 注册，覆盖五项验收行为且不改工具结果", async () => {
  const { context, tools, decisions, events } = fixture();
  await app.apply(context);
  assert.deepEqual([...tools.keys()], ["skill_gate_declare"]);
  assert.deepEqual([...decisions.keys()], ["agent/before-start", "agent/pre-step"]);
  assert.deepEqual([...events.keys()], ["session.shutdown"]);
  assert.equal(decisions.has("tools/post-execute"), false);
  assert.equal(decisions.has("tools/pre-execute"), false);
  const start = decisions.get("agent/before-start");
  const preStep = decisions.get("agent/pre-step");
  const declare = tools.get("skill_gate_declare").execute;

  assert.deepEqual(await start({ session, prompt: "查看目录", systemPrompt: "系统提示" }), {});
  assert.deepEqual(await preStep({ session, messages: [user] }), {});
  const reminded = await preStep({ session, messages });
  assert.equal(reminded.messages.at(-1).customType, REMINDER_TYPE);
  assert.equal(reminded.messages[2], messages[2]);

  const invalid = await declare({ reason: "  ", context: { sessionPath: session.sessionPath } });
  assert.equal(invalid.details.accepted, false);
  assert.ok(await preStep({ session, messages }));
  const accepted = await declare({ reason: "无相关技能", context: { sessionPath: session.sessionPath } });
  assert.equal(accepted.details.accepted, true);
  assert.deepEqual(await preStep({ session, messages }), {});

  await start({ session, prompt: "新任务", systemPrompt: "系统提示" });
  assert.deepEqual(await preStep({ session, messages }), {});
  const read = { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: { resource: { kind: "skill", name: "example" } } }] };
  assert.deepEqual(await preStep({ session, messages: [...messages, read] }), {});
  await events.get("session.shutdown")({ session });
  assert.deepEqual(await preStep({ session, messages }), {});
});

test("钩子注册失败向宿主报告，不伪装为已成功加载", async () => {
  const { context } = fixture("agent/pre-step");
  await assert.rejects(app.apply(context), /钩子注册被拒绝/);
});

test("清单只请求实际使用的四项能力，入口与版本一致", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.id, "skill-gate");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.entry, "index.js");
  assert.deepEqual(manifest.capabilities, [
    "app/tools.expose-to-model", "app/hooks.agent-before-start",
    "app/hooks.agent-pre-step", "app/hooks.observe",
  ]);
  assert.equal(manifest.network, undefined);
  assert.equal(manifest.activation, undefined);
});
