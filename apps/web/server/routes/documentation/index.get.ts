import { documentedRoutes } from '../../xcs/openapi'

const TITLE = 'XCS reference read API'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const STYLE = `
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  code { font-family: ui-monospace, monospace; }
`

/**
 * A server-rendered index of the documented routes. It carries no script at
 * all and nonces its single inline stylesheet from `nuxt-security`, so it
 * satisfies the app's `script-src`/`style-src` policy; without a nonce it
 * renders unstyled rather than violating the policy.
 */
export default defineEventHandler((event) => {
  const nonce = event.context.security?.nonce
  const rows = documentedRoutes(event.context.xcs.handlers.routes)
    .map(
      (route) =>
        `<tr><td><code>${escapeHtml(route.method)}</code></td>` +
        `<td><code>${escapeHtml(route.path)}</code></td>` +
        `<td>${escapeHtml(route.summary)}</td></tr>`,
    )
    .join('\n')
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
${nonce === undefined ? '' : `<style nonce="${escapeHtml(nonce)}">${STYLE}</style>`}
</head>
<body>
<h1>${TITLE}</h1>
<p><a href="/documentation/openapi.json">OpenAPI 3.1 document (JSON)</a></p>
<table>
<thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`
})
