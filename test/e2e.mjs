// End-to-end: loads the real extension into Chrome and drives every user flow
// against the mock Notion API (including OAuth through the real worker code).
import puppeteer from 'puppeteer-core'
import http from 'node:http'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockNotion, OAUTH, PAGE_ID, TEAM_PAGE_ID } from './mock-notion.js'
import worker from '../server/oauth-worker.js'

const root = new URL('..', import.meta.url).pathname
const shots = join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const step = msg => console.log(`✓ ${msg}`)

const mock = await startMockNotion()

// The OAuth exchange worker, served by Node.
const exchange = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const response = await worker.fetch(
    new Request(`http://x${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? body : undefined }),
    { NOTION_CLIENT_ID: OAUTH.clientId, NOTION_CLIENT_SECRET: OAUTH.clientSecret, NOTION_API: mock.url },
  )
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(await response.text())
})
await new Promise(r => exchange.listen(0, '127.0.0.1', r))

// Test copy: allow scripting on the fixture server and point OAuth at the mock.
const ext = mkdtempSync(join(tmpdir(), 'proofclip-'))
cpSync(join(root, 'extension'), ext, { recursive: true })
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json')))
manifest.host_permissions.push('http://127.0.0.1/*')
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest))
writeFileSync(join(ext, 'config.js'), `export const OAUTH = ${JSON.stringify({ clientId: OAUTH.clientId, exchangeUrl: `http://127.0.0.1:${exchange.address().port}/exchange`, authorizeUrl: `${mock.url}/v1/oauth/authorize` })}\n`)

const article = readFileSync(join(root, 'test/fixtures/long-article.html'), 'utf8')
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  if (req.url === '/blocked') return res.end('<title>Just a moment...</title><p>Checking your browser before accessing the site. This may take a few seconds.</p>')
  if (req.url === '/sidebar') return res.end(`<title>Guide</title><main><h1>Guide</h1><div class="post-body"><p>${'The opening section explains the basics in a few sentences. '.repeat(14)}</p></div><div class="sidebar-steps">${Array.from({ length: 12 }, (_, i) => `<p>Step ${i}: ${'This step describes an important part of the process that readers need. '.repeat(3)}</p>`).join('')}</div></main>`)
  // Content injected by JS after load, to prove we clip the rendered DOM.
  res.end(article.replace('</article>', '<div id="late"></div></article><script>setTimeout(() => { document.getElementById("late").innerHTML = "<p>Loaded by JavaScript after render.</p>" }, 50)</script>'))
})
await new Promise(r => site.listen(0, '127.0.0.1', r))
const pageUrl = `http://127.0.0.1:${site.address().port}/guide`

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, pipe: true, enableExtensions: [ext], args: ['--no-sandbox'] })
const lastPage = () => [...mock.roots()].at(-1)

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background.js'))
  const workerTarget = await sw.worker()
  const base = `chrome-extension://${new URL(sw.url()).host}`

  // 1. Workspaces: OAuth sign-in, then a token connection.
  const options = await browser.newPage()
  await options.goto(`${base}/options.html`)
  await options.waitForSelector('#signIn', { visible: true })
  await options.click('#signIn')
  await options.waitForFunction(() => /Connected to Team Space/.test(document.getElementById('status').textContent), { timeout: 15000 })
  step('Sign in with Notion (OAuth through the exchange worker) connected “Team Space”')
  const exchanged = mock.requests.find(r => r.path === '/v1/oauth/token')
  assert.ok(exchanged && !JSON.stringify(exchanged.body).includes(OAUTH.clientSecret), 'secret must stay server-side')

  await options.$eval('#tokenBox', d => (d.open = true))
  await options.type('#token', mock.token)
  await options.$eval('#apiBase', (el, v) => (el.value = v), mock.url)
  await options.click('#connect')
  await options.waitForFunction(() => /Connected to Acme Personal/.test(document.getElementById('status').textContent))
  assert.deepEqual(await options.$$eval('#connections li .grow', ls => ls.map(l => l.textContent)), ['🗂 Team Space', '🗂 Acme Personal'])
  await options.screenshot({ path: join(shots, 'settings.png') })
  step('token connection added “Acme Personal”; settings lists both workspaces')

  // 2. First clip: picker opens, search, Enter picks, Enter saves.
  const tab = await browser.newPage()
  await tab.goto(pageUrl)
  await tab.waitForSelector('#late p')
  const tabId = await workerTarget.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, pageUrl)
  const popup = await browser.newPage()
  await popup.setViewport({ width: 440, height: 900 })
  const popupErrors = []
  popup.on('pageerror', e => popupErrors.push(e.message))
  popup.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && popupErrors.push(m.text()))
  process.on('exit', () => popupErrors.length && console.log('popup errors:', popupErrors))
  const openPopup = async () => {
    await popup.goto(`${base}/popup.html?tab=${tabId}`)
    await popup.bringToFront()
    await popup.waitForSelector('#title')
    await popup.waitForSelector('body[data-ready]')
  }
  const waitResult = async (statuses = ['verified', 'mismatch', 'failed']) => {
    await popup.waitForFunction(s => s.includes(document.getElementById('resultBadge').textContent), { timeout: 20000 }, statuses)
    return popup.evaluate(() => [document.getElementById('resultBadge').textContent, document.getElementById('resultText').textContent])
  }

  await openPopup()
  assert.equal(await popup.$eval('#workspace', s => (s.hidden ? '' : s.selectedOptions[0].textContent)), '🗂 Acme Personal')
  assert.equal(await popup.$eval('#title', i => i.value), 'A long guide')
  assert.equal(await popup.$eval('#destPanel', p => p.hidden), false, 'picker should open when there is no destination yet')
  await popup.waitForSelector('#destList button')
  assert.deepEqual(await popup.$$eval('#destList button span:first-child', bs => bs.map(b => b.textContent)).then(x => x.sort()), ['💡 Ideas', '📚 Reading list', '📝 Research notes'])
  assert.equal(await popup.$eval('#save', b => b.disabled), true, 'cannot save without a destination')
  await popup.screenshot({ path: join(shots, 'popup-picker.png') })
  await popup.type('#destSearch', 'read')
  await popup.waitForFunction(() => document.querySelectorAll('#destList button').length === 1)
  await popup.keyboard.press('Enter')
  await popup.waitForSelector('#prop-Tags')
  assert.equal(await popup.$eval('#destLabel', l => l.textContent), '📚 Reading list')
  const info = await popup.evaluate(() => ({
    stats: document.getElementById('stats').textContent,
    url: document.getElementById('prop-URL').value,
    clipped: document.getElementById('prop-Clipped').value,
    preview: document.getElementById('preview').textContent,
    warning: document.getElementById('warning').hidden,
    titleField: !!document.getElementById('prop-Name'),
  }))
  assert.equal(info.url, pageUrl)
  assert.equal(info.clipped, new Date().toISOString().slice(0, 10))
  assert.ok(info.preview.includes('Loaded by JavaScript after render.'), 'rendered DOM content missing')
  assert.ok(!info.preview.includes('Home | Blog'), 'navigation should be stripped')
  assert.equal(info.warning, true, 'complete article should not warn')
  assert.equal(info.titleField, false, 'title lives in the top field, not duplicated')
  step(`search “read” + Enter chose Reading list; ${info.stats}`)

  await popup.click('#prop-Tags button')
  await popup.$eval('#title', i => (i.value = ''))
  await popup.type('#title', 'My edited title')
  await popup.screenshot({ path: join(shots, 'popup.png'), fullPage: true })
  await popup.focus('#title')
  await popup.keyboard.press('Enter')
  let [status, text] = await waitResult()
  assert.equal(status, 'verified', text)
  assert.equal(await popup.$eval('#openPage', a => !a.hidden && a.textContent), 'Open in Notion')
  await popup.screenshot({ path: join(shots, 'popup-saved.png'), fullPage: true })
  let saved = lastPage()
  assert.equal(saved.properties.Name.title[0].text.content, 'My edited title')
  assert.deepEqual(saved.properties.Tags, { multi_select: [{ name: 'research' }] })
  assert.equal(saved.properties.URL.url, pageUrl)
  step(`Enter saved: ${text}`)

  // 3. Reopen: last destination and tags are remembered; outage + retry.
  mock.state.dropCreates = 1
  await openPopup()
  await popup.waitForSelector('#prop-Tags button')
  assert.equal(await popup.$eval('#destLabel', l => l.textContent), '📚 Reading list')
  assert.equal(await popup.$eval('#destPanel', p => p.hidden), true)
  assert.equal(await popup.$eval('#prop-Tags button', b => b.getAttribute('aria-pressed')), 'true')
  const before = mock.roots().length
  await popup.click('#save')
  ;[status, text] = await waitResult(['failed'])
  step(`last destination + tags remembered; outage kept locally: ${text}`)
  await popup.click('#retry')
  ;[status] = await waitResult(['verified'])
  assert.equal(mock.roots().length, before + 1)
  step('manual retry verified, no duplicate page')

  // 4. Recent list, then save under a plain page.
  await openPopup()
  await popup.click('#destButton')
  await popup.waitForFunction(() => document.querySelectorAll('#destList li.group').length === 2)
  assert.deepEqual(await popup.$$eval('#destList li.group', g => g.map(x => x.textContent)), ['Recent', 'Pages & databases'])
  await popup.click(`#destList button[data-id="${PAGE_ID}"]`)
  await popup.waitForFunction(() => document.getElementById('propsBox').hidden)
  await popup.click('#save')
  ;[status, text] = await waitResult()
  assert.equal(status, 'verified', text)
  saved = lastPage()
  assert.deepEqual(saved.parent, { page_id: PAGE_ID })
  assert.equal(saved.properties.title.title[0].text.content, 'A long guide')
  step(`saved as a subpage of Research notes: ${text}`)

  // 5. Database without a URL property gets one.
  await openPopup()
  await popup.click('#destButton')
  await popup.type('#destSearch', 'ideas')
  await popup.waitForFunction(() => document.querySelectorAll('#destList button').length === 1)
  await popup.keyboard.press('Enter')
  await popup.waitForFunction(() => !document.getElementById('urlNote').hidden)
  await popup.click('#save')
  ;[status, text] = await waitResult()
  assert.equal(status, 'verified', text)
  assert.equal(lastPage().properties.URL.url, pageUrl)
  step('“Ideas” had no URL property — one was added and filled')

  // 6. + New links database.
  await openPopup()
  await popup.click('#destButton')
  await popup.click('#newDbToggle')
  await popup.waitForFunction(() => document.getElementById('newDbParent').options.length > 0)
  await popup.$eval('#newDbName', i => (i.value = ''))
  await popup.type('#newDbName', 'Clips')
  await popup.select('#newDbParent', PAGE_ID)
  await popup.screenshot({ path: join(shots, 'popup-newdb.png') })
  await popup.keyboard.press('Enter')
  await popup.waitForFunction(() => document.getElementById('destLabel').textContent === '🔗 Clips')
  await popup.waitForSelector('#prop-URL')
  await popup.click('#save')
  ;[status, text] = await waitResult()
  assert.equal(status, 'verified', text)
  assert.equal(lastPage().properties.URL.url, pageUrl)
  step('created “Clips” links database inside Research notes and saved into it')

  // 7. Switch workspace.
  await openPopup()
  await popup.select('#workspace', 'ws-2')
  await popup.waitForSelector(`#destList button[data-id="${TEAM_PAGE_ID}"]`)
  await popup.click(`#destList button[data-id="${TEAM_PAGE_ID}"]`)
  await popup.click('#save')
  ;[status, text] = await waitResult()
  assert.equal(status, 'verified', text)
  saved = lastPage()
  assert.equal(saved.workspace, 'Team Space')
  step('switched to Team Space and saved into Team wiki')

  // 8. A remembered destination that was deleted, and a revoked token.
  const ws1 = mock.workspaces.secret_test
  const ideas = Object.entries(ws1.databases).find(([, d]) => d.title === 'Ideas')
  await popup.select('#workspace', (await popup.$$eval('#workspace option', os => os.map(o => o.value))).find(v => v !== 'ws-2'))
  await popup.waitForFunction(() => document.getElementById('destLabel').textContent !== 'Choose a page or database…')
  const lastDest = await popup.$eval('#destLabel', l => l.textContent)
  const removed = Object.entries(ws1.databases).find(([, d]) => lastDest.includes(d.title))
  delete ws1.databases[removed[0]]
  await openPopup()
  const gone = await popup.$eval('#notice', n => n.textContent)
  assert.match(gone, /deleted or is no longer shared/)
  assert.equal(await popup.$eval('#destPanel', p => p.hidden), false)
  assert.equal(await popup.$eval('#save', b => b.disabled), true)
  ws1.databases[removed[0]] = removed[1]
  step(`deleted destination handled: ${gone}`)
  mock.workspaces.revoked = mock.workspaces.secret_test
  delete mock.workspaces.secret_test
  await openPopup()
  await popup.waitForFunction(() => /no longer connected/.test(document.getElementById('notice').textContent))
  mock.workspaces.secret_test = mock.workspaces.revoked
  step(`revoked token handled: ${await popup.$eval('#notice', n => n.textContent)}`)
  assert.ok(ideas)

  // 9. Selection clipping.
  await tab.bringToFront()
  await tab.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelectorAll('article p')[3])
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  })
  await openPopup()
  const sel = await popup.evaluate(() => [document.querySelector('[data-source=selection]').getAttribute('aria-pressed'), document.getElementById('stats').textContent])
  assert.equal(sel[0], 'true')
  assert.match(sel[1], /1 blocks/)
  step(`selection mode: ${sel[1]}`)

  // 10. Completeness warnings and Full page fallback.
  for (const [path, pattern] of [['/blocked', /block, login or error page/], ['/sidebar', /Article view kept \d+ of about/]]) {
    await tab.goto(new URL(path, pageUrl).href)
    await openPopup()
    const warning = await popup.$eval('#warning', w => (w.hidden ? '' : w.textContent))
    assert.match(warning, pattern, `${path}: ${await popup.$eval('#stats', e => e.textContent)}`)
    step(`warns on ${path}: ${warning}`)
  }
  await popup.keyboard.press('Escape')
  assert.equal(await popup.$eval('#destPanel', p => p.hidden), true)
  await popup.click('[data-source=page]')
  assert.equal(await popup.$eval('#warning', w => w.hidden), true)
  step(`full page mode: ${await popup.$eval('#stats', e => e.textContent)}`)

  // 11. History.
  const history = await browser.newPage()
  await history.setViewport({ width: 960, height: 520 })
  await history.goto(`${base}/history.html`)
  await history.waitForSelector('#rows tr')
  const rows = await history.$$eval('#rows tr .badge', bs => bs.map(b => b.textContent))
  assert.equal(rows.length, 6)
  assert.ok(rows.every(r => r === 'verified'), rows.join())
  await history.screenshot({ path: join(shots, 'history.png') })
  step(`history lists ${rows.length} verified clips`)

  // Multi-source databases use the chosen source's schema and parent ID.
  ws1.databases.multi = { title: 'Library', sources: [
    { id: 'source-articles', title: 'Articles', properties: { Article: { type: 'title' }, Topic: { type: 'rich_text' } } },
    { id: 'source-bookmarks', title: 'Bookmarks', properties: { Bookmark: { type: 'title' }, Link: { type: 'url' } } },
  ] }
  for (const [id, titleProperty, field] of [['source-articles', 'Article', 'Topic'], ['source-bookmarks', 'Bookmark', 'Link']]) {
    await openPopup()
    if (await popup.$eval('#destPanel', panel => panel.hidden)) await popup.click('#destButton')
    await popup.type('#destSearch', 'Library')
    await popup.waitForFunction(() => document.querySelectorAll('#destList button').length === 2)
    await popup.click(`#destList button[data-id="${id}"]`)
    await popup.waitForSelector(`#prop-${field}`)
    await popup.waitForFunction(() => !document.getElementById('save').disabled)
    await popup.click('#save')
    ;[status, text] = await waitResult()
    assert.equal(status, 'verified', text)
    assert.deepEqual(lastPage().parent, { data_source_id: id })
    assert.ok(lastPage().properties[titleProperty])
  }
  assert.equal(ws1.databases.multi.sources[0].properties.URL.type, 'url')
  assert.equal(ws1.databases.multi.sources[1].properties.URL, undefined)
  step('both sources of Library use separate schemas and receive verified clips')

  // An ambiguous remembered database cannot enable Save before source selection.
  await workerTarget.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings')
    settings.lastDestination[settings.activeConnectionId] = { type: 'database', id: 'multi', title: 'Library' }
    await chrome.storage.local.set({ settings })
  })
  await openPopup()
  await popup.waitForFunction(() => /choose a data source/.test(document.getElementById('notice').textContent))
  assert.equal(await popup.$eval('#save', b => b.disabled), true)
  step('an old multi-source destination requires an explicit source selection')
  console.log('E2E PASSED')
} finally {
  await browser.close()
  mock.close()
  site.close()
  exchange.close()
}
