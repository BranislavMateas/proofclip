import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { readFileSync } from 'node:fs'
import { htmlToBlocks } from '../extension/lib/convert.js'
import { createClient, NOTION_VERSION, NotionError } from '../extension/lib/notion.js'
import { newClip, uploadClip, storage, isDue } from '../extension/lib/clips.js'
import { buildProperties, editableProperties, autofill } from '../extension/lib/properties.js'
import { startMockNotion, DB_ID, NO_URL_DB_ID, DS_ID, NO_URL_DS_ID, PAGE_ID, OAUTH } from './mock-notion.js'
import worker from '../server/oauth-worker.js'

let mock
before(async () => { mock = await startMockNotion() })
after(() => mock.close())

const memoryArea = () => {
  const data = {}
  return {
    async get(key) { return key === null ? structuredClone(data) : key in data ? { [key]: structuredClone(data[key]) } : {} },
    async set(obj) { Object.assign(data, structuredClone(obj)) },
    async remove(key) { delete data[key] },
  }
}

async function makeClip(html) {
  const { document } = parseHTML(`<html><body><main>${html}</main></body></html>`)
  const blocks = htmlToBlocks(document.querySelector('main'), { baseUrl: 'https://example.com/a' })
  const client = createClient({ token: mock.token, apiBase: mock.url })
  const props = editableProperties(await client.getDataSource(DS_ID))
  const values = autofill(props, { title: 'Big article', url: 'https://example.com/a', byline: 'Jo' }, { Tags: ['research'] })
  return { client, clip: newClip({ source: 'article', title: 'Big article', url: 'https://example.com/a', blocks, markdown: '', destination: { type: 'data_source', id: DS_ID, title: 'Reading list' }, connectionId: 'c1', properties: buildProperties(props, values) }) }
}

const fixture = readFileSync(new URL('./fixtures/long-article.html', import.meta.url), 'utf8')

test('a long real-world article uploads in batches and verifies', async () => {
  const { client, clip } = await makeClip(fixture)
  assert.ok(clip.blocks.length > 100, `fixture should need multiple batches, got ${clip.blocks.length}`)
  const store = storage(memoryArea())
  await uploadClip(clip, client, store.put)
  assert.equal(clip.status, 'verified', clip.error || clip.verifyNote)
  const page = mock.pages.get(clip.pageId)
  assert.equal(page.blocks.length, clip.blocks.length)
  assert.deepEqual(page.properties.Tags, { multi_select: [{ name: 'research' }] })
  assert.equal(page.properties.Author.rich_text[0].text.content, 'Jo')
  assert.equal((await store.get(clip.id)).status, 'verified')
})

test('lost append responses recover without duplicating the page or blocks', async () => {
  const { client, clip } = await makeClip(fixture)
  const store = storage(memoryArea())
  mock.state.dropAppends = 1
  const pagesBefore = mock.roots().length
  await uploadClip(clip, client, store.put)
  assert.equal(clip.status, 'failed')
  assert.equal(clip.retryable, true)
  assert.match(clip.error, /unreadable response/)
  assert.ok(clip.pageId && clip.uploadedBatches === 1)
  assert.ok(clip.nextRetryAt > Date.now())
  assert.equal(isDue(clip), false)
  assert.equal(isDue(clip, clip.nextRetryAt), true)
  await uploadClip(clip, client, store.put)
  assert.equal(clip.status, 'verified', clip.error)
  assert.equal(mock.roots().length, pagesBefore + 1)
  assert.equal(mock.pages.get(clip.pageId).blocks.length, clip.blocks.length)
})

test('a lost create response recovers; validation errors do not auto-retry', async () => {
  const { client, clip } = await makeClip('<p>short</p>')
  mock.state.dropCreates = 1
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.status, 'failed')
  assert.equal(clip.pageId, null)
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.status, 'verified')

  const bad = (await makeClip('<p>x</p>')).clip
  bad.properties.Nope = { rich_text: [] }
  await uploadClip(bad, client, async () => {})
  assert.equal(bad.status, 'failed')
  assert.equal(bad.retryable, false)
  assert.match(bad.error, /Nope is not a property/)
})

test('bad token is reported and not retried', async () => {
  const { clip } = await makeClip('<p>x</p>')
  const client = createClient({ token: 'wrong', apiBase: mock.url })
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.retryable, false)
  assert.match(clip.error, /token is invalid/)
})

test('mock rejects what Notion would reject (sanity check of the harness)', async () => {
  const client = createClient({ token: mock.token, apiBase: mock.url })
  const tooLong = { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'x'.repeat(2001) } }] } }
  await assert.rejects(client.createPage({ parent: { data_source_id: DS_ID }, properties: {}, children: [tooLong] }), /2000/)
  const deep = { object: 'block', type: 'paragraph', paragraph: { rich_text: [], children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [], children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }] } }] } }
  await assert.rejects(client.createPage({ parent: { data_source_id: DS_ID }, properties: {}, children: [deep] }), /nesting/)
})

test('verification catches a nested block that Notion altered', async () => {
  const { client, clip } = await makeClip('<ul><li>parent<ul><li>child</li></ul></li></ul><table><tr><td>a</td><td>b</td></tr></table>')
  const tampering = { ...client, listChildren: async id => {
    const blocks = await client.listChildren(id)
    for (const b of blocks) if (b.type === 'table_row') b.table_row.cells[1][0].plain_text = 'B'
    return blocks
  } }
  await uploadClip(clip, tampering, async () => {})
  assert.equal(clip.status, 'mismatch')
  assert.match(clip.verifyNote, /Inside block 2: Block 1 \(table_row\)/)
  const ok = (await makeClip('<ul><li>parent<ul><li>child</li></ul></li></ul>')).clip
  await uploadClip(ok, client, async () => {})
  assert.equal(ok.verifyNote, 'All 2 blocks match.')
})

const pageClip = (destination, properties, extra = {}) =>
  newClip({ source: 'article', title: 'T', url: 'https://example.com/p', blocks: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'hi' } }] } }], markdown: '', destination, connectionId: 'c1', properties, ...extra })

test('saving under a plain page uses page_id and a title-only payload', async () => {
  const client = createClient({ token: mock.token, apiBase: mock.url })
  const clip = pageClip({ type: 'page', id: PAGE_ID, title: 'Research notes' }, { title: { title: [{ type: 'text', text: { content: 'T' } }] } })
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.status, 'verified', clip.error)
  const saved = mock.pages.get(clip.pageId)
  assert.deepEqual(saved.parent, { page_id: PAGE_ID })
})

test('a database without a URL property gets one, like Notion\'s clipper', async () => {
  const client = createClient({ token: mock.token, apiBase: mock.url })
  const clip = pageClip({ type: 'database', id: NO_URL_DB_ID, title: 'Ideas' }, { Title: { title: [{ type: 'text', text: { content: 'T' } }] } }, { ensureUrlProperty: 'URL' })
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.status, 'verified', clip.error)
  assert.equal(mock.workspaces.secret_test.databases[NO_URL_DB_ID].properties.URL.type, 'url')
  assert.deepEqual(mock.pages.get(clip.pageId).properties.URL, { url: 'https://example.com/p' })
  delete mock.workspaces.secret_test.databases[NO_URL_DB_ID].properties.URL
})

test('without schema permission the clip still saves, with a note', async () => {
  const client = createClient({ token: mock.token, apiBase: mock.url })
  mock.state.denySchemaEdits = true
  const clip = pageClip({ type: 'database', id: NO_URL_DB_ID, title: 'Ideas' }, { Title: { title: [] } }, { ensureUrlProperty: 'URL' })
  await uploadClip(clip, client, async () => {})
  mock.state.denySchemaEdits = false
  assert.equal(clip.status, 'verified', clip.error)
  assert.match(clip.urlPropertyNote, /Insufficient permissions/)
  assert.equal(mock.pages.get(clip.pageId).properties.URL, undefined)
})

test('search, workspace identity and new links database', async () => {
  const client = createClient({ token: mock.token, apiBase: mock.url })
  assert.equal((await client.me()).bot.workspace_name, 'Acme Personal')
  const all = await client.search()
  assert.deepEqual(all.map(d => `${d.type}:${d.title}`).sort(), ['data_source:Ideas', 'data_source:Reading list', 'page:Research notes'])
  assert.deepEqual((await client.search('resea')).map(d => d.title), ['Research notes'])
  const db = await client.createDatabase(PAGE_ID, 'Links')
  const schema = editableProperties(await client.getDataSource(db.data_sources[0].id))
  assert.deepEqual(schema.map(p => `${p.name}:${p.type}`), ['Name:title', 'URL:url', 'Tags:multi_select'])
  const other = createClient({ token: OAUTH.token, apiBase: mock.url })
  assert.deepEqual((await other.search()).map(d => d.title), ['Team wiki'])
})

test('lost create responses recover after a storage reload for page and data source destinations', async () => {
  const client = createClient({ token: mock.token, apiBase: mock.url })
  for (const destination of [{ type: 'page', id: PAGE_ID }, { type: 'data_source', id: DS_ID }]) {
    const property = destination.type === 'page' ? 'title' : 'Name'
    const clip = pageClip(destination, { [property]: { title: [{ type: 'text', text: { content: 'Restored title' } }] } })
    const store = storage(memoryArea())
    const before = mock.roots().length
    mock.state.dropCreates = 1
    await uploadClip(clip, client, store.put)
    const reloaded = await store.get(clip.id)
    assert.equal(reloaded.createPending, true)
    assert.equal(reloaded.pageId, null)
    assert.equal(mock.roots().length, before + 1)
    const pending = mock.roots().at(-1)
    assert.equal(pending.properties[property].title[0].text.content, reloaded.createMarker)
    await uploadClip(reloaded, client, store.put)
    assert.equal(reloaded.status, 'verified', reloaded.error)
    assert.equal(reloaded.pageId, pending.id)
    assert.equal(mock.roots().length, before + 1)
    assert.equal(pending.properties[property].title[0].text.content, 'Restored title')
  }
})

test('recovery waits for a hidden page instead of issuing another create', async () => {
  const { client, clip } = await makeClip('<p>x</p>')
  mock.state.dropCreates = 1
  await uploadClip(clip, client, async () => {})
  const before = mock.requests.filter(r => r.path === '/v1/pages' && r.method === 'POST').length
  await uploadClip(clip, { ...client, findCreatedPage: async () => [] }, async () => {})
  assert.equal(clip.status, 'failed')
  assert.match(clip.error, /not visible yet/)
  assert.equal(mock.requests.filter(r => r.path === '/v1/pages' && r.method === 'POST').length, before)
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.status, 'verified', clip.error)
})

test('an ambiguous server error without a page never triggers another create', async () => {
  const { client, clip } = await makeClip('<p>x</p>')
  const before = mock.roots().length
  mock.state.failCreates = 1
  await uploadClip(clip, client, async () => {})
  const requests = mock.requests.length
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.status, 'failed')
  assert.match(clip.error, /previous save is uncertain/)
  assert.equal(mock.roots().length, before)
  assert.ok(mock.requests.slice(requests).every(r => r.path !== '/v1/pages'))
})

test('a definite rate limit rejection can retry creation', async () => {
  const { client, clip } = await makeClip('<p>x</p>')
  await uploadClip(clip, { ...client, createPage: async () => { throw new NotionError(429, 'rate_limited', 'Rate limited') } }, async () => {})
  assert.equal(clip.createPending, false)
  assert.equal(clip.retryable, true)
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.status, 'verified', clip.error)
})

test('a lost title update response resumes with the persisted page ID', async () => {
  const { client, clip } = await makeClip('<p>x</p>')
  const store = storage(memoryArea())
  const before = mock.roots().length
  mock.state.dropUpdates = 1
  await uploadClip(clip, client, store.put)
  assert.equal(clip.status, 'failed')
  assert.ok(clip.pageId)
  const reloaded = await store.get(clip.id)
  await uploadClip(reloaded, client, store.put)
  assert.equal(reloaded.status, 'verified', reloaded.error)
  assert.equal(mock.roots().length, before + 1)
})

test('a lost append response resumes after storage reload; absent or altered blocks are never appended twice', async () => {
  const { client, clip } = await makeClip(fixture)
  const store = storage(memoryArea())
  mock.state.dropAppends = 1
  await uploadClip(clip, client, store.put)
  const reloaded = await store.get(clip.id)
  assert.ok(reloaded.pendingAppend)
  const before = mock.requests.filter(r => r.method === 'PATCH' && r.path.endsWith('/children')).length
  await uploadClip(reloaded, { ...client, listChildren: async () => [] }, store.put)
  assert.equal(reloaded.status, 'failed')
  assert.match(reloaded.error, /previous block upload is uncertain/)
  assert.equal(mock.requests.filter(r => r.method === 'PATCH' && r.path.endsWith('/children')).length, before)
  await uploadClip(reloaded, client, store.put)
  assert.equal(reloaded.status, 'verified', reloaded.error)
  assert.equal(mock.pages.get(reloaded.pageId).blocks.length, clip.blocks.length)
})

test('legacy uncertain saves cannot silently create another page', async () => {
  const { client, clip } = await makeClip('<p>x</p>')
  delete clip.createPending
  clip.attempts = 1
  const before = mock.roots().length
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.status, 'failed')
  assert.equal(clip.retryable, false)
  assert.match(clip.error, /earlier version/)
  assert.equal(mock.roots().length, before)
})

test('multi-source databases list separate destinations, schemas and parents', async () => {
  const client = createClient({ token: mock.token, apiBase: mock.url })
  const databaseId = 'multi-db'
  const db = mock.workspaces.secret_test.databases[databaseId] = {
    title: 'Multi',
    sources: [
      { id: 'multi-articles', title: 'Articles', properties: { Article: { type: 'title' } } },
      { id: 'multi-bookmarks', title: 'Bookmarks', properties: { Bookmark: { type: 'title' }, Link: { type: 'url' } } },
    ],
  }
  try {
    const destinations = await client.search('Multi')
    assert.deepEqual(destinations.map(d => [d.id, d.type, d.title, d.databaseId]), [
      ['multi-articles', 'data_source', 'Articles', databaseId],
      ['multi-bookmarks', 'data_source', 'Bookmarks', databaseId],
    ])
    await assert.rejects(client.resolveDestination({ type: 'database', id: databaseId }), /choose a data source/)
    for (const dest of destinations) {
      const schema = editableProperties(await client.getDataSource(dest.id))
      const property = schema.find(p => p.type === 'title').name
      const clip = pageClip(dest, { [property]: { title: [] } }, dest.id === 'multi-articles' ? { ensureUrlProperty: 'Source URL' } : {})
      mock.state.dropCreates = 1
      await uploadClip(clip, client, async () => {})
      await uploadClip(clip, client, async () => {})
      assert.equal(clip.status, 'verified', clip.error)
      assert.deepEqual(mock.pages.get(clip.pageId).parent, { data_source_id: dest.id })
    }
    assert.equal(db.sources[0].properties['Source URL'].type, 'url')
    assert.equal(db.sources[1].properties['Source URL'], undefined)
    assert.ok(mock.requests.filter(r => r.path !== '/v1/oauth/token').every(r => r.version === NOTION_VERSION))
  } finally {
    delete mock.workspaces.secret_test.databases[databaseId]
  }
})

test('unreadable successful responses preserve uncertain creation for recovery', async () => {
  const { clip } = await makeClip('<p>x</p>')
  const client = createClient({ token: 't', fetchImpl: async () => new Response('truncated', { status: 200 }) })
  await uploadClip(clip, client, async () => {})
  assert.equal(clip.createPending, true)
  assert.match(clip.error, /unreadable response/)
})

test('destination search follows pagination and excludes trashed sources', async () => {
  const cursors = []
  const source = (id, in_trash = false) => ({ object: 'data_source', id, title: [{ plain_text: id }], parent: { database_id: 'db' }, in_trash })
  const client = createClient({ token: 't', fetchImpl: async (_url, options) => {
    const { start_cursor: cursor } = JSON.parse(options.body)
    cursors.push(cursor)
    return Response.json(cursor ? { results: [source('second'), source('trashed', true)], has_more: false } : { results: [source('first')], has_more: true, next_cursor: 'next' })
  } })
  assert.deepEqual((await client.search()).map(d => d.id), ['first', 'second'])
  assert.deepEqual(cursors, [undefined, 'next'])
})

test('oauth worker exchanges a code with the client secret and enforces origin', async () => {
  const env = { NOTION_CLIENT_ID: OAUTH.clientId, NOTION_CLIENT_SECRET: OAUTH.clientSecret, NOTION_API: mock.url }
  const call = (origin, body) => worker.fetch(new Request('https://w.example/exchange', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env)
  const ok = await call('chrome-extension://abc', { code: OAUTH.code, redirect_uri: 'https://abc.chromiumapp.org/notion' })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('access-control-allow-origin'), 'chrome-extension://abc')
  assert.equal((await ok.json()).access_token, OAUTH.token)
  assert.equal((await call('https://evil.example', { code: OAUTH.code, redirect_uri: 'x' })).status, 403)
  assert.equal((await call('chrome-extension://abc', { code: 'wrong', redirect_uri: 'x' })).status, 400)
  assert.equal((await worker.fetch(new Request('https://w.example/exchange', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc' } }), env)).status, 204)
})

test('rate limits are waited out using Retry-After', async () => {
  const { client, clip } = await makeClip(fixture)
  mock.state.rateLimitEvery = 3
  await uploadClip(clip, client, async () => {})
  mock.state.rateLimitEvery = 0
  assert.equal(clip.status, 'verified', clip.error)
  assert.equal(clip.attempts, 1)
})
