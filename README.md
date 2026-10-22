# Proofclip

An open-source web clipper for Notion. It works like Notion's own Web Clipper and checks every save.

## Parity with Notion Web Clipper

| Notion Web Clipper | Proofclip |
|---|---|
| Sign in with your Notion account | **Sign in with Notion** (OAuth). Integration tokens also work. |
| Workspace picker | Workspace switcher. Each workspace remembers its own last destination. |
| “Add to” any page or database, default list + search | Recent destinations plus search, with arrow keys and Enter to pick |
| `+ New links database` | Same. You name it and choose its parent page. |
| Editable title, Enter / `Save page` | Same |
| “Open in Notion” after saving | Same |
| URL property added to databases that lack one | Same. If Proofclip can't edit the schema, the clip still saves. |
| Tags/properties only editable afterwards in Notion | **Better:** edit every property before saving. Values are filled in automatically and tags are remembered. |
| Silent missing text / wrong content | **Better:** a preview of the exact blocks to be saved, missing-content and block-page warnings, plus Selection and Full page modes |
| Failed saves are lost | **Better:** each clip is stored locally first. Proofclip retries with backoff, resumes partial uploads without duplicates, and waits out rate limits. |
| No check of the result | **Better:** Proofclip reads the page back from Notion and compares every block, including nested blocks |
| — | Markdown copy/download, history, and JSON backup/restore |

Out of scope: the iOS/Android share sheet and Safari.

## Install (development)

1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
2. Settings → **Connect with an integration token**. Create the token at notion.so/profile/integrations with Read, Insert and Update content. Then share pages or databases with it: ••• → Connections.

### Enabling “Sign in with Notion”

1. Create a **public** integration in Notion. Set its redirect URI to `https://<extension-id>.chromiumapp.org/notion`.
2. Deploy `server/oauth-worker.js` (Cloudflare Worker) with the secrets `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`. Set `ALLOWED_ORIGIN=chrome-extension://<extension-id>`.
3. Put the client ID and the worker URL in `extension/config.js`. The client secret never ships in the extension, and the worker stores nothing.

## Tests

```
npm install
npm test        # 26 unit/integration tests against a strict mock Notion API
npm run e2e     # real extension in Chrome: OAuth, workspaces, search, pages, databases,
                # new links database, URL property, outage/retry, deleted destination,
                # revoked token, selection, warnings, history (17 steps)
npm run real    # the real Notion API: needs NOTION_TOKEN + NOTION_PAGE_ID (or .env.test)
node test/real-pages.mjs URL…   # clip live sites through the extension into the mock
```

## Known gaps

- The integration hasn't run against the real Notion API yet. Run `npm run real` with a token to do that.
- If Notion creates a page but its response is lost, a retry creates a second page.
- Proofclip uses API version `2022-06-28`. It doesn't yet support multi-source databases (`2025-09-03`).
