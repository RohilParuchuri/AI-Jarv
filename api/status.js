export function status(req) {
  return new Response(JSON.stringify({ ok: true, method: req.method, hasGroq: !!process.env.GROQ_API_KEY }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default function handler(req) {
  return new Response(JSON.stringify({ ok: true, method: req.method, hasGroq: !!process.env.GROQ_API_KEY }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}