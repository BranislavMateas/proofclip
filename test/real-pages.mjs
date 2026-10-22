// Clips live pages through the real extension into the strict mock API.
// Usage: node test/real-pages.mjs [url ...]
import puppeteer from 'puppeteer-core'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockNotion, DB_ID } from './mock-notion.js'

const URLS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://en.wikipedia.org/wiki/Chrome_Web_Store',
  'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch',
  'https://github.com/mozilla/readability',
  'https://paulgraham.com/startupideas.html',
  'https://blog.cloudflare.com/',
  'https://www.theverge.com/',
  'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
  'https://news.ycombinator.com/',
  'https://docs.python.org/3/tutorial/classes.html',
  'https://react.dev/learn/thinking-in-react',
]

const root = new URL('..', import.meta.url).pathname
const ext = mkdtempSync(join(tmpdir(), 'proofclip-'))
cpSync(join(root, 'extension'), ext, { recursive: true })
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json')))
manifest.host_permissions.push('<all_urls>')
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest))

const mock = await startMockNotion()
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, pipe: true, enableExtensions: [ext], args: ['--no-sandbox'] })
const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background.js'))
const worker = await sw.worker()
const base = `chrome-extension://${new URL(sw.url()).host}`
// Exercises the v0.1 settings migration too: a bare token plus a remembered database.
await worker.evaluate((token, apiBase, id) => chrome.storage.local.set({ settings: { token, apiBase, lastDestination: { legacy: { id, type: 'database', title: 'Reading list', icon: '📚' } } } }), mock.token, mock.url, DB_ID)

let failures = 0
for (const url of URLS) {
  const tab = await browser.newPage()
  const popup = await browser.newPage()
  try {
    await tab.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    const tabId = await worker.evaluate(async u => (await chrome.tabs.query({})).find(t => t.url === u || t.pendingUrl === u)?.id, tab.url())
    await popup.goto(`${base}/popup.html?tab=${tabId}`)
    await popup.waitForSelector('body[data-ready], #notice:not([hidden])', { timeout: 15000 })
    const stats = await popup.$eval('#stats', e => e.textContent)
    if (await popup.$eval('#save', b => b.disabled)) {
      console.log(`- skipped  ${url}\n    no readable content (${await tab.title()})`)
      continue
    }
    await popup.click('#save')
    await popup.waitForFunction(() => ['verified', 'mismatch', 'failed'].includes(document.getElementById('resultBadge').textContent), { timeout: 60000 }).catch(async e => { console.log('    stuck at:', await popup.evaluate(() => document.getElementById('resultBadge').textContent + ' | ' + document.getElementById('resultText').textContent + ' | ' + document.getElementById('notice').textContent)); throw e })
    const [status, text] = await popup.evaluate(() => [document.getElementById('resultBadge').textContent, document.getElementById('resultText').textContent])
    if (status !== 'verified') failures++
    const warning = await popup.$eval('#warning', w => (w.hidden ? '' : `\n    ⚠ ${w.textContent}`))
    console.log(`${status === 'verified' ? '✓' : '✗'} ${status.padEnd(8)} ${url}\n    ${stats}${warning}${status !== 'verified' ? `\n    ${text}` : ''}`)
  } catch (e) {
    failures++
    console.log(`✗ error    ${url}\n    ${e.message.split('\n')[0]} ${await popup.$eval('#notice', n => n.textContent).catch(() => '')}`)
  } finally {
    await tab.close()
    await popup.close()
  }
}
await browser.close()
mock.close()
console.log(`\n${failures} failed of ${URLS.length}`)
process.exit(failures ? 1 : 0)
