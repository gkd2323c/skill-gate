export const REMINDER_TYPE = "app:skill-gate/reminder";

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let diagDir = null;
let diagCount = 0;

function diagDump(meta) {
  if (!diagDir || diagCount > 300) return;
  try {
    appendFileSync(join(diagDir, "diag.jsonl"), `${JSON.stringify(meta)}\n`, "utf8");
    diagCount++;
  } catch {
    // 诊断不影响判定
  }
}

export const REMINDER_TEXT =
  '<skill-gate>本轮已经调用工具，但尚未读取任何 skill。请查阅与本任务相关的 skill。</skill-gate>' +
  '<skill-gate>读取 skill 的判定：用 read 读取 resource.kind="skill" 的技能资源，或读取文件名为 SKILL.md 的文件（大小写不敏感）。</skill-gate>' +
  '<skill-gate>声明理由只能是「不存在与本任务相关的 skill」；只有这种情况才能调用 skill_gate_declare，并在 reason 中说明。</skill-gate>' +
  '<skill-gate>「我很熟悉」「我已知道怎么做」「这个很简单」不构成理由。读 recipe 或 agent 不算读取 skill。</skill-gate>';

function sessionKey(session) {
  if (typeof session?.sessionPath === "string" && session.sessionPath.trim()) {
    return `path:${session.sessionPath}`;
  }
  if (typeof session?.sessionId === "string" && session.sessionId.trim()) {
    return `id:${session.sessionId}`;
  }
  return null;
}

function freshState() {
  return {
    toolCalled: false,
    skillRead: false,
    declared: false,
    seenCalls: null,
    // 本轮开始前的历史调用：只作为基线，不参与本轮计分
    baselineIds: null,
    turnKey: null,
  };
}

// 宿主在 hook 输入里可能用 arguments，也可能用 input；两种形状都认，
// 否则 skill 读取永远识别不到（只认一种时表现为「每步都提醒」）。
function callArguments(call) {
  return call?.arguments ?? call?.input ?? null;
}

function toolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const call of message.content) {
        if (call?.type === "toolCall" && typeof call.id === "string" && call.id) {
          calls.push({ id: call.id, name: call.name, input: callArguments(call) });
        }
      }
    } else if (message?.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId) {
      calls.push({ id: message.toolCallId });
    }
  }
  return calls;
}

function isSkillFile(target) {
  if (typeof target !== "string" || !target.trim()) return false;
  return /(^|[\\/])SKILL\.md$/i.test(target.trim());
}

function skillTarget(input) {
  if (!input || typeof input !== "object") return false;
  if (input.resource?.kind === "skill") return true;
  if (isSkillFile(input.path)) return true;
  if (isSkillFile(input.fileId)) return true;
  return isSkillFile(input.resource?.path);
}

function readTarget(input) {
  if (input && typeof input === "object" && input.server === "core" && input.tool === "read") {
    return callArguments(input);
  }
  return input;
}

// 从「最后一条 user 消息」开始回放本轮：即使宿主在每步都触发 before-start、
// 或消息被压缩重放，只要本轮读过 skill 就能被识别出来。
function analyzeTurn(messages, baselineIds) {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") { start = i; break; }
  }
  let toolCalled = false;
  let skillRead = false;
  for (let i = start + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (call?.type !== "toolCall" || typeof call.id !== "string" || !call.id) continue;
      if (baselineIds?.has(call.id)) continue;
      toolCalled = true;
      const raw = callArguments(call);
      const input = call.name === "read" ? raw
        : call.name === "tool_call" ? readTarget(raw) : null;
      if (input && skillTarget(input)) skillRead = true;
    }
  }
  const key = start >= 0
    ? `turn:${messages[start].id ?? messages[start].timestamp ?? `idx:${start}`}`
    : null;
  return { toolCalled, skillRead, key };
}

function observeCalls(state, messages) {
  const calls = toolCalls(messages);
  if (state.seenCalls === null) {
    // 首次模型请求中的调用属于历史；每轮只认此后新增的宿主调用 ID。
    state.seenCalls = new Set(calls.map((call) => call.id));
    return;
  }
  for (const call of calls) {
    if (state.seenCalls.has(call.id)) continue;
    state.seenCalls.add(call.id);
    state.toolCalled = true;
    const raw = call.input ?? null;
    const input = call.name === "read" ? raw
      : call.name === "tool_call" ? readTarget(raw) : null;
    if (input && skillTarget(input)) state.skillRead = true;
  }
}

function rebase(state, messages, turnKey) {
  const ids = new Set(toolCalls(messages).map((call) => call.id));
  state.seenCalls = ids;
  state.baselineIds = new Set(ids);
  state.turnKey = turnKey;
  state.toolCalled = false;
  state.skillRead = false;
  state.declared = false;
}

function reply(status, accepted, code, summary) {
  return {
    content: [{ type: "text", text: summary }],
    details: { status, accepted, code, summary },
    ...(accepted ? {} : { isError: true }),
  };
}

export function createSkillGate(options = {}) {
  if (options?.dataDir) {
    try {
      diagDir = join(options.dataDir, "diag");
      mkdirSync(diagDir, { recursive: true });
    } catch {
      diagDir = null;
    }
  }
  const sessions = new Map();

  function stateFor(session) {
    const key = sessionKey(session);
    if (key === null) return null;
    if (!sessions.has(key)) sessions.set(key, freshState());
    return sessions.get(key);
  }

  return {
    beginTurn({ session, signal } = {}) {
      if (signal?.aborted) return;
      const key = sessionKey(session);
      if (key !== null) sessions.set(key, freshState());
    },

    declare({ reason, context } = {}) {
      if (typeof reason !== "string" || !reason.trim()) {
        return reply("error", false, "EMPTY_REASON", "<skill-gate>声明未采纳：reason 不能为空。只有不存在与本任务相关的 skill 才能声明；请读取相关 skill 或填写理由。</skill-gate>");
      }
      const state = stateFor(context);
      if (!state) {
        return reply("error", false, "SESSION_REQUIRED", "<skill-gate>声明未采纳：缺少宿主提供的会话身份。请在目标会话内调用本工具。</skill-gate>");
      }
      state.declared = true;
      return reply("success", true, "DECLARED", "<skill-gate>声明已采纳，本轮停止提醒。</skill-gate>");
    },

    beforeStep({ session, messages, signal } = {}) {
      if (signal?.aborted || !Array.isArray(messages)) return;
      const state = stateFor(session);
      if (!state) return;

      // 首次观察：把当时可见的调用整体作为基线，本轮从零计分（不 return，
      // 要让下方清理逻辑照常移除上下文里遗留的提醒）。
      if (state.seenCalls === null) {
        rebase(state, messages, analyzeTurn(messages, null).key);
      } else {
        const turn = analyzeTurn(messages, state.baselineIds);
        if (turn.key !== null && state.turnKey !== turn.key) {
          // 新的用户消息：把当前全部调用视为历史，本轮从头计分。
          rebase(state, messages, turn.key);
        } else {
          // 本轮已发生的事实优先于增量记录，抵消任意频率的状态重置与压缩重放。
          if (turn.toolCalled) state.toolCalled = true;
          if (turn.skillRead) state.skillRead = true;
        }
      }

      observeCalls(state, messages);

      const clean = messages.filter((message) =>
        !(message?.role === "custom" && message.customType === REMINDER_TYPE));
      const willRemind = state.toolCalled && !state.skillRead && !state.declared;
      diagDump({
        ts: Date.now(),
        count: messages.length,
        turnKey: state.turnKey,
        baseline: state.baselineIds ? state.baselineIds.size : null,
        seen: state.seenCalls ? state.seenCalls.size : null,
        toolCalled: state.toolCalled,
        skillRead: state.skillRead,
        declared: state.declared,
        willRemind,
        sample: messages.slice(-3).flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
          .filter((c) => c?.type === "toolCall")
          .map((c) => ({ name: c.name, hasArgs: !!c.arguments, path: String(c.arguments?.path ?? "").slice(-40) })),
      });
      if (willRemind) {
        return {
          messages: [...clean, {
            role: "custom",
            customType: REMINDER_TYPE,
            content: REMINDER_TEXT,
            display: false,
            timestamp: Date.now(),
          }],
        };
      }
      if (clean.length !== messages.length) return { messages: clean };
    },

    closeSession({ session } = {}) {
      const key = sessionKey(session);
      if (key !== null) sessions.delete(key);
    },
  };
}
