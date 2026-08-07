const $ = (id) => document.getElementById(id);

async function fetchT(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(e) {
  return !!(e && (e.name === 'AbortError' || e.code === 20));
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

const PROVIDERS = {
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: () => s.geminiKey, needKey: true },
  cerebras: { base: 'https://api.cerebras.ai/v1', key: () => s.cerebrasKey, needKey: true },
  groq: { base: 'https://api.groq.com/openai/v1', key: () => s.groqKey, needKey: true },
  deepseek: { base: 'https://api.deepseek.com', key: () => s.deepseekKey, needKey: true },
  ollama: { base: () => (s.ollamaUrl || '').replace(/\/+$/, ''), key: () => '', needKey: false }
};

// When served from the Vercel deployment, API keys live server-side only and
// requests go through /api/chat. Locally, the app talks to providers directly.
const PROXY = location && location.protocol === 'https:' && /(?:\.vercel\.app|ai\-jarv)/i.test(location.hostname)
  ? location.origin + '/api/chat'
  : '';
const CFG = PROXY ? PROXY.replace(/\/api\/chat$/, '/api/config') : '';
const PROXIED_TAGS = ['groq', 'gemini', 'cerebras', 'deepseek'];
let serverProviders = null;

function serverEnabled(tag) {
  if (serverProviders) return !!serverProviders[tag];
  return tag === 'groq';
}

// Keep the app fresh: register the service worker immediately (even when the
// setup screen shows) and reload the page the instant a newer app takes
// control, so phones never stay stuck on an old cached build.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    if (navigator.serviceWorker.controller) {
      setInterval(() => reg.update().catch(() => {}), 5 * 60 * 1000);
    }
  }).catch(() => {});
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
}
function providerEnabled(tag) {
  if (tag === 'ollama') return !!s.ollamaUrl;
  if (PROXIED_TAGS.includes(tag)) return PROXY ? serverEnabled(tag) : !!PROVIDERS[tag].key();
  return !PROVIDERS[tag].needKey || !!PROVIDERS[tag].key();
}

const MODELS = [
  { id: 'llama-3.3-70b-versatile', tag: 'groq', role: 'smart', label: 'Groq / Llama 3.3 70B' },
  { id: 'llama-3.1-8b-instant', tag: 'groq', role: 'fast', label: 'Groq / Llama 3.1 8B' },
  { id: 'gemini-2.5-flash', tag: 'gemini', role: 'smart', label: 'Gemini / Flash 2.5 (free)' },
  { id: 'gemini-2.5-flash-lite', tag: 'gemini', role: 'fast', label: 'Gemini / Flash-Lite 2.5 (free)' },
  { id: 'llama-3.3-70b', tag: 'cerebras', role: 'smart', label: 'Cerebras / Llama 3.3 70B' },
  { id: 'llama-3.1-8b', tag: 'cerebras', role: 'fast', label: 'Cerebras / Llama 3.1 8B' },
  { id: 'deepseek-v4-flash', tag: 'deepseek', role: 'smart', label: 'DeepSeek / V4 Flash' }
];

const VISION_MODELS = [
  { id: 'gemini-2.5-flash', tag: 'gemini', role: 'smart', label: 'Gemini / Flash 2.5 (vision)' }
];

const SYSTEM = {
  role: 'system',
  content: 'You are Rohil, a helpful personal AI assistant. Be concise, accurate and friendly. ' +
    'Answer the user directly. If you call a tool, briefly present the result to the user in your next reply.'
};

function systemPrompt() {
  let content = SYSTEM.content;
  if (s.memory.length) {
    content += '\n\nPersistent memory (things I have learned about you). Respect these and remember them often, unless the user asks you to forget them:\n' +
      s.memory.map((m, i) => (i + 1) + '. ' + m).join('\n');
  }
  return { role: 'system', content };
}

function persistConversation() {
  localStorage.setItem('rohil.history', JSON.stringify(chat));
}
function loadConversation() {
  try {
    const d = JSON.parse(localStorage.getItem('rohil.history') || 'null');
    return Array.isArray(d) ? d : [];
  } catch (_) { return []; }
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information when the answer may be outdated or you lack exact knowledge.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calc',
      description: 'Evaluate a math expression exactly and return the numeric result.',
      parameters: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. (12 + 3) * 4 / sin(30)' } }, required: ['expression'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'current_time',
      description: 'Get the current date, time, and timezone.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

let s = loadState();
let manualModel = null;
let chat = [];
let busy = false;
let aborted = false;
let liveBubble = null;
let liveTextNode = null;
let liveMeta = '';
let lastFinalText = '';
let recognition = null;
let pendingImages = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  const d = JSON.parse(localStorage.getItem('jarvis.config') || '{}');
  return {
    orKey: d.orKey || '',
    groqKey: d.groqKey || '',
    geminiKey: d.geminiKey || '',
    cerebrasKey: d.cerebrasKey || '',
    deepseekKey: d.deepseekKey || '',
    ollamaUrl: d.ollamaUrl || 'http://localhost:11434/v1',
    ollamaModel: d.ollamaModel || 'llama3.2',
    voiceOn: d.voiceOn !== false,
    voiceInputOn: d.voiceInputOn === true,
    voiceRate: d.voiceRate || 1.0,
    voiceName: d.voiceName || 'default',
    memory: Array.isArray(d.memory) ? d.memory : [],
    toolSearch: d.toolSearch !== false,
    toolCalc: d.toolCalc !== false,
    toolTime: d.toolTime !== false,
    mode: d.mode || 'auto'
  };
}
function saveState() { localStorage.setItem('jarvis.config', JSON.stringify(s)); }

function poolFor(mode) {
  if (mode === 'manual' && manualModel) return [manualModel];
  const smart = MODELS.filter((m) => m.role === 'smart' && providerEnabled(m.tag));
  const fast = MODELS.filter((m) => m.role === 'fast' && providerEnabled(m.tag));
  const ollama = (s.ollamaUrl && s.ollamaModel)
    ? [{ id: s.ollamaModel, tag: 'ollama', role: 'local', label: 'Ollama / ' + s.ollamaModel }]
    : [];
  const base = smart.concat(fast);
  const ordered = base.concat(ollama);
  if (mode === 'fast') return fast.concat(smart).concat(ollama);
  if (mode === 'smart') return ordered;
  return ordered;
}

function activeTools() {
  const out = [];
  if (s.toolSearch) out.push(TOOLS[0]);
  if (s.toolCalc) out.push(TOOLS[1]);
  if (s.toolTime) out.push(TOOLS[2]);
  return out;
}

function hasImagesInChat() {
  return chat.some((t) => t.role === 'user' && Array.isArray(t.content) && t.content.some((p) => p.type === 'image_url'));
}

/* ---------------- Providers ---------------- */

async function chatOnce(model, messages, tools) {
  const prov = PROVIDERS[model.tag];
  const proxied = PROXY && PROXIED_TAGS.includes(model.tag);
  const base = typeof prov.base === 'function' ? prov.base() : prov.base;
  const url = proxied ? PROXY : base + '/chat/completions';
  const body = { model: model.id, messages, stream: false, temperature: 0.6 };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  if (proxied) body.provider = model.tag;

  const headers = { 'Content-Type': 'application/json' };
  if (!proxied && prov.key()) headers.Authorization = 'Bearer ' + prov.key();

  let res;
  try {
    res = await fetchT(url, { method: 'POST', headers, body: JSON.stringify(body) }, 90000);
  } catch (e) {
    throw new Error('Cannot reach ' + model.label + (isAbort(e) ? ' (timed out)' : ''));
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch (_) {}
    throw new Error(model.label + ': ' + msg);
  }
  const j = await res.json();
  const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const toolCalls = (m.tool_calls || []).map((t) => {
    let args = {};
    try { args = JSON.parse(t.function.arguments || '{}'); } catch (_) {}
    return { id: t.id, name: t.function.name, args };
  });
  return { content: m.content || '', toolCalls };
}

async function streamChat(model, messages, onToken) {
  const prov = PROVIDERS[model.tag];
  const proxied = PROXY && PROXIED_TAGS.includes(model.tag);
  const base = typeof prov.base === 'function' ? prov.base() : prov.base;
  const url = proxied ? PROXY : base + '/chat/completions';
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (!proxied && prov.key()) headers.Authorization = 'Bearer ' + prov.key();
  const payload = { model: model.id, messages, stream: true, temperature: 0.6 };
  if (proxied) payload.provider = model.tag;
  const res = await fetchT(url, { method: 'POST', headers, body: JSON.stringify(payload) }, 60000);
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch (_) {}
    throw new Error(model.label + ': ' + msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return acc;
        try {
          const j = JSON.parse(data);
          const tok = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (tok) { acc += tok; if (onToken) onToken(acc); }
        } catch (_) {}
      }
    }
  } catch (e) {
    if (isAbort(e)) throw new Error(model.label + ': timed out');
    throw e;
  }
  return acc;
}

async function run() {
  if (busy) return;
  busy = true;
  setSendDisabled(true);
  aborted = false;

  if (s.mode === 'blend') { await runBlend(); return; }

  const hasImg = hasImagesInChat();
  let tools = activeTools();
  let candidates = poolFor(s.mode);
  if (hasImg) {
    tools = [];
    const vision = VISION_MODELS.filter((m) => providerEnabled(m.tag));
    const seen = new Set(candidates.map((c) => c.id + '|' + c.tag));
    candidates = vision.concat(candidates.filter((c) => !seen.has(c.id + '|' + c.tag)));
  }

  if (!candidates.length) {
    setStatus('No model available. Add an API key (or start Ollama).', 'error');
    busy = false;
    setSendDisabled(false);
    return;
  }

  let done = false;
  let lastErr = null;
  let aiText = '';

  try {
    for (let round = 0; round < 6 && !done && !aborted; round++) {
      for (const model of candidates) {
        if (aborted) break;
        if (!liveBubble) startBubble(model.label);
        else setBubbleMeta(model.label);
        try {
          const { content, toolCalls } = await chatOnce(model, [systemPrompt()].concat(chat), tools);
          if (toolCalls.length) {
            aiText += content;
            chat.push({
              role: 'assistant',
              content: content || null,
              tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
            });
            for (const c of toolCalls) {
              addToolBubble(toolLabel(c), c);
              const result = await executeTool(c.name, c.args);
              chat.push({ role: 'tool', tool_call_id: c.id, content: result });
              updateLastToolBubble(result.slice(0, 160));
            }
            break;
          }
          if (!content || !content.trim()) {
            throw new Error(model.label + ': returned an empty reply');
          }
          aiText += content;
          renderText(content);
          finishBubble();
          done = true;
          break;
        } catch (e) {
          if (aborted) break;
          lastErr = e;
          failBubble();
          setStatus('Provider ' + model.label + ' failed: ' + e.message + ' - trying next...');
          // Free tiers rate-limit aggressively; pause so the next provider
          // isn't instantly hammered (which is what caused the cascade).
          await sleep(/429|quota|rate|too many|limit|capacity/i.test(e.message) ? 1600 : 300);
        }
      }
    }

    if (aborted) { teardownBubble(); setStatus('Stopped.'); }
    else if (lastErr && !done) { teardownBubble(); setStatus('No model responded: ' + lastErr.message, 'error'); }
    else if (done) {
      if (s.voiceOn && aiText.trim()) speak(aiText.trim());
      lastFinalText = aiText;
      setStatus('Rohil replied.');
    }
  } catch (e) {
    teardownBubble();
    setStatus('Unexpected error: ' + e.message, 'error');
  } finally {
    busy = false;
    setSendDisabled(false);
    updateModeSelect();
    persistConversation();
    extractMemoryFrom();
    scroll();
  }
}

function allEnabledModels() {
  const seen = new Set();
  const out = MODELS.filter((m) => providerEnabled(m.tag));
  if (s.ollamaUrl && s.ollamaModel) {
    out.push({ id: s.ollamaModel, tag: 'ollama', role: 'local', label: 'Ollama / ' + s.ollamaModel });
  }
  return out.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

function addSourceBubble(label, content) {
  const m = document.createElement('div');
  m.className = 'msg tool-msg';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = 'Source ' + label + ':\n' + (content || '(empty)').slice(0, 220);
  m.appendChild(b);
  chatEl.appendChild(m);
  scroll();
}

async function runBlend() {
  try {
    let models = allEnabledModels();
    if (hasImagesInChat()) {
      models = VISION_MODELS.filter((m) => providerEnabled(m.tag)).concat(models.filter((m) => !VISION_MODELS.some((v) => v.id === m.id && v.tag === m.tag)));
    }
    if (!models.length) {
      setStatus('No models available. Add an API key (or start Ollama).', 'error');
      return;
    }
    const results = [];
    const jobs = models.map((model) =>
      withTimeout(chatOnce(model, [systemPrompt()].concat(chat), []).then((r) => ({ label: model.label, content: r.content })), 12000).catch(() => null)
    );
    await Promise.race([
      Promise.all(jobs.map((j) => j.then((r) => { if (r && r.content && r.content.trim()) results.push(r); }))),
      new Promise((res) => setTimeout(res, 4000))
    ]);
    if (!results.length) {
      setStatus('All providers failed in Blend mode. Try Fast or Auto.', 'error');
      return;
    }
    for (const r of results) addSourceBubble(r.label, r.content);

    let best = '';
    if (results.length === 1) {
      best = results[0].content.trim();
      startBubble('Rohil / 1 source');
      renderText(best);
      finishBubble();
      setStatus('Blend: only ' + results[0].label + ' answered.');
    } else {
      const judge = models[0];
      const lastUser = chat.length ? chat[chat.length - 1].content : 'the question';
      const judgePrompt = {
        role: 'user',
        content:
          'A user asked: "' + lastUser + '".\n' +
          'Several AI models each produced an answer, marked [LABEL] below. Pick the single best, ' +
          'most accurate and most helpful answer. Rewrite it cleanly, combining the best facts and wording. ' +
          'Output ONLY the winning answer with no labels.\n\n' +
          results.map((r) => '[' + r.label + ']:\n' + r.content).join('\n\n')
      };
      startBubble('Rohil / judging ' + results.length + ' sources');
      let streamed = false;
      try {
        const out = await withTimeout(streamChat(judge, [judgePrompt], (t) => { if (liveBubble) renderText(t); }), 15000);
        if (out && out.trim()) { best = out.trim(); streamed = true; }
      } catch (_) {}
      if (!streamed) {
        try { best = (await withTimeout(chatOnce(judge, [judgePrompt], []), 15000)).content.trim(); } catch (_) {}
        if (!best) best = results[0].content.trim();
        renderText(best);
      }
      finishBubble();
      setStatus('Synthesized from ' + results.length + ' providers.');
    }

    if (best && s.voiceOn) speak(best.slice(0, 600));
  } catch (e) {
    teardownBubble();
    setStatus('Blend error: ' + e.message, 'error');
  } finally {
    busy = false;
    setSendDisabled(false);
    updateModeSelect();
    persistConversation();
    extractMemoryFrom();
    scroll();
  }
}

/* ---------------- Tool calling ---------------- */

function toolLabel(c) {
  switch (c.name) {
    case 'web_search': return 'Web search: "' + String(c.args.query || '').slice(0, 80) + '"';
    case 'calc': return 'Calculate: ' + String(c.args.expression || '');
    case 'current_time': return 'Read clock';
    default: return 'Tool: ' + c.name;
  }
}

async function executeTool(name, args) {
  try {
    if (name === 'web_search') return await webSearch(String(args.query || ''));
    if (name === 'calc') return String(parseMath(String(args.expression || '')));
    if (name === 'current_time') return new Date().toString();
    return 'Unknown tool: ' + name;
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

async function webSearch(q) {
  if (!q) return 'No query provided.';
  let out = [];
  try {
    const r = await fetchT('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {}, 15000);
    if (r.ok) {
      const txt = await r.text();
      const doc = new DOMParser().parseFromString(txt, 'text/html');
      for (const a of doc.querySelectorAll('a.result__a')) {
        const t = a.textContent.trim();
        if (t) out.push(t + ' - ' + a.href);
      }
    }
  } catch (_) {}
  if (!out.length) {
    try {
      const r2 = await fetchT('https://api.duckduckgo.com/?q=' + encodeURIComponent(q) + '&format=json&no_html=1', {}, 15000);
      const j = await r2.json();
      if (j.AbstractText) out.push(j.AbstractText);
      for (const t of (j.RelatedTopics || [])) if (t.Text) out.push(t.Text);
    } catch (_) {}
  }
  if (!out.length) return 'No results found for "' + q + '".';
  return out.slice(0, 5).join('\n');
}

function parseMath(expr) {
  const tokens = (expr.match(/\d+\.?\d*|[a-z]|[+\-*/^()]/g) || []).filter(Boolean);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function fn(name, v) {
    switch (name) {
      case 'a': return Math.abs(v);
      case 's': return Math.sin(v);
      case 'c': return Math.cos(v);
      case 't': return Math.tan(v);
      case 'l': return Math.log(v);
      case 'r': return Math.round(v);
      case 'f': return Math.floor(v);
      default: throw new Error('unknown fn');
    }
  }
  function isFn(t) { return t && /^(a|s|c|t|l|r|f)$/.test(t); }
  function value() {
    let t = peek();
    if (t === '(') { next(); const v = add(); next(); return v; }
    if (t === 'p') { next(); return Math.PI; }
    if (t === 'e') { next(); return Math.E; }
    if (isFn(t)) {
      const name = next();
      if (peek() === '(') next();
      const v = add();
      if (peek() === ')') next();
      return fn(name, v);
    }
    if (t === undefined) throw new Error('bad expression');
    const f = parseFloat(next());
    if (isNaN(f)) throw new Error('bad token: ' + t);
    return f;
  }
  function power() {
    let l = value();
    while (peek() === '^') { next(); const r = value(); l = Math.pow(l, r); }
    return l;
  }
  function term() {
    let l = power();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = power();
      l = op === '*' ? l * r : l / r;
    }
    return l;
  }
  function add() {
    let l = term();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = term();
      l = op === '+' ? l + r : l - r;
    }
    return l;
  }
  const v = add();
  if (pos !== tokens.length) throw new Error('trailing tokens');
  if (!isFinite(v)) throw new Error('invalid result');
  return v;
}

/* ---------------- UI ---------------- */

const chatEl = $('chat');
const input = $('input');
const sendBtn = $('sendBtn');
const statusEl = $('status');
const micBtn = $('micBtn');
const modeTabs = document.querySelectorAll('.mode-tab');
const modelSelect = $('modelSelect');

function scroll() { chatEl.scrollTop = chatEl.scrollHeight; }

function addUserBubble(content) {
  const b = addMsg('user');
  renderInto(b, content);
  scroll();
}

function contentToParts(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  let text = '';
  const images = [];
  for (const o of (content || [])) {
    if (o.type === 'image_url') images.push({ url: o.image_url.url });
    else if (o.type === 'text') text += (text ? '\n' : '') + o.text;
  }
  return { text, images };
}

function renderInto(bubble, content) {
  const { text, images } = contentToParts(content);
  if (images.length) {
    const row = document.createElement('div');
    row.className = 'img-row';
    for (const im of images) {
      const img = document.createElement('img');
      img.src = im.url;
      img.className = 'bubble-img';
      row.appendChild(img);
    }
    bubble.appendChild(row);
  }
  if (text) {
    const sp = document.createElement('div');
    sp.textContent = text;
    bubble.appendChild(sp);
  }
}

function addMsg(role) {
  const m = document.createElement('div');
  m.className = 'msg ' + role;
  const b = document.createElement('div');
  b.className = 'bubble';
  m.appendChild(b);
  chatEl.appendChild(m);
  return b;
}

function startBubble(meta) {
  liveMeta = meta;
  liveBubble = addMsg('ai');
  liveBubble.className = 'bubble streaming';
  liveTextNode = document.createElement('div');
  liveTextNode.className = 'typing-dots';
  liveTextNode.innerHTML = '<span></span><span></span><span></span>';
  liveBubble.appendChild(liveTextNode);
  liveBubble.appendChild(metaLine(meta));
}
function setBubbleMeta(meta) {
  liveMeta = meta;
  const ml = liveBubble.querySelector('.meta');
  if (ml) ml.textContent = meta;
}
function metaLine(text) {
  const d = document.createElement('div');
  d.className = 'meta';
  d.textContent = text;
  return d;
}
function renderText(text) {
  liveTextNode.textContent = text;
  scroll();
}
function finishBubble() {
  if (liveBubble) liveBubble.classList.remove('streaming');
  liveBubble = null;
  liveTextNode = null;
}
function failBubble() {
  if (liveBubble) {
    liveBubble.classList.remove('streaming');
    liveBubble.classList.add('error');
  }
}
function teardownBubble() {
  if (liveBubble) { liveBubble.classList.remove('streaming'); liveTextNode = null; }
  liveBubble = null;
}

function addToolBubble(label, c) {
  const m = document.createElement('div');
  m.className = 'msg tool-msg';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = 'Using tool: ' + label;
  m.appendChild(b);
  m._result = b;
  chatEl.appendChild(m);
  scroll();
}
function updateLastToolBubble(text) {
  const msgs = chatEl.querySelectorAll('.msg.tool-msg');
  const last = msgs[msgs.length - 1];
  if (last && last._result) last._result.textContent += '\n\u2192 ' + text;
  scroll();
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', kind === 'error');
}
function setSendDisabled(v) {
  sendBtn.disabled = v;
  sendBtn.style.opacity = v ? '0.4' : '1';
}

function esc(t) { return String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function compressImage(dataUrl, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, cw, ch);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function handleImageFiles(files) {
  for (const file of Array.from(files || [])) {
    if (!file.type || !file.type.startsWith('image/')) continue;
    try {
      const raw = await fileToDataUrl(file);
      const url = await compressImage(raw, 1024, 0.72);
      pendingImages.push({ url });
    } catch (_) {}
  }
  renderImagePreviews();
}

function renderImagePreviews() {
  const box = $('imgPreview');
  if (!box) return;
  box.innerHTML = '';
  pendingImages.forEach((im, idx) => {
    const wrap = document.createElement('span');
    wrap.className = 'img-thumb';
    const img = document.createElement('img');
    img.src = im.url;
    const x = document.createElement('button');
    x.className = 'img-remove';
    x.textContent = '\u00d7';
    x.title = 'Remove image';
    x.onclick = () => { pendingImages.splice(idx, 1); renderImagePreviews(); };
    wrap.appendChild(img);
    wrap.appendChild(x);
    box.appendChild(wrap);
  });
  if (box.parentElement) box.parentElement.classList.toggle('has-imgs', pendingImages.length > 0);
}

function autogrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

function send() {
  const val = input.value.trim();
  const imgs = pendingImages.slice();
  if ((!val && !imgs.length) || busy) return;
  let content;
  if (imgs.length) {
    content = [];
    if (val) content.push({ type: 'text', text: val });
    for (const im of imgs) content.push({ type: 'image_url', image_url: { url: im.url } });
  } else {
    content = val;
  }
  addUserBubble(content);
  chat.push({ role: 'user', content });
  pendingImages = [];
  renderImagePreviews();
  input.value = '';
  autogrow();
  persistConversation();
  if (typeof content === 'string' && memoryCommand(content)) return;
  run();
}

function ack(msg) {
  const b = addMsg('ai');
  const t = document.createElement('div');
  t.textContent = msg;
  b.appendChild(t);
  const m = document.createElement('div');
  m.className = 'meta';
  m.textContent = 'Rohil / memory';
  b.appendChild(m);
  scroll();
}

function renderHistory() {
  chatEl.innerHTML = '';
  for (const turn of chat) {
    if (!turn || turn.role === 'system' || (turn.role === 'assistant' && !turn.content)) continue;
    const b = addMsg(turn.role === 'user' ? 'user' : (turn.role === 'tool' ? 'tool-msg' : 'ai'));
    if (turn.role === 'tool') b.textContent = 'tool: ' + String(turn.content || '').slice(0, 120);
    else renderInto(b, turn.content || '');
  }
  scroll();
}

function memoryCommand(val) {
  const t = val.trim();
  const low = t.toLowerCase();

  if (/(erase|forget|wipe|clear|delete)\s+(everything|all|my\s+memory|your\s+memory|your\s+brain|the\s+memory|all\s+memories|history)\b/i.test(low) || /forget\s+everything/i.test(low)) {
    s.memory = [];
    chat = [];
    saveState();
    localStorage.removeItem('rohil.history');
    renderHistory();
    addWelcome();
    ack("Understood. I have wiped my memory and our conversation history.");
    return true;
  }
  const rm = t.match(/^(?:remember|remind me|don'?t forget|keep in mind|keep this|note)\b\s*[:.\-]?\s*(.+)$/i);
  if (rm && rm[1]) {
    s.memory.push(rm[1].trim());
    saveState();
    ack('OK. I will remember: "' + rm[1].trim() + '"');
    return true;
  }
  const forget = t.match(/\bforget\s+(?!to\b|it\s+to\b)(.+)$/i);
  if (forget && s.memory.length) {
    const phrase = forget[1].toLowerCase();
    const before = s.memory.length;
    s.memory = s.memory.filter((mem) => !(phrase.includes(mem.toLowerCase()) || mem.toLowerCase().includes(phrase)));
    if (s.memory.length !== before) {
      saveState();
      ack('Removed ' + (before - s.memory.length) + ' item(s) from my memory.');
      return true;
    }
  }
  return false;
}

async function extractMemoryFrom(skipValues) {
  if (aborted) return;
  const cands = allEnabledModels();
  if (!cands.length) return;
  const recent = chat.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-8).map((m) => {
    const { text } = contentToParts(m.content);
    return Object.assign({}, m, { content: text });
  });
  if (!recent.length) return;
  const prompt = {
    role: 'user',
    content: 'From the chat above, list every durable personal fact about the user or durable preference they stated, one per line, no bullets or numbering. Omit pleasantries and hypotheticals. If nothing worth remembering, reply with exactly NONE.'
  };
  try {
    const { content } = await withTimeout(chatOnce(cands[0], [{ role: 'system', content: SYSTEM.content }].concat(recent).concat([prompt]), []), 12000);
    const trimmed = (content || '').trim();
    if (!trimmed || /^\s*none\b|no (durable )?facts/i.test(trimmed)) return;
    const existing = new Set(s.memory.map((m) => m.toLowerCase()));
    let added = 0;
    for (const line of trimmed.split(/\n+/)) {
      const f = line.replace(/^[\s\-\d\.\)\u2022:]+/, '').trim().replace(/[.!]+$/, '');
      if (!f || /^none$/i.test(f)) continue;
      if (f.length > 180) continue;
      const k = f.toLowerCase();
      if (!existing.has(k)) {
        s.memory.push(f);
        existing.add(k);
        added++;
      }
    }
    if (s.memory.length > 80) s.memory = s.memory.slice(-80);
    if (added) saveState();
  } catch (_) {}
}

/* ---------------- Voice ---------------- */

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const clean = text.replace(/\s+/g, ' ').slice(0, 600);
  if (!clean) return;
  // Mobile browsers (esp. iOS) block TTS until the page has had a user
  // gesture and refuse to start mid-sentence if the engine is paused, so
  // resume before speaking and never cancel in the same tick.
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  try { speechSynthesis.resume(); } catch (_) {}
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = s.voiceRate;
  u.pitch = 1;
  if (s.voiceName && s.voiceName !== 'default') {
    const v = speechSynthesis.getVoices().find((x) => x.name === s.voiceName);
    if (v) u.voice = v;
  }
  speechSynthesis.speak(u);
}

// One-time audio unlock: iOS only lets speech play after a real user gesture,
// so fire a silent utterance when the user first taps the page. Without this,
// asynchronous "speak reply" calls never make any sound on a phone.
(function unlockVoice() {
  if (!('speechSynthesis' in window)) return;
  const prime = () => {
    try {
      speechSynthesis.resume();
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.rate = 10;
      speechSynthesis.speak(u);
    } catch (_) {}
  };
  document.addEventListener('pointerdown', prime, { once: true, capture: true });
  document.addEventListener('touchstart', prime, { once: true, capture: true });
  document.addEventListener('keydown', prime, { once: true, capture: true });
})();

function buildVoices() {
  const sel = $('voice');
  if (!sel) return;
  sel.innerHTML = '';
  const voices = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : [];
  s.voiceName = s.voiceName || 'default';
  const keep = Array.from(voices).some((v) => v.name === s.voiceName) ? s.voiceName === 'default' ? '' : s.voiceName : '';
  const def = document.createElement('option');
  def.value = 'default';
  def.textContent = 'Default voice';
  sel.appendChild(def);
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = v.name + (v.lang ? ' (' + v.lang + ')' : '');
    sel.appendChild(o);
  }
  if (keep && Array.from(sel.options).some((o) => o.value === keep)) sel.value = keep;
  else sel.value = 'default';
}

function getRecognition() {
  const C = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!C) return null;
  const r = new C();
  r.lang = 'en-US';
  r.interimResults = true;
  r.continuous = false;
  r.onresult = (e) => {
    let t = '';
    for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
    input.value = t;
    autogrow();
    if (e.results[0].isFinal) toggleMic(false);
  };
  r.onend = () => { micBtn.classList.remove('listening'); if (input.value.trim() && !busy) send(); };
  r.onerror = () => toggleMic(false);
  return r;
}

function toggleMic(on) {
  if (on === undefined) on = micBtn.classList.contains('listening');
  if (!on) {
    if (recognition) recognition.stop();
    micBtn.classList.remove('listening');
    return;
  }
  if (!recognition) recognition = getRecognition();
  if (!recognition) { setStatus('Speech recognition not supported in this browser.', 'error'); return; }
  micBtn.classList.add('listening');
  recognition.start();
}

/* ---------------- Settings ---------------- */

function buildModelSelect() {
  const opts = [
    { v: '__auto__', l: 'Auto (recommended)' },
    { v: '__fast__', l: 'Fast' },
    { v: '__smart__', l: 'Smart' },
    { v: '__blend__', l: 'Blend (best of both)' }
  ];
  const seen = {};
  for (const m of MODELS) {
    if (!providerEnabled(m.tag)) continue;
    if (seen[m.id]) continue;
    seen[m.id] = 1;
    opts.push({ v: m.tag + ':' + m.id, l: m.label });
  }
  const ollama = s.ollamaUrl && s.ollamaModel;
  if (ollama) opts.push({ v: 'ollama:' + s.ollamaModel, l: 'Ollama / ' + s.ollamaModel + ' (local)' });
  if (!opts.length) opts.push({ v: '__auto__', l: 'No models yet' });
  modelSelect.innerHTML = opts.map((o) => '<option value="' + esc(o.v) + '">' + esc(o.l) + '</option>').join('');
  updateModeSelect();
}

function updateModeSelect() {
  if (s.mode === 'manual' && manualModel) {
    modelSelect.value = manualModel.tag + ':' + manualModel.id;
  } else {
    modelSelect.value = '__' + s.mode + '__';
  }
  for (const t of modeTabs) t.classList.toggle('active', t.dataset.mode === s.mode);
}

function syncSettingsFromUI() {
  s.orKey = $('orKey') ? $('orKey').value.trim() : s.orKey;
  s.groqKey = $('groqKey').value.trim();
  s.geminiKey = $('geminiKey').value.trim();
  s.cerebrasKey = $('cerebrasKey').value.trim();
  s.deepseekKey = $('deepseekKey').value.trim();
  s.ollamaUrl = $('ollamaUrl').value.trim() || 'http://localhost:11434/v1';
  s.ollamaModel = $('ollamaModel').value.trim() || 'llama3.2';
  s.voiceOn = $('voiceOn').checked;
  s.voiceInputOn = $('voiceInputOn').checked;
  s.voiceRate = parseFloat($('voiceRate').value);
  s.voiceName = $('voice').value || 'default';
  s.toolSearch = $('toolSearch').checked;
  s.toolCalc = $('toolCalc').checked;
  s.toolTime = $('toolTime').checked;
  saveState();
}

function loadSettingsIntoUI() {
  if ($('orKey')) $('orKey').value = s.orKey;
  $('groqKey').value = s.groqKey;
  $('geminiKey').value = s.geminiKey;
  $('cerebrasKey').value = s.cerebrasKey;
  $('deepseekKey').value = s.deepseekKey;
  $('ollamaUrl').value = s.ollamaUrl;
  $('ollamaModel').value = s.ollamaModel;
  $('voiceOn').checked = s.voiceOn;
  $('voiceInputOn').checked = s.voiceInputOn;
  $('voiceRate').value = s.voiceRate;
  $('voiceRateVal').textContent = s.voiceRate.toFixed(2);
  buildVoices();
  $('toolSearch').checked = s.toolSearch;
  $('toolCalc').checked = s.toolCalc;
  $('toolTime').checked = s.toolTime;
}

/* ---------------- Events & boot ---------------- */

sendBtn.addEventListener('click', send);
input.addEventListener('input', autogrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

for (const t of modeTabs) {
  t.addEventListener('click', () => {
    s.mode = t.dataset.mode;
    manualModel = null;
    saveState();
    updateModeSelect();
  });
}
modelSelect.addEventListener('change', () => {
  const v = modelSelect.value;
  if (v.startsWith('__')) {
    s.mode = v.slice(2, -2);
    manualModel = null;
  } else {
    const [tag, ...rest] = v.split(':');
    const id = rest.join(':');
    const found = MODELS.find((m) => m.id === id && m.tag === tag) || { id, tag, label: tag + ' / ' + id };
    s.mode = 'manual';
    manualModel = found;
  }
  saveState();
  updateModeSelect();
});

micBtn.addEventListener('click', () => toggleMic());
$('imgBtn').addEventListener('click', () => $('imgInput').click());
$('imgInput').addEventListener('change', (e) => {
  handleImageFiles(e.target.files);
  e.target.value = '';
});
$('showKeys').addEventListener('change', () => {
  const show = $('showKeys').checked;
  for (const id of ['orKey', 'groqKey', 'geminiKey', 'cerebrasKey', 'deepseekKey']) {
    const el = $(id);
    if (el) el.type = show ? 'text' : 'password';
  }
});

function hideSettings() {
  syncSettingsFromUI();
  $('settingsPanel').classList.add('hidden');
  buildModelSelect();
}

$('settingsBtn').addEventListener('click', () => { $('settingsPanel').classList.remove('hidden'); });
$('closeSettings').addEventListener('click', hideSettings);
$('settingsPanel').addEventListener('click', (e) => { if (e.target === $('settingsPanel')) hideSettings(); });
$('saveSettingsBtn').addEventListener('click', hideSettings);

['groqKey', 'geminiKey', 'cerebrasKey', 'deepseekKey', 'ollamaUrl', 'ollamaModel', 'voiceOn', 'voiceInputOn', 'voiceRate', 'voice', 'toolSearch', 'toolCalc', 'toolTime'].forEach((id) => {
  const el = $(id);
  const ev = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
  el.addEventListener(ev, syncSettingsFromUI);
});
$('voiceRate').addEventListener('input', () => { $('voiceRateVal').textContent = parseFloat($('voiceRate').value).toFixed(2); });
$('resetBtn').addEventListener('click', () => {
  if (confirm('Reset Rohil? This clears all stored keys.')) {
    localStorage.removeItem('jarvis.config');
    localStorage.removeItem('jarvis.ready');
    location.reload();
  }
});
$('backupBtn').addEventListener('click', () => {
  syncSettingsFromUI();
  const data = {
    app: 'rohil',
    exportedAt: new Date().toISOString(),
    orKey: s.orKey,
    groqKey: s.groqKey,
    geminiKey: s.geminiKey,
    cerebrasKey: s.cerebrasKey,
    deepseekKey: s.deepseekKey,
    ollamaUrl: s.ollamaUrl,
    ollamaModel: s.ollamaModel,
    voiceOn: s.voiceOn,
    voiceInputOn: s.voiceInputOn,
    voiceRate: s.voiceRate,
    voiceName: s.voiceName,
    memory: s.memory,
    toolSearch: s.toolSearch,
    toolCalc: s.toolCalc,
    toolTime: s.toolTime
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/\D/g, '');
  a.href = URL.createObjectURL(blob);
  a.download = 'rohil-backup-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  setStatus('Backup downloaded.');
});
$('restoreBtn').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (!json || json.app !== 'rohil') throw new Error('not a Rohil backup file');
    if (String(json.orKey || '').length) s.orKey = String(json.orKey);
    if (String(json.groqKey || '').length) s.groqKey = String(json.groqKey);
    if (String(json.geminiKey || '').length) s.geminiKey = String(json.geminiKey);
    if (String(json.cerebrasKey || '').length) s.cerebrasKey = String(json.cerebrasKey);
    if (String(json.deepseekKey || '').length) s.deepseekKey = String(json.deepseekKey);
    if (String(json.ollamaUrl || '').length) s.ollamaUrl = String(json.ollamaUrl);
    if (String(json.ollamaModel || '').length) s.ollamaModel = String(json.ollamaModel);
    if (typeof json.voiceOn === 'boolean') s.voiceOn = json.voiceOn;
    if (typeof json.voiceInputOn === 'boolean') s.voiceInputOn = json.voiceInputOn;
    if (typeof json.voiceRate === 'number') s.voiceRate = json.voiceRate;
    if (typeof json.voiceName === 'string') s.voiceName = json.voiceName;
    if (Array.isArray(json.memory)) s.memory = json.memory.slice(0, 80);
    if (typeof json.toolSearch === 'boolean') s.toolSearch = json.toolSearch;
    if (typeof json.toolCalc === 'boolean') s.toolCalc = json.toolCalc;
    if (typeof json.toolTime === 'boolean') s.toolTime = json.toolTime;
    saveState();
    loadSettingsIntoUI();
    setStatus('Settings restored from backup.');
  } catch (err) {
    setStatus('Restore failed: ' + err.message, 'error');
  }
});
$('newChatBtn').addEventListener('click', () => {
  chat = [];
  chatEl.innerHTML = '';
  addWelcome();
  persistConversation();
});

function addWelcome() {
  const b = addMsg('ai');
  b.innerHTML = '<div>Ready, sir. Ask me anything, or tap the mic to talk.</div><div class="meta">Rohil</div>';
  scroll();
}

function initSetup() {
  const overlay = $('setup');
  $('setupGo').addEventListener('click', () => {
    const grk = $('setupGroq').value.trim();
    const gmk = $('setupGemini').value.trim();
    const cek = $('setupCerebras').value.trim();
    const dsk = $('setupDeepSeek').value.trim();
    const olU = $('setupOllama').value.trim();
    const olM = $('setupOllamaModel').value.trim();
    if (grk) s.groqKey = grk;
    if (gmk) s.geminiKey = gmk;
    if (cek) s.cerebrasKey = cek;
    if (dsk) s.deepseekKey = dsk;
    if (olU) s.ollamaUrl = olU;
    else s.ollamaUrl = s.ollamaUrl || 'http://localhost:11434/v1';
    if (olM) s.ollamaModel = olM;
    s.voiceOn = $('setupVoice').checked;
    s.toolSearch = $('setupSearch').checked;
    saveState();
    localStorage.setItem('jarvis.ready', '1');
    overlay.classList.add('hidden');
    boot();
  });
}

function boot() {
  $('setup').classList.add('hidden');
  chat = loadConversation();
  renderHistory();
  if (!chat.length) addWelcome();
  loadSettingsIntoUI();
  buildModelSelect();
  buildVoices();
  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = () => {
      const cur = $('voice').value;
      buildVoices();
      if (cur) $('voice').value = cur;
    };
  }
}

if (PROXY) {
  // Ask the server which free providers have keys configured, so the model
  // list only shows ones that can actually reply. Groq stays available even
  // while this is loading.
  fetch(CFG, { cache: 'no-store' })
    .then((r) => r.json())
    .then((j) => { if (j && typeof j === 'object') serverProviders = j; })
    .catch(() => {})
    .finally(() => boot());
} else if (localStorage.getItem('jarvis.ready') === '1') {
  boot();
} else {
  initSetup();
}
