# Chrome Web Store listing

Name: Proofclip: verified web clipper for Notion
Short description: Save web pages to Notion. Preview the content, edit properties, and verify that every text block arrived.
Category: Workflow and planning (Productivity)
Language: English
Price: Free
Website: https://github.com/BranislavMateas/proofclip
Support: https://github.com/BranislavMateas/proofclip/issues
Privacy policy: https://github.com/BranislavMateas/proofclip/blob/main/PRIVACY.md

## Detailed description

Save a page to Notion. Then check what arrived.

Proofclip is a free, open-source web clipper for Notion. Preview the blocks before
you save, choose a page or database, and edit the title, tags, and other supported
properties in the popup. After saving, Proofclip reads the page back from Notion
and compares the block types and text, including nested lists and table rows.

CHOOSE WHAT TO SAVE
• Article mode extracts the main content.
• Selection mode saves the text you select.
• Full page mode provides another option when article extraction misses content.
• Preview the blocks and see warnings about short, incomplete, or blocked pages.

ORGANIZE BEFORE YOU SAVE
• Search pages and databases in your connected workspace.
• Edit supported properties and tags before saving.
• Create a links database without leaving the extension.
• Keep separate destinations for multiple workspace connections.

KEEP A LOCAL COPY
• Each clip is stored locally before upload.
• Failed uploads remain available for retry.
• Continue partial uploads from their saved progress.
• Copy or download Markdown, and export or restore a JSON clip backup.

CHECK THE RESULT
• Read saved blocks back from Notion.
• Compare their types and text, including nested blocks.
• See a verified result or a clear mismatch message.
• Open the saved page in Notion.

SETUP
This version connects with a Notion integration token. Create an internal connection
in Notion with Read, Insert, and Update content permissions. Share the pages or
databases you want to use with that connection, then enter the token in Proofclip
Settings. One-click OAuth sign-in is not configured in this release.

PRIVACY
Clips and connection details are kept in your local browser profile. Clip content
is sent to Notion when you save or retry. Preview images may load from their source
websites. No analytics, ads, or developer-operated clip collection service.

Proofclip is an independent project and is not affiliated with Notion.

## Single purpose

Save user-selected web content to a chosen Notion destination and verify the saved
block content, with local clip history and retry support.

## Permission explanations

activeTab: Read the page that the user chooses to clip after opening the extension.
scripting: Run the bundled article extractor in that user-selected tab.
storage: Store Notion connection details, preferences, and local clips.
unlimitedStorage: Keep full article content and failed uploads without Chrome's normal local storage quota.
alarms: Schedule retries for clips that failed to upload.
identity: Support the optional Notion OAuth flow in configured deployments. The default release uses a token.
https://api.notion.com/*: Connect to Notion, search shared destinations, save pages, and read blocks back for verification.

## Data disclosure

Disclose authentication information (Notion integration tokens), website content
(selected page text and media references), and browsing history (the URLs and titles
of pages the user chooses to clip). There is no passive browsing-history collection.
There is no remote executable code. Bundled Readability runs locally; API responses
and article images are data, not downloaded executable code.

## Reviewer instructions

1. Load the extension and open Settings.
2. In a Notion test workspace, create an internal connection with Read, Insert, and Update content access.
3. Create a test page and grant that connection access to it.
4. Paste the integration token into Proofclip Settings and connect.
5. Open a public article, open Proofclip, and choose the test page.
6. Review the preview and click Save page. Wait for the verified result.
7. Test Selection and Full page modes. History contains local clips and export controls.

No developer-owned account or shared credential is required. Use a test workspace.
