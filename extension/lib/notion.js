// Minimal Notion API client. `apiBase` is configurable for tests.

export const NOTION_VERSION = '2026-03-11'

export class NotionError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }

  // Validation, auth and permission errors will fail again on retry.
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

export function createClient({ token, apiBase = 'https://api.notion.com', fetchImpl = (...args) => fetch(...args), maxRateLimitWaits = 4 }) {
  async function request(method, path, body) {
    // Notion allows ~3 requests/second; honour Retry-After instead of failing.
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(method, path, body)
      } catch (e) {
        if (e.status !== 429 || attempt >= maxRateLimitWaits) throw e
        await sleep(Math.min(30, e.retryAfter || 2 ** attempt) * 1000)
      }
    }
  }

  async function send(method, path, body) {
    let res
    try {
      res = await fetchImpl(`${apiBase.replace(/\/$/, '')}/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (e) {
      throw new NotionError(0, 'network_error', `Network error: ${e.message}`)
    }
    let data
    try {
      data = await res.json()
    } catch {
      throw new NotionError(0, 'invalid_response', 'Notion returned an unreadable response. The request may have completed.')
    }
    if (!res.ok) {
      const error = new NotionError(res.status, data.code || 'http_error', data.message || `HTTP ${res.status}`)
      error.retryAfter = Number(res.headers.get('Retry-After')) || 0
      throw error
    }
    return data
  }

  async function paginate(fetchPage) {
    const results = []
    let cursor
    do {
      const page = await fetchPage(cursor)
      results.push(...page.results)
      cursor = page.has_more ? page.next_cursor : undefined
    } while (cursor)
    return results
  }

  return {
    me: () => request('GET', '/users/me'),
    // Search returns each data source separately, including multi-source databases.
    async search(query = '') {
      const results = await paginate(cursor => request('POST', '/search', { query, page_size: 100, ...(cursor && { start_cursor: cursor }), sort: { direction: 'descending', timestamp: 'last_edited_time' } }))
      return results.filter(r => !r.in_trash && ['page', 'data_source'].includes(r.object)).map(toDestination)
    },
    getDatabase: id => request('GET', `/databases/${id}`),
    getDataSource: id => request('GET', `/data_sources/${id}`),
    async resolveDestination(destination) {
      if (destination.type !== 'database') return destination
      const db = await request('GET', `/databases/${destination.id}`)
      if (db.data_sources?.length !== 1) {
        throw new NotionError(400, 'choose_data_source', 'This database has multiple data sources. Search for the database and choose a data source.')
      }
      return { ...destination, type: 'data_source', id: db.data_sources[0].id, databaseId: db.id }
    },
    createDatabase: (parentPageId, title) =>
      request('POST', '/databases', {
        parent: { type: 'page_id', page_id: parentPageId },
        icon: { type: 'emoji', emoji: '🔗' },
        title: [{ type: 'text', text: { content: title } }],
        initial_data_source: { properties: { Name: { title: {} }, URL: { url: {} }, Tags: { multi_select: { options: [] } }, Created: { created_time: {} } } },
      }),
    addProperty: (dataSourceId, name, type) => request('PATCH', `/data_sources/${dataSourceId}`, { properties: { [name]: { [type]: {} } } }),
    createPage: body => request('POST', '/pages', body),
    updatePage: (id, properties) => request('PATCH', `/pages/${id}`, { properties }),
    // A temporary, unique title survives a lost create response. Do not use
    // search indexing for recovery: read the actual parent instead.
    async findCreatedPage(destination, marker, titleProperty) {
      if (destination.type === 'data_source') {
        const results = await paginate(cursor => request('POST', `/data_sources/${destination.id}/query`, {
          filter: { property: titleProperty, title: { equals: marker } }, page_size: 100,
          ...(cursor && { start_cursor: cursor }),
        }))
        return results.filter(p => !p.in_trash)
      }
      const children = await paginate(cursor => request('GET', `/blocks/${destination.id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`))
      return children.filter(b => !b.in_trash && b.type === 'child_page' && b.child_page.title === marker)
        .map(b => ({ id: b.id, url: `https://www.notion.so/${b.id.replace(/-/g, '')}` }))
    },
    appendChildren: (id, children) => request('PATCH', `/blocks/${id}/children`, { children }),
    listChildren: id =>
      paginate(cursor => request('GET', `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`)),
  }
}

const plainText = rich => (rich || []).map(t => t.plain_text ?? t.text?.content ?? '').join('')

export function toDestination(r) {
  const title = ['database', 'data_source'].includes(r.object) ? plainText(r.title) : plainText(Object.values(r.properties || {}).find(p => p.type === 'title')?.title)
  return { id: r.id, type: r.object, title: title || 'Untitled', icon: r.icon?.type === 'emoji' ? r.icon.emoji : '', ...(r.object === 'data_source' && { databaseId: r.parent.database_id }) }
}
