import { defineApp } from "./sdk/app-contract/server-client.js";
import { createSkillGate } from "./lib/gate-core.js";

export default defineApp(async (sdk) => {
  const gate = createSkillGate();

  await sdk.tools.register({
    name: "skill_gate_declare",
    description: "仅当不存在与本任务相关的 skill 时，填写非空 reason 声明并停止本轮技能门卫提醒。「我很熟悉」「我已知道怎么做」「这个很简单」不构成理由。",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "说明不存在与本任务相关的 skill。" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    sessionPermission: {
      kind: "write",
      auto: "allow",
      sideEffect: "仅更新当前会话的本轮内存状态",
    },
    execute: gate.declare,
  });

  // 保留可传输的空裁决；从步骤消息观察调用，避免加入工具前置瀑布。
  await sdk.hooks.onDecision("agent/before-start", (invocation) => gate.beginTurn(invocation) ?? {});
  await sdk.hooks.onDecision("agent/pre-step", (invocation) => gate.beforeStep(invocation) ?? {});
  await sdk.hooks.on("session.shutdown", gate.closeSession);
});
