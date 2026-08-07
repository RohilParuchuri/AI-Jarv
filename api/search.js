// Vercel serverless function: free, keyless web search used by Rohil's
// web_search tool. Returns real content (a Wikipedia intro plus direct
// search-result summaries) so the model can answer instead of only seeing
// link titles. Classic (req, res) handler - see api/chat.js for why.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function strip(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function wikipedia(q) {
  const lines = [];
  try {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
      encodeURIComponent(q) + '&format=json&srlimit=5&origin=*';
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return lines;
    const j = await r.json();
    const hits = (j && j.query && j.query.search) || [];
    for (const h of hits.slice(0, 5)) {
      lines.push('- ' + h.title + ': ' + strip(h.snippet));
    }
    if (hits.length) {
      const title = hits[0].title;
      const s = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' +
        encodeURIComponent(title), { headers: { 'user-agent': UA } });
      if (s.ok) {
        const sj = await s.json();
        const intro = strip(sj.extract || '');
        if (intro.length > 80) {
          lines.push('\n[TOP ARTICLE: ' + sj.title + ']');
          lines.push(intro.slice(0, 1600));
        }
      }
    }
  } catch (_) {}
  return lines;
}

async function duckduckgoLite(q) {
  const lines = [];
  try {
    const r = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q), {
      headers: { 'user-agent': UA }
    });
    if (!r.ok) return lines;
    const txt = await r.text();
    const re = /<tr class="result">([\s\S]*?)<\/tr>/g;
    let m;
    let count = 0;
    while ((m = re.exec(txt)) && count < 8) {
      const text = strip(m[1]).replace(/^(\s*-?\s*)/, '');
      const parts = text.match(/^([^:]*[.:])\s+(.+)$/);
      if (parts) lines.push('- ' + parts[1] + ' ' + parts[2].slice(0, 300));
      count++;
    }
  } catch (_) {}
  return lines;
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const q = String(url.searchParams.get('q') || '').trim();
  if (!q) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing q' }));
  }

  const parts = [];
  parts.push('Wikipedia results for "' + q + '":');
  parts.push(...(await wikipedia(q)));
  const ddg = await ddgLiteTimeout(q);
  if (ddg.length) {
    parts.push('\nOther web results for "' + q + '":');
    parts.push(...ddg);
  }
  const content = parts.join('\n').slice(0, 4200) || 'No results found for "' + q + '".';

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'private, max-age=300');
  return res.end(JSON.stringify({ content }));
}

async function ddgLiteTimeout(q) {
  try {
    return await Promise.race([
      ddgLite(q),
      new Promise((resolve) => setTimeout(() => resolve([]), 8000))
    ]);
  } catch (_) {
    return [];
  }
}