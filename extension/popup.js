import { htmlToBlocks, blocksToHtml, blocksToMarkdown, stats } from './lib/convert.js'
import { createClient } from './lib/notion.js'
import { editableProperties, autofill, buildProperties, STICKY } from './lib/properties.js'
import { storage, newClip } from './lib/clips.js'
import { getSettings, updateSettings, activeConnection, rememberDestination } from './lib/settings.js'

const $ = id => document.getElementById(id)
const clips = storage()
const state = { page: null, source: 'article', blocks: [], dest: null, props: [], values: {}, client: null, settings: null, connection: null, results: [], searchSeq: 0 }

function notice(html, bad = false) {
  $('notice').innerHTML = html
  $('notice').className = `notice${bad ? ' bad' : ''}`
  $('notice').hidden = !html
}

async function extract() {
  // ?tab= lets tests drive the popup from a normal tab.
  const tabId = Number(new URLSearchParams(location.search).get('tab')) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id
  await chrome.scripting.executeScript({ target: { tabId }, files: ['vendor/Readability.js'] })
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'] })
  return result
}

// --- Content ---------------------------------------------------------------

function buildBlocks() {
  const p = state.page
  const html = { selection: p.selectionHtml, page: p.fallbackHtml }[state.source] ?? (p.html || p.fallbackHtml)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  state.blocks = htmlToBlocks(doc.body, { baseUrl: p.url })
  const s = stats(state.blocks)
  $('stats').textContent = `${s.words.toLocaleString()} words · ${s.blocks} blocks · ${s.images} images`
  $('preview').innerHTML = blocksToHtml(state.blocks) || '<p class="muted">Nothing readable found on this page.</p>'
  $('warning').textContent = completenessWarning(s.words)
  $('warning').hidden = !$('warning').textContent
  updateSaveButton()
}

const BLOCKED = /just a moment|attention required|access denied|are you a robot|captcha|verify you are human|\b40[34]\b|page not found|not found|sign in to continue|log in to continue|subscribe to (continue|read)/i

function completenessWarning(words) {
  const p = state.page
  if (BLOCKED.test(p.pageTitle) || BLOCKED.test(p.title)) return `This looks like a block, login or error page (“${p.pageTitle}”), not the article. Reload the page in your browser before clipping.`
  if (state.source === 'article' && p.pageWords > 150 && words < p.pageWords * 0.6) {
    return `Article view kept ${words.toLocaleString()} of about ${Math.round(p.pageWords).toLocaleString()} words visible on the page. If text is missing, switch to Full page.`
  }
  return ''
}

function updateSaveButton() {
  $('save').disabled = !state.blocks.length || !state.client || !state.dest || !$('title').value.trim()
}

// --- Properties ------------------------------------------------------------

function field(prop) {
  const wrap = document.createElement('div')
  const id = `prop-${prop.name}`
  const value = state.values[prop.name]
  const set = v => { state.values[prop.name] = v }
  const label = Object.assign(document.createElement('label'), { textContent: prop.name, htmlFor: id })
  wrap.append(label)
  let input
  if (prop.type === 'checkbox') {
    input = Object.assign(document.createElement('input'), { type: 'checkbox', id, checked: !!value })
    input.onchange = () => set(input.checked)
    label.prepend(input)
    return wrap
  }
  if (prop.type === 'multi_select') {
    const chips = Object.assign(document.createElement('div'), { className: 'chips', id })
    const selected = new Set(value || [])
    const add = Object.assign(document.createElement('input'), { placeholder: '+ new tag', style: 'width:90px;padding:1px 6px', className: 'no-submit' })
    const render = () => {
      chips.replaceChildren(...[...new Set([...prop.options, ...selected])].map(name => {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: name })
        b.setAttribute('aria-pressed', selected.has(name))
        b.onclick = () => { selected.has(name) ? selected.delete(name) : selected.add(name); set([...selected]); render() }
        return b
      }), add)
    }
    add.onkeydown = e => {
      if (e.key === 'Enter' && add.value.trim()) { selected.add(add.value.trim()); add.value = ''; set([...selected]); render(); add.focus() }
    }
    render()
    wrap.append(chips)
    return wrap
  }
  if (prop.type === 'select' || prop.type === 'status') {
    input = document.createElement('select')
    input.append(new Option('—', ''), ...prop.options.map(o => new Option(o, o)))
    if (value && !prop.options.includes(value)) input.append(new Option(value, value))
    input.value = value || ''
  } else if (prop.type === 'rich_text' && /excerpt|summary|description|note/i.test(prop.name)) {
    input = document.createElement('textarea')
    input.rows = 2
    input.value = value || ''
  } else {
    input = document.createElement('input')
    input.type = { url: 'url', date: 'date', number: 'number', email: 'email' }[prop.type] || 'text'
    input.value = value ?? ''
  }
  input.id = id
  input.oninput = input.onchange = () => set(input.value)
  wrap.append(input)
  return wrap
}

async function loadSchema() {
  state.props = []
  $('propsBox').hidden = true
  $('urlNote').hidden = true
  if (state.dest?.type !== 'database') return
  const dest = state.dest
  const db = await state.client.getDatabase(dest.id)
  if (state.dest !== dest) return
  state.props = editableProperties(db)
  state.values = autofill(state.props, state.page, state.settings.sticky[dest.id] || {})
  const others = state.props.filter(p => p.type !== 'title')
  $('props').replaceChildren(...others.map(field))
  $('propsBox').hidden = !others.length
  $('urlNote').hidden = state.props.some(p => p.type === 'url')
}

// --- Destination picker ----------------------------------------------------

const label = d => `${d.icon || (d.type === 'database' ? '🗂' : '📄')} ${d.title}`

function renderDestinations() {
  const query = $('destSearch').value.trim()
  const recents = state.settings.recents[state.connection.id] || []
  const groups = query ? [['Results', state.results]] : [['Recent', recents], ['Pages & databases', state.results.filter(r => !recents.some(x => x.id === r.id))]]
  const items = []
  for (const [name, list] of groups) {
    if (!list.length) continue
    items.push(Object.assign(document.createElement('li'), { className: 'group', textContent: name }))
    for (const d of list) {
      const li = document.createElement('li')
      const b = Object.assign(document.createElement('button'), { type: 'button' })
      b.setAttribute('role', 'option')
      b.dataset.id = d.id
      b.append(Object.assign(document.createElement('span'), { textContent: label(d) }), Object.assign(document.createElement('span'), { className: 'kind', textContent: d.type }))
      b.onclick = () => chooseDestination(d)
      li.append(b)
      items.push(li)
    }
  }
  if (!items.length) {
    items.push(Object.assign(document.createElement('li'), {
      className: 'group',
      textContent: query ? 'No matches. Is the page shared with Proofclip?' : 'Nothing shared yet. In Notion, open a page → ••• → Connections → add Proofclip.',
    }))
  }
  $('destList').replaceChildren(...items)
  const first = $('destList').querySelector('button')
  if (first) first.classList.add('active')
  // Pages can parent a new database.
  const pages = [...recents, ...state.results].filter((d, i, all) => d.type === 'page' && all.findIndex(x => x.id === d.id) === i)
  const parent = $('newDbParent')
  const keep = parent.value
  parent.replaceChildren(...pages.map(p => new Option(label(p), p.id)))
  if (pages.some(p => p.id === keep)) parent.value = keep
  $('newDbCreate').disabled = !pages.length
}

async function search() {
  const seq = ++state.searchSeq
  try {
    const results = await state.client.search($('destSearch').value.trim())
    if (seq !== state.searchSeq) return
    state.results = results
    renderDestinations()
  } catch (e) {
    if (e.status === 401) handleNotionError(e)
    else notice(`Couldn't search Notion: ${e.message}`, true)
  }
}

function togglePanel(open = $('destPanel').hidden) {
  $('destPanel').hidden = !open
  $('destButton').setAttribute('aria-expanded', open)
  if (open) {
    renderDestinations()
    search()
    $('destSearch').focus()
  }
}

async function chooseDestination(d) {
  state.dest = d
  $('destLabel').textContent = label(d)
  $('destLabel').className = ''
  togglePanel(false)
  updateSaveButton()
  try {
    await loadSchema()
    notice('')
  } catch (e) {
    handleNotionError(e, d)
  }
  updateSaveButton()
}

function handleNotionError(e, dest) {
  if (e.status === 401) {
    notice(`${state.connection.workspaceName} is no longer connected (${e.message}). Reconnect it in <a href="options.html" target="_blank">Settings</a>.`, true)
  } else if (e.status === 404 && dest) {
    // Deleted or unshared since last time: forget it and let the user pick again.
    const recents = (state.settings.recents[state.connection.id] || []).filter(x => x.id !== dest.id)
    const lastDestination = { ...state.settings.lastDestination }
    delete lastDestination[state.connection.id]
    updateSettings({ recents: { ...state.settings.recents, [state.connection.id]: recents }, lastDestination }).then(s => { state.settings = s })
    state.dest = null
    $('destLabel').textContent = 'Choose a page or database…'
    $('destLabel').className = 'muted'
    notice(`“${dest.title}” was deleted or is no longer shared with Proofclip. Choose another destination.`, true)
    togglePanel(true)
  } else {
    notice(`Couldn't load “${dest?.title}”: ${e.message}`, true)
  }
}

async function createLinksDatabase() {
  const name = $('newDbName').value.trim() || 'Links'
  const parentId = $('newDbParent').value
  if (!parentId) return
  $('newDbCreate').disabled = true
  try {
    const db = await state.client.createDatabase(parentId, name)
    const dest = { id: db.id, type: 'database', title: name, icon: '🔗' }
    state.settings = await rememberDestination(state.connection.id, dest)
    $('newDbForm').hidden = true
    await chooseDestination(dest)
  } catch (e) {
    notice(`Couldn't create the database: ${e.message}`, true)
  } finally {
    $('newDbCreate').disabled = false
  }
}

// --- Save ------------------------------------------------------------------

function showResult(clip) {
  $('result').hidden = false
  const labels = {
    queued: 'Saved locally. Uploading…',
    saving: `Uploading to Notion (attempt ${clip.attempts})…`,
    verifying: 'Uploaded. Checking that Notion stored every block…',
    verified: `Saved to ${clip.destination.title} and verified. ${clip.verifyNote}`,
    mismatch: `Saved, but Notion's copy differs: ${clip.verifyNote} Your full copy is kept in History.`,
    failed: `Not saved: ${clip.error} ${clip.retryable ? `Kept locally — retrying automatically${clip.nextRetryAt ? ` at ${new Date(clip.nextRetryAt).toLocaleTimeString()}` : ''}.` : 'Kept locally in History.'}`,
  }
  $('resultBadge').textContent = clip.status
  $('resultBadge').className = `badge ${clip.status}`
  $('resultText').textContent = labels[clip.status] + (clip.urlPropertyNote ? ` ${clip.urlPropertyNote}` : '')
  $('openPage').hidden = !clip.pageUrl
  $('openPage').href = clip.pageUrl || '#'
  $('retry').hidden = clip.status !== 'failed'
  $('retry').onclick = () => chrome.runtime.sendMessage({ type: 'upload', id: clip.id })
}

async function save() {
  if ($('save').disabled) return
  $('save').disabled = true
  const dest = state.dest
  const title = $('title').value.trim()
  let properties
  let ensureUrlProperty = null
  if (dest.type === 'database') {
    const titleProp = state.props.find(p => p.type === 'title')
    if (titleProp) state.values[titleProp.name] = title
    properties = buildProperties(state.props, state.values)
    if (!state.props.some(p => p.type === 'url')) ensureUrlProperty = state.props.some(p => p.name === 'URL') ? 'Source URL' : 'URL'
    const sticky = Object.fromEntries(state.props.filter(p => STICKY.includes(p.type) && p.name in state.values).map(p => [p.name, state.values[p.name]]))
    await updateSettings({ sticky: { ...state.settings.sticky, [dest.id]: sticky } })
  } else {
    properties = { title: { title: [{ type: 'text', text: { content: title.slice(0, 2000) } }] } }
  }
  await rememberDestination(state.connection.id, dest)
  const clip = newClip({
    source: state.source,
    title,
    url: state.page.url,
    blocks: state.blocks,
    markdown: markdown(),
    destination: dest,
    connectionId: state.connection.id,
    properties,
    ensureUrlProperty,
  })
  await clips.put(clip)
  showResult(clip)
  chrome.storage.onChanged.addListener(changes => {
    const change = changes[`clip:${clip.id}`]
    if (change?.newValue) showResult(change.newValue)
  })
  await chrome.runtime.sendMessage({ type: 'upload', id: clip.id })
}

function markdown() {
  const p = state.page
  const title = $('title').value.trim() || p.title
  return `# ${title}\n\nSource: ${p.url}\n\n${blocksToMarkdown(state.blocks)}`.trimEnd() + '\n'
}

// --- Workspaces ------------------------------------------------------------

async function useConnection(connection) {
  state.connection = connection
  state.client = createClient(connection)
  state.dest = null
  state.results = []
  $('destLabel').textContent = 'Choose a page or database…'
  $('destLabel').className = 'muted'
  $('propsBox').hidden = true
  $('urlNote').hidden = true
  notice('')
  updateSaveButton()
  const last = state.settings.lastDestination[connection.id]
  if (last) await chooseDestination(last)
  else togglePanel(true)
}

function renderWorkspaces() {
  const select = $('workspace')
  select.replaceChildren(...state.settings.connections.map(c => new Option(`${c.workspaceIcon || '🗂'} ${c.workspaceName}`, c.id)))
  select.value = state.connection.id
  select.hidden = state.settings.connections.length < 2
  select.onchange = async () => {
    state.settings = await updateSettings({ activeConnectionId: select.value })
    await useConnection(activeConnection(state.settings))
  }
}

// --- Init ------------------------------------------------------------------

async function init() {
  state.settings = await getSettings()
  try {
    state.page = await extract()
  } catch (e) {
    notice(`This page can't be clipped (${e.message}). Browser pages and the Web Store block extensions.`, true)
    return
  }
  $('form').hidden = false
  $('title').value = state.page.title
  $('title').oninput = updateSaveButton
  $('sourceToggle').querySelector('[data-source=selection]').disabled = !state.page.selectionHtml
  if (state.page.selectionHtml) state.source = 'selection'
  else if (!state.page.html) state.source = 'page'
  for (const b of $('sourceToggle').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', b.dataset.source === state.source)
    b.onclick = () => {
      state.source = b.dataset.source
      for (const x of $('sourceToggle').querySelectorAll('button')) x.setAttribute('aria-pressed', x === b)
      buildBlocks()
    }
  }
  buildBlocks()
  $('copyMd').onclick = async () => { await navigator.clipboard.writeText(markdown()); $('copyMd').textContent = 'Copied' }
  $('downloadMd').onclick = () => {
    const name = ($('title').value || 'clip').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80).trim() || 'clip'
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([markdown()], { type: 'text/markdown' })), download: `${name}.md` }).click()
  }

  const connection = activeConnection(state.settings)
  if (!connection) {
    notice('Connect a Notion workspace in <a href="options.html" target="_blank">Settings</a> to save. Markdown export works without it.')
    return
  }

  $('save').onclick = save
  $('destButton').onclick = () => togglePanel()
  let timer
  $('destSearch').oninput = () => { clearTimeout(timer); timer = setTimeout(search, 200) }
  $('destSearch').onkeydown = e => {
    const options = [...$('destList').querySelectorAll('button')]
    const i = options.findIndex(o => o.classList.contains('active'))
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = options[Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      options.forEach(o => o.classList.toggle('active', o === next))
      next?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      options[Math.max(0, i)]?.click()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      togglePanel(false)
    }
  }
  $('newDbToggle').onclick = () => { $('newDbForm').hidden = !$('newDbForm').hidden; $('newDbName').select() }
  $('newDbCreate').onclick = createLinksDatabase
  $('newDbName').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); createLinksDatabase() } }
  document.addEventListener('click', e => { if (!e.target.closest('.picker')) togglePanel(false) })
  // Like Notion's clipper, Enter saves.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('destPanel').hidden) {
      e.preventDefault()
      togglePanel(false)
      return
    }
    if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented) return
    if (e.target.closest('textarea, button, .no-submit, #destPanel, #newDbForm')) return
    e.preventDefault()
    save()
  })

  state.connection = connection
  renderWorkspaces()
  await useConnection(connection)
  document.body.dataset.ready = 'true'
}

init()
