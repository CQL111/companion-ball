// build-site.cjs - 把 public/ 组装成 Cloudflare Pages 产物 dist/
//
// 为什么不用 Astro：站点只有一页静态 HTML，引入框架只增加失败点。
// Pages 需要的是「一个装着 index.html 的目录」+ 可选 _routes.json + functions/。
//
// 用法：npm run build -w @companion/web
const fs = require('fs');
const path = require('path');

const PKG = __dirname;
const SRC = path.join(PKG, 'public');
const OUT = path.join(PKG, 'dist');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 静态文件
for (const name of fs.readdirSync(SRC)) {
  fs.cpSync(path.join(SRC, name), path.join(OUT, name), { recursive: true });
}

// Pages 路由：页面与接口都交给 Functions 兜底匹配，静态资源优先
// 见 https://developers.cloudflare.com/pages/functions/routing/
const routes = { version: 1, include: ['/*'], exclude: [] };
fs.writeFileSync(path.join(OUT, '_routes.json'), JSON.stringify(routes, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const files = fs.readdirSync(OUT);
console.log(`✅ dist/ 已生成：${files.join(', ')}`);
console.log('   部署：npx wrangler pages deploy dist --project-name <项目名>');
