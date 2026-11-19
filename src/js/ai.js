// ai.js - LLM 调用封装（主进程侧）
// 用 Electron 内置 net.fetch，无需第三方依赖
// 线上：DeepSeek OpenAI 兼容 API；备用：本地 Ollama
// 所有调用失败都 throw，由调用方决定降级（浮窗显示错误提示）

const { net } = require('electron');
const logger = require('./logger');

const DEFAULT_MODEL = 'deepseek-chat';

// 探测端点：OpenAI 兼容 /v1/chat/completions；localhost 视为本地模型
function detectEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(u);
  u = u.replace(/\/v\d+$/, '');
  return { kind: 'openai', url: u + '/v1/chat/completions', isLocal };
}

// ---------- System Prompts ----------
function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) return 'https://api.deepseek.com/v1';
  if (!/\/v\d+$/.test(url)) url += '/v1';
  return url;
}

// ---------- 失败去重：同类错误 5 分钟内只记一次 error，其余降为 warn ----------
const FAIL_DEDUPE_MS = 5 * 60 * 1000;
const lastFailAt = new Map();
function shouldLogAsError(key) {
  const now = Date.now();
  const last = lastFailAt.get(key) || 0;
  if (now - last < FAIL_DEDUPE_MS) return false;
  lastFailAt.set(key, now);
  return true;
}

// ---------- 核心：callLLM ----------
/**
 * 调用 OpenAI 兼容 chat completions（DeepSeek / 本地 Ollama）。
 * @param {Object} opts
 * @param {string} opts.baseUrl    - 如 "https://api.deepseek.com/v1"
 * @param {string} opts.token      - 明文 token（本地可空）
 * @param {Array}  opts.messages   - [{role, content}, ...]
 */
async function callLLM({
  baseUrl,
  token,
  messages,
  model = DEFAULT_MODEL,
  temperature = 0.7,
  maxTokens = 600,
  timeoutMs = 12000,
  tools,
  jsonMode,
}) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('NO_MESSAGES');

  const ep = detectEndpoint(baseUrl);
  if (!token && !ep.isLocal) throw new Error('NO_TOKEN');
  const startTs = Date.now();
  const hasTools = Array.isArray(tools) && tools.length > 0;
  logger.info('ai.callLLM', `model=${model} local=${ep.isLocal} tools=${hasTools} timeout=${timeoutMs}`);

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (hasTools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // tool 调用不能强制 json_object；本地模型对 json_object 也不稳
  const wantJson = jsonMode !== undefined ? jsonMode : (!hasTools && !ep.isLocal);
  if (wantJson) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 统一错误出口：写一条结构化日志再抛，保证日志里一定能看到原因
  const fail = (code, status, detail, extra) => {
    const meta = {
      code,
      status: status || 0,
      model,
      local: ep.isLocal,
      timeoutMs,
      ms: Date.now() - startTs,
      ...(extra || {}),
    };
    const line = `${code} status=${status || '-'} ${detail || ''}`.trim();
    // 首次（5 分钟内）记 error（会触发 watcher 诊断/通知），重复的只记 warn，避免刷屏
    if (shouldLogAsError(code)) logger.error('ai.callLLM', line, meta);
    else logger.warn('ai.callLLM', '（重复）' + line, meta);
    return new Error(detail && code.startsWith('HTTP_') ? `${code}: ${detail}` : code);
  };

  let resp;
  try {
    resp = await net.fetch(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw fail('TIMEOUT', 0, `超过 ${timeoutMs}ms 未返回`);
    throw fail('NETWORK', 0, String((e && e.message) || e));
  }
  clearTimeout(timer);

  const status = resp.status;
  let json;
  try {
    json = await resp.json();
  } catch (e) {
    throw fail('BAD_JSON', status, '响应不是合法 JSON');
  }

  // 从响应体里提取服务端错误信息（DeepSeek 常见：余额不足 / 无效 Key / 模型不存在）
  const upstreamMsg = String(
    (json && (json.error?.message || json.error_message || json.message)) || ''
  ).replace(/s+/g, ' ').slice(0, 200);
  const code = (json && json.error && json.error.code) || '';

  if (status === 401 || status === 403) throw fail('AUTH_FAILED', status, upstreamMsg, { upstreamCode: code });
  if (status === 429) throw fail('RATE_LIMITED', status, upstreamMsg, { upstreamCode: code });
  if (status === 402) throw fail('INSUFFICIENT_BALANCE', status, upstreamMsg, { upstreamCode: code });
  if (status >= 500) throw fail(`SERVER_${status}`, status, upstreamMsg, { upstreamCode: code });

  // 业务层错误也可能以 200 + error 字段返回
  if (json && json.error && !json.choices) {
    throw fail('UPSTREAM_ERROR', status, upstreamMsg, { upstreamCode: code });
  }

  if (!resp.ok) throw fail(`HTTP_${status}`, status, upstreamMsg, { upstreamCode: code });

  const message = json?.choices?.[0]?.message || {};
  const content = message.content || '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const normalizedUsage = json?.usage || {};
  if (!content && toolCalls.length === 0) {
    throw fail('EMPTY_RESPONSE', status, `finish=${json?.choices?.[0]?.finish_reason || '-'}`);
  }

  logger.info('ai.callLLM', `done ${Date.now() - startTs}ms tokens=${normalizedUsage.total_tokens || '?'} tools=${toolCalls.length}`);
  return {
    content,
    tool_calls: toolCalls,
    finish_reason: json?.choices?.[0]?.finish_reason || '',
    usage: normalizedUsage,
    model: json.model || model,
  };
}

// ---------- 把模型的 JSON 输出解析为字符串 ----------
function extractText(content) {
  // 模型返回 JSON 字符串：{ "text": "...", "summary": "..." } 或裸字符串
  const trimmed = String(content || '').trim();
  if (!trimmed) return '';
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj === 'string') return obj;
    if (obj && typeof obj.text === 'string') return obj.text;
    if (obj && typeof obj.summary === 'string') return obj.summary;
    if (obj && typeof obj.interpretation === 'string') return obj.interpretation;
    return JSON.stringify(obj);
  } catch {
    // 不是 JSON：直接当文本返回
    logger.warn('ai.extractText', 'JSON parse failed, fallback to raw');
    return trimmed;
  }
}

// ---------- 用户上下文构造 ----------
// 本模块只保留底层 LLM 调用、连接测试与日志诊断；对话人格在 agent.js。

// ---------- 探测：测试连接 ----------
async function testConnection({ baseUrl, token, model }) {
  logger.info('ai.testConnection', `baseUrl=${baseUrl} model=${model || DEFAULT_MODEL}`);
  if (!token) return { ok: false, error: 'NO_TOKEN' };
  try {
    // 测试只校验鉴权/网络/模型名，不需要结构化输出：
    // jsonMode=false 避免 DeepSeek 要求 prompt 里必须出现 "json" 字样而误报失败
    const result = await callLLM({
      baseUrl,
      token,
      messages: [
        { role: 'system', content: '你是一个连通性测试助手，只回复 OK。' },
        { role: 'user', content: '回复 OK' },
      ],
      model: model || DEFAULT_MODEL,
      temperature: 0.1,
      maxTokens: 8,
      timeoutMs: 8000,
      jsonMode: false,
    });
    return { ok: true, model: result.model };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- AI 自动诊断 ----------
const DIAGNOSE_SYSTEM =
  '你是一位资深 Electron 桌面应用工程师，专门负责快速定位错误并给出可执行的修复建议。' +
  '用户会贴最近 50 行日志 + 一条关键错误 + 触发上下文，请你：' +
  '1) 给出最可能的根因（1-2 句中文）' +
  '2) 给出具体修复步骤（1-3 步，不要超过 100 字）' +
  '3) 给信心分（0-1 之间的小数）' +
  '请严格按 JSON 返回：{"rootCause":"...","fix":"...","confidence":0.X}';

async function diagnose({ line, recentLines = [], meta = {}, aiConfig, ctx = {} }) {
  logger.info('ai.diagnose', `line=${(line || '').slice(0, 80)}`);
  if (!aiConfig || !aiConfig.token) throw new Error('NO_TOKEN');

  // 限制最近日志长度，避免爆 token
  const tailLines = (recentLines || []).slice(-50).join('\n').slice(0, 4000);
  const userPrompt =
    `【错误】\n${line}\n\n` +
    `【最近 50 行日志】\n${tailLines || '(空)'}\n\n` +
    `【触发上下文】\n${JSON.stringify({ ...ctx, meta }, null, 0).slice(0, 800)}\n\n` +
    '请返回 JSON：{"rootCause":"...","fix":"...","confidence":0.X}';

  const messages = [
    { role: 'system', content: DIAGNOSE_SYSTEM },
    { role: 'user', content: userPrompt },
  ];

  const result = await callLLM({
    baseUrl: aiConfig.baseUrl,
    token: aiConfig.token,
    messages,
    model: aiConfig.model || DEFAULT_MODEL,
    temperature: 0.3,
    maxTokens: 400,
    timeoutMs: 15000,
  });

  let parsed;
  try {
    parsed = JSON.parse(String(result.content || '').trim());
  } catch {
    // 不是 JSON：尝试简单正则提取
    const m = String(result.content || '').match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch {}
    }
  }
  if (!parsed || typeof parsed.rootCause !== 'string') {
    throw new Error('EMPTY_TEXT');
  }

  return {
    rootCause: String(parsed.rootCause || '').slice(0, 200),
    fix: String(parsed.fix || '').slice(0, 300),
    confidence: typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5,
    model: result.model,
    usage: result.usage,
  };
}

module.exports = {
  DEFAULT_MODEL,
  normalizeBaseUrl,
  detectEndpoint,
  callLLM,
  testConnection,
  diagnose,
};