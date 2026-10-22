// Cloudflare Worker that exchanges a Notion OAuth code for a token, keeping the
// client secret off users' machines. Stores nothing.
// Secrets: NOTION_CLIENT_ID, NOTION_CLIENT_SECRET. Optional: NOTION_API (tests),
// ALLOWED_ORIGIN (chrome-extension://<your extension id>).
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''
    const allowed = env.ALLOWED_ORIGIN ? origin === env.ALLOWED_ORIGIN : origin.startsWith('chrome-extension://')
    const cors = { 'Access-Control-Allow-Origin': allowed ? origin : 'null', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST' || !allowed) return Response.json({ error: 'forbidden' }, { status: 403, headers: cors })
    const { code, redirect_uri } = await request.json().catch(() => ({}))
    if (!code || !redirect_uri) return Response.json({ error: 'invalid_request' }, { status: 400, headers: cors })
    const res = await fetch(`${env.NOTION_API || 'https://api.notion.com'}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`)}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri }),
    })
    return new Response(await res.text(), { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } })
  },
}
