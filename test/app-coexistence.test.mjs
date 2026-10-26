import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";
import app from "../index.js";
import { REMINDER_TYPE } from "../lib/gate-core.js";

function receipt() {
  const dispose = () => {};
  dispose.ready = Promise.resolve();
  dispose.disposeAsync = async () => {};
  return dispose;
}

async function runtime() {
  const root = process.env.HANA_APP_TOOLS_ROOT;
  const tunerRoot = process.env.SKILL_GATE_TUNER_ROOT;
  assert.ok(root && tunerRoot, "需指定 HANA_APP_TOOLS_ROOT 与 SKILL_GATE_TUNER_ROOT");
  const bundle = await readFile(path.join(root, "bundle/index.js"), "utf8");
  const child = await readFile(path.join(root, "app-host-entry.js"), "utf8");
  const start = bundle.indexOf("const d4e = Object.freeze([");
  const end = bundle.indexOf('const h4e = Object.freeze(["worktree/created"])', start);
  assert.ok(start >= 0 && end > start, "宿主注册器边界变化");
  const Registry = vm.runInNewContext(`${bundle.slice(start, end)}\nK_s`, { console });
  const wire = child.match(/this\.checkedSend\((\{ jsonrpc: "2\.0", id, result: result \?\? null \})\)/);
  assert.ok(wire, "宿主 RPC 编码契约变化");
  const response = vm.runInNewContext(`(id, result) => (${wire[1]})`);
  const { default: tuner } = await import(pathToFileURL(path.join(tunerRoot, "index.js")));
  const registry = new Registry();
  const tools = new Map();
  const registrations = [];
  function context(owner, order) {
    return {
      dataDir: "/unused/coexistence-test",
      bus: { request() { throw new Error("不得调用真实宿主或模型"); } },
      hooks: {
        onDecision(word, handler) {
          registrations.push({ owner, word });
          const off = registry.onDecision(word, async (input) =>
            JSON.parse(JSON.stringify(response("hook", await handler(input)))).result,
          { owner, order });
          return Object.assign(off, { ready: Promise.resolve(), disposeAsync: async () => off() });
        },
        on() { return receipt(); },
      },
      tools: { register(tool) { tools.set(`${owner}/${tool.name}`, tool); return receipt(); } },
      logger: { info() {}, warn() {}, error() {} },
      config: { get() { return undefined; } },
      resources: { read() { throw new Error("测试不得读取业务文件"); } },
      storage: { global: {}, agent: () => ({}) },
      models: {}, media: {}, providers: {},
    };
  }
  return { registry, tools, registrations, loadTuner: () => tuner.apply(context("tool-result-tuner", 1)),
    loadGate: () => app.apply(context("skill-gate", 2)) };
}

const session = { sessionId: "a", sessionPath: "/sessions/a.jsonl" };
const user = { role: "user", content: "检查目录", timestamp: 1 };
const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "ls", arguments: {} }], timestamp: 2 };
const toolResult = { role: "toolResult", toolCallId: "call-a", toolName: "ls", content: [{ type: "text", text: "原始结果" }], timestamp: 3 };

test("真实 tuner 单独运行与加入技能门卫后，普通工具均不因 null.block 中断", async () => {
  const { registry, loadTuner, loadGate, registrations } = await runtime();
  await loadTuner();
  const input = { session, toolName: "ls", input: {} };
  assert.equal(await registry.decide("tools/pre-execute", input), null);
  await loadGate();
  const decision = await registry.decide("tools/pre-execute", input);
  assert.ok(!decision?.block);
  assert.equal(registrations.filter(({ word }) => word === "tools/pre-execute").length, 1);
});

test("与真实 tuner 共存时，首步不提醒、工具后独立提醒、严格 skill 入参停止，结果保持原样", async () => {
  const { registry, loadTuner, loadGate } = await runtime();
  await loadTuner();
  await loadGate();
  await registry.decide("agent/before-start", { session });
  await registry.decide("agent/pre-step", { session, messages: [user] });
  await registry.decide("tools/pre-execute", { session, toolName: "ls", input: {} });
  const messages = [user, assistant, toolResult];
  const projected = await registry.decide("agent/pre-step", { session, messages });
  assert.equal(projected.messages.at(-1).customType, REMINDER_TYPE);
  assert.deepEqual(projected.messages.slice(0, -1), messages);
  const readCall = { role: "assistant", content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { resource: { kind: "skill" } } }], timestamp: 4 };
  const readResult = { role: "toolResult", toolCallId: "call-read", toolName: "read", content: [{ type: "text", text: "技能正文" }], timestamp: 5 };
  const released = await registry.decide("agent/pre-step", { session, messages: [...projected.messages, readCall, readResult] });
  assert.deepEqual(released.messages, [...messages, readCall, readResult]);
});
