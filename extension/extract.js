// Injected into the page after vendor/Readability.js. Runs on the live,
// already-rendered DOM, so content loaded by scripts is included.
;(() => {
  const selection = window.getSelection()
  let selectionHtml = ''
  if (selection && selection.rangeCount && !selection.isCollapsed) {
    const box = document.createElement('div')
    for (let i = 0; i < selection.rangeCount; i++) box.appendChild(selection.getRangeAt(i).cloneContents())
    selectionHtml = box.innerHTML
  }
  let article = null
  try {
    article = new Readability(document.cloneNode(true), { keepClasses: true }).parse()
  } catch {}
  const words = el => (el?.innerText?.match(/\S+/g) || []).length
  const main = document.querySelector('article, main, [role=main]')
  const meta = name => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || ''
  return {
    url: location.href,
    title: article?.title || meta('og:title') || document.title,
    html: article?.content || '',
    fallbackHtml: document.body?.innerHTML || '',
    // Visible words, used to warn when the article view drops content.
    pageWords: Math.max(words(main), main ? 0 : words(document.body) * 0.6),
    pageTitle: document.title,
    byline: article?.byline || meta('author'),
    siteName: article?.siteName || meta('og:site_name') || location.hostname,
    excerpt: article?.excerpt || meta('description'),
    publishedTime: article?.publishedTime || meta('article:published_time'),
    selectionHtml,
  }
})()
