// Runs test/real-notion.mjs against the mock API, to check the script itself.
import { spawn } from 'node:child_process'
import { startMockNotion, PAGE_ID } from '../test/mock-notion.js'
const mock = await startMockNotion()
const child = spawn(process.execPath, [new URL('../test/real-notion.mjs', import.meta.url).pathname], {
  env: { ...process.env, NOTION_TOKEN: mock.token, NOTION_PAGE_ID: PAGE_ID, NOTION_API: mock.url },
  stdio: 'inherit',
})
child.on('exit', code => { mock.close(); process.exit(code) })
