// A strict in-memory Notion API used by integration and e2e tests. It models two
// workspaces, rejects payloads that break the real API's documented limits, and
// implements the OAuth authorize/token endpoints.
import http from 'node:http'
import { randomUUID } from 'node:crypto'

export const DB_ID = 'db000000-0000-0000-0000-000000000001'
export const NO_URL_DB_ID = 'db000000-0000-0000-0000-000000000002'
export const PAGE_ID = 'pg000000-0000-0000-0000-000000000001'
export const TEAM_PAGE_ID = 'pg000000-0000-0000-0000-000000000002'
export const OAUTH = { clientId: 'client-123', clientSecret: 'shh', code: 'code-abc', token: 'secret_ws2' }

const plainTitle = text => [{ type: 'text', text: { content: text }, plain_text: text }]

function makeWorkspaces() {
  return {
    secret_test: {
      name: 'Acme Personal',
      botId: 'bot-1',
      databases: {
        [DB_ID]: {
          title: 'Reading list',
          icon: '📚',
          properties: {
            Name: { type: 'title' },
            URL: { type: 'url' },
            Tags: { type: 'multi_select', options: ['research', 'later'] },
            Author: { type: 'rich_text' },
            Clipped: { type: 'date' },
            Read: { type: 'checkbox' },
          },
        },
        [NO_URL_DB_ID]: { title: 'Ideas', icon: '💡', properties: { Title: { type: 'title' }, Status: { type: 'status', options: ['Inbox', 'Done'] } } },
      },
      pages: { [PAGE_ID]: { title: 'Research notes', icon: '📝' } },
    },
    [OAUTH.token]: {
      name: 'Team Space',
      botId: 'bot-2',
      databases: {},
      pages: { [TEAM_PAGE_ID]: { title: 'Team wiki', icon: '🏢' } },
    },
  }
}

function databaseObject(id, db) {
  const properties = {}
  for (const [name, p] of Object.entries(db.properties)) {
    properties[name] = { id: name.toLowerCase(), name, type: p.type, [p.type]: p.options ? { options: p.options.map(o => ({ name: o })) } : {} }
  }
  return { object: 'database', id, url: `https://www.notion.so/${id}`, title: plainTitle(db.title), icon: db.icon ? { type: 'emoji', emoji: db.icon } : null, properties, archived: false, in_trash: false }
}

const pageObject = (id, page) => ({
  object: 'page',
  id,
  url: `https://www.notion.so/${id}`,
  icon: page.icon ? { type: 'emoji', emoji: page.icon } : null,
  parent: { type: 'workspace', workspace: true },
  properties: { title: { id: 'title', type: 'title', title: plainTitle(page.title) } },
  archived: false,
  in_trash: false,
})

export function startMockNotion({ token = 'secret_test', failAppends = 0, failCreates = 0 } = {}) {
  const workspaces = makeWorkspaces()
  const pages = new Map()
  const requests = []
  const state = { failAppends, failCreates, denySchemaEdits: false, rateLimitEvery: 0, served: 0 }

  function validateRich(rich, where) {
    if (!Array.isArray(rich)) throw `${where}: rich_text must be an array`
    if (rich.length > 100) throw `${where}: rich_text has ${rich.length} items (max 100)`
    for (const t of rich) {
      if (t.text?.content?.length > 2000) throw `${where}: text.content length ${t.text.content.length} > 2000`
      if (t.text?.link && !/^https?:\/\//.test(t.text.link.url)) throw `${where}: invalid link url`
    }
  }

  function validateBlocks(blocks, depth, where) {
    if (blocks.length > 100) throw `${where}: ${blocks.length} children (max 100)`
    for (const [i, b] of blocks.entries()) {
      const data = b[b.type]
      if (!data) throw `${where}[${i}]: missing ${b.type} body`
      if (data.rich_text) validateRich(data.rich_text, `${where}[${i}].${b.type}`)
      if (b.type === 'table_row') data.cells.forEach((c, j) => validateRich(c, `${where}[${i}].cell${j}`))
      if (b.type === 'image' && !/^https?:\/\//.test(data.external?.url)) throw `${where}[${i}]: invalid image url`
      if (b.type === 'table' && !data.children?.length) throw `${where}[${i}]: table needs rows`
      if (data.children) {
        if (depth >= 2) throw `${where}[${i}]: nesting deeper than 2 levels`
        validateBlocks(data.children, depth + 1, `${where}[${i}]`)
      }
    }
  }

  const count = bs => bs.reduce((n, b) => n + 1 + count(b[b.type].children || []), 0)
  const withPlain = rich => rich.map(t => ({ ...t, plain_text: t.text.content }))

  function store(blocks) {
    return blocks.map(b => {
      const data = structuredClone(b[b.type])
      delete data.children
      for (const key of ['rich_text', 'caption']) if (data[key]) data[key] = withPlain(data[key])
      if (data.cells) data.cells = data.cells.map(withPlain)
      const block = { object: 'block', id: randomUUID(), type: b.type, has_children: !!b[b.type].children, [b.type]: data }
      // Nested blocks are addressable like pages.
      pages.set(block.id, { blocks: store(b[b.type].children || []) })
      return block
    })
  }

  function addChildren(page, children) {
    validateBlocks(children, 1, 'children')
    if (count(children) > 1000) throw 'more than 1000 blocks in one request'
    if (JSON.stringify(children).length > 500_000) throw 'payload over 500KB'
    page.blocks.push(...store(children))
  }

  function validateProperties(schema, properties) {
    for (const [name, value] of Object.entries(properties || {})) {
      if (!schema[name]) throw `${name} is not a property that exists.`
      const type = schema[name].type
      if (!(type in value)) throw `${name} is expected to be ${type}.`
      if (type === 'title') validateRich(value.title, name)
      if (type === 'status' && !schema[name].options.includes(value.status?.name)) throw `Invalid status option "${value.status?.name}".`
    }
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', ...headers })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    if (req.method === 'OPTIONS') return send(204)
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    const url = new URL(req.url, 'http://x')
    requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization })

    // OAuth: the consent screen approves immediately and redirects with a code.
    if (url.pathname === '/v1/oauth/authorize') {
      const q = url.searchParams
      if (q.get('client_id') !== OAUTH.clientId || q.get('response_type') !== 'code' || q.get('owner') !== 'user') return send(400, { error: 'invalid_request' })
      const target = new URL(q.get('redirect_uri'))
      target.searchParams.set('code', OAUTH.code)
      target.searchParams.set('state', q.get('state'))
      res.writeHead(302, { Location: target.href })
      return res.end()
    }
    if (url.pathname === '/v1/oauth/token' && req.method === 'POST') {
      const expected = `Basic ${Buffer.from(`${OAUTH.clientId}:${OAUTH.clientSecret}`).toString('base64')}`
      if (req.headers.authorization !== expected) return send(401, { error: 'invalid_client' })
      if (body.grant_type !== 'authorization_code' || body.code !== OAUTH.code || !body.redirect_uri) return send(400, { error: 'invalid_grant' })
      const ws = workspaces[OAUTH.token]
      return send(200, { access_token: OAUTH.token, token_type: 'bearer', bot_id: ws.botId, workspace_id: 'ws-2', workspace_name: ws.name, workspace_icon: null, owner: { type: 'user' } })
    }

    if (state.rateLimitEvery && ++state.served % state.rateLimitEvery === 0) return send(429, { code: 'rate_limited', message: 'Rate limited' }, { 'Retry-After': '0.05' })
    const ws = workspaces[(req.headers.authorization || '').replace(/^Bearer /, '')]
    if (!ws) return send(401, { code: 'unauthorized', message: 'API token is invalid.' })
    if (!req.headers['notion-version']) return send(400, { code: 'missing_version', message: 'Notion-Version header missing' })
    try {
      let m
      if (req.method === 'GET' && url.pathname === '/v1/users/me') {
        return send(200, { object: 'user', id: ws.botId, type: 'bot', name: 'Proofclip', bot: { owner: { type: 'workspace', workspace: true }, workspace_name: ws.name } })
      }
      if (req.method === 'POST' && url.pathname === '/v1/search') {
        const query = (body?.query || '').toLowerCase()
        let results = [
          ...Object.entries(ws.databases).map(([id, db]) => databaseObject(id, db)),
          ...Object.entries(ws.pages).map(([id, p]) => pageObject(id, p)),
        ]
        if (body?.filter?.value) results = results.filter(r => r.object === body.filter.value)
        if (query) results = results.filter(r => (r.object === 'database' ? r.title : r.properties.title.title)[0].plain_text.toLowerCase().includes(query))
        return send(200, { results, has_more: false, next_cursor: null })
      }
      if (req.method === 'POST' && url.pathname === '/v1/databases') {
        if (!ws.pages[body.parent?.page_id]) return send(404, { code: 'object_not_found', message: 'Could not find page' })
        const titles = Object.values(body.properties || {}).filter(p => 'title' in p)
        if (titles.length !== 1) throw 'A database needs exactly one title property.'
        const id = randomUUID()
        const properties = Object.fromEntries(Object.entries(body.properties).map(([name, p]) => {
          const type = Object.keys(p)[0]
          return [name, { type, ...(p[type]?.options && { options: p[type].options.map(o => o.name) }) }]
        }))
        ws.databases[id] = { title: body.title?.map(t => t.text.content).join('') || 'Untitled', icon: body.icon?.emoji, properties }
        return send(200, databaseObject(id, ws.databases[id]))
      }
      if ((m = url.pathname.match(/^\/v1\/databases\/([^/]+)$/))) {
        const db = ws.databases[m[1]]
        if (!db) return send(404, { code: 'object_not_found', message: 'Could not find database' })
        if (req.method === 'PATCH') {
          if (state.denySchemaEdits) return send(403, { code: 'restricted_resource', message: 'Insufficient permissions to update database schema' })
          for (const [name, p] of Object.entries(body.properties || {})) db.properties[name] = { type: Object.keys(p)[0] }
        }
        return send(200, databaseObject(m[1], db))
      }
      if (req.method === 'POST' && url.pathname === '/v1/pages') {
        if (state.failCreates > 0) { state.failCreates--; return send(502, { code: 'bad_gateway', message: 'Bad gateway' }) }
        const parent = body.parent || {}
        if (parent.database_id) {
          const db = ws.databases[parent.database_id]
          if (!db) return send(404, { code: 'object_not_found', message: 'Could not find database' })
          validateProperties(db.properties, body.properties)
        } else if (parent.page_id) {
          if (!ws.pages[parent.page_id]) return send(404, { code: 'object_not_found', message: 'Could not find page' })
          const keys = Object.keys(body.properties || {})
          if (keys.some(k => k !== 'title')) throw 'Pages under a page can only have a title property.'
        } else throw 'parent is required'
        const page = { root: true, id: randomUUID(), url: 'https://www.notion.so/mock-page', parent, workspace: ws.name, properties: body.properties, blocks: [] }
        addChildren(page, body.children || [])
        pages.set(page.id, page)
        return send(200, { object: 'page', id: page.id, url: page.url })
      }
      if ((m = url.pathname.match(/^\/v1\/blocks\/([^/]+)\/children$/))) {
        const page = pages.get(m[1])
        if (!page) return send(404, { code: 'object_not_found', message: 'Could not find block' })
        if (req.method === 'PATCH') {
          if (state.failAppends > 0) { state.failAppends--; return send(503, { code: 'service_unavailable', message: 'Notion is unavailable' }) }
          addChildren(page, body.children)
          return send(200, { results: [] })
        }
        const size = Number(url.searchParams.get('page_size') || 100)
        const start = Number(url.searchParams.get('start_cursor') || 0)
        const results = page.blocks.slice(start, start + size)
        const more = start + size < page.blocks.length
        return send(200, { results, has_more: more, next_cursor: more ? String(start + size) : null })
      }
      send(404, { code: 'object_not_found', message: `No route ${req.method} ${url.pathname}` })
    } catch (e) {
      send(400, { code: 'validation_error', message: String(e) })
    }
  })

  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        roots: () => [...pages.values()].filter(p => p.root),
        workspaces,
        pages,
        requests,
        state,
        token,
        close: () => server.close(),
      }),
    ),
  )
}
