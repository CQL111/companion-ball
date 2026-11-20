// scripts/release.js - 发布流程（带门禁）
// 一次发布 = 版本号 + CHANGELOG 条目 + 功能测试 + 类型检查 + tag + GitHub Release
//
// 用法：
//   npm run release:patch|minor|major   # 升版本 → 门禁 → 提交打 tag → 构建 → 发布
//   npm run release                     # 用 package.json 现有版本（tag 不能已存在）
//
// 门禁（任何一项失败都会中止，不会推送到远程）：
//   1. git 工作区干净（未提交改动不允许进入版本）
//   2. CHANGELOG.md 有对应版本的条目，且不是「无变更」
//   3. npm test（Vitest + core 边界）
//   4. npm run typecheck
//   5. npm run build（electron-vite 构建成功）
//   6. node tests/e2e/smoke.mjs（真实启动应用的功能测试）
//
// 之后：git tag vX.Y.Z → push → 构建并发布 **公开版** → GitHub Release
// Release notes 取 CHANGELOG 中该版本的段落。
//
// ⚠️ 安全边界：内置 Key 版（electron-builder.key.yml）**永远不发布到 GitHub**。
// 它把 .env 里的真实 Key 打进安装包，一旦公开上传，任何人都能解包取出并消耗你的额度。
// 需要内置 Key 版时在本机执行 `npm run build:key`，产物只留在 out-release-key/。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');
const arg = process.argv[2];
const validTypes = ['patch', 'minor', 'major'];

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, env: { ...process.env }, ...opts });
}
function capture(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}
function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
}

// ---------- 1. 工作区必须干净 ----------
const dirty = capture('git status --porcelain');
if (dirty) {
  console.error(dirty);
  fail('工作区有未提交的改动。请先提交（变更 + CHANGELOG 一起），再发版。');
}

// ---------- 2. 升版本 ----------
if (arg && validTypes.includes(arg)) {
  console.log(`⬆️ 升级版本 (${arg})...`);
  run(`npm version ${arg} --no-git-tag-version`, { stdio: 'ignore' });
} else if (arg) {
  fail(`未知的版本类型 "${arg}"，可用：${validTypes.join(' / ')}`);
}

const version = readVersion();
const tagName = `v${version}`;

// tag 已存在 → 中止（除非是重跑同一次发布，由用户显式处理）
try {
  execSync(`git rev-parse ${tagName}`, { stdio: 'ignore', cwd: ROOT });
  fail(`Tag ${tagName} 已存在。请升级版本，或先手动删除旧 tag。`);
} catch {
  /* 不存在 = 正常 */
}

// ---------- 3. CHANGELOG 条目 ----------
console.log(`\n📝 检查 CHANGELOG 中 ${tagName} 的条目...`);
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
const sectionRe = new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?.*$`, 'm');
const m = sectionRe.exec(changelog);
if (!m) {
  fail(`CHANGELOG.md 缺少 "${version}" 的条目。请先补写变更记录（这就是文档记录门禁）。`);
}
const startIdx = m.index + m[0].length;
const nextIdx = changelog.indexOf('\n## ', startIdx);
const section = changelog.slice(startIdx, nextIdx === -1 ? undefined : nextIdx).trim();
if (!section || /^无变更\s*$/.test(section)) {
  fail(`CHANGELOG.md 的 "${version}" 条目为空。`);
}

// ---------- 4~6. 测试与构建门禁 ----------
console.log('\n🧪 运行单元测试与边界检查...');
run('npm test');

console.log('\n🔍 类型检查...');
run('npm run typecheck');

console.log('\n📦 构建...');
run('npm run build');

console.log('\n🧭 功能测试（真实启动应用）...');
run('node tests/e2e/smoke.mjs');

// ---------- 7. 提交 + tag + push ----------
console.log('\n🏷️ 提交版本变更并打 tag...');
run('git add -A');
try {
  execSync(`git commit -m "chore(release): ${tagName}"`, { stdio: 'ignore', cwd: ROOT });
} catch {
  /* 无变更（仅版本号变化时 npm version 已写入） */
}
run(`git tag -a ${tagName} -m "release ${tagName}"`);

console.log('\n📤 推送到远程...');
run('git push origin HEAD --follow-tags');

// ---------- 8. 构建安装包并发布 ----------
const notesFile = path.join(ROOT, '.release-notes.md');
fs.writeFileSync(notesFile, `# ${tagName}\n\n${section}\n`, 'utf8');

try {
  console.log('\n🚀 构建公开版并发布...');
  run('electron-builder --win --publish always --config electron-builder.public.yml');

  // 内置 Key 版只在本地构建，绝不发布到 GitHub（见文件头部的安全边界说明）
  if (fs.existsSync(path.join(ROOT, 'bundled-ai.json'))) {
    console.log('\n🔒 检测到 bundled-ai.json：内置 Key 版不随 Release 发布');
    console.log('   需要个人版安装包时，在本机执行：npm run build:key');
  }

  console.log('\n📄 写入 Release notes（来自 CHANGELOG）...');
  try {
    run(`gh release edit ${tagName} --notes-file .release-notes.md`, { stdio: 'ignore' });
    console.log('   ✅ Release notes 已更新');
  } catch {
    console.log('   ⚠️ gh CLI 不可用，跳过 notes 更新（可手动粘贴 CHANGELOG 片段）');
  }
} finally {
  try {
    fs.unlinkSync(notesFile);
  } catch {
    /* ignore */
  }
}

console.log('\n✅ 发布完成：');
console.log(`   https://github.com/CQL111/companion-ball/releases/tag/${tagName}`);
