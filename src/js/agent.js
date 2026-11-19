// agent.js - 桌面陪伴 AI 对话（多轮；S0 阶段不带工具，S2 再挂人格/记忆工具）
// 不依赖 Electron，便于单测。

const logger = require('./logger');

const MAX_STEPS = 6;
const RESULT_MAX = 2400;
const HISTORY_TURNS = 8; // 按用户轮次裁，不是按 raw message 条数

const SYSTEM_PROMPT =
  '你是常驻用户桌面的小团子猫，一个陪伴型角色。' +
  '你可以和用户连续聊天，语气温暖、轻松、简短，像身边的朋友。' +
  '不装成算命先生、不编造事实；不知道就坦白说不知道，再顺着话题聊下去。' +
  '每次回答尽量 1-3 句，不要长篇大论，也不要重复用户的话。';

const TOOLS = [];

const TOOL_LABELS = {};

function compact(obj) {
  try {
    const s = JSON.stringify(obj);
    return s.length <= RESULT_MAX ? s : s.slice(0, RESULT_MAX) + '…';
  } catch {
    return '{"error":"SERIALIZE"}';
  }
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// S0 阶段没有工具；S2 接入人格/记忆时在这里注册并返回数据
function executeTool(name, args, ctx = {}) {
  return { ok: false, error: 'NO_TOOLS' };
}

function publicHistory(messages) {
  return (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));
}

function emptyAgentChat() {
  return { messages: [], scene: '', updatedAt: 0 };
}

function trimByUserTurns(messages, maxTurns = HISTORY_TURNS) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.role && m.role !== 'system') : [];
  const userIdx = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].role === 'user') userIdx.push(i);
  }
  if (userIdx.length <= maxTurns) return list;
  return list.slice(userIdx[userIdx.length - maxTurns]);
}

async function runAgent({ history, userQuery, aiConfig, ctx = {}, callLLM, onProgress }) {
  const q = String(userQuery || '').trim();
  if (!q) throw new Error('EMPTY_QUERY');
  if (!aiConfig || !aiConfig.token) throw new Error('NO_TOKEN');

  const tools = TOOLS;
  const labels = TOOL_LABELS;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimByUserTurns(history || []),
    { role: 'user', content: q },
  ];

  const usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolsUsed = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await callLLM({
      baseUrl: aiConfig.baseUrl,
      token: aiConfig.token,
      model: aiConfig.model,
      messages,
      tools,
      jsonMode: false,
      temperature: 0.7,
      maxTokens: 800,
      timeoutMs: 20000,
    });
    if (result.usage) {
      usageTotal.prompt_tokens += result.usage.prompt_tokens || 0;
      usageTotal.completion_tokens += result.usage.completion_tokens || 0;
      usageTotal.total_tokens += result.usage.total_tokens || 0;
    }

    const calls = result.tool_calls || [];
    if (calls.length === 0) {
      const text = String(result.content || '').trim();
      if (!text) throw new Error('EMPTY_TEXT');
      messages.push({ role: 'assistant', content: text });
      logger.info('agent.run', `done steps=${step + 1} tools=${toolsUsed.join(',') || 'none'}`);
      return {
        text,
        toolsUsed,
        usage: usageTotal,
        history: trimByUserTurns(messages.filter((m) => m.role !== 'system')),
      };
    }

    messages.push({
      role: 'assistant',
      content: result.content || '',
      tool_calls: calls,
    });

    for (const call of calls) {
      const name = call.function?.name || call.name;
      const args = parseArgs(call.function?.arguments || call.arguments);
      const id = call.id || `call_${toolsUsed.length}`;
      logger.info('agent.tool', `name=${name}`);
      if (typeof onProgress === 'function') onProgress({ tool: name, label: labels[name] || name });
      toolsUsed.push(name);
      const out = executeTool(name, args, ctx);
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: compact(out),
      });
    }
  }

  throw new Error('AGENT_MAX_STEPS');
}

module.exports = {
  TOOLS,
  TOOL_LABELS,
  SYSTEM_PROMPT,
  HISTORY_TURNS,
  executeTool,
  runAgent,
  publicHistory,
  parseArgs,
  trimByUserTurns,
  emptyAgentChat,
};
