import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import app from "../index.js";
import { REMINDER_TYPE } from "../lib/gate-core.js";

const hostRoot = process.env.HANA_APP_TOOLS_ROOT;

async function hostRuntime() {
  assert.ok(hostRoot, "请将 HANA_APP_TOOLS_ROOT 指向实际宿主的 Server 版本目录");
  const bundle = await readFile(path.join(hostRoot, "bundle/index.js"), "utf8");
  const childEntry = await readFile(path.join(hostRoot, "app-host-entry.js"), "utf8");
  const registryStart = bundle.indexOf('const d4e = Object.freeze([');
  const registryEnd = bundle.indexOf('const h4e = Object.freeze(["worktree/created"])', registryStart);
  assert.ok(registryStart >= 0 && registryEnd > registryStart, "宿主注册器代码边界已变化，需重新核对");
  const registrySource = bundle.slice(registryStart, registryEnd);
  assert.match(registrySource, /class K_s/);
  assert.match(registrySource, /c\.block === !0/);
  const HookRegistry = vm.runInNewContext(`${registrySource}\nK_s;`, { console });
  const wireMatch = childEntry.match(/this\.checkedSend\((\{ jsonrpc: "2\.0", id, result: result \?\? null \})\)/);
  assert.ok(wireMatch, "宿主 RPC 结果编码契约已变化，需重新核对");
  const makeResponse = vm.runInNewContext(`(id, result) => (${wireMatch[1]})`);
  return {
    HookRegistry,
    wire: (value) => JSON.parse(JSON.stringify(makeResponse("hook-result", value))).result,
  };
}

function receipt() {
  const dispose = () => {};
  dispose.ready = Promise.resolve();
  dispose.disposeAsync = async () => {};
  return dispose;
}

async function loadThroughWire(runtime) {
  const registry = new runtime.HookRegistry();
  const tools = new Map();
  const callbacks = new Map();
  const events = new Map();
  registry.onDecision("tools/pre-execute", () => undefined, { owner: "host-guard", order: 0 });
  const context = {
    dataDir: "/unused/skill-gate-test",
    bus: { request() { throw new Error("回归测试不得调用真实会话或模型"); } },
    hooks: {
      onDecision(word, handler) {
        callbacks.set(word, handler);
        const off = registry.onDecision(word, async (input) => runtime.wire(await handler(input)), {
          owner: "skill-gate", order: 1,
        });
        return Object.assign(off, { ready: Promise.resolve(), disposeAsync: async () => off() });
      },
      on(word, handler) { events.set(word, handler); return receipt(); },
    },
    tools: { register(tool) { tools.set(tool.name, tool); return receipt(); } },
    storage: { global: {}, agent: () => ({}) },
    models: {}, media: {}, providers: {},
  };
  await app.apply(context);
  return { registry, tools, callbacks, events };
}

const session = { sessionId: "session-a", sessionPath: "/test/session-a.jsonl" };
const messages = [
  { role: "user", content: "检查目录", timestamp: 1 },
  { role: "toolResult", toolName: "ls", toolCallId: "a", content: [{ type: "text", text: "原结果" }], timestamp: 2 },
];

test("宿主原始 RPC 编码与瀑布注册器能复现 undefined 转 null.block 故障", async () => {
  const runtime = await hostRuntime();
  assert.equal(runtime.wire(undefined), null);
  const registry = new runtime.HookRegistry();
  registry.onDecision("tools/pre-execute", () => undefined, { owner: "host-guard", order: 0 });
  registry.onDecision("tools/pre-execute", () => runtime.wire(undefined), { owner: "broken-app", order: 1 });
  await assert.rejects(registry.decide("tools/pre-execute", { session, toolName: "ls", input: {} }),
    /Cannot read properties of null \(reading 'block'\)/);
});

test("App 经宿主 RPC 编码与原始瀑布注册器，普通工具不崩溃且放行", async () => {
  const runtime = await hostRuntime();
  const { registry, callbacks } = await loadThroughWire(runtime);
  assert.equal(callbacks.has("tools/pre-execute"), false);
  await registry.decide("agent/before-start", { session, prompt: "检查目录", systemPrompt: "系统" });
  await registry.decide("agent/pre-step", { session, messages: messages.slice(0, 1) });
  const decision = await registry.decide("tools/pre-execute", { session, toolName: "ls", input: {} });
  assert.equal(decision, undefined);
  const projected = await registry.decide("agent/pre-step", { session, messages });
  assert.equal(projected.messages.at(-1).customType, REMINDER_TYPE);
  assert.deepEqual(projected.messages.slice(0, -1), messages);
});

test("两个裁决钩子的无改写、取消与缺身份分支传输后均为对象", async () => {
  const runtime = await hostRuntime();
  const { callbacks } = await loadThroughWire(runtime);
  const signal = AbortSignal.abort();
  for (const input of [{}, { session, messages }, { session, messages, signal }]) {
    for (const [word, callback] of callbacks) {
      const result = runtime.wire(await callback(input));
      assert.ok(result !== null && typeof result === "object" && !Array.isArray(result), word);
    }
  }
});

test("真实钩子传输后，skill 读取与声明仍释放提醒，宿主阻断仍优先生效", async () => {
  const runtime = await hostRuntime();
  const { registry, tools } = await loadThroughWire(runtime);
  const start = async () => {
    await registry.decide("agent/before-start", { session, prompt: "任务", systemPrompt: "系统" });
    await registry.decide("agent/pre-step", { session, messages: messages.slice(0, 1) });
  };
  await start();
  const read = { role: "assistant", content: [{ type: "toolCall", id: "skill-call", name: "read", arguments: { resource: { kind: "skill" } } }] };
  assert.deepEqual(await registry.decide("agent/pre-step", { session, messages: [...messages, read] }), {});
  await start();
  await registry.decide("tools/pre-execute", { session, toolName: "ls", input: {} });
  assert.equal(tools.get("skill_gate_declare").execute({ reason: "  ", context: session }).details.accepted, false);
  assert.ok((await registry.decide("agent/pre-step", { session, messages })).messages);
  assert.equal(tools.get("skill_gate_declare").execute({ reason: "无相关 skill", context: session }).details.accepted, true);
  assert.deepEqual(await registry.decide("agent/pre-step", { session, messages }), {});
  registry.onDecision("tools/pre-execute", () => ({ block: true, reason: "宿主已阻断" }), { owner: "host-deny", order: -1 });
  const blocked = await registry.decide("tools/pre-execute", { session, toolName: "ls", input: {} });
  assert.equal(blocked.block, true);
  assert.equal(blocked.reason, "宿主已阻断");
});
