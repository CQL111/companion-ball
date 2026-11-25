// 旧版一键发布脚本（保留备查，不在 package.json 中注册；正式发版走根 scripts/release.js）
// 2026-11-25 monorepo 后：GH_TOKEN 从仓库根 .env 读取。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

if (!process.env.GH_TOKEN) {
  console.error('❌ 缺少 GH_TOKEN（仓库根 .env）');
  process.exit(1);
}

console.log('🔑 GH_TOKEN:', `${process.env.GH_TOKEN.substring(0, 8)}...`);
console.log('🚀 开始构建并发布 (publish=always)...');

const withKey = fs.existsSync(path.join(__dirname, '..', 'bundled-ai.json'));
const cfgArg = withKey ? ' --config electron-builder.key.yml' : '';
execSync('electron-builder --win --publish always' + cfgArg, {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, DEBUG: 'electron-builder' },
});
