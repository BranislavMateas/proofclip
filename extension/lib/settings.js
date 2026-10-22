// Settings hold one connection per Notion workspace.
const DEFAULTS = { connections: [], activeConnectionId: '', recents: {}, sticky: {}, lastDestination: {} }

export async function getSettings() {
  const stored = (await chrome.storage.local.get('settings')).settings || {}
  const settings = { ...DEFAULTS, ...stored }
  // v0.1 stored a single token.
  if (stored.token && !settings.connections.length) {
    settings.connections = [{ id: 'legacy', workspaceName: 'Notion', token: stored.token, apiBase: stored.apiBase || 'https://api.notion.com' }]
    settings.activeConnectionId = 'legacy'
  }
  delete settings.token
  delete settings.apiBase
  delete settings.databases
  return settings
}

export async function updateSettings(patch) {
  const settings = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ settings })
  return settings
}

export const activeConnection = settings =>
  settings.connections.find(c => c.id === settings.activeConnectionId) || settings.connections[0] || null

export async function saveConnection(connection) {
  const settings = await getSettings()
  const connections = [...settings.connections.filter(c => c.id !== connection.id), connection]
  return updateSettings({ connections, activeConnectionId: connection.id })
}

export async function removeConnection(id) {
  const settings = await getSettings()
  const connections = settings.connections.filter(c => c.id !== id)
  return updateSettings({ connections, activeConnectionId: connections[0]?.id || '' })
}

export async function rememberDestination(connectionId, destination) {
  const settings = await getSettings()
  const list = [destination, ...(settings.recents[connectionId] || []).filter(d => d.id !== destination.id)].slice(0, 8)
  return updateSettings({
    recents: { ...settings.recents, [connectionId]: list },
    lastDestination: { ...settings.lastDestination, [connectionId]: destination },
  })
}
