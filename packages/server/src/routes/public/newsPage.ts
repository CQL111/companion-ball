// routes/public/newsPage.ts - /news 与 /news/:id 的服务端渲染
//
// 为什么只有这两条走服务端渲染：
//   新闻是唯一有 SEO 价值的入口（标题 / 摘要 / OG 标签）。
//   橱窗全程 noindex，静态页就够了（WINDOW 4.3）。

import type { ServerConfig } from '../../handler'
import { isOff } from '../../handler'
import { html } from '../../http/respond'
import * as news from '../../repo/news'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(opts: { title: string; description: string; body: string; canonical?: string }): string {
  const t = escapeHtml(opts.title)
  const d = escapeHtml(opts.description)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${t} · 团子猫</title>
<meta name="description" content="${d}" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${d}" />
<meta property="og:type" content="article" />
${opts.canonical ? `<link rel="canonical" href="${escapeHtml(opts.canonical)}" />` : ''}
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<header class="top">
  <a class="mark" href="/">团子猫</a>
  <nav><a href="/gallery">看海</a><a href="/news">海上的消息</a><a href="/download">下载</a></nav>
</header>
<main class="wrap">
${opts.body}
  <footer class="foot">
    <span>每天最多一条</span>
    <span><a href="/privacy">隐私</a> · <a href="/terms">协议</a></span>
  </footer>
</main>
</body>
</html>`
}

export async function renderList(cfg: ServerConfig, now: number): Promise<Response> {
  if (await isOff('NEWS_OFF', cfg)) {
    return html(page({ title: '海上的消息', description: '官方编辑，每天最多一条。', body: '<h1>海上的消息</h1><p class="empty">暂时没有消息。</p>' }))
  }
  await news.publishDue(cfg.db, now).catch(() => 0)
  const rows = await news.listPublished(cfg.db, { limit: 30 })
  const list = rows.length
    ? rows
        .map(
          (n) => `<article class="news-item">
  <h3><a href="/news/${encodeURIComponent(n.id)}">${escapeHtml(n.title)}</a></h3>
  <p class="summary">${escapeHtml(n.summary)}</p>
  ${n.source_name ? `<p class="src">来源：${escapeHtml(n.source_name)}</p>` : ''}
</article>`,
        )
        .join('\n')
    : '<p class="empty">还没有消息。<br>不是每天都必须有。</p>'

  return html(
    page({
      title: '海上的消息',
      description: '官方编辑，每天最多一条。会进你的笔记本。',
      canonical: `${cfg.siteOrigin || ''}/news`,
      body: `<span class="kicker">消息</span>
<h1>海上的消息</h1>
<p class="lead">官方编辑写的。每天最多一条，会进你的笔记本——所以不制造焦虑，也不摆出全世界的坏消息。</p>
<section style="margin-top:34px">${list}</section>`,
    }),
  )
}

export async function renderDetail(cfg: ServerConfig, id: string, now: number): Promise<Response> {
  if (await isOff('NEWS_OFF', cfg)) {
    return html(page({ title: '海上的消息', description: '暂时没有消息。', body: '<p class="empty">暂时没有消息。</p>' }), 503)
  }
  const n = await news.findPublishedById(cfg.db, id)
  if (!n) {
    return html(
      page({ title: '找不到这条', description: '这一页可能已经被收起来了。', body: '<h1>找不到这条</h1><p class="empty"><a href="/news">回消息列表 →</a></p>' }),
      404,
    )
  }
  const date = new Date(n.publish_at ?? n.created_at).toISOString().slice(0, 10)
  return html(
    page({
      title: n.title,
      description: n.summary,
      canonical: `${cfg.siteOrigin || ''}/news/${n.id}`,
      body: `<span class="kicker">${escapeHtml(date)}</span>
<h1>${escapeHtml(n.title)}</h1>
<p class="lead">${escapeHtml(n.summary)}</p>
<div class="news-body" style="margin-top:26px">${escapeHtml(n.body)}</div>
${n.source_name ? `<p class="src" style="margin-top:22px;font-size:12px;color:var(--ink-3)">来源：${escapeHtml(n.source_name)}</p>` : ''}
<p style="margin-top:32px"><a href="/news" style="font-size:13px">← 回消息列表</a></p>`,
    }),
  )
}
