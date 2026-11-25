// scripts/publish-r2.js - 把安装包发布到 R2，并维护 latest.json
//
// 为什么不用 GitHub Release：仓库改为私有后 Release 不再对公众可见，
// 安装包改由 R2 托管、站点下载页分发（见 docs/PLATFORM.md 第九、十二节）。
//
// 用法：
//   node scripts/publish-r2.js <version> <distDir> [--dry-run]
//   npm run publish:r2            # 读 packages/desktop 的版本与 dist-public
//
// 产物布局：
//   releases/vX.Y.Z/<安装包与 blockmap 等资产>
//   latest.json                 ← { version, publishedAt, assets: { win|mac: {...} } }
//
// 环境变量见 .env.example（CF_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /
// R2_BUCKET / R2_PUBLIC_BASE_URL）。缺任意一项都会直接退出并提示。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const r2 = require('./r2');

const ROOT = path.resolve(__dirname, '..');
// .env 在仓库根：先加载它，再读 process.env（CI 里直接用环境变量即可）
dotenv.config({ path: path.join(ROOT, '.env') });

const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');

const desktopPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/desktop/package.json'), 'utf8'));
const version = args[0] || desktopPkg.version;
const distDir = path.resolve(ROOT, args[1] || path.join('packages/desktop/dist-public', version));
const tag = `v${version}`;

const ALLOWED = /\.(exe|dmg|zip|blockmap|yml)$/i;

function listAssets() {
  if (!fs.existsSync(distDir)) {
    console.error(`❌ 构建产物目录不存在：${rel(distDir)}`);
    console.error('   先执行 npm run build:public（或 npm run release:patch 的构建步骤）。');
    process.exit(1);
  }
  return fs
    .readdirSync(distDir)
    .filter((f) => ALLOWED.test(f))
    .sort();
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 从资产名推断平台与「主安装包」 */
function classify(name) {
  if (!/\.(exe|dmg|zip)$/i.test(name)) return null;
  if (/unpacked|blockmap/i.test(name)) return null;
  const isMac = /\.dmg$/i.test(name);
  return {
    platform: isMac ? 'mac' : 'win',
    arch: /arm64/i.test(name) ? 'arm64' : /x64/i.test(name) ? 'x64' : 'universal',
    name,
  };
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function human(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function readLatest(cfg) {
  if (!cfg.publicBaseUrl) return null;
  try {
    const res = await fetch(`${cfg.publicBaseUrl}/latest.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  let cfg;
  try {
    cfg = r2.readConfig();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const names = listAssets();
  if (!names.length) {
    console.error(`❌ ${rel(distDir)} 里没有可发布的安装包（找不到 .exe/.dmg/.zip）`);
    process.exit(1);
  }

  const entries = names
    .map((name) => {
      const buf = fs.readFileSync(path.join(distDir, name));
      return { name, buf, sha256: sha256(buf), kind: classify(name) };
    })
    .filter(Boolean);

  console.log(`\n📦 发布 ${tag} 到 R2 桶 "${cfg.bucket}"（${entries.length} 个文件）`);
  if (dryRun) console.log('   --dry-run：只打印计划，不实际写入\n');

  const uploaded = [];
  for (const e of entries) {
    const key = `releases/${tag}/${e.name}`;
    const url = r2.publicUrl(cfg, key);
    if (dryRun) {
      console.log(`   [dry] PUT ${key}  ${human(e.buf.length)}`);
      // dry-run 也要把条目算进 manifest，否则看不到「将会发布什么」
      uploaded.push({ ...e, key, url });
    } else {
      try {
        const res = await r2.uploadFile(cfg, key, path.join(distDir, e.name));
        console.log(`   ⬆️  ${e.name}  ${human(res.bytes)}`);
      } catch (err) {
        console.error(`\n❌ ${err.message}`);
        process.exit(1);
      }
      // 幂等校验：HEAD 确认对象存在
      const head = await r2.headObject(cfg, key);
      if (!head) {
        console.error(`❌ 上传后校验失败：${key} 不存在`);
        process.exit(1);
      }
      uploaded.push({ ...e, key, url });
    }
  }

  // latest.json：只覆盖「主安装包」，历史版本保留在 releases/ 下
  const prev = await readLatest(cfg);
  const assets = { ...(prev && prev.assets ? prev.assets : {}) };
  for (const u of uploaded) {
    if (!u.kind) continue;
    assets[u.kind.platform] = {
      name: u.name,
      url: u.url,
      sha256: u.sha256,
      bytes: u.buf.length,
      releasedAt: new Date().toISOString(),
    };
  }
  const manifest = {
    version,
    tag,
    publishedAt: new Date().toISOString(),
    assets,
  };

  const manifestKey = 'latest.json';
  if (dryRun) {
    console.log('\n   [dry] PUT latest.json');
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    await r2.uploadBuffer(cfg, manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)));
    console.log(`\n   ⬆️  latest.json（version=${version}）`);
    const check = await r2.headObject(cfg, manifestKey);
    if (!check) {
      console.error('❌ latest.json 校验失败');
      process.exit(1);
    }
    const url = r2.publicUrl(cfg, manifestKey);
    console.log(`\n✅ 发布完成：${url || '(未配置 R2_PUBLIC_BASE_URL，无法给出公开地址)'}`);
    if (!cfg.publicBaseUrl) {
      console.log('   提示：在 .env 配置 R2_PUBLIC_BASE_URL 后，下载页才能拿到可点击地址。');
    }
  }
}

main().catch((e) => {
  console.error(`❌ 发布失败：${e?.message || e}`);
  process.exit(1);
});
