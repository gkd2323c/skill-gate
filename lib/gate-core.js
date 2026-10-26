export const REMINDER_TYPE = "app:skill-gate/reminder";

export const REMINDER_TEXT =
  '<skill-gate>本轮已经调用工具，但尚未通过 read 的 resource.kind="skill" 读取任何 skill。请查阅与本任务所有相关的 skill。</skill-gate>' +
  '<skill-gate>声明理由只能是「不存在与本任务相关的 skill」；只有这种情况才能调用 skill_gate_declare，并在 reason 中说明。</skill-gate>' +
  '<skill-gate>「我很熟悉」「我已知道怎么做」「这个很简单」不构成理由。读普通文件、recipe 或 agent 不算读取 skill。</skill-gate>';

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
  return { toolCalled: false, skillRead: false, declared: false, seenCalls: null };
}

function toolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const call of message.content) {
        if (call?.type === "toolCall" && typeof call.id === "string" && call.id) {
          calls.push({ id: call.id, name: call.name, input: call.arguments });
        }
      }
    } else if (message?.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId) {
      calls.push({ id: message.toolCallId });
    }
  }
  return calls;
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
    const input = call.name === "read" ? call.input
      : call.name === "tool_call" && call.input?.server === "core" && call.input?.tool === "read"
        ? call.input.arguments : null;
    if (input?.resource?.kind === "skill") state.skillRead = true;
  }
}

function reply(status, accepted, code, summary) {
  return {
    content: [{ type: "text", text: summary }],
    details: { status, accepted, code, summary },
    ...(accepted ? {} : { isError: true }),
  };
}

export function createSkillGate() {
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
      observeCalls(state, messages);
      const clean = messages.filter((message) =>
        !(message?.role === "custom" && message.customType === REMINDER_TYPE));
      if (state.toolCalled && !state.skillRead && !state.declared) {
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
