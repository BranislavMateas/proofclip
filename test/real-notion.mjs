// Runs the upload pipeline against the real Notion API.
//
//   NOTION_TOKEN=ntn_… NOTION_PAGE_ID=<page shared with the integration> node test/real-notion.mjs
//
// Values can also live in proofclip/.env.test (KEY=value lines, git-ignored).
// Everything it creates is moved to Notion's trash at the end (KEEP=1 to keep).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { htmlToBlocks, stats } from '../extension/lib/convert.js'
import { createClient, NOTION_VERSION } from '../extension/lib/notion.js'
import { newClip, uploadClip } from '../extension/lib/clips.js'
import { editableProperties, autofill, buildProperties } from '../extension/lib/properties.js'

const envFile = new URL('../.env.test', import.meta.url)
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
const { NOTION_TOKEN: token, NOTION_PAGE_ID: rawPageId, KEEP, NOTION_API: apiBase = 'https://api.notion.com' } = process.env
if (!token || !rawPageId) {
  console.log('Skipped: set NOTION_TOKEN and NOTION_PAGE_ID (or create .env.test).')
  process.exit(0)
}
const pageId = rawPageId.replace(/^.*?([0-9a-f]{32}|[0-9a-f-]{36})(?:\?.*)?$/i, '$1')

const LIVE_URLS = [
  'https://en.wikipedia.org/wiki/Chrome_Web_Store',
  'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch',
  'https://paulgraham.com/startupideas.html',
  'https://docs.python.org/3/tutorial/classes.html',
  'https://simonwillison.net/',
  'https://en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal)',
]

const client = createClient({ token, apiBase })
const recoveryOnly = process.argv.includes('--recovery-only')
const created = []
const step = msg => console.log(`✓ ${msg}`)
let failures = 0

async function save(label, html, url, destination, propsFor) {
  const { document } = parseHTML(html)
  const article = new Readability(document).parse()
  const { document: doc } = parseHTML(`<html><body>${article?.content || html}</body></html>`)
  const blocks = htmlToBlocks(doc.body, { baseUrl: url })
  const clip = newClip({ source: 'article', title: article?.title || label, url, blocks, markdown: '', destination, connectionId: 'real', properties: propsFor(article?.title || label, url, article) })
  const started = Date.now()
  await uploadClip(clip, client, async () => {})
  if (clip.pageId) created.push({ kind: 'pages', id: clip.pageId })
  const s = stats(blocks)
  const ok = clip.status === 'verified'
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${clip.status.padEnd(8)} ${label} — ${s.words} words, ${s.blocks} blocks, ${s.images} images, ${((Date.now() - started) / 1000).toFixed(1)}s${ok ? '' : `\n    ${clip.error || clip.verifyNote}`}`)
  return clip
}

async function recoveryProbe(destination, titleProperty) {
  let loseCreate = true
  let loseAppend = true
  const faultyClient = createClient({ token, apiBase, fetchImpl: async (url, options) => {
    const response = await fetch(url, options)
    if (response.ok && options.method === 'POST' && url.endsWith('/v1/pages') && loseCreate) {
      loseCreate = false
      const page = await response.clone().json()
      created.push({ kind: 'pages', id: page.id })
      throw new Error('Simulated lost create response after Notion committed the page')
    }
    if (response.ok && options.method === 'PATCH' && url.endsWith('/children') && loseAppend) {
      loseAppend = false
      await response.text()
      throw new Error('Simulated lost append response after Notion committed the blocks')
    }
    return response
  } })
  const clip = newClip({ source: 'article', title: 'Recovery test', url: 'https://example.com/recovery', markdown: '', connectionId: 'real', destination,
    properties: { [titleProperty]: { title: [{ type: 'text', text: { content: 'Recovery test' } }] } },
    blocks: Array.from({ length: 101 }, (_, i) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `Recovery block ${i}` } }] } })),
  })
  let snapshot
  const persist = async value => { snapshot = structuredClone(value) }
  await uploadClip(clip, faultyClient, persist)
  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.createPending, true)
  for (let i = 0; i < 5 && snapshot.status !== 'verified'; i++) {
    await uploadClip(structuredClone(snapshot), faultyClient, persist)
    if (snapshot.status !== 'verified') await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.equal(snapshot.status, 'verified', snapshot.error || snapshot.verifyNote)
  assert.equal(loseCreate, false)
  assert.equal(loseAppend, false)
  assert.equal((await client.listChildren(snapshot.pageId)).length, 101)
  step(`lost create and append responses recovered after storage reload (${destination.type})`)
}

try {
  const me = await client.me()
  step(`connected to “${me.bot?.workspace_name}” (API ${NOTION_VERSION})`)
  const destinations = await client.search()
  assert.ok(destinations.some(d => d.id.replace(/-/g, '') === pageId.replace(/-/g, '')), 'NOTION_PAGE_ID is not shared with this integration')
  step(`search lists ${destinations.length} destinations, including the test page`)

  const db = await client.createDatabase(pageId, `Proofclip test ${new Date().toISOString().slice(0, 16)}`)
  created.push({ kind: 'databases', id: db.id })
  const dataSourceId = db.data_sources[0].id
  await client.addProperty(dataSourceId, 'Source', 'url')
  const props = editableProperties(await client.getDataSource(dataSourceId))
  assert.deepEqual(props.map(p => p.type).sort(), ['multi_select', 'title', 'url', 'url'])
  step('created a links database and added a URL property')
  const dbDest = { type: 'data_source', id: dataSourceId, title: 'test db' }
  const dbProps = (title, url, article) => buildProperties(props, { ...autofill(props, { title, url, byline: article?.byline }), Tags: ['proofclip-test'] })

  if (recoveryOnly) {
    const response = await fetch(`${apiBase}/v1/data_sources`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: { type: 'database_id', database_id: db.id }, title: [{ type: 'text', text: { content: 'Second source' } }], properties: { Article: { title: {} } } }),
    })
    assert.equal(response.ok, true, `Create second data source: HTTP ${response.status}`)
    const second = await response.json()
    assert.equal((await client.getDatabase(db.id)).data_sources.length, 2)
    await assert.rejects(client.resolveDestination({ type: 'database', id: db.id }), /choose a data source/)
    await save('first source → multi-source database', '<html><title>First source</title><body><p>First source content.</p></body></html>', 'https://example.com/first', dbDest, dbProps)
    const secondDest = { type: 'data_source', id: second.id, databaseId: db.id, title: 'Second source' }
    await client.addProperty(second.id, 'Source URL', 'url')
    assert.equal((await client.getDataSource(dataSourceId)).properties['Source URL'], undefined)
    await save('second source → multi-source database', '<html><title>Second source</title><body><p>Second source content.</p></body></html>', 'https://example.com/second', secondDest,
      title => ({ Article: { title: [{ type: 'text', text: { content: title } }] } }))
    await recoveryProbe(secondDest, 'Article')
    await recoveryProbe({ type: 'page', id: pageId, title: 'Test page' }, 'title')
  } else {
    await save('long fixture → database', readFileSync(new URL('./fixtures/long-article.html', import.meta.url), 'utf8'), 'https://example.com/guide', dbDest, dbProps)
    await save('fixture → page', readFileSync(new URL('./fixtures/long-article.html', import.meta.url), 'utf8'), 'https://example.com/guide', { type: 'page', id: pageId, title: 'test page' }, title => ({ title: { title: [{ type: 'text', text: { content: title } }] } }))

    for (const url of LIVE_URLS) {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36' } }).catch(e => ({ ok: false, statusText: e.message }))
      if (!res.ok) {
        console.log(`- skipped  ${url} (${res.status || ''} ${res.statusText})`)
        continue
      }
      await save(url, await res.text(), url, dbDest, dbProps)
    }
  }
} finally {
  if (!KEEP) {
    let cleaned = 0
    for (const { kind, id } of created.reverse()) {
      try {
        const response = await fetch(`${apiBase}/v1/${kind}/${id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
          body: JSON.stringify({ in_trash: true }),
        })
        assert.equal(response.ok, true, `Cleanup ${kind}/${id}: HTTP ${response.status}`)
        assert.equal((await response.json()).in_trash, true)
        cleaned++
      } catch (e) {
        failures++
        console.error(`Cleanup failed: ${e.message}`)
      }
    }
    console.log(`cleaned up ${cleaned}/${created.length} test objects (moved to trash)`)
  }
}
console.log(failures ? `\n${failures} FAILED against real Notion` : '\nREAL NOTION PASSED')
process.exit(failures ? 1 : 0)
