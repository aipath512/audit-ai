/**
 * AUDIT-AI™ Cloudflare Worker v2
 * Routes:
 *   POST /audit  → proxy to Anthropic API (key secret)
 *   GET  /stats  → return live audit counters from KV
 *
 * KV namespace: RATE_KV (bind in Cloudflare dashboard)
 * Secret:       ANTHROPIC_API_KEY
 *
 * KV keys used:
 *   global:total_audits      — total audit runs ever
 *   global:unique_domains    — count of distinct domains ever audited
 *   domain:{hostname}        — existence flag for unique domain tracking
 *   rate:{ip}                — hourly rate limit counter (TTL 3600s)
 */

const ALLOWED_ORIGINS = [
  'https://1clic-ia.eu',
  'https://www.1clic-ia.eu',
  'http://127.0.0.1:5500',
  'null',
  'https://eu-ai-audit.eu',
  'https://www.eu-ai-audit.eu',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = corsHeaders(allowed ? origin : ALLOWED_ORIGINS[0]);

    // ── CORS preflight ────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // ── GET /stats ────────────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/stats') {
      return handleStats(env, cors);
    }

    // ── POST /lead ────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/lead') {
      return handleLead(request, env, cors);
    }

    // ── POST /audit ───────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/audit') {
      return handleAudit(request, env, cors);
    }

    // Pass all other requests to Pages static assets (serves index.html)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

// ── STATS HANDLER ─────────────────────────────────────────────────────────────
async function handleStats(env, cors) {
  if (!env.RATE_KV) {
    return new Response(JSON.stringify({ total_audits: 0, unique_domains: 0 }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  const [total, unique, leads] = await Promise.all([
    env.RATE_KV.get('global:total_audits'),
    env.RATE_KV.get('global:unique_domains'),
    env.RATE_KV.get('global:total_leads'),
  ]);
  return new Response(JSON.stringify({
    total_audits:   parseInt(total  || '0'),
    unique_domains: parseInt(unique || '0'),
    total_leads:    parseInt(leads  || '0'),
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}

// ── AUDIT HANDLER ─────────────────────────────────────────────────────────────
async function handleAudit(request, env, cors) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // Rate limit: 20 audits/hour per IP
  if (env.RATE_KV) {
    const rateKey = `rate:${ip}`;
    const count = parseInt(await env.RATE_KV.get(rateKey) || '0');
    if (count >= 20) {
      return new Response(JSON.stringify({
        error: 'Rate limit reached: max 20 audits/hour per IP. Try again later.'
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    await env.RATE_KV.put(rateKey, String(count + 1), { expirationTtl: 3600 });
  }

  // Parse body
  let body;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON body', 400, cors); }

  if (!body.messages || !body.system) {
    return jsonError('Missing messages or system field', 400, cors);
  }

  // Extract domain for unique tracking
  let domain = '';
  try {
    const auditedUrl = body.audited_url || '';
    domain = new URL(auditedUrl.startsWith('http') ? auditedUrl : 'https://'+auditedUrl).hostname;
  } catch { domain = ''; }

  // Forward to Anthropic
  const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: body.system,
      messages: body.messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });

  const data = await anthropicResp.json();

  if (!anthropicResp.ok) {
    return new Response(JSON.stringify({
      error: data.error?.message || 'Anthropic API error'
    }), {
      status: anthropicResp.status,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // ── Update counters in KV (non-blocking — don't await) ──────────────────
  if (env.RATE_KV) {
    updateCounters(env, domain).catch(() => {});
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ── LEAD HANDLER ──────────────────────────────────────────────────────────────
async function handleLead(request, env, cors) {
  let lead;
  try { lead = await request.json(); }
  catch { return jsonError('Invalid JSON', 400, cors); }

  if (env.RATE_KV) {
    // Store lead with timestamp key — leads:2026-05-29T22:14:00Z:domain.com
    const key = `lead:${lead.ts || new Date().toISOString()}:${(lead.url||'').replace(/https?:\/\//,'')}`;
    await env.RATE_KV.put(key, JSON.stringify({
      name:      lead.name      || '',
      email:     lead.email     || '',
      whatsapp:  lead.whatsapp  || '',
      via:       lead.via       || '',
      url:       lead.url       || '',
      ts:        lead.ts        || new Date().toISOString(),
    }));

    // Increment total leads counter
    const count = parseInt(await env.RATE_KV.get('global:total_leads') || '0');
    await env.RATE_KV.put('global:total_leads', String(count + 1));
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ── COUNTER UPDATE ────────────────────────────────────────────────────────────
async function updateCounters(env, domain) {
  // Increment total audits
  const total = parseInt(await env.RATE_KV.get('global:total_audits') || '0');
  await env.RATE_KV.put('global:total_audits', String(total + 1));

  // Track unique domains
  if (domain) {
    const domainKey = `domain:${domain}`;
    const seen = await env.RATE_KV.get(domainKey);
    if (!seen) {
      await env.RATE_KV.put(domainKey, '1');
      const unique = parseInt(await env.RATE_KV.get('global:unique_domains') || '0');
      await env.RATE_KV.put('global:unique_domains', String(unique + 1));
    }
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonError(msg, status, cors) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
