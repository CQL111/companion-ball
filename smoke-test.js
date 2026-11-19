// smoke-test.js - 核心模块单元烟雾测试（S0：角色壳 + AI 对话）
const agent = require('./src/js/agent');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.log('  ✗', msg); }
}

// === agent.js ===
console.log('\n[agent.js]');
assert(typeof agent.SYSTEM_PROMPT === 'string' && agent.SYSTEM_PROMPT.length > 0, '系统提示非空');
assert(agent.SYSTEM_PROMPT.includes('团子猫'), '系统提示是陪伴型角色');
assert(Array.isArray(agent.TOOLS) && agent.TOOLS.length === 0, 'S0 不带工具');
assert(agent.HISTORY_TURNS >= 4, '保留的对话轮数 >= 4');

// parseArgs
assert(JSON.stringify(agent.parseArgs('{"a":1}')) === '{"a":1}', 'parseArgs 解析 JSON');
assert(JSON.stringify(agent.parseArgs('not json')) === '{}', 'parseArgs 非法输入返回空对象');
assert(JSON.stringify(agent.parseArgs(null)) === '{}', 'parseArgs null 返回空对象');

// executeTool
const tr = agent.executeTool('anything', {}, {});
assert(tr.ok === false && tr.error === 'NO_TOOLS', 'S0 没有可执行工具');

// publicHistory
const hist = agent.publicHistory([
  { role: 'system', content: 'x' },
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '嗨' },
  { role: 'tool', content: 'y' },
  { role: 'assistant', content: '' },
]);
assert(hist.length === 2, 'publicHistory 只保留有内容的 user/assistant');
assert(hist[0].role === 'user' && hist[1].role === 'assistant', 'publicHistory 顺序正确');

// trimByUserTurns
const long = [];
for (let i = 0; i < 20; i++) {
  long.push({ role: 'user', content: 'u' + i });
  long.push({ role: 'assistant', content: 'a' + i });
}
const trimmed = agent.trimByUserTurns(long, 8);
assert(trimmed.filter((m) => m.role === 'user').length === 8, '裁到 8 个用户轮');
assert(trimmed[0].content === 'u12', '裁掉最早的用户轮');
assert(agent.trimByUserTurns(long, 50).length === long.length, '未超限不裁剪');

// emptyAgentChat
const empty = agent.emptyAgentChat();
assert(Array.isArray(empty.messages) && empty.messages.length === 0, '空会话结构正确');

// runAgent：假 LLM 直接返回文本
(async () => {
  console.log('\n[runAgent]');
  const calls = [];
  const fakeCallLLM = async (opts) => {
    calls.push(opts);
    return { content: '我在呢。', usage: { total_tokens: 12 } };
  };
  const res = await agent.runAgent({
    history: [],
    userQuery: '你在吗',
    aiConfig: { baseUrl: 'http://x', token: 't', model: 'm' },
    ctx: {},
    callLLM: fakeCallLLM,
  });
  assert(res.text === '我在呢。', '返回模型文本');
  assert(res.usage.total_tokens === 12, '累计 token 用量');
  assert(Array.isArray(res.history) && res.history.length === 2, '历史包含本轮问答');
  assert(calls[0].messages[0].role === 'system', '首条是 system 提示');
  assert(calls[0].messages[1].content === '你在吗', '用户问题进入上下文');

  // 空问题 / 无 token
  let threw = '';
  try { await agent.runAgent({ userQuery: '  ', aiConfig: { token: 't' }, callLLM: fakeCallLLM }); }
  catch (e) { threw = e.message; }
  assert(threw === 'EMPTY_QUERY', '空问题抛 EMPTY_QUERY');

  threw = '';
  try { await agent.runAgent({ userQuery: 'x', aiConfig: { token: '' }, callLLM: fakeCallLLM }); }
  catch (e) { threw = e.message; }
  assert(threw === 'NO_TOKEN', '无 token 抛 NO_TOKEN');

  console.log(`\n总计: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
