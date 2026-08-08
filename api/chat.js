// Vercel serverless function: proxies chat completions to free providers
// (Groq, Gemini free tier, DeepSeek V4 Flash via HF Gateway) using keys stored ONLY as Vercel
// environment variables, so no API key ever reaches the browser or the repo.

// IMPORTANT: Vercel's runtime for this project only reliably works with the
// classic (req, res) handler contract, NOT `export default handler(req)`
// returning a Web `new Response(...)`. If you switch styles the function will
// hang with 0 bytes.

const CONFIG = {
  groq: { base: 'https://api.groq.com/openai/v1', key: () => process.env.GROQ_API_KEY },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: () => process.env.GEMINI_API_KEY },
  // DeepSeek V4 Flash via Hugging Face Gateway's free "friendlyhw" provider.
  deepseek: { base: 'https://router.huggingface.co/v1', key: () => process.env.HF_TOKEN },
  // OpenRouter: hub for many free models incl. NVIDIA Nemotron (sku routing).
  openrouter: { base: 'https://openrouter.ai/api/v1', key: () => process.env.OPENROUTER_API_KEY }
};

const PROXIED_TAGS = Object.keys(CONFIG);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify(Object.fromEntries(PROXIED_TAGS.map((t) => [t, !!CONFIG[t].key()]))));
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Use POST' }));
  }

  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch (_) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }

  const provider = body.provider;
  const cfg = CONFIG[provider];
  const key = cfg ? cfg.key() : null;
  if (!cfg || !key) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Provider key is not configured on the server' }));
  }

  const payload = {
    model: body.model,
    messages: body.messages || [],
    stream: !!body.stream,
    temperature: body.temperature != null ? body.temperature : 0.6
  };
  if (body.max_tokens != null) payload.max_tokens = body.max_tokens;
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools;
    payload.tool_choice = 'auto';
  }

  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + key
  };
  if (provider === 'deepseek') headers['provider'] = 'friendlyhw';
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://ai-jarv1234.vercel.app';
    headers['X-Title'] = 'Rohil';
  }

  let upstream;
  try {
    upstream = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Upstream error: ' + e.message }));
  }

  if (payload.stream) {
    res.writeHead(upstream.status, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const ctrl = new AbortController();
      req.on('close', () => ctrl.abort());
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ctrl.signal.aborted) break;
          res.write(value);
        }
      } catch (_) {
        /* aborted or upstream closed */
      }
    }
    return res.end();
  }

  const text = await upstream.text();
  res.statusCode = upstream.status;
  res.setHeader('Content-Type', 'application/json');
  return res.end(text);
}