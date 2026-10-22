// Maps clip metadata onto a database's properties and builds the API payload.

export const EDITABLE = ['title', 'rich_text', 'url', 'select', 'multi_select', 'status', 'checkbox', 'number', 'date', 'email', 'phone_number']
// Values worth remembering between clips (tags, status, etc.).
export const STICKY = ['select', 'multi_select', 'status', 'checkbox']

export function editableProperties(database) {
  return Object.entries(database.properties || {})
    .filter(([, p]) => EDITABLE.includes(p.type))
    .map(([name, p]) => ({
      name,
      type: p.type,
      options: (p[p.type]?.options || []).map(o => o.name),
    }))
    .sort((a, b) => (a.type === 'title' ? -1 : b.type === 'title' ? 1 : 0))
}

const RULES = [
  { types: ['url'], pattern: /url|link|source|href|address/i, key: 'url' },
  { types: ['date'], pattern: /clip|saved|added|captured|created|date/i, key: 'today' },
  { types: ['date'], pattern: /publish|posted|written/i, key: 'published', priority: true },
  { types: ['rich_text'], pattern: /author|byline|writer/i, key: 'byline' },
  { types: ['rich_text', 'select'], pattern: /site|publication|publisher|domain|website/i, key: 'siteName' },
  { types: ['rich_text'], pattern: /excerpt|summary|description|abstract/i, key: 'excerpt' },
]

export function autofill(props, meta, sticky = {}) {
  const values = {}
  const facts = {
    url: meta.url,
    today: new Date().toISOString().slice(0, 10),
    published: meta.publishedTime ? String(meta.publishedTime).slice(0, 10) : '',
    byline: meta.byline,
    siteName: meta.siteName,
    excerpt: meta.excerpt,
  }
  for (const prop of props) {
    if (prop.type === 'title') {
      values[prop.name] = meta.title || ''
      continue
    }
    if (prop.name in sticky && STICKY.includes(prop.type)) values[prop.name] = sticky[prop.name]
    const matches = RULES.filter(r => r.types.includes(prop.type) && r.pattern.test(prop.name))
    const rule = matches.find(r => r.priority) || matches[0]
    if (rule && facts[rule.key]) values[prop.name] = facts[rule.key]
  }
  // A database with a single URL property almost always wants the source.
  const urls = props.filter(p => p.type === 'url')
  if (urls.length === 1 && !values[urls[0].name]) values[urls[0].name] = meta.url
  return values
}

const text = v => [{ type: 'text', text: { content: String(v).slice(0, 2000) } }]
const optionName = v => String(v).replace(/,/g, ' ').trim().slice(0, 100)

export function buildProperties(props, values) {
  const out = {}
  for (const { name, type } of props) {
    const v = values[name]
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
    if (type === 'checkbox') {
      if (v !== undefined) out[name] = { checkbox: !!v }
      continue
    }
    if (empty) {
      if (type === 'title') out[name] = { title: [] }
      continue
    }
    switch (type) {
      case 'title': out[name] = { title: text(v) }; break
      case 'rich_text': out[name] = { rich_text: text(v) }; break
      case 'url': out[name] = { url: String(v) }; break
      case 'email': out[name] = { email: String(v) }; break
      case 'phone_number': out[name] = { phone_number: String(v) }; break
      case 'select': out[name] = { select: { name: optionName(v) } }; break
      case 'status': out[name] = { status: { name: String(v) } }; break
      case 'multi_select': out[name] = { multi_select: [...new Set([].concat(v).map(optionName).filter(Boolean))].map(n => ({ name: n })) }; break
      case 'number': if (Number.isFinite(Number(v))) out[name] = { number: Number(v) }; break
      case 'date': out[name] = { date: { start: String(v) } }; break
    }
  }
  return out
}
