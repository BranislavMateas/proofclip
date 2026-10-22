import { getSettings, saveConnection, removeConnection, updateSettings } from './lib/settings.js'
import { connectWithToken, signInWithNotion, oauthConfigured } from './lib/auth.js'

const $ = id => document.getElementById(id)

function status(text, bad = false) {
  $('status').hidden = !text
  $('status').className = `notice${bad ? ' bad' : ''}`
  $('status').textContent = text
}

async function render() {
  const settings = await getSettings()
  $('none').hidden = settings.connections.length > 0
  $('oauthBox').hidden = !oauthConfigured()
  $('tokenBox').open = !oauthConfigured() && !settings.connections.length
  $('connections').replaceChildren(...settings.connections.map(c => {
    const li = document.createElement('li')
    const name = Object.assign(document.createElement('span'), { className: 'grow', textContent: `${c.workspaceIcon || '🗂'} ${c.workspaceName}` })
    const how = Object.assign(document.createElement('span'), { className: 'muted', textContent: c.method === 'oauth' ? 'signed in' : 'token' })
    const active = Object.assign(document.createElement('span'), { className: 'badge verified', textContent: 'default', hidden: c.id !== settings.activeConnectionId })
    const remove = Object.assign(document.createElement('button'), { textContent: 'Disconnect' })
    remove.onclick = async () => {
      if (!confirm(`Disconnect ${c.workspaceName}? Clips already saved stay in Notion and in History.`)) return
      await removeConnection(c.id)
      render()
    }
    const makeDefault = Object.assign(document.createElement('button'), { textContent: 'Make default', hidden: c.id === settings.activeConnectionId })
    makeDefault.onclick = async () => { await updateSettings({ activeConnectionId: c.id }); render() }
    li.append(name, active, how, makeDefault, remove)
    return li
  }))
}

$('connect').onclick = async () => {
  status('Connecting…')
  try {
    const connection = await connectWithToken($('token').value.trim(), $('apiBase').value.trim() || 'https://api.notion.com')
    await saveConnection(connection)
    $('token').value = ''
    status(`Connected to ${connection.workspaceName}.`)
    render()
  } catch (e) {
    status(`Couldn't connect: ${e.message}`, true)
  }
}

$('signIn').onclick = async () => {
  status('Waiting for Notion…')
  try {
    const connection = await signInWithNotion()
    await saveConnection(connection)
    status(`Connected to ${connection.workspaceName}.`)
    render()
  } catch (e) {
    status(e.message, true)
  }
}

render()
