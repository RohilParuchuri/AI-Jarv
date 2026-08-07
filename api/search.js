// Vercel serverless function: free, keyless web + news search used by Rohil's
// web_search and news_search tools. Returns real content (Wikipedia intro,
// Bing + DuckDuckGo result summaries, live dated news headlines, and a ground-
// ing extract from the top article) so the model can answer accurately and
// cite real, click-able source URLs. Classic (req, res) handler - see
// api/chat.js for why.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const NEWS_FEED = 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
const NEWS_SEARCH = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=';
const JINA = 'https://r.jina.ai/';

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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(''), ms))
  ]);
}

async function fetchText(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { 'user-agent': UA } }, opts || {}));
  if (!r.ok) return '';
  return await r.text();
}

async function wikipedia(q) {
  const lines = [];
  const urls = [];
  try {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
      encodeURIComponent(q) + '&format=json&srlimit=4&origin=*';
    const j = JSON.parse(await withTimeout(fetchText(url), 6000) || '{}');
    const hits = (j && j.query && j.query.search) || [];
    for (const h of hits.slice(0, 4)) {
      lines.push('- ' + h.title + ': ' + stripTags(h.snippet));
      urls.push('https://en.wikipedia.org/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')));
    }
    if (hits.length) {
      const title = hits[0].title;
      const sj = JSON.parse(await withTimeout(
        fetchText('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title)),
        6000
      ) || '{}');
      const intro = stripTags(sj.extract || '');
      if (intro.length > 80) {
        lines.push('\n[TOP ARTICLE: ' + (sj.title || title) + ']');
        lines.push(intro.slice(0, 1600));
        urls.push('https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')));
      }
    }
  } catch (_) {}
  return { lines, urls };
}

// Bing HTML scrape - more robust current-result coverage than DDG.
async function bing(q) {
  const lines = [];
  const urls = [];
  try {
    const html = await withTimeout(
      fetchText('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&ensearch=11'),
      9000
    );
    const re = /<li class="b_algo">([\s\S]*?)<\/li>/g;
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
          lines.push('- ' + (title || 'Web result') + (snip ? ' - ' + snip.slice(0, 220) : '') + ' - ' + href);
          urls.push(href);
          count++;
        }
      }
    }
  } catch (_) {}
  return { lines, urls };
}

function cleanUrl(u) {
  // Skip Bing's own tracker links
  if (u.indexOf('bing.com/ck/a') !== -1) return '';
  return u;
}

async function duckduckgoLite(q) {
  const lines = [];
  const urls = [];
  try {
    const txt = await withTimeout(
      fetchText('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q)),
      8000
    );
    const re = /<tr class="result">([\s\S]*?)<\/tr>/g;
    let m;
    let count = 0;
    while ((m = re.exec(txt)) && count < 8) {
      const text = stripTags(m[1]).replace(/^(\s*-?\s*)/, '');
      const parts = text.match(/^([^:]*[.:])\s+(.+)$/);
      if (parts) {
        const title = parts[1].trim();
        lines.push('- ' + parts[1] + ' ' + parts[2].slice(0, 260));
        urls.push('DDG: ' + title);
        count++;
      }
    }
  } catch (_) {}
  return { lines, urls: [] };
}

// Real-content grounder: fetch the readable article text for the top results.
async function reader(url) {
  try {
    const txt = await withTimeout(
      fetchText(JINA + encodeURI(url), { headers: { 'x-respond-with': 'text', 'x-timeout': '3' } }),
      3500
    );
    const cleaned = stripTags(txt).slice(0, 700);
    if (!cleaned) return '';
    return '\n[GROUNDING from ' + url + ']: ' + cleaned;
  } catch (_) { return ''; }
}

// Live news headlines from Google News RSS (no API key needed). Each line is
// "[ago] headline (source) - url".
async function googleNews(q) {
  const lines = [];
  const urls = [];
  try {
    const feedUrl = q ? NEWS_SEARCH + encodeURIComponent(q) : NEWS_FEED;
    const xml = await withTimeout(fetchText(feedUrl), 7000);
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
      const rel = shortDate(pub);
      const head = (title.split(' - ')[0] || title).slice(0, 140).trim();
      lines.push('- ' + (rel ? '[' + rel + '] ' : '') + head +
        (source ? ' (' + source.split(' -')[0].trim() + ')' : '') +
        (href ? ' - ' + href.trim() : ''));
      if (href) urls.push(href.trim());
      count++;
    }
  } catch (_) {}
  return { lines, urls };
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const q = String(url.searchParams.get('q') || '').trim();
  const type = String(url.searchParams.get('type') || 'web').trim();
  if (!q && type !== 'news') {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing q' }));
  }

  let content;
  if (type === 'news') {
    const parts = [];
    const seen = new Set();
    const [top, rel] = await Promise.all([googleNews(''), googleNews(q)]);
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
    const ground = await Promise.all(top.urls.concat(rel.urls).slice(0, 2).map((u) => reader(u)));
    for (const g of ground) if (g) parts.push(g);
    content = parts.join('\n').slice(0, 6000) || 'No news found for "' + q + '".';
  } else {
    const parts = [];
    const wp = await wikipedia(q);
    const bg = await bing(q);
    const ddg = await duckduckgoLite(q);
    parts.push('Wikipedia results for "' + q + '":');
    parts.push(...wp.lines);
    if (bg.lines.length) {
      parts.push('\nBing results:');
      parts.push(...bg.lines);
    }
    if (ddg.lines.length) {
      parts.push('\nDuckDuckGo results:');
      parts.push(...ddg.lines);
    }
    const urls = wp.urls.concat(bg.urls);
    const ground = await Promise.all(urls.slice(0, 2).map((u) => reader(u)));
    for (const g of ground) if (g) parts.push(g);
    content = parts.join('\n').slice(0, 6500) || 'No results found for "' + q + '".';
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'private, max-age=90');
  return res.end(JSON.stringify({ content }));
}