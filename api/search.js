// Vercel serverless function: free, keyless web + news + academic search used by
// Rohil's web_search / news_search / research_search tools. Returns real content
// (Wikipedia intro, Bing/DuckDuckGo summaries, live dated news from Google News
// RSS, and peer-reviewed paper abstracts from Semantic Scholar/arXiv, plus a
// grounding extract from the top article via r.jina.ai) so the model can answer
// accurately and cite real, click-able source URLs.
//
// All independent fetches run in parallel and use short timeouts so the whole
// thing reliably finishes under Vercel's ~10s function limit.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const NEWS_FEED = 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
const NEWS_SEARCH = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=';
const JINA = 'https://r.jina.ai/';
// Optional: Google Programmable Search. Credentials come from Vercel env vars
// (never committed). Empty = Google results are silently skipped.
const GOOGLE_API_KEY = (typeof process !== 'undefined' && process.env && process.env.GOOGLE_API_KEY) ? process.env.GOOGLE_API_KEY : '';
const GSE_CX = (typeof process !== 'undefined' && process.env && process.env.GSE_CX) ? process.env.GSE_CX : '';

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function shortDate(o) {
  try {
    const d = new Date(String(o).trim());
    if (isNaN(d)) return '';
    const diff = Date.now() - d.getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 60) return mins <= 1 ? 'just now' : mins + 'm ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  } catch (_) { return ''; }
}

// Race a fetch promise against a timeout; resolves '' on timeout/error.
async function withTimeout(promise, ms) {
  return Promise.race([
    promise.then((v) => v).catch(() => ''),
    new Promise((resolve) => setTimeout(() => resolve(''), ms))
  ]);
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return '';
    return await r.text();
  } catch (_) { return ''; }
}

function addSection(prefix, lines) {
  if (!lines || !lines.length) return [];
  return [prefix].concat(lines);
}

async function wikipedia(q) {
  const lines = [];
  const urls = [];
  try {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
      encodeURIComponent(q) + '&format=json&srlimit=4&origin=*';
    const j = JSON.parse(await withTimeout(fetchText(url), 5000) || '{}');
    const hits = (j && j.query && j.query.search) || [];
    for (const h of hits.slice(0, 4)) {
      lines.push('- ' + h.title + ': ' + stripTags(h.snippet));
      urls.push('https://en.wikipedia.org/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')));
    }
    if (hits.length) {
      const title = hits[0].title;
      const sj = JSON.parse(await withTimeout(
        fetchText('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title)),
        5000
      ) || '{}');
      const intro = stripTags(sj.extract || '');
      if (intro.length > 80) {
        lines.push('\n[TOP ARTICLE: ' + (sj.title || title) + ']');
        lines.push(intro.slice(0, 1400));
        urls.push('https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')));
      }
    }
  } catch (_) {}
  return { lines, urls };
}

async function bing(q) {
  const lines = [];
  const urls = [];
  try {
    const html = await withTimeout(
      fetchText('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&ensearch=11'),
      6500
    );
    const re = /class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
    let m;
    let count = 0;
    while ((m = re.exec(html)) && count < 8) {
      const block = m[1];
      const hm = block.match(/href="(https?:\/\/[^"]+)"/);
      const tm = block.match(/<h2[^>]*>(.*?)<\/h2>/i);
      const pm = block.match(/<p[^>]*>(.*?)<\/p>/i);
      if (hm) {
        const href = cleanUrl(hm[1]);
        if (href) {
          const title = stripTags(tm ? tm[1] : '');
          const snip = stripTags(pm ? pm[1] : '');
          lines.push('- ' + (title || 'Web result') + (snip ? ' - ' + snip.slice(0, 200) : '') + ' - ' + href);
          urls.push(href);
          count++;
        }
      }
    }
  } catch (_) {}
  return { lines, urls };
}

function cleanUrl(u) {
  if (u.indexOf('bing.com/ck/a') !== -1) return '';
  return u;
}

async function duckduckgoLite(q) {
  const lines = [];
  try {
    const txt = await withTimeout(
      fetchText('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q)),
      6000
    );
    const re = /<tr class="result">([\s\S]*?)<\/tr>/g;
    let m;
    let count = 0;
    while ((m = re.exec(txt)) && count < 8) {
      const text = stripTags(m[1]).replace(/^(\s*-?\s*)/, '');
      const parts = text.match(/^([^:]*[.:])\s+(.+)$/);
      if (parts) {
        lines.push('- ' + parts[1] + ' ' + parts[2].slice(0, 240));
        count++;
      }
    }
  } catch (_) {}
  return { lines, urls: [] };
}

// Optional Google Programmable Search (requires GOOGLE_API_KEY + GSE_CX env).
// Falls back silently when credentials are missing.
async function googleSearch(q) {
  const lines = [];
  const urls = [];
  if (!GOOGLE_API_KEY || !GSE_CX) return { lines, urls };
  try {
    const endpoint = 'https://www.googleapis.com/customsearch/v1?key=' + GOOGLE_API_KEY +
      '&cx=' + GSE_CX + '&num=8&q=' + encodeURIComponent(q);
    const j = JSON.parse(await withTimeout(fetchText(endpoint), 6500) || '{}');
    const items = (j && j.items) || [];
    for (const it of items.slice(0, 8)) {
      const title = stripTags(it.title || '');
      const link = it.link || '';
      const snip = stripTags(it.snippet || '');
      if (!link) continue;
      lines.push('- ' + title + (snip ? ' - ' + snip.slice(0, 200) : '') + ' - ' + link);
      urls.push(link);
    }
  } catch (_) {}
  return { lines, urls };
}

// Real-content grounder: fetch the readable article text for a top link.
async function reader(url) {
  return withTimeout(fetchText(JINA + encodeURI(url)), 2800)
    .then((t) => {
      const cleaned = stripTags(t).slice(0, 600);
      if (!cleaned || cleaned.length < 20) return '';
      return '\n[GROUNDING from ' + url + ']: ' + cleaned;
    })
    .catch(() => '');
}

// Live news headlines from Google News RSS (no API key needed). Lines are
// "[ago] headline (source) - url".
async function googleNews(q) {
  const lines = [];
  const urls = [];
  try {
    const feedUrl = q ? NEWS_SEARCH + encodeURIComponent(q) : NEWS_FEED;
    const xml = await withTimeout(fetchText(feedUrl), 6000);
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    let count = 0;
    while ((m = itemRe.exec(xml)) && count < 10) {
      const block = m[1];
      const grab = (t) => {
        const mm = block.match(new RegExp('<' + t + '>([\\s\\S]*?)<\\/' + t + '>'));
        return mm ? stripTags(mm[1]) : '';
      };
      const title = grab('title');
      const pub = grab('pubDate');
      const source = grab('source');
      const href = (block.match(/<link>([\s\\S]*?)<\/link>/) || [])[1] || '';
      if (!title) continue;
      const head = (title.split(' - ')[0] || title).slice(0, 140).trim();
      lines.push('- ' + (shortDate(pub) ? '[' + shortDate(pub) + '] ' : '') + head +
        (source ? ' (' + source.split(' -')[0].trim() + ')' : '') +
        (href ? ' - ' + href.trim() : ''));
      if (href) urls.push(href.trim());
      count++;
    }
  } catch (_) {}
  return { lines, urls };
}

// Peer-reviewed papers from Semantic Scholar (PubMed/arXiv/DOI index). No key.
async function semanticScholar(q) {
  const lines = [];
  const urls = [];
  try {
    const fields = 'title,abstract,year,venue,authors,externalIds,url';
    const endpoint = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' +
      encodeURIComponent(q) + '&limit=8&fields=' + fields;
    const j = JSON.parse(await withTimeout(fetchText(endpoint), 6500) || '{}');
    const papers = (j && j.data) || [];
    for (const p of papers.slice(0, 8)) {
      const title = stripTags(p.title || '');
      const abs = stripTags(p.abstract || '');
      const yr = p.year ? String(p.year) : '';
      const venue = stripTags(String(p.venue || ''));
      let link = p.url || '';
      const ids = p.externalIds || {};
      if (!link && ids.ArXiv) link = 'https://arxiv.org/abs/' + ids.ArXiv;
      else if (!link && ids.DOI) link = 'https://doi.org/' + ids.DOI;
      if (!title) continue;
      let out = '- ' + (yr ? yr + ' ' : '') + title + (venue ? ' [' + venue + ']' : '');
      if (abs) out += ' \u2014 ' + abs.slice(0, 200);
      if (link) out += ' - ' + link;
      lines.push(out);
      if (link) urls.push(link);
    }
  } catch (_) {}
  return { lines, urls };
}

// arXiv preprints (cs, quantitative biology incl. psychology). No key.
async function arxiv(q) {
  const lines = [];
  const urls = [];
  try {
    const txt = await withTimeout(
      fetchText('http://export.arxiv.org/api/query?search_query=all:' + encodeURIComponent(q) + '&max-results=6'),
      6500
    );
    const e = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    let count = 0;
    while ((m = e.exec(txt)) && count < 6) {
      const b = m[1];
      const title = stripTags((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      const link = String((b.match(/<id>([\s\S]*?)<\/id>/) || [])[1]).trim();
      const sum = stripTags((b.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]);
      if (!title) continue;
      lines.push('- ' + title + (sum ? ' \u2014 ' + sum.slice(0, 200) : '') + (link ? ' - ' + link : ''));
      if (link) urls.push(link);
      count++;
    }
  } catch (_) {}
  return { lines, urls };
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const q = String(url.searchParams.get('q') || '').trim();
  const type = String(url.searchParams.get('type') || 'web').trim();
  if (!q && type !== 'news' && type !== 'research') {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing q' }));
  }

  let parts = [];
  let urls = [];
  let maxChars = 5000;

  if (type === 'news') {
    const [top, rel] = await Promise.all([googleNews(''), googleNews(q)]);
    const seen = new Set();
    const add = (arr) => {
      for (const l of arr.lines) {
        const key = l.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(l);
      }
    };
    add(top);
    parts.push('\nNews matching "' + q + '":');
    add(rel);
    urls = top.urls.concat(rel.urls);
  } else if (type === 'research') {
    const [sch, ar, wiki] = await Promise.all([
      semanticScholar(q), arxiv(q), wikipedia(q)
    ]);
    if (sch.lines.length) { parts.push('Peer-reviewed papers:'); parts.push(...sch.lines); }
    if (ar.lines.length) { parts.push('\narXiv preprints:'); parts.push(...ar.lines); }
    if (wiki.lines.length) { parts.push('\nWikipedia:'); parts.push(...wiki.lines); }
    urls = sch.urls.concat(ar.urls);
    maxChars = 6000;
   } else {
    const [wp, bg, ddg, ggl] = await Promise.all([
      wikipedia(q), bing(q), duckduckgoLite(q), googleSearch(q)
    ]);
    parts.push('Wikipedia results for "' + q + '":');
    parts.push(...wp.lines);
    if (bg.lines.length) { parts.push('\nBing results:'); parts.push(...bg.lines); }
    if (ddg.lines.length) { parts.push('\nDuckDuckGo results:'); parts.push(...ddg.lines); }
    if (ggl.lines.length) { parts.push('\nGoogle results:'); parts.push(...ggl.lines); }
    urls = wp.urls.concat(bg.urls, ggl.urls);
  }

  // Best-effort: ground the answer by reading the actual top article.
  const ground = await Promise.all(urls.slice(0, 2).map((u) => reader(u)));
  for (const g of ground) if (g) parts.push(g);

  let content = (parts.join('\n').slice(0, maxChars)) || 'No results found for "' + q + '".';

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'private, max-age=90');
  return res.end(JSON.stringify({ content }));
}