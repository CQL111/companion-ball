// check-core-boundary.js - 守护 src/core/ 的零平台依赖
// core 必须能在纯 node 下跑（单测 + 将来的手机端复用），所以禁止：
//   - require Electron / Node 内置（fs / path / os / child_process / electron）
//   - 浏览器全局（window / document / navigator）
//   - 平台判断（process.platform）
// 用法：node scripts/check-core-boundary.js        退出码 0 = 通过
//       node scripts/check-core-boundary.js --fix  列出建议

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'src', 'core');
// src/data/ 是纯 JSON 内容资产（台词、人格卡），零依赖，允许 core 只读引用
const DATA_DIR = path.join(ROOT, 'src', 'data');

// 禁止的 require：Electron 与 Node 平台模块
const FORBIDDEN_MODULES = [
  'electron',
  'fs', 'fs/promises',
  'path',
  'os',
  'child_process',
  'net',
  'http', 'https',
  'crypto', // 允许时改成白名单
  'electron-store',
];

// 禁止的全局
const FORBIDDEN_GLOBALS = [
  { re: /\bwindow\s*\./, msg: 'window（浏览器全局）' },
  { re: /\bdocument\s*\./, msg: 'document（浏览器全局）' },
  { re: /\bnavigator\s*\./, msg: 'navigator（浏览器全局）' },
  { re: /\bprocess\.platform\b/, msg: 'process.platform（平台判断）' },
  { re: /\b__dirname\b/, msg: '__dirname（路径依赖）' },
  { re: /\b__filename\b/, msg: '__filename（路径依赖）' },
];

// 允许例外：整行注释 / 行尾注释不影响；字符串里的 require 也不小心会命中，
// 但 core 里不应出现这些字符串，所以不做特殊豁免。
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g
// ESM：import x from 'mod' / import 'mod' / export * from 'mod' / import('mod')
const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...listJsFiles(full));
    else if (/\.(js|mjs|cjs|ts|mts|cts)$/.test(name)) out.push(full);
  }
  return out;
}

function stripCommentsAndStrings(src) {
  // 粗略剥离注释和字符串：足够避免把注释里的说明当成违规。
  // 不用完整解析器，保持零依赖。
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function checkFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const problems = [];

  const reportModule = (rawMod, index, kind) => {
    const mod = rawMod.replace(/^node:/, '');
    if (mod.startsWith('.')) {
      // 相对路径视为 core 内部依赖，但不得跳出 core/
      const resolved = path.resolve(path.dirname(file), mod);
      const inCore = resolved.startsWith(CORE_DIR + path.sep) || resolved === CORE_DIR;
      const inData = resolved.startsWith(DATA_DIR + path.sep) && resolved.endsWith('.json');
      if (!inCore && !inData) {
        const line = src.slice(0, index).split('\n').length;
        problems.push({ line, msg: `${kind} 跳出 core：${mod}` });
      }
      return;
    }
    if (FORBIDDEN_MODULES.includes(mod)) {
      const line = src.slice(0, index).split('\n').length;
      problems.push({ line, msg: `禁止的模块：${mod}` });
    }
  };

  for (const [re, kind] of [
    [REQUIRE_RE, 'require'],
    [IMPORT_RE, 'import'],
    [DYNAMIC_IMPORT_RE, 'import()'],
  ]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) reportModule(m[1], m.index, kind);
  }

  // 全局检查：先剥注释与字符串，避免误报
  const code = stripCommentsAndStrings(src);
  for (const { re, msg } of FORBIDDEN_GLOBALS) {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) problems.push({ line: i + 1, msg });
    }
  }

  return problems;
}

function main() {
  const files = listJsFiles(CORE_DIR);

  if (files.length === 0) {
    console.log('[check-core] src/core/ 还没有文件——S1 建立后再守护。跳过。');
    return 0;
  }

  let total = 0;
  for (const file of files) {
    const problems = checkFile(file);
    if (problems.length === 0) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    for (const p of problems) {
      total++;
      console.error(`  ✗ ${rel}:${p.line}  ${p.msg}`);
    }
  }

  if (total === 0) {
    console.log(`[check-core] 通过：${files.length} 个 core 文件均无平台依赖`);
    return 0;
  }
  console.error(`[check-core] 失败：${total} 处违规。core 必须零平台依赖（见 docs/ROADMAP.md 第六节）。`);
  return 1;
}

process.exit(main());
