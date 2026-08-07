// Vercel serverless: free speech-to-text for phones (iOS Safari has no web
// speech recognition). The app records audio on-device and POSTs the raw
// bytes here; we forward them to Groq's free Whisper endpoint using the same
// GROQ_API_KEY already used for chat. Classic (req, res) contract.
// Without a browser feature, microphone audio lands in the POST body with a
// mime type in the query string (e.g. /api/stt?mime=audio/mp4).

const EXTS = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'application/octet-stream': 'webm',
  '': 'webm'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'Use POST' }));
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'STT not configured on the server' }));
  }

  const url = new URL(req.url || '/', 'http://x');
  const mime = String(url.searchParams.get('mime') || '').toLowerCase();
  const ext = EXTS[mime || ''] || 'webm';

  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on('data', (c) => chunks.push(c));
    req.on('end', resolve);
    req.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  if (!buf.length) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'No audio received' }));
  }

  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.' + ext);
  fd.append('model', 'whisper-large-v3-turbo');

  try {
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key },
      body: fd
    });
    if (!r.ok) {
      const err = await r.text();
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'Transcription upstream failed: ' + r.status + ' ' + err.slice(0, 200) }));
    }
    const j = await r.json();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    return res.end(JSON.stringify({ text: String(j.text || '').trim() }));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'STT error: ' + e.message }));
  }
}