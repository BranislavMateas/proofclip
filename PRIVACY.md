# Proofclip privacy policy

Effective date: October 22, 2026

Proofclip is an open-source Chrome extension maintained by Branislav Mateáš.
It saves web content that you select to your Notion workspace and checks the saved blocks.

## Data used by the extension

When you open Proofclip, it reads the current page to prepare a clip. This can include
its title, URL, article text, selected text, images, links, and author information.
You can inspect the resulting preview before saving.

Proofclip stores clips, their source URLs, destination details, editable properties,
save status, and history in Chrome's local extension storage. It also stores your
Notion integration token and workspace connection details there. This storage is
local to your browser profile; it does not use Chrome Sync.

## Where data goes

When you save a clip, Proofclip sends its content and properties directly to Notion
through the Notion API. It authenticates requests with your integration token and
reads the saved blocks back to check their content. It also contacts Notion when
connecting a workspace, searching destinations, or editing a destination schema.
Failed clips can be retried in the background.

Article previews can load images from the websites that host those images. Those
websites can receive ordinary image requests, including your IP address and browser
request information. Links that you open are handled by your browser.

The distributed version uses an integration token. Optional OAuth code exists for
self-hosted deployments. If a deployment enables OAuth, its configured token-exchange
server also processes the authorization code and resulting Notion token. The bundled
example worker does not deliberately persist them; hosting logs depend on that deployment.

Proofclip has no analytics, advertising, tracking scripts, or developer-operated
content collection service. The maintainer does not receive your clips or token.
Your data is not sold or used for advertising. Processing is limited to the clipping,
Notion connection, local history, export, backup, retry, and verification features.

## Your controls

- Share only the Notion pages and databases that you want the integration to access.
- Delete local clips in History. This does not delete pages already saved to Notion.
- Disconnect a workspace in Settings. This removes its stored connection and token,
  but keeps local clip history and pages already saved in Notion.
- Revoke the integration token in Notion to end its API access.
- Uninstall the extension to remove its local browser storage.
- Copy or download Markdown, or export and restore a local JSON clip backup.

Exported backups contain clip content and metadata. Store and share them carefully.
Notion retains saved pages according to your Notion settings and its own policies.

## Contact and changes

For questions, contact the maintainer through
[GitHub](https://github.com/BranislavMateas) or open a
[Proofclip issue](https://github.com/BranislavMateas/proofclip/issues).
Do not include tokens or private page content in a public issue.

Changes to this policy will be recorded in this repository with a new effective date.
