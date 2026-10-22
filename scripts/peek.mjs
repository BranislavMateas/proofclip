// Compares page text with what Readability extracts, to find dropped content.
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
const readability = readFileSync(new URL('../extension/vendor/Readability.js', import.meta.url), 'utf8')
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
for (const url of process.argv.slice(2)) {
  const p = await b.newPage()
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
  const r = await p.evaluate(src => {
    eval(src)
    const words = s => (s.match(/\S+/g) || []).length
    const a = new Readability(document.cloneNode(true)).parse()
    const main = document.querySelector('article, main, [role=main]')
    return { title: document.title, page: words(document.body.innerText), main: main ? words(main.innerText) : null, readability: a ? words(a.textContent) : null, start: a?.textContent.trim().slice(0, 160) }
  }, readability)
  console.log(url, JSON.stringify(r, null, 1))
  await p.close()
}
await b.close()
