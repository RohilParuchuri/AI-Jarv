// Vercel serverless function: free, keyless web + news search used by Rohil's
// web_search and news_search tools. Returns real content (a Wikipedia intro,
// direct search-result summaries, and live news headlines with recency) so the
// model can answer instead of only seeing link titles. Classic (req, res)
// handler - see api/chat.js for why.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const NEWS_FEED = 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
const NEWS_SEARCH = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=';

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

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) return '';
  return await r.text();
}

async function wikipedia(q) {
  const lines = [];
  try {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
      encodeURIComponent(q) + '&format=json&srlimit=5&origin=*';
    const j = JSON.parse(await withTimeout(fetchText(url), 6000) || '{}');
    const hits = (j && j.query && j.query.search) || [];
    for (const h of hits.slice(0, 5)) {
      lines.push('- ' + h.title + ': ' + stripTags(h.snippet));
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
      }
    }
  } catch (_) {}
  return lines;
}

// Live news headlines from Google News RSS (no API key needed). Each line is
// "[ago] headline (source) - url" so the model can reason about recency.
async function googleNews(q) {
  const lines = [];
  try {
    const feedUrl = q
      ? NEWS_SEARCH + encodeURIComponent(q + ' when:1y')
      : NEWS_FEED;
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
      if (!title) continue;
      const href = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const rel = shortDate(pub);
      let head = title.split(' - ')[0].trim();
      if (!head) head = title.slice(0, 120);
      let line = '- ' + (rel ? '[' + rel + '] ' : '') + head;
      if (source) line += ' (' + source.split(' -')[0].trim() + ')';
      if (href) line += ' - ' + href.trim();
      lines.push(line);
      count++;
    }
  } catch (_) {}
  return lines;
}

async function duckduckgoLite(q) {
  const lines = [];
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
      if (parts) lines.push('- ' + parts[1] + ' ' + parts[2].slice(0, 300));
      count++;
    }
  } catch (_) {}
  return lines;
}

function joinArr(prefix, lines) {
  return [prefix].concat(lines);
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
    const [top, rel] = await Promise.all([googleNews(''), googleNews(q)]);
    if (top.length) parts.push(...joinArr('Top headlines (latest):', top.slice(0, 6)));
    if (rel.length) parts.push(...joinArr('News matching "' + q + '":', rel.slice(0, 7)));
    content = parts.join('\n').slice(0, 5000);
    if (!content) content = 'No news found for "' + q + '".';
  } else {
    const parts = [];
    parts.push('Wikipedia results for "' + q + '":');
    parts.push(...(await wikipedia(q)));
    const ddg = await duckduckgoLite(q);
    if (ddg.length) {
      parts.push('\nOther web results for "' + q + '":');
      parts.push(...ddg);
    }
    content = parts.join('\n').slice(0, 4200) || 'No results found for "' + q + '".';
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'private, max-age=120');
  return res.end(JSON.stringify({ content }));
}