// scripts/publish-github.js - 把构建产物上传到 GitHub Release（幂等）
// 用法：node scripts/publish-github.js <version> <distDir>
//
// 为什么不用 electron-builder --publish always：
// 它会在多个产物并发生成时重复 POST 创建 Release（同名 tag），并且部分失败时会留下
// 只传了一半资产的 Release。这里改为：
//   1. 构建用 --publish never（本地产物完整）
//   2. 本脚本按 tag 查找/创建 Release，逐个上传资产，已存在同名资产先删再传
//   3. 上传后校验资产是否齐全，不全则退出码 1
// Release notes 取 CHANGELOG 中该版本的段落。
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const distDir = path.resolve(ROOT, process.argv[3] || `dist-public/${version}`);
const tag = `v${version}`;

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('❌ 缺少 GH_TOKEN（.env 或环境变量）。无法上传 Release。');
  process.exit(1);
}
const OWNER = 'CQL111';
const REPO = 'companion-ball';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const HEADERS = {
  Authorization: `Bearer ${token}`,
  'User-Agent': 'companion-ball-release',
  'X-GitHub-Api-Version': '2022-11-28',
};

function readNotes() {
  // 按行扫描：找到以 "## " 开头的版本标题，取其后的正文直到下一个 "## " 标题。
  // 不用跨行正则的 lookahead（在 JS 多行模式下容易误判为空）。
  const lines = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
  const header = new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?`);
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return '';
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

async function api(pathname, init = {}) {
  const res = await fetch(API + pathname, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
}

async function ensureRelease() {
  const find = await api(`/releases/tags/${tag}`);
  if (find.status === 200) {
    console.log(`📎 复用已有 Release ${tag}`);
    return find.json;
  }
  const body = `## ${tag}\n\n${readNotes()}\n`;
  const created = await api('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: version, body, draft: false, prerelease: false }),
  });
  if (created.status !== 201) {
    throw new Error(`创建 Release 失败 HTTP ${created.status}: ${created.text.slice(0, 200)}`);
  }
  console.log(`🆕 创建 Release ${tag}`);
  return created.json;
}

async function uploadAsset(release, name) {
  const file = path.join(distDir, name);
  if (!fs.existsSync(file)) return { name, ok: false, reason: '本地缺少文件' };
  // 同名资产先删再传，保证幂等
  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing) await api(`/releases/assets/${existing.id}`, { method: 'DELETE' });
  const size = fs.statSync(file).size;
  const res = await fetch(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: fs.readFileSync(file),
  });
  const text = await res.text();
  if (res.status !== 201) return { name, ok: false, reason: `HTTP ${res.status} ${text.slice(0, 160)}` };
  console.log(`⬆️  ${name} (${(size / 1048576).toFixed(1)} MB)`);
  return { name, ok: true };
}

async function main() {
  if (!fs.existsSync(distDir)) {
    console.error(`❌ 构建产物目录不存在：${distDir}`);
    process.exit(1);
  }
  const release = await ensureRelease();

  // 需要上传的资产：安装包、blockmap、latest.yml（如果存在）
  const wanted = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith('.exe') || f.endsWith('.blockmap') || f === 'latest.yml' || f === 'latest-mac.yml')
    .sort();

  const results = [];
  for (const name of wanted) results.push(await uploadAsset(release, name));

  // 校验：为每个 wanted 资产确认远端存在
  const fresh = await api(`/releases/tags/${tag}`);
  const remote = new Set((fresh.json?.assets || []).map((a) => a.name));
  const missing = wanted.filter((n) => !remote.has(n));
  const bad = results.filter((r) => !r.ok);

  console.log('\n📋 校验:');
  for (const name of wanted) console.log(`   ${remote.has(name) ? '✓' : '✗'} ${name}`);
  for (const b of bad) console.log(`   ✗ ${b.name}: ${b.reason}`);

  if (missing.length) {
    console.error(`\n❌ 资产不完整，缺少：${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`\n✅ Release 完成：https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
}

main().catch((e) => {
  console.error('❌ 发布失败：' + (e?.message || e));
  process.exit(1);
});
