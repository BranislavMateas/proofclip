// Minimal Notion API client. `apiBase` is configurable for tests.

export const NOTION_VERSION = '2022-06-28'

export class NotionError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }

  // Validation, auth and permission errors will fail again on retry.
  get retryable() {
    return this.status === 0 || this.status === 409 || this.status === 429 || this.status >= 500
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
    const data = await res.json().catch(() => ({}))
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
    // Pages and databases the user can clip into, most recently edited first.
    async search(query = '') {
      const page = await request('POST', '/search', { query, page_size: 50, sort: { direction: 'descending', timestamp: 'last_edited_time' } })
      return page.results.filter(r => !r.archived && !r.in_trash).map(toDestination)
    },
    getDatabase: id => request('GET', `/databases/${id}`),
    createDatabase: (parentPageId, title) =>
      request('POST', '/databases', {
        parent: { type: 'page_id', page_id: parentPageId },
        icon: { type: 'emoji', emoji: '🔗' },
        title: [{ type: 'text', text: { content: title } }],
        properties: { Name: { title: {} }, URL: { url: {} }, Tags: { multi_select: { options: [] } }, Created: { created_time: {} } },
      }),
    addProperty: (databaseId, name, type) => request('PATCH', `/databases/${databaseId}`, { properties: { [name]: { [type]: {} } } }),
    createPage: body => request('POST', '/pages', body),
    appendChildren: (id, children) => request('PATCH', `/blocks/${id}/children`, { children }),
    listChildren: id =>
      paginate(cursor => request('GET', `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`)),
  }
}

const plainText = rich => (rich || []).map(t => t.plain_text).join('')

export function toDestination(r) {
  const title = r.object === 'database' ? plainText(r.title) : plainText(Object.values(r.properties || {}).find(p => p.type === 'title')?.title)
  return { id: r.id, type: r.object, title: title || 'Untitled', icon: r.icon?.type === 'emoji' ? r.icon.emoji : '' }
}
