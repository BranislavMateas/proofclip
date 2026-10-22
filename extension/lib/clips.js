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
    if (!clip.pageId && clip.ensureUrlProperty) await addUrlProperty(clip, client, persist)
    if (!clip.pageId) {
      const { type, id } = clip.destination
      const parent = type === 'database' ? { database_id: id } : { page_id: id }
      const page = await client.createPage({ parent, properties: clip.properties, children: batches[0] || [] })
      Object.assign(clip, { pageId: page.id, pageUrl: page.url, uploadedBatches: 1 })
      await persist(clip)
    }
    for (let i = clip.uploadedBatches; i < batches.length; i++) {
      await client.appendChildren(clip.pageId, batches[i])
      clip.uploadedBatches = i + 1
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
