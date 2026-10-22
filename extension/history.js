import { storage } from './lib/clips.js'

const $ = id => document.getElementById(id)
const clips = storage()

const download = (name, text, type) =>
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name }).click()

const button = (label, onclick) => Object.assign(document.createElement('button'), { textContent: label, onclick })

async function render() {
  const list = await clips.list()
  $('empty').hidden = list.length > 0
  $('rows').replaceChildren(...list.map(clip => {
    const tr = document.createElement('tr')
    const main = document.createElement('td')
    const link = Object.assign(document.createElement('a'), { href: clip.url, target: '_blank', textContent: clip.title || clip.url })
    const detail = Object.assign(document.createElement('div'), { className: 'detail' })
    detail.textContent = [clip.destination?.title || clip.databaseTitle, clip.source === 'selection' ? 'selection' : null, clip.error || clip.verifyNote].filter(Boolean).join(' · ')
    main.append(link, detail)
    const status = document.createElement('td')
    status.append(Object.assign(document.createElement('span'), { className: `badge ${clip.status}`, textContent: clip.status }))
    const when = Object.assign(document.createElement('td'), { className: 'muted', textContent: new Date(clip.savedAt || clip.createdAt).toLocaleString() })
    const actions = Object.assign(document.createElement('td'), { className: 'actions' })
    if (clip.pageUrl) actions.append(Object.assign(document.createElement('a'), { href: clip.pageUrl, target: '_blank', textContent: 'Open' }), ' ')
    if (['failed', 'mismatch'].includes(clip.status)) {
      actions.append(button(clip.status === 'mismatch' ? 'Save again' : 'Retry', async () => {
        // A mismatched page is left as is; saving again creates a fresh page.
        if (clip.status === 'mismatch') Object.assign(clip, { pageId: null, pageUrl: null, uploadedBatches: 0 })
        Object.assign(clip, { status: 'queued', attempts: 0, retryable: true })
        await clips.put(clip)
        chrome.runtime.sendMessage({ type: 'upload', id: clip.id })
      }), ' ')
    }
    actions.append(button('.md', () => download(`${(clip.title || 'clip').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.md`, clip.markdown, 'text/markdown')), ' ')
    actions.append(button('Delete', async () => {
      if (confirm(`Delete the local copy of “${clip.title}”? The Notion page is not affected.`)) await clips.remove(clip.id)
    }))
    tr.append(main, status, when, actions)
    return tr
  }))
}

$('retryAll').onclick = async () => {
  for (const clip of await clips.list()) {
    if (clip.status !== 'failed') continue
    Object.assign(clip, { status: 'queued', attempts: 0, retryable: true })
    await clips.put(clip)
    chrome.runtime.sendMessage({ type: 'upload', id: clip.id })
  }
}
$('export').onclick = async () =>
  download(`proofclip-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, clips: await clips.list() }, null, 1), 'application/json')
$('importBtn').onclick = () => $('import').click()
$('import').onchange = async () => {
  const file = $('import').files[0]
  if (!file) return
  const { clips: imported = [] } = JSON.parse(await file.text())
  for (const clip of imported) if (clip.id && clip.blocks) await clips.put(clip)
  alert(`Imported ${imported.length} clips.`)
}

chrome.storage.onChanged.addListener(render)
render()
