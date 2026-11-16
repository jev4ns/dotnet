#!/usr/bin/env node
/**
 * Renders RSS feeds into index.html at build time, so the page shows real
 * content without relying on a client-side script or a third-party proxy.
 *
 * Content is written between marker comments in index.html:
 *   <!-- FEED:ssn:start --> ... <!-- FEED:ssn:end -->
 *   <!-- FEED:blog:start --> ... <!-- FEED:blog:end -->
 *
 * Run:  node scripts/render-feeds.mjs
 * Test against saved files instead of the network:
 *   FEED_SSN_FILE=ssn.xml FEED_BLOG_FILE=blog.xml node scripts/render-feeds.mjs
 *
 * If a feed can't be fetched or parsed, its block is left untouched, so a
 * bad night never blanks the page. Exits 0 either way.
 */
import { readFile, writeFile } from 'node:fs/promises';

const PAGE = new URL('../index.html', import.meta.url);

const FEEDS = {
  ssn: {
    url: 'https://www.southshore.news/feed',
    file: process.env.FEED_SSN_FILE,
    limit: 5,
    render: renderNews,
  },
  blog: {
    url: 'https://evansexplains.substack.com/feed',
    file: process.env.FEED_BLOG_FILE,
    limit: 3,
    render: renderBlog,
    // To show only certain posts, list lowercase keywords here, e.g.
    // ['energy', 'pipeline', 'geothermal']. Matched against the post's
    // Substack tags first, then its title. Empty = show everything.
    filter: [],
  },
};

// ---------- parsing ----------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–',
  hellip: '…', bull: '•', middot: '·',
};

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
}

function toText(s) {
  return decode(
    s.replace(/<!\[CDATA\[|\]\]>/g, '')
     .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function parse(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    title: toText(tag(it, 'title')),
    link: toText(tag(it, 'link')),
    date: new Date(toText(tag(it, 'pubDate'))),
    desc: toText(tag(it, 'description')),
    cats: [...it.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)]
      .map(([, c]) => toText(c).toLowerCase()),
  })).filter(i => i.title && /^https:\/\//.test(i.link) && !isNaN(i.date));
}

// ---------- rendering ----------

const esc = s => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clip = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);

const fmt = d => d.toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
});

function icon(title) {
  const t = title.toLowerCase();
  if (/budget|deficit|finance|override|tax/.test(t)) return '💰';
  if (/school|superintendent|regional agreement/.test(t)) return '🎓';
  if (/trash|water|sewer|road/.test(t)) return '🛠️';
  if (/election|vote/.test(t)) return '🗳️';
  if (/energy|gas|pipeline|geothermal|electric/.test(t)) return '⚡';
  return '📋';
}

function renderNews(items) {
  return items.map(p => `
                <a href="${esc(p.link)}" class="news-item fade-in" target="_blank" rel="noopener">
                    <span class="news-date">${fmt(p.date)}</span>
                    <div class="news-content">
                        <h4>${esc(p.title)}</h4>
                        <p>${esc(clip(p.desc, 110))}</p>
                    </div>
                    <span class="news-source">South Shore News</span>
                </a>`).join('');
}

function renderBlog(items) {
  return items.map(p => `
                <a href="${esc(p.link)}" class="blog-card fade-in" target="_blank" rel="noopener">
                    <div class="blog-card-image">${icon(p.title)}</div>
                    <div class="blog-card-content">
                        <div class="blog-card-meta">
                            <span class="blog-card-category">Evans Explains</span>
                            <span class="blog-card-date">${fmt(p.date)}</span>
                        </div>
                        <h3>${esc(p.title)}</h3>
                        <p>${esc(clip(p.desc, 120))}</p>
                    </div>
                </a>`).join('');
}

// ---------- main ----------

async function load(feed) {
  if (feed.file) return readFile(feed.file, 'utf8');
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'justinevans.net feed renderer' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

let page = await readFile(PAGE, 'utf8');
const before = page;

for (const [name, feed] of Object.entries(FEEDS)) {
  const re = new RegExp(`(<!-- FEED:${name}:start -->)[\\s\\S]*?(\\s*<!-- FEED:${name}:end -->)`);
  if (!re.test(page)) { console.warn(`[${name}] markers not found; skipped`); continue; }
  try {
    let items = parse(await load(feed));
    const kw = feed.filter ?? [];
    if (kw.length) {
      items = items.filter(i =>
        i.cats.some(c => kw.includes(c)) ||
        kw.some(k => i.title.toLowerCase().includes(k)));
    }
    items = items.slice(0, feed.limit);
    if (!items.length) throw new Error('no items after parsing/filtering');
    page = page.replace(re, (_, a, b) => a + feed.render(items) + b);
    console.log(`[${name}] rendered ${items.length} items`);
  } catch (e) {
    console.warn(`[${name}] kept existing content: ${e.message}`);
  }
}

if (page !== before) {
  await writeFile(PAGE, page);
  console.log('index.html updated');
} else {
  console.log('index.html unchanged');
}
