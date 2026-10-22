// Render the native SVG icon and compose store images from actual extension UI.
import puppeteer from 'puppeteer-core'
import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, cpSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startMockNotion } from '../test/mock-notion.js'

const root = new URL('..', import.meta.url).pathname
const assets = join(root, 'store/assets')
mkdirSync(assets, { recursive: true })
const mock = await startMockNotion()
const ext = mkdtempSync(join(tmpdir(), 'proofclip-store-'))
cpSync(join(root, 'extension'), ext, { recursive: true })
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json')))
manifest.host_permissions.push('http://127.0.0.1/*')
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest))
const article = `<!doctype html><html><head><title>A practical guide to better research notes</title></head><body><article><h1>A practical guide to better research notes</h1><p>Good research notes help you return to an idea without repeating the work. Save the source, write down what matters, and keep enough context to understand it later.</p><h2>Keep the source with the idea</h2><p>A useful note connects an observation to its evidence. Keep the original link and capture the passage that explains the idea. A short description can help you remember why you saved it.</p><h2>Organize while the context is fresh</h2><p>Choose a destination and add a few useful tags. Clear names make it easier to find the note when you need it. Review the saved content before moving on to the next page.</p><ul><li>Save the source URL.</li><li>Keep important passages and headings.</li><li>Add tags that describe your current project.</li><li>Check that the content arrived.</li></ul><h2>Return to your notes</h2><p>Revisit your saved ideas during a project review. Connect related notes and remove material you no longer need. The goal is a small collection that you can use, rather than a large collection that you never open.</p></article></body></html>`
const site = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(article) })
await new Promise(r => site.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${site.address().port}/research-notes`
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, pipe: true, enableExtensions: [ext], args: ['--no-sandbox'] })
const htmlPage = await browser.newPage()
const svg = readFileSync(join(root, 'extension/icons/icon.svg'), 'utf8')
const img = data => `data:image/png;base64,${Buffer.from(data).toString('base64')}`
async function render(html, width, height, path, transparent = false) {
  await htmlPage.bringToFront()
  await htmlPage.setViewport({ width, height, deviceScaleFactor: 1 })
  await htmlPage.setContent(html)
  await htmlPage.evaluate(() => Promise.all([...document.images].map(i => i.decode())))
  await htmlPage.screenshot({ path, omitBackground: transparent })
}
try {
  for (const size of [16, 32, 48, 128]) {
    await render(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`, size, size, join(root, `extension/icons/icon-${size}.png`), true)
  }
  console.log('Icons rendered.');
  const workerTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background.js'))
  const worker = await workerTarget.worker()
  const base = `chrome-extension://${new URL(workerTarget.url()).host}`
  const options = await browser.newPage()
  await options.goto(`${base}/options.html`)
  await options.type('#token', mock.token)
  await options.$eval('#apiBase', (i, value) => { i.value = value }, mock.url)
  await options.click('#connect')
  await options.waitForFunction(() => document.getElementById('status').textContent.startsWith('Connected to'))
  console.log('Demo workspace connected.');
  const articlePage = await browser.newPage()
  await articlePage.goto(url)
  const tabId = await worker.evaluate(async u => (await chrome.tabs.query({ url: u }))[0].id, url)
  const popup = await browser.newPage()
  await popup.setViewport({ width: 440, height: 740 })
  await popup.goto(`${base}/popup.html?tab=${tabId}`)
  await popup.bringToFront()
  await popup.waitForSelector('body[data-ready]'); console.log('Demo popup ready.');
  await popup.type('#destSearch', 'Reading list')
  await popup.waitForFunction(() => document.querySelectorAll('#destList button').length === 1)
  await popup.keyboard.press('Enter')
  await popup.waitForSelector('#prop-Tags')
  await popup.click('#prop-Tags button')
  console.log('Destination and properties selected.');
  const preview = await popup.screenshot()
  await popup.click('#save')
  await popup.waitForFunction(() => document.getElementById('resultBadge').textContent === 'verified')
  console.log('Demo clip verified.');
  await popup.$eval('#propsBox', el => { el.open = false })
  const saved = await popup.screenshot()
  const style = `<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font-family:Arial,sans-serif}body{background:#122e35;color:#f5faf7}.label{font-size:18px;letter-spacing:3px;text-transform:uppercase;color:#89e2ae}.copy{position:absolute;left:80px;top:125px;width:570px}h1{font-size:62px;line-height:1.05;letter-spacing:-2px;margin:30px 0 24px;font-weight:700}p{font-size:23px;line-height:1.5;color:#c4d6d4;max-width:490px}.brand{position:absolute;left:72px;bottom:56px;display:flex;align-items:center;font-weight:700;font-size:23px}.brand svg{height:54px;width:54px;margin-right:10px}.ui{position:absolute;right:80px;top:30px;width:440px;box-shadow:0 20px 60px #0004;border-radius:10px}.line{position:absolute;left:80px;top:88px;background:#89e2ae;width:44px;height:4px}</style>`
  for (const scene of [
    { path: '01-preview.png', title: 'Save the page.<br>Keep the context.', text: 'Preview the content. Choose a destination. Edit tags and properties before you save.', image: preview },
    { path: '02-verified.png', title: 'Saved.<br>Then checked.', text: 'Proofclip reads the blocks back from Notion and compares their types and text.', image: saved },
  ]) {
    await render(`${style}<div class="line"></div><div class="copy"><div class="label">Web clipping for Notion</div><h1>${scene.title}</h1><p>${scene.text}</p></div><img class="ui" src="${img(scene.image)}"><div class="brand">${svg}Proofclip</div>`, 1280, 800, join(assets, scene.path))
  }
  await render(`<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#122e35;font-family:Arial,sans-serif;color:#f5faf7}main{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column}svg{width:156px;height:156px}h1{font-size:38px;letter-spacing:-1px;margin:-2px 0 0}p{font-size:17px;color:#b9d3ce;margin:10px 0}</style><main>${svg}<h1>Proofclip</h1><p>Save to Notion. Check what arrived.</p></main>`, 440, 280, join(assets, 'promo-440x280.png'))
  await render(`<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#122e35;font-family:Arial,sans-serif;color:#f5faf7}.wrap{display:flex;align-items:center;height:100%;padding:0 100px;gap:60px}svg{width:300px;height:300px}h1{font-size:86px;letter-spacing:-3px;margin:0}p{font-size:34px;color:#b9d3ce;margin:18px 0}.tag{color:#89e2ae;font-size:18px;text-transform:uppercase;letter-spacing:3px;margin-bottom:20px}</style><div class="wrap">${svg}<div><div class="tag">An open-source web clipper for Notion</div><h1>Proofclip</h1><p>Save the page. Check what arrived.</p></div></div>`, 1400, 560, join(assets, 'marquee-1400x560.png'))
  console.log('Rendered extension icons and four Chrome Web Store images from actual demo UI.')
} finally {
  await browser.close()
  mock.close()
  site.close()
}
