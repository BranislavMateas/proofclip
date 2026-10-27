// Local clip storage and the upload state machine. Every clip is stored
// before upload, so a failed save never loses content.

import { chunkBlocks, verifyTree } from './convert.js'

export const MAX_ATTEMPTS = 8
const PREFIX = 'clip:'

export const backoff = attempt => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1))

export function storage(area = globalThis.chrome?.storage.local) {
  return {
    async get(id) {
      return (await area.get(PREFIX + id))[PREFIX + id] || null
    },
    async put(clip) {
      clip.updatedAt = Date.now()
      await area.set({ [PREFIX + clip.id]: clip })
      return clip
    },
    async remove(id) {
      await area.remove(PREFIX + id)
    },
    async list() {
      const all = await area.get(null)
      return Object.entries(all)
        .filter(([k]) => k.startsWith(PREFIX))
        .map(([, v]) => v)
        .sort((a, b) => b.createdAt - a.createdAt)
    },
  }
}

export function newClip({ source, title, url, blocks, markdown, destination, connectionId, properties, ensureUrlProperty = null }) {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    source,
    title,
    url,
    blocks,
    markdown,
    destination,
    connectionId,
    properties,
    ensureUrlProperty,
    status: 'queued',
    attempts: 0,
    pageId: null,
    pageUrl: null,
    uploadedBatches: 0,
    createPending: false,
    createMarker: null,
    titleRestored: false,
    pendingAppend: null,
    error: null,
    retryable: true,
    nextRetryAt: null,
  }
}

// Resumable: a page that was created, or partly filled, is never recreated.
export async function uploadClip(clip, client, persist) {
  const batches = chunkBlocks(clip.blocks)
  clip.attempts++
  Object.assign(clip, { status: 'saving', error: null, nextRetryAt: null })
  await persist(clip)
  try {
    // Resolve old saved destinations only when their database is unambiguous.
    if (!clip.pageId && clip.destination.type === 'database') {
      clip.destination = await client.resolveDestination(clip.destination)
      await persist(clip)
    }
    if (!clip.pageId && clip.ensureUrlProperty) await addUrlProperty(clip, client, persist)
    if (!clip.pageId) {
      // Pre-upgrade attempts had no recovery marker. Never silently recreate one.
      if (clip.legacyUncertain || (clip.createPending === undefined && clip.attempts > 1)) {
        clip.legacyUncertain = true
        const e = new Error('An earlier version attempted this save without a recovery marker. Check Notion before making a new clip.')
        e.retryable = false
        throw e
      }
      const { type, id } = clip.destination
      const parent = type === 'data_source' ? { data_source_id: id } : { page_id: id }
      const titleProperty = Object.keys(clip.properties).find(name => 'title' in clip.properties[name])
      if (!titleProperty) throw Object.assign(new Error('The destination has no title property. Choose it again.'), { retryable: false })
      let page
      if (clip.createPending) {
        const matches = await client.findCreatedPage(clip.destination, clip.createMarker, titleProperty)
        if (matches.length !== 1) throw new Error(matches.length ? 'Multiple recovery pages found. Check Notion before making a new clip.' : 'The previous save is uncertain. Its recovery page is not visible yet. Retry to check again; no second page will be created.')
        page = matches[0]
      } else {
        clip.createMarker ||= `Proofclip pending ${crypto.randomUUID()}`
        clip.createPending = true
        await persist(clip)
        try {
          page = await client.createPage({ parent, properties: { ...clip.properties, [titleProperty]: { title: [{ type: 'text', text: { content: clip.createMarker } }] } }, children: batches[0] || [] })
          if (!page?.id || !page?.url) throw new Error('Notion returned an incomplete page response. Retry to recover the page.')
        } catch (e) {
          if (definitelyRejected(e)) clip.createPending = false
          throw e
        }
      }
      Object.assign(clip, { pageId: page.id, pageUrl: page.url, uploadedBatches: 1, createPending: false })
      await persist(clip)
    }
    // Store the page ID before replacing its unique recovery title. A lost
    // update response is safe: updating properties again does not add content.
    if (clip.createMarker && !clip.titleRestored) {
      await client.updatePage(clip.pageId, clip.properties)
      clip.titleRestored = true
      await persist(clip)
    }
    if (clip.pendingAppend) {
      const { index, end } = clip.pendingAppend
      const expected = clip.blocks.slice(0, end)
      const check = await verifyTree(expected, client.listChildren, clip.pageId)
      if (!check.ok) throw new Error(`The previous block upload is uncertain. ${check.note} Retry to check again; no blocks will be sent twice.`)
      clip.uploadedBatches = index + 1
      clip.pendingAppend = null
      await persist(clip)
    }
    for (let i = clip.uploadedBatches; i < batches.length; i++) {
      clip.pendingAppend = { index: i, end: batches.slice(0, i + 1).reduce((n, batch) => n + batch.length, 0) }
      await persist(clip)
      try {
        await client.appendChildren(clip.pageId, batches[i])
      } catch (e) {
        if (definitelyRejected(e)) clip.pendingAppend = null
        throw e
      }
      clip.uploadedBatches = i + 1
      clip.pendingAppend = null
      await persist(clip)
    }
    clip.status = 'verifying'
    await persist(clip)
    const check = await verifyTree(clip.blocks, client.listChildren, clip.pageId)
    Object.assign(clip, { status: check.ok ? 'verified' : 'mismatch', verifyNote: check.note, savedAt: Date.now() })
  } catch (e) {
    const retryable = (e.retryable ?? true) && clip.attempts < MAX_ATTEMPTS
    Object.assign(clip, {
      status: 'failed',
      error: e.message,
      retryable,
      nextRetryAt: retryable ? Date.now() + backoff(clip.attempts) : null,
    })
  }
  await persist(clip)
  return clip
}

// A transport failure, conflict or server failure can follow a committed write.
const definitelyRejected = e => e.status >= 400 && e.status < 500 && ![408, 409].includes(e.status)

// Like Notion's clipper, databases without a URL property get one, so the
// source is always recorded. Lacking permission to edit the schema is not fatal.
async function addUrlProperty(clip, client, persist) {
  const name = clip.ensureUrlProperty
  try {
    await client.addProperty(clip.destination.id, name, 'url')
    clip.properties[name] = { url: clip.url }
  } catch (e) {
    if (e.retryable) throw e
    clip.urlPropertyNote = `Couldn't add a URL property: ${e.message}`
  }
  clip.ensureUrlProperty = null
  await persist(clip)
}

export const isDue = (clip, now = Date.now()) =>
  (clip.status === 'failed' && clip.retryable && clip.nextRetryAt <= now) ||
  (clip.status === 'queued' && now - clip.updatedAt > 10_000) ||
  // A service worker that died mid-upload leaves these behind.
  (['saving', 'verifying'].includes(clip.status) && now - clip.updatedAt > 2 * 60_000)
