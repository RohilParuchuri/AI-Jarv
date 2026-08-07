// Reports which free providers have keys configured server-side, so the app
// only shows models that can actually reply. Classic (req, res) contract —
// the Web `new Response(...)` style hangs on this runtime.
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    groq: !!process.env.GROQ_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    cerebras: !!process.env.CEREBRAS_API_KEY,
    deepseek: !!process.env.DEEPSEEK_API_KEY
  }));
}