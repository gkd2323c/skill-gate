export const REMINDER_TYPE = "app:skill-gate/reminder";

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
    // 会话级记忆：本轮读过 skill，即使上下文窗口被裁剪也能放行
    readObserved: false,
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

// 本轮提醒自身可能被宿主投影成 user 消息回灌；它不是用户发言，不能当轮次边界。
function isRealUserMessage(message) {
  if (message?.role !== "user") return false;
  if (message?.customType === REMINDER_TYPE) return false;
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("")
      : "";
  if (!text.trim()) return false;
  if (text.includes("<skill-gate>")) return false;
  if (text.includes("本轮已经调用工具，但尚未读取任何 skill")) return false;
  return true;
}

function findTurnStart(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i])) return i;
  }
  return -1;
}

function turnKeyOf(messages, start) {
  if (start < 0) return null;
  return `turn:${messages[start].id ?? messages[start].timestamp ?? `idx:${start}`}`;
}

// 从「最后一条真实 user 消息」之后回放本轮：即使宿主在每步都触发 before-start、
// 或消息被压缩重放，只要本轮读过 skill 就能被识别出来。
function analyzeTurn(messages, start, baselineIds) {
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
  return { toolCalled, skillRead };
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
    if (input && skillTarget(input)) {
      state.skillRead = true;
      state.readObserved = true;
    }
  }
}

function rebase(state, messages, start, all = false) {
  // all：首次观察，把窗口内已有调用整体作为历史（静默）。
  // 否则：新一轮用户发言，基线只到今天之前，本轮已发生的调用能被回放出来。
  const upto = all || start < 0 ? messages : messages.slice(0, start + 1);
  const baseline = new Set(toolCalls(upto).map((call) => call.id));
  state.baselineIds = baseline;
  state.seenCalls = new Set(toolCalls(messages).map((call) => call.id));
  state.turnKey = turnKeyOf(messages, start);
  state.toolCalled = false;
  state.skillRead = false;
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
      const state = stateFor(session);
      if (!state) return;
      // 只清本轮计分，保留声明：声明失效只由真实的新用户发言触发
      state.toolCalled = false;
      state.skillRead = false;
      state.seenCalls = null;
      state.baselineIds = null;
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

      // 首次观察与新的用户轮次都按「真实用户发言之前」建基线：
      // 本轮已发生的读取必须能被回放出来，否则会话重开/窗口重建后会反复误报。
      const start = findTurnStart(messages);
      const turnKey = turnKeyOf(messages, start);
      const newTurn = turnKey !== null && state.turnKey !== turnKey;
      if (state.seenCalls === null || newTurn) {
        rebase(state, messages, start);
        // 声明与读取记忆只由真实的新用户发言失效
        if (newTurn) {
          state.declared = false;
          state.readObserved = false;
        }
      }

      if (start >= 0) {
        // 本轮已发生的事实优先于增量记录，抵消任意频率的状态重置与压缩重放。
        const turn = analyzeTurn(messages, start, state.baselineIds);
        if (turn.toolCalled) state.toolCalled = true;
        if (turn.skillRead) {
          state.skillRead = true;
          state.readObserved = true;
        }
      }

      observeCalls(state, messages);

      const clean = messages.filter((message) =>
        !(message?.role === "custom" && message.customType === REMINDER_TYPE));
      const satisfied = state.skillRead || state.readObserved;
      if (state.toolCalled && !satisfied && !state.declared) {
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
