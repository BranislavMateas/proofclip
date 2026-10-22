import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { readFileSync } from 'node:fs'
import { htmlToBlocks } from '../extension/lib/convert.js'
import { createClient } from '../extension/lib/notion.js'
import { newClip, uploadClip, storage, isDue } from '../extension/lib/clips.js'
import { buildProperties, editableProperties, autofill } from '../extension/lib/properties.js'
import { startMockNotion, DB_ID, NO_URL_DB_ID, PAGE_ID, OAUTH } from './mock-notion.js'
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
  const props = editableProperties(await client.getDatabase(DB_ID))
  const values = autofill(props, { title: 'Big article', url: 'https://example.com/a', byline: 'Jo' }, { Tags: ['research'] })
  return { client, clip: newClip({ source: 'article', title: 'Big article', url: 'https://example.com/a', blocks, markdown: '', destination: { type: 'database', id: DB_ID, title: 'Reading list' }, connectionId: 'c1', properties: buildProperties(props, values) }) }
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

test('failed appends resume without duplicating the page or blocks', async () => {
  const { client, clip } = await makeClip(fixture)
  const store = storage(memoryArea())
  mock.state.failAppends = 1
  const pagesBefore = mock.roots().length
  await uploadClip(clip, client, store.put)
  assert.equal(clip.status, 'failed')
  assert.equal(clip.retryable, true)
  assert.match(clip.error, /unavailable/)
  assert.ok(clip.pageId && clip.uploadedBatches === 1)
  assert.ok(clip.nextRetryAt > Date.now())
  assert.equal(isDue(clip), false)
  assert.equal(isDue(clip, clip.nextRetryAt), true)
  await uploadClip(clip, client, store.put)
  assert.equal(clip.status, 'verified', clip.error)
  assert.equal(mock.roots().length, pagesBefore + 1)
  assert.equal(mock.pages.get(clip.pageId).blocks.length, clip.blocks.length)
})

test('a failed create retries; validation errors do not auto-retry', async () => {
  const { client, clip } = await makeClip('<p>short</p>')
  mock.state.failCreates = 1
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
  await assert.rejects(client.createPage({ parent: { database_id: DB_ID }, properties: {}, children: [tooLong] }), /2000/)
  const deep = { object: 'block', type: 'paragraph', paragraph: { rich_text: [], children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [], children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }] } }] } }
  await assert.rejects(client.createPage({ parent: { database_id: DB_ID }, properties: {}, children: [deep] }), /nesting/)
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
  assert.deepEqual(all.map(d => `${d.type}:${d.title}`).sort(), ['database:Ideas', 'database:Reading list', 'page:Research notes'])
  assert.deepEqual((await client.search('resea')).map(d => d.title), ['Research notes'])
  const db = await client.createDatabase(PAGE_ID, 'Links')
  const schema = editableProperties(await client.getDatabase(db.id))
  assert.deepEqual(schema.map(p => `${p.name}:${p.type}`), ['Name:title', 'URL:url', 'Tags:multi_select'])
  const other = createClient({ token: OAUTH.token, apiBase: mock.url })
  assert.deepEqual((await other.search()).map(d => d.title), ['Team wiki'])
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
