import { createClient } from './lib/notion.js'
import { storage, uploadClip, isDue } from './lib/clips.js'
import { getSettings } from './lib/settings.js'

const clips = storage()
const inflight = new Set()

async function run(id) {
  if (inflight.has(id)) return
  inflight.add(id)
  try {
    const clip = await clips.get(id)
    if (!clip || ['verified', 'mismatch'].includes(clip.status)) return
    const settings = await getSettings()
    const connection = settings.connections.find(c => c.id === clip.connectionId)
    if (!connection) {
      Object.assign(clip, { status: 'failed', error: 'This workspace is no longer connected. Reconnect it in Settings, then retry.', retryable: false })
      await clips.put(clip)
      return
    }
    await uploadClip(clip, createClient(connection), clips.put)
  } finally {
    inflight.delete(id)
  }
}

async function retryDue() {
  for (const clip of await clips.list()) if (isDue(clip) && !inflight.has(clip.id)) await run(clip.id)
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'upload') {
    run(msg.id)
    reply({ ok: true })
  }
})

chrome.alarms.get('retry').then(alarm => alarm || chrome.alarms.create('retry', { periodInMinutes: 1 }))
chrome.alarms.onAlarm.addListener(alarm => alarm.name === 'retry' && retryDue())
chrome.runtime.onStartup.addListener(retryDue)
