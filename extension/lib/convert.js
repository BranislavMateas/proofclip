// Converts rendered article HTML into Notion blocks that respect the API limits:
// 2000 chars per text object, 100 rich text items per block, 100 children per
// array and two levels of nesting per request.

export const MAX_TEXT = 2000
export const MAX_RICH = 100
export const MAX_CHILDREN = 100

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'nav', 'video', 'audio', 'source', 'head', 'meta', 'link'])
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul', 'img', 'picture', 'body', 'html'])

const CODE_LANGUAGES = new Set(['abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#', 'css', 'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran', 'f#', 'gherkin', 'glsl', 'go', 'graphql', 'groovy', 'haskell', 'html', 'java', 'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript', 'lua', 'makefile', 'markdown', 'markup', 'matlab', 'mermaid', 'nix', 'objective-c', 'ocaml', 'pascal', 'perl', 'php', 'plain text', 'powershell', 'prolog', 'protobuf', 'python', 'r', 'reason', 'ruby', 'rust', 'sass', 'scala', 'scheme', 'scss', 'shell', 'sql', 'swift', 'typescript', 'vb.net', 'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml'])
const LANGUAGE_ALIASES = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', sh: 'shell', zsh: 'shell', console: 'shell', yml: 'yaml', md: 'markdown', cpp: 'c++', cs: 'c#', csharp: 'c#', golang: 'go', rs: 'rust', kt: 'kotlin', dockerfile: 'docker', text: 'plain text', txt: 'plain text', plaintext: 'plain text', html: 'html', xhtml: 'html' }

const tagOf = node => node.tagName ? node.tagName.toLowerCase() : ''

export function htmlToBlocks(root, { baseUrl } = {}) {
  const out = []
  convertChildren(root, out, { baseUrl })
  return limitDepth(out)
}

function containsBlock(el) {
  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue
    const tag = tagOf(child)
    if (SKIP.has(tag)) continue
    if (BLOCK.has(tag) || containsBlock(child)) return true
  }
  return false
}

const isBlockNode = node => node.nodeType === 1 && !SKIP.has(tagOf(node)) && (BLOCK.has(tagOf(node)) || containsBlock(node))

function convertChildren(node, out, ctx) {
  let run = []
  const flush = () => {
    if (run.length) out.push(...textBlocks('paragraph', richText(run, ctx)))
    run = []
  }
  for (const child of node.childNodes) {
    if (child.nodeType === 3) run.push(child)
    else if (child.nodeType !== 1 || SKIP.has(tagOf(child))) continue
    else if (isBlockNode(child)) { flush(); convertElement(child, out, ctx) }
    else run.push(child)
  }
  flush()
}

function convertElement(el, out, ctx) {
  const tag = tagOf(el)
  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(Number(tag[1]), 3)
    out.push(...textBlocks(`heading_${level}`, richText(el.childNodes, ctx)))
    // Images inside headings would otherwise be lost.
    for (const img of el.querySelectorAll('img')) pushImage(img, out, ctx)
  } else if (tag === 'ul' || tag === 'ol') {
    const type = tag === 'ol' ? 'numbered_list_item' : 'bulleted_list_item'
    for (const child of el.childNodes) {
      if (tagOf(child) === 'li') out.push(...listItem(child, type, ctx))
      else if (child.nodeType === 1 && !SKIP.has(tagOf(child))) convertElement(child, out, ctx)
    }
  } else if (tag === 'li') {
    out.push(...listItem(el, 'bulleted_list_item', ctx))
  } else if (tag === 'blockquote') {
    out.push(...quote(el, ctx))
  } else if (tag === 'pre') {
    out.push(...codeBlocks(el))
  } else if (tag === 'hr') {
    out.push({ object: 'block', type: 'divider', divider: {} })
  } else if (tag === 'img') {
    pushImage(el, out, ctx)
  } else if (tag === 'picture') {
    const img = el.querySelector('img')
    if (img) pushImage(img, out, ctx)
  } else if (tag === 'table') {
    out.push(...table(el, ctx))
  } else {
    convertChildren(el, out, ctx)
  }
}

function listItem(li, type, ctx) {
  let rich = null
  const nested = []
  let run = []
  const flush = () => {
    if (!run.length) return
    const text = richText(run, ctx)
    if (rich === null) rich = text
    else nested.push(...textBlocks('paragraph', text))
    run = []
  }
  for (const child of li.childNodes) {
    if (child.nodeType === 3) { run.push(child); continue }
    if (child.nodeType !== 1 || SKIP.has(tagOf(child))) continue
    if (!isBlockNode(child)) { run.push(child); continue }
    flush()
    if (rich === null && tagOf(child) === 'p' && !containsBlock(child)) rich = richText(child.childNodes, ctx)
    else convertElement(child, nested, ctx)
  }
  flush()
  const [first, ...rest] = splitRich(rich || [])
  const block = makeBlock(type, first || [])
  const children = [...rest.map(r => makeBlock('paragraph', r)), ...nested]
  if (children.length) block[type].children = children
  return [block]
}

function quote(el, ctx) {
  const inner = []
  convertChildren(el, inner, ctx)
  if (!inner.length) return []
  if (inner.every(b => b.type === 'paragraph' && !b.paragraph.children)) {
    const rich = []
    inner.forEach((b, i) => {
      if (i) rich.push(plain('\n'))
      rich.push(...b.paragraph.rich_text)
    })
    return textBlocks('quote', mergeRich(rich))
  }
  const [head, ...tail] = inner
  if (head.type === 'paragraph' && !head.paragraph.children) {
    const block = makeBlock('quote', head.paragraph.rich_text)
    if (tail.length) block.quote.children = tail
    return [block]
  }
  const block = makeBlock('quote', [])
  block.quote.children = inner
  return [block]
}

function codeBlocks(pre) {
  const code = pre.querySelector('code')
  const classes = `${pre.getAttribute('class') || ''} ${code?.getAttribute('class') || ''} ${pre.getAttribute('data-lang') || ''} ${pre.getAttribute('data-language') || ''}`
  const match = classes.match(/(?:lang(?:uage)?-)([\w#+.-]+)/i) || classes.match(/\b(?:highlight-source-|brush:\s*)([\w#+.-]+)/i)
  let language = 'plain text'
  if (match) {
    const raw = match[1].toLowerCase()
    language = LANGUAGE_ALIASES[raw] || (CODE_LANGUAGES.has(raw) ? raw : 'plain text')
  }
  const text = (pre.textContent || '').replace(/\n$/, '')
  if (!text.trim()) return []
  return splitRich(chunkString(text).map(plain)).map(rich => ({ object: 'block', type: 'code', code: { rich_text: rich, language } }))
}

function table(el, ctx) {
  const rows = [...el.querySelectorAll('tr')].filter(tr => tr.closest('table') === el)
  const cells = rows
    .map(tr => [...tr.children].filter(c => ['td', 'th'].includes(tagOf(c))))
    .filter(r => r.length)
  if (!cells.length) return []
  const width = Math.max(...cells.map(r => r.length))
  const hasHeader = cells[0].every(c => tagOf(c) === 'th') || tagOf(rows[0].parentNode) === 'thead'
  const toRow = r => ({
    object: 'block',
    type: 'table_row',
    table_row: { cells: Array.from({ length: width }, (_, i) => (r[i] ? richText(r[i].childNodes, ctx) : []).slice(0, MAX_RICH)) },
  })
  const all = cells.map(toRow)
  const header = hasHeader ? all.shift() : null
  const per = MAX_CHILDREN - (header ? 1 : 0)
  const tables = []
  do {
    const chunk = all.splice(0, per)
    const children = header ? [structuredClone(header), ...chunk] : chunk
    tables.push({ object: 'block', type: 'table', table: { table_width: width, has_column_header: !!header, has_row_header: false, children } })
  } while (all.length)
  // Images inside cells cannot live in a table row; keep them after the table.
  const images = []
  for (const img of el.querySelectorAll('img')) pushImage(img, images, ctx)
  return [...tables, ...images]
}

function pushImage(img, out, ctx) {
  const src = img.getAttribute('src') || img.getAttribute('data-src') || ''
  const url = safeUrl(src, ctx.baseUrl)
  if (!url) return
  const alt = (img.getAttribute('alt') || '').trim().slice(0, MAX_TEXT)
  out.push({ object: 'block', type: 'image', image: { type: 'external', external: { url }, caption: alt ? [plain(alt)] : [] } })
}

export function safeUrl(href, baseUrl) {
  if (!href) return null
  try {
    const url = new URL(href, baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.href.length > MAX_TEXT) return null
    return url.href
  } catch {
    return null
  }
}

// --- Rich text -------------------------------------------------------------

const ANNOTATION_TAGS = {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', cite: 'italic', s: 'strikethrough', del: 'strikethrough', strike: 'strikethrough', u: 'underline', ins: 'underline', code: 'code', kbd: 'code', samp: 'code', tt: 'code',
}

export function richText(nodes, ctx = {}) {
  const parts = []
  const push = (text, ann, link) => {
    const prev = parts[parts.length - 1]
    // Collapse whitespace across element boundaries like a browser would.
    if (!ann.pre && (!prev || /[ \n]$/.test(prev.text))) text = text.replace(/^ +/, '')
    if (text) parts.push({ text, ann, link })
  }
  const walk = (node, ann, link) => {
    if (node.nodeType === 3) {
      const text = ann.pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' ')
      push(text, ann, link)
      return
    }
    if (node.nodeType !== 1) return
    const tag = tagOf(node)
    if (SKIP.has(tag) || tag === 'img' || tag === 'picture') return
    if (tag === 'br') {
      const prev = parts[parts.length - 1]
      if (prev) prev.text = prev.text.replace(/ +$/, '')
      parts.push({ text: '\n', ann, link })
      return
    }
    let next = ann
    if (ANNOTATION_TAGS[tag]) next = { ...ann, [ANNOTATION_TAGS[tag]]: true }
    if (tag === 'pre') next = { ...next, pre: true }
    const style = node.getAttribute('style') || ''
    if (/font-weight:\s*(bold|[6-9]00)/i.test(style)) next = { ...next, bold: true }
    if (/font-style:\s*italic/i.test(style)) next = { ...next, italic: true }
    let nextLink = link
    if (tag === 'a') nextLink = safeUrl(node.getAttribute('href'), ctx.baseUrl) || link
    for (const child of node.childNodes) walk(child, next, nextLink)
  }
  for (const node of nodes) walk(node, {}, null)

  // Trim the run as a whole.
  while (parts.length && !parts[0].text.replace(/^\s+/, '')) parts.shift()
  while (parts.length && !parts[parts.length - 1].text.replace(/\s+$/, '')) parts.pop()
  if (!parts.length) return []
  parts[0].text = parts[0].text.replace(/^\s+/, '')
  parts[parts.length - 1].text = parts[parts.length - 1].text.replace(/\s+$/, '')

  const items = []
  for (const { text, ann, link } of parts) {
    for (const content of chunkString(text)) items.push(textItem(content, ann, link))
  }
  return mergeRich(items)
}

function textItem(content, ann = {}, link = null) {
  const annotations = {}
  for (const key of ['bold', 'italic', 'strikethrough', 'underline', 'code']) if (ann[key]) annotations[key] = true
  const item = { type: 'text', text: { content, link: link ? { url: link } : null } }
  if (Object.keys(annotations).length) item.annotations = annotations
  return item
}

export const plain = content => textItem(content)

const sameStyle = (a, b) =>
  JSON.stringify(a.annotations || {}) === JSON.stringify(b.annotations || {}) && (a.text.link?.url || null) === (b.text.link?.url || null)

function mergeRich(items) {
  const out = []
  for (const item of items) {
    const prev = out[out.length - 1]
    if (prev && sameStyle(prev, item) && prev.text.content.length + item.text.content.length <= MAX_TEXT) {
      prev.text.content += item.text.content
    } else {
      out.push(structuredClone(item))
    }
  }
  return out
}

function chunkString(text) {
  const out = []
  for (let i = 0; i < text.length; i += MAX_TEXT) {
    let end = Math.min(i + MAX_TEXT, text.length)
    // Never split a surrogate pair.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    out.push(text.slice(i, end))
    i = end - MAX_TEXT
  }
  return out
}

const splitRich = rich => {
  const out = []
  for (let i = 0; i < rich.length; i += MAX_RICH) out.push(rich.slice(i, i + MAX_RICH))
  return out
}

function makeBlock(type, rich) {
  return { object: 'block', type, [type]: { rich_text: rich } }
}

function textBlocks(type, rich) {
  if (!rich.length) return []
  return splitRich(rich).map((r, i) => makeBlock(i ? 'paragraph' : type, r))
}

// --- Structural limits -----------------------------------------------------

// Notion accepts children on top-level blocks only within one request, so
// deeper levels are hoisted next to their parent.
export function limitDepth(blocks, depth = 0) {
  const out = []
  for (const block of blocks) {
    const data = block[block.type]
    const kids = data.children
    if (!kids?.length) {
      delete data.children
      out.push(block)
    } else if (depth === 0) {
      if (block.type === 'table') {
        out.push(block)
        continue
      }
      data.children = limitDepth(kids, 1)
      const extra = data.children.splice(MAX_CHILDREN)
      out.push(block, ...extra)
    } else if (block.type === 'table') {
      out.push(...tableToParagraphs(block))
    } else {
      delete data.children
      out.push(block, ...limitDepth(kids, depth))
    }
  }
  return out
}

function tableToParagraphs(block) {
  return block.table.children.flatMap(row => {
    const rich = []
    row.table_row.cells.forEach((cell, i) => {
      if (i) rich.push(plain(' | '))
      rich.push(...cell)
    })
    return textBlocks('paragraph', mergeRich(rich))
  })
}

export function countBlocks(blocks) {
  return blocks.reduce((n, b) => n + 1 + countBlocks(b[b.type].children || []), 0)
}

// Splits top-level blocks into request-sized batches.
export function chunkBlocks(blocks, { maxTop = MAX_CHILDREN, maxTotal = 900, maxBytes = 400_000 } = {}) {
  const batches = []
  let batch = []
  let total = 0
  let bytes = 0
  for (const block of blocks) {
    const n = countBlocks([block])
    const size = JSON.stringify(block).length
    if (batch.length && (batch.length >= maxTop || total + n > maxTotal || bytes + size > maxBytes)) {
      batches.push(batch)
      batch = []
      total = 0
      bytes = 0
    }
    batch.push(block)
    total += n
    bytes += size
  }
  if (batch.length) batches.push(batch)
  return batches
}

// --- Verification ----------------------------------------------------------

// Notion removes zero-width word-break spaces from stored rich text.
// Keep other invisible characters, such as joiners used in emoji and scripts.
const normalize = s => s.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim()

export function blockText(block) {
  const data = block[block.type] || {}
  const join = rich => rich.map(t => t.plain_text ?? t.text?.content ?? '').join('')
  if (data.cells) return normalize(data.cells.map(join).join(' | '))
  return normalize(join(data.rich_text || data.caption || []))
}

// Compares what we sent with what Notion stored, top-level block by block.
export function verifyBlocks(expected, actual) {
  if (expected.length !== actual.length) {
    return { ok: false, note: `Expected ${expected.length} blocks, Notion has ${actual.length}.` }
  }
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]
    const got = actual[i]
    if (want.type !== got.type) return { ok: false, note: `Block ${i + 1}: expected ${want.type}, Notion has ${got.type}.` }
    if (blockText(want) !== blockText(got)) return { ok: false, note: `Block ${i + 1} (${want.type}) text differs from what was sent.` }
  }
  return { ok: true, note: `All ${expected.length} blocks match.` }
}

// Walks the whole tree, so nested list items and table rows are checked too.
export async function verifyTree(expected, listChildren, parentId) {
  const actual = await listChildren(parentId)
  const check = verifyBlocks(expected, actual)
  if (!check.ok) return check
  let count = expected.length
  for (const [i, block] of expected.entries()) {
    const kids = block[block.type].children
    if (!kids?.length) continue
    const sub = await verifyTree(kids, listChildren, actual[i].id)
    if (!sub.ok) return { ok: false, note: `Inside block ${i + 1}: ${sub.note}` }
    count += sub.count
  }
  return { ok: true, count, note: `All ${count} blocks match.` }
}

// --- Markdown & preview ----------------------------------------------------

function richToMarkdown(rich) {
  return rich
    .map(t => {
      const a = t.annotations || {}
      let s = t.text?.content ?? t.plain_text ?? ''
      if (!s) return ''
      if (a.code) s = `\`${s}\``
      else s = s.replace(/([*_`[\]\\~])/g, '\\$1')
      const [, lead, core, trail] = s.match(/^(\s*)([\s\S]*?)(\s*)$/)
      s = core
      if (s) {
        if (a.bold) s = `**${s}**`
        if (a.italic) s = `_${s}_`
        if (a.strikethrough) s = `~~${s}~~`
        if (t.text?.link?.url) s = `[${s}](${t.text.link.url})`
      }
      return lead + s + trail
    })
    .join('')
}

export function blocksToMarkdown(blocks, indent = '') {
  const lines = []
  let n = 0
  for (const b of blocks) {
    const data = b[b.type]
    const text = data.rich_text ? richToMarkdown(data.rich_text) : ''
    const kids = data.children || []
    if (b.type !== 'numbered_list_item') n = 0
    switch (b.type) {
      case 'heading_1': case 'heading_2': case 'heading_3':
        lines.push(`${indent}${'#'.repeat(Number(b.type.at(-1)))} ${text}`, '')
        break
      case 'bulleted_list_item':
      case 'numbered_list_item': {
        const marker = b.type === 'bulleted_list_item' ? '- ' : `${++n}. `
        lines.push(indent + marker + text.replace(/\n/g, `\n${indent}${' '.repeat(marker.length)}`))
        if (kids.length) lines.push(blocksToMarkdown(kids, indent + ' '.repeat(marker.length)).replace(/\n+$/, ''))
        const next = blocks[blocks.indexOf(b) + 1]
        if (!next || next.type !== b.type) lines.push('')
        continue
      }
      case 'quote':
        lines.push(text.split('\n').map(l => `${indent}> ${l}`).join('\n'))
        if (kids.length) lines.push(blocksToMarkdown(kids).trim().split('\n').map(l => `${indent}> ${l}`).join('\n'))
        lines.push('')
        continue
      case 'code':
        lines.push(`${indent}\`\`\`${data.language === 'plain text' ? '' : data.language}`, ...data.rich_text.map(t => t.text.content).join('').split('\n').map(l => indent + l), `${indent}\`\`\``, '')
        break
      case 'divider':
        lines.push(`${indent}---`, '')
        break
      case 'image':
        lines.push(`${indent}![${richToMarkdown(data.caption || [])}](${data.external.url})`, '')
        break
      case 'table': {
        const rows = data.children.map(r => `${indent}| ${r.table_row.cells.map(c => richToMarkdown(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)
        const sep = `${indent}|${' --- |'.repeat(data.table_width)}`
        if (data.has_column_header) rows.splice(1, 0, sep)
        else rows.unshift(`${indent}|${'   |'.repeat(data.table_width)}`, sep)
        lines.push(...rows, '')
        break
      }
      default:
        lines.push(indent + text.replace(/\n/g, `  \n${indent}`), '')
    }
    if (kids.length && b.type !== 'table') lines.push(blocksToMarkdown(kids, indent + '  '))
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function richToHtml(rich) {
  return rich
    .map(t => {
      const a = t.annotations || {}
      let s = esc(t.text.content).replace(/\n/g, '<br>')
      if (a.code) s = `<code>${s}</code>`
      if (a.bold) s = `<strong>${s}</strong>`
      if (a.italic) s = `<em>${s}</em>`
      if (a.strikethrough) s = `<s>${s}</s>`
      if (a.underline) s = `<u>${s}</u>`
      if (t.text.link) s = `<a href="${esc(t.text.link.url)}" target="_blank" rel="noopener noreferrer">${s}</a>`
      return s
    })
    .join('')
}

// Renders exactly what will be sent, so the preview cannot drift from the upload.
export function blocksToHtml(blocks) {
  let html = ''
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const data = b[b.type]
    const kids = data.children ? blocksToHtml(data.children) : ''
    const text = data.rich_text ? richToHtml(data.rich_text) : ''
    if (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item') {
      const tag = b.type === 'bulleted_list_item' ? 'ul' : 'ol'
      let items = ''
      while (i < blocks.length && blocks[i].type === b.type) {
        const d = blocks[i][b.type]
        items += `<li>${richToHtml(d.rich_text)}${d.children ? blocksToHtml(d.children) : ''}</li>`
        i++
      }
      i--
      html += `<${tag}>${items}</${tag}>`
      continue
    }
    switch (b.type) {
      case 'heading_1': html += `<h1>${text}</h1>${kids}`; break
      case 'heading_2': html += `<h2>${text}</h2>${kids}`; break
      case 'heading_3': html += `<h3>${text}</h3>${kids}`; break
      case 'quote': html += `<blockquote>${text}${kids}</blockquote>`; break
      case 'code': html += `<pre data-lang="${esc(data.language)}"><code>${esc(data.rich_text.map(t => t.text.content).join(''))}</code></pre>`; break
      case 'divider': html += '<hr>'; break
      case 'image': html += `<figure><img src="${esc(data.external.url)}" alt="" loading="lazy">${data.caption?.length ? `<figcaption>${richToHtml(data.caption)}</figcaption>` : ''}</figure>`; break
      case 'table': {
        const rows = data.children.map((r, ri) => {
          const cell = ri === 0 && data.has_column_header ? 'th' : 'td'
          return `<tr>${r.table_row.cells.map(c => `<${cell}>${richToHtml(c)}</${cell}>`).join('')}</tr>`
        })
        html += `<table>${rows.join('')}</table>`
        break
      }
      default: html += `<p>${text}</p>${kids}`
    }
  }
  return html
}

export function stats(blocks) {
  let words = 0
  let images = 0
  const visit = list => {
    for (const b of list) {
      const data = b[b.type]
      if (b.type === 'image') images++
      for (const t of data.rich_text || []) words += (t.text.content.match(/\S+/g) || []).length
      if (b.type === 'table') for (const r of data.children) for (const c of r.table_row.cells) for (const t of c) words += (t.text.content.match(/\S+/g) || []).length
      if (data.children && b.type !== 'table') visit(data.children)
    }
  }
  visit(blocks)
  return { blocks: countBlocks(blocks), words, images }
}
