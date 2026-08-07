// Vercel serverless function: proxies chat completions to Groq / OpenRouter
// using keys stored ONLY as Vercel environment variables, so no API key ever
// reaches the browser or the repository.

const CONFIG = {
  groq: { base: 'https://api.groq.com/openai/v1', key: () => process.env.GROQ_API_KEY },
  openrouter: { base: 'https://openrouter.ai/api/v1', key: () => process.env.OPENROUTER_API_KEY }
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const provider = body.provider;
  const cfg = CONFIG[provider];
  const key = cfg ? cfg.key() : null;
  if (!cfg || !key) {
    return new Response(JSON.stringify({ error: 'Provider key is not configured on the server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const payload = {
    model: body.model,
    messages: body.messages || [],
    stream: !!body.stream,
    temperature: body.temperature != null ? body.temperature : 0.6
  };
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools;
    payload.tool_choice = 'auto';
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + key
  };
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
    return new Response(JSON.stringify({ error: 'Upstream error: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (payload.stream) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      }
    });
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' }
  });
}