import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { htmlToBlocks, chunkBlocks, countBlocks, verifyBlocks, blocksToMarkdown, blocksToHtml, stats } from '../extension/lib/convert.js'
import { autofill, buildProperties, editableProperties } from '../extension/lib/properties.js'

const convert = (html, baseUrl = 'https://example.com/post/1') => {
  const { document } = parseHTML(`<!doctype html><html><body><div id="root">${html}</div></body></html>`)
  return htmlToBlocks(document.getElementById('root'), { baseUrl })
}
const texts = blocks => blocks.map(b => `${b.type}:${(b[b.type].rich_text || []).map(t => t.text.content).join('')}`)

test('paragraphs, headings and inline formatting', () => {
  const blocks = convert(`<h1>Title</h1><p>Hello <strong>bold</strong> and <em>it</em> <a href="/x">link</a></p><h4>Deep</h4>`)
  assert.deepEqual(texts(blocks), ['heading_1:Title', 'paragraph:Hello bold and it link', 'heading_3:Deep'])
  const rich = blocks[1].paragraph.rich_text
  assert.deepEqual(rich[1].annotations, { bold: true })
  assert.equal(rich.at(-1).text.link.url, 'https://example.com/x')
})

test('whitespace is collapsed like a browser renders it', () => {
  const blocks = convert(`<p>
     Some   <b>spaced </b> text
     here<br>  next line </p>`)
  assert.deepEqual(texts(blocks), ['paragraph:Some spaced text here\nnext line'])
})

test('mixed inline and block content in a div keeps order', () => {
  const blocks = convert(`<div>Intro text <span>inline</span><p>Para</p>tail <img src="a.png" alt="A pic"></div>`)
  assert.deepEqual(texts(blocks), ['paragraph:Intro text inline', 'paragraph:Para', 'paragraph:tail', 'image:'])
  assert.equal(blocks[3].image.external.url, 'https://example.com/post/a.png')
  assert.equal(blocks[3].image.caption[0].text.content, 'A pic')
})

test('nested lists stay within Notion depth limits', () => {
  const blocks = convert(`<ul><li>One<ul><li>Two<ul><li>Three</li></ul></li></ul></li><li><p>Four</p><p>Four b</p></li></ul><ol><li>A</li><li>B</li></ol>`)
  assert.deepEqual(texts(blocks), ['bulleted_list_item:One', 'bulleted_list_item:Four', 'numbered_list_item:A', 'numbered_list_item:B'])
  assert.deepEqual(texts(blocks[0].bulleted_list_item.children), ['bulleted_list_item:Two', 'bulleted_list_item:Three'])
  assert.deepEqual(texts(blocks[1].bulleted_list_item.children), ['paragraph:Four b'])
  for (const child of blocks[0].bulleted_list_item.children) assert.equal(child.bulleted_list_item.children, undefined)
})

test('long text is split at 2000 chars and 100 rich text items', () => {
  const long = 'x'.repeat(4500)
  const [block] = convert(`<p>${long}</p>`)
  assert.deepEqual(block.paragraph.rich_text.map(t => t.text.content.length), [2000, 2000, 500])
  const many = Array.from({ length: 150 }, (_, i) => (i % 2 ? `<b>b${i}</b>` : `<i>i${i}</i>`)).join('')
  const blocks = convert(`<p>${many}</p>`)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].paragraph.rich_text.length, 100)
  assert.equal(blocks[1].paragraph.rich_text.length, 50)
})

test('emoji are not split across text chunks', () => {
  const text = 'a'.repeat(1999) + '😀' + 'b'
  const [block] = convert(`<p>${text}</p>`)
  assert.equal(block.paragraph.rich_text.map(t => t.text.content).join(''), text)
  assert.ok(block.paragraph.rich_text.every(t => t.text.content.length <= 2000))
})

test('code blocks keep whitespace and language', () => {
  const [block] = convert(`<pre><code class="language-js">const a = 1;\n  if (a) {\n    go()\n  }\n</code></pre>`)
  assert.equal(block.type, 'code')
  assert.equal(block.code.language, 'javascript')
  assert.equal(block.code.rich_text[0].text.content, 'const a = 1;\n  if (a) {\n    go()\n  }')
})

test('blockquote, divider, table', () => {
  const blocks = convert(`<blockquote><p>Q1</p><p>Q2</p></blockquote><hr><table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>a</td><td><b>b</b></td></tr><tr><td>c</td></tr></tbody></table>`)
  assert.deepEqual(texts(blocks), ['quote:Q1\nQ2', 'divider:', 'table:'])
  const table = blocks[2].table
  assert.equal(table.table_width, 2)
  assert.equal(table.has_column_header, true)
  assert.equal(table.children.length, 3)
  assert.deepEqual(table.children[2].table_row.cells[1], [])
})

test('unsafe urls and junk elements are dropped', () => {
  const blocks = convert(`<script>bad()</script><p><a href="javascript:alert(1)">x</a></p><img src="data:image/png;base64,AAAA"><nav>menu</nav><style>p{}</style>`)
  assert.deepEqual(texts(blocks), ['paragraph:x'])
  assert.equal(blocks[0].paragraph.rich_text[0].text.link, null)
})

test('chunking respects top-level and total limits', () => {
  const blocks = convert(Array.from({ length: 250 }, (_, i) => `<p>p${i}</p>`).join(''))
  const batches = chunkBlocks(blocks)
  assert.deepEqual(batches.map(b => b.length), [100, 100, 50])
  const lists = convert(`<ul>${Array.from({ length: 30 }, () => `<li>x<ul>${'<li>y</li>'.repeat(40)}</ul></li>`).join('')}</ul>`)
  for (const batch of chunkBlocks(lists)) assert.ok(countBlocks(batch) <= 900)
})

test('verification detects missing and altered blocks', () => {
  const sent = convert('<p>a</p><p>b</p>')
  const stored = sent.map(b => ({ type: b.type, [b.type]: { rich_text: b[b.type].rich_text.map(t => ({ plain_text: t.text.content })) } }))
  assert.equal(verifyBlocks(sent, stored).ok, true)
  assert.equal(verifyBlocks(sent, stored.slice(1)).ok, false)
  stored[1].paragraph.rich_text[0].plain_text = 'B'
  assert.match(verifyBlocks(sent, stored).note, /Block 2/)
})

test('verification accepts Notion removing zero-width spaces but preserves meaningful joiners', () => {
  const sent = convert('<p>document\u200b.currentScript \u{1f469}\u200d\u{1f4bb}</p>')
  const stored = [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'document.currentScript \u{1f469}\u200d\u{1f4bb}' }] } }]
  assert.equal(verifyBlocks(sent, stored).ok, true)
  stored[0].paragraph.rich_text[0].plain_text = 'document.currentScript \u{1f469}\u{1f4bb}'
  assert.equal(verifyBlocks(sent, stored).ok, false, 'an emoji joiner must not be ignored')
  stored[0].paragraph.rich_text[0].plain_text = 'document.currentScrip \u{1f469}\u200d\u{1f4bb}'
  assert.equal(verifyBlocks(sent, stored).ok, false, 'visible content changes must still fail')
})

test('markdown export', () => {
  const md = blocksToMarkdown(convert(`<h2>Head</h2><p>Some <b>bold</b> <a href="https://a.b">l</a></p><ul><li>x<ul><li>y</li></ul></li></ul><ol><li>one</li><li>two</li></ol><pre class="language-py">print(1)</pre><table><tr><th>A</th></tr><tr><td>1</td></tr></table>`))
  assert.equal(md.trim(), [
    '## Head', '', 'Some **bold** [l](https://a.b/)', '', '- x', '  - y', '', '1. one', '2. two', '', '```python', 'print(1)', '```', '', '| A |', '| --- |', '| 1 |',
  ].join('\n'))
})

test('preview html escapes content', () => {
  const html = blocksToHtml(convert('<p>&lt;script&gt;x&lt;/script&gt;</p>'))
  assert.equal(html, '<p>&lt;script&gt;x&lt;/script&gt;</p>')
  assert.deepEqual(stats(convert('<p>one two</p><img src="/a.png">')), { blocks: 2, words: 2, images: 1 })
})

test('properties: autofill and payload', () => {
  const props = editableProperties({ properties: {
    Link: { type: 'url' }, Name: { type: 'title' }, Tags: { type: 'multi_select', multi_select: { options: [{ name: 'a' }] } },
    Author: { type: 'rich_text' }, Published: { type: 'date' }, Read: { type: 'checkbox' }, Formula: { type: 'formula' },
  } })
  assert.deepEqual(props.map(p => p.name), ['Name', 'Link', 'Tags', 'Author', 'Published', 'Read'])
  const values = autofill(props, { title: 'T', url: 'https://x.y', byline: 'Ann', publishedTime: '2026-01-02T10:00:00Z' }, { Tags: ['a'], Read: true })
  assert.deepEqual(values, { Name: 'T', Link: 'https://x.y', Tags: ['a'], Author: 'Ann', Published: '2026-01-02', Read: true })
  const payload = buildProperties(props, { ...values, Tags: ['a,b', 'a,b', ''] })
  assert.deepEqual(payload.Tags, { multi_select: [{ name: 'a b' }] })
  assert.deepEqual(payload.Name, { title: [{ type: 'text', text: { content: 'T' } }] })
  assert.equal(payload.Formula, undefined)
})
