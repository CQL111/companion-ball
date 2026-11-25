// scripts/check-docs.js - 文档一致性门禁
//
// 起因（真实教训）：0.9.4 / 0.9.5 做完后只更新了 CHANGELOG 和 AGENTS，
// ROADMAP 的状态一直停在「下一步 P0.5」——路线图里查不到做了什么。
// 人工检查会漏，所以做成机器检查。
//
// 检查项：
//   1. CHANGELOG.md 最新版本号 == packages/desktop/package.json 的 version
//   2. ROADMAP 里不能出现已知的过期说法
//   3. 每个 CHANGELOG 版本条目都要有内容（不能是「无变更」）
//
// 用法：node scripts/check-docs.js     退出码 0 = 通过

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------- 1. 版本号一致 ----------
const pkg = JSON.parse(read('packages/desktop/package.json'));
const changelog = read('CHANGELOG.md');

const versionRe = /^##\s+\[?(\d+\.\d+\.\d+)\]?/gm;
const versions = [];
let m;
while ((m = versionRe.exec(changelog)) !== null) versions.push(m[1]);

if (!versions.length) {
  problems.push('CHANGELOG.md 里找不到任何版本条目');
} else {
  const latest = versions[0];

  if (latest === pkg.version) {
    notes.push(`CHANGELOG 最新版本 = 桌面端 ${pkg.version}`);
  } else if (semverGt(latest, pkg.version)) {
    // 允许「CHANGELOG 领先于已发布版本」——持续开发时正常，
    // 但每一条超前的条目都必须明确标注「未发布」，否则就是在假装已发布。
    for (const v of versions) {
      if (!semverGt(v, pkg.version)) break;
      const section = sectionOf(changelog, v);
      if (!/未发布/.test(section)) {
        problems.push(
          `CHANGELOG [${v}] 超前于桌面端版本 (${pkg.version})，但标题没标「未发布」——` +
            `要么标未发布，要么运行 npm run release:patch 真正发版。`,
        );
      }
    }
    if (versions.slice(0, versions.indexOf(pkg.version) === -1 ? versions.length : versions.indexOf(pkg.version)).every((v) => /未发布/.test(sectionOf(changelog, v)))) {
      notes.push(`CHANGELOG 领先于已发布版本（0.9.${pkg.version.split('.')[2]}），超前条目均已标「未发布」`);
    }
  } else {
    problems.push(
      `CHANGELOG 最新版本 (${latest}) 低于 packages/desktop/package.json (${pkg.version})——` +
        `已发版但没写变更记录。`,
    );
  }

  // 条目不能为空
  for (const v of versions) {
    const body = sectionOf(changelog, v).replace(/^##[^\n]*\n/, '').trim();
    if (!body || /^无变更$/.test(body)) problems.push(`CHANGELOG [${v}] 条目为空`);
  }
}

/** 取某个版本条目（含标题）的全文 */
function sectionOf(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?`).test(l));
  if (start === -1) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\[?\d+\.\d+\.\d+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

function semverGt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

// ---------- 2. ROADMAP 不能有过期说法 ----------
const roadmap = read('docs/ROADMAP.md');

/** 已知的过期表述：这些阶段都已完成了，ROADMAP 里不该再写着「下一步 / 待定」 */
const STALE_MARKERS = [
  { re: /下一步\s*P0\.5/, msg: 'ROADMAP 仍写着「下一步 P0.5」，但 P0.5 已完成' },
  { re: /下一步\s*P1[^.\d]/, msg: 'ROADMAP 仍写着「下一步 P1」，但 P1 已完成' },
  { re: /\|\s*\*\*P0\.5\*\*[^|]*\|\s*0\.9\.x\s*\|/, msg: 'P0.5 的版本号仍写着 0.9.x' },
];

for (const { re, msg } of STALE_MARKERS) {
  if (re.test(roadmap)) problems.push(msg);
}

// ---------- 3. 每个已完成的阶段要在总表里标 ✅ ----------
const DONE_STAGES = ['P0', 'P0.5', 'P1'];
const tableStart = roadmap.indexOf('## 二、里程碑总表');
if (tableStart >= 0) {
  const tableEnd = roadmap.indexOf('\n## ', tableStart + 10);
  const table = roadmap.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
  for (const stage of DONE_STAGES) {
    const rowRe = new RegExp(`\\|\\s*\\*\\*${stage.replace('.', '\\.')}\\*\\*\\s*\\|[^\\n]*`);
    const row = rowRe.exec(table);
    if (!row) {
      problems.push(`ROADMAP 总表里找不到 ${stage} 这一行`);
      continue;
    }
    if (!row[0].includes('✅') && !row[0].includes('已完成')) {
      notes.push(`${stage} 在总表里未标完成（若刚完成请更新）`);
    }
  }
}

// ---------- 输出 ----------
if (problems.length) {
  console.error('[check-docs] 失败：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

for (const n of notes) console.log(`  · ${n}`);
console.log(`[check-docs] 通过（${versions.length} 个版本条目）`);
process.exit(0);
