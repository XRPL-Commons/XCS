// Generate offline review artifacts from the bilingual screen catalog; no application code runs.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const screens = JSON.parse(await readFile(join(root, 'screens.json'), 'utf8'))
const check = process.argv.includes('--check')
const roles = {
  admin: ['Administration', 'Administration'],
  issuer: ['Émetteur', 'Issuer'],
  recipient: ['Destinataire', 'Recipient'],
  verifier: ['Vérificateur', 'Verifier'],
  shared: ['États partagés', 'Shared states'],
}
const locales = ['fr', 'en']
const W = 390
const H = 844
const outputs = new Map()
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

function wrap(value, max) {
  const lines = ['']
  for (const word of value.split(/\s+/)) {
    if ((lines.at(-1) + ' ' + word).trim().length > max && lines.at(-1)) lines.push('')
    lines[lines.length - 1] = (lines.at(-1) + ' ' + word).trim()
  }
  return lines.join('\n')
}

function primitives(screen, locale) {
  const index = locales.indexOf(locale)
  const list = []
  const rect = (x, y, width, height, fill = '#ffffff', stroke = '#b4b4b4') =>
    list.push({ type: 'rectangle', x, y, width, height, fill, stroke })
  const text = (value, x, y, fontSize = 14, max = 44, color = '#252525') => {
    const content = wrap(value, max)
    const height = content.split('\n').length * fontSize * 1.3
    list.push({ type: 'text', x, y, width: W - x - 24, height, fontSize, content, color })
    return height
  }
  rect(0, 0, W, H, '#ffffff', '#777777')
  rect(0, 0, W, 42, '#eeeeee', '#777777')
  text(`XCS  /  ${roles[screen.role][index]}`, 20, 12, 13)
  let y = 62
  y += text(screen.title[index], 24, y, 23, 25) + 12
  y += text(screen.intro[index], 24, y, 14, 43) + 15
  const statusText = wrap(screen.status[index], 43)
  const statusHeight = statusText.split('\n').length * 17 + 20
  rect(24, y, 342, statusHeight, '#eeeeee')
  text(screen.status[index], 34, y + 10, 13, 43)
  y += statusHeight + 16
  for (const [label, value] of screen.rows) {
    const labelHeight = wrap(label[index], 43).split('\n').length * 17
    const valueHeight = wrap(value[index], 43).split('\n').length * 18.2
    const height = labelHeight + valueHeight + 24
    rect(24, y, 342, height)
    text(label[index], 34, y + 9, 13, 43, '#555555')
    text(value[index], 34, y + 12 + labelHeight, 14, 43)
    y += height + 10
  }
  y += 6
  for (const [actionIndex, action] of screen.actions.entries()) {
    const label = wrap(action[index], 40)
    const height = Math.max(44, label.split('\n').length * 18.2 + 20)
    rect(24, y, 342, height, actionIndex === 0 ? '#333333' : '#ffffff', '#333333')
    text(
      action[index],
      36,
      y + (height - label.split('\n').length * 18.2) / 2,
      14,
      40,
      actionIndex === 0 ? '#ffffff' : '#252525',
    )
    y += height + 10
  }
  y += text(screen.note[index], 24, y + 3, 12, 49, '#555555') + 9
  if (y > H - 30) throw new Error(`${screen.id}/${locale}: content exceeds mobile frame (${y})`)
  text(
    index === 0
      ? 'MAQUETTE · Exemple fictif · Non fonctionnel'
      : 'WIREFRAME · Fictional example · Non-functional',
    24,
    H - 23,
    10,
    60,
    '#666666',
  )
  return list
}

function svg(screen, locale, items) {
  const index = locales.indexOf(locale)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc" xml:lang="${locale}">
<title id="title">${screen.id} — ${escape(screen.title[index])}</title>
<desc id="desc">${escape(screen.intro[index])} ${escape(screen.note[index])}</desc>
${items
  .map((item) =>
    item.type === 'rectangle'
      ? `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="3" fill="${item.fill}" stroke="${item.stroke}"/>`
      : `<text x="${item.x}" y="${item.y}" font-family="Arial, sans-serif" font-size="${item.fontSize}" fill="${item.color}" dominant-baseline="text-before-edge">${item.content
          .split('\n')
          .map(
            (line, i) =>
              `<tspan x="${item.x}" dy="${i === 0 ? 0 : item.fontSize * 1.3}">${escape(line)}</tspan>`,
          )
          .join('')}</text>`,
  )
  .join('\n')}
</svg>\n`
}

function sceneElement(item, id, offsetX, offsetY) {
  const base = {
    id,
    type: item.type,
    x: item.x + offsetX,
    y: item.y + offsetY,
    width: item.width,
    height: item.height,
    angle: 0,
    strokeColor: item.type === 'text' ? item.color : item.stroke,
    backgroundColor: item.fill ?? 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    created: null,
    link: null,
    locked: false,
  }
  if (item.type === 'text')
    Object.assign(base, {
      text: item.content,
      originalText: item.content,
      fontSize: item.fontSize,
      fontFamily: 2,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: 1.3,
    })
  return base
}

const seen = new Set()
for (const screen of screens) {
  if (seen.has(screen.id) || !/^[AIRVF][1-6]$/.test(screen.id) || !roles[screen.role])
    throw new Error(`Invalid screen: ${screen.id}`)
  seen.add(screen.id)
  const pairs = [
    screen.title,
    screen.intro,
    screen.status,
    screen.note,
    ...screen.actions,
    ...screen.rows.flat(),
  ]
  if (
    pairs.some(
      (pair) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair.some((value) => typeof value !== 'string' || !value.trim()),
    )
  )
    throw new Error(`Missing FR/EN copy: ${screen.id}`)
}

for (const role of Object.keys(roles)) {
  const roleScreens = screens.filter((screen) => screen.role === role)
  for (const locale of locales) {
    const elements = []
    for (const [screenIndex, screen] of roleScreens.entries()) {
      const items = primitives(screen, locale)
      outputs.set(`${role}/${screen.id.toLowerCase()}.${locale}.svg`, svg(screen, locale, items))
      const x = (screenIndex % 3) * (W + 50)
      const y = Math.floor(screenIndex / 3) * (H + 80)
      items.forEach((item, i) =>
        elements.push(sceneElement(item, `${screen.id}-${locale}-${i}`, x, y)),
      )
    }
    outputs.set(
      `${role}/wireframes.${locale}.excalidraw`,
      JSON.stringify(
        {
          type: 'excalidraw',
          version: 2,
          source: 'https://excalidraw.com',
          elements,
          appState: { viewBackgroundColor: '#f5f5f5', gridSize: null },
          files: {},
        },
        null,
        2,
      ) + '\n',
    )
  }
}

const html = `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>XCS — parcours et maquettes / journeys and wireframes</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f4f4; color: #242424; font: 16px/1.5 system-ui, sans-serif; }
header, main { max-width: 1360px; margin: auto; padding: 24px; }
h1 { font-size: clamp(1.6rem, 4vw, 2.5rem); line-height: 1.15; }
a { color: #222; text-underline-offset: 3px; }
a:focus-visible, input:focus-visible { outline: 3px solid #333; outline-offset: 4px; }
nav { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 16px 0; }
nav a, .downloads a { display: inline-block; padding: 10px 0; min-height: 44px; }
.notice { border-left: 4px solid #555; padding: 12px 16px; background: #fff; max-width: 850px; }
.language { display: inline-block; padding: 12px 8px 12px 0; cursor: pointer; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 24px; align-items: start; }
figure { margin: 0; min-width: 0; }
figcaption { margin: 10px 0; font-size: 14px; }
img { display: block; width: 100%; max-width: 390px; height: auto; margin: 0 auto; }
section { scroll-margin-top: 12px; margin: 36px 0 56px; }
.en { display: none; }
body:has(#locale-en:checked) .fr { display: none; }
body:has(#locale-en:checked) .en { display: revert; }
@media print { nav, .language, input { display: none; } figure { break-inside: avoid; } }
</style></head>
<body><header>
<p>ISSUE #29 / XCS</p>
<h1>Parcours et maquettes<br><span lang="en">Journeys and wireframes</span></h1>
<p class="notice fr">Proposition à tester avec deux personnes par rôle. Aucune session réalisée. Données fictives ; les boutons dessinés ne réalisent aucune action.</p>
<p class="notice en" lang="en">Draft for testing with two people per role. No sessions conducted. Fictional data; controls drawn in the screens perform no action.</p>
<input type="radio" id="locale-fr" name="locale" checked><label class="language" for="locale-fr">Français</label>
<input type="radio" id="locale-en" name="locale"><label class="language" for="locale-en" lang="en">English</label>
<nav aria-label="Rôles / Roles">${Object.entries(roles)
  .map(
    ([role, names]) =>
      `<a href="#${role}"><span class="fr">${escape(names[0])}</span><span class="en" lang="en">${escape(names[1])}</span></a>`,
  )
  .join('')}</nav>
<p><a href="README.md">Contexte et décisions / Context and decisions</a> · <a href="usability.md">Protocole et sessions / Protocol and sessions</a></p>
</header><main>
${Object.entries(roles)
  .map(
    ([
      role,
      names,
    ]) => `<section id="${role}"><h2><span class="fr">${escape(names[0])}</span><span class="en" lang="en">${escape(names[1])}</span></h2>
<p class="downloads"><a href="${role}/README.md">Parcours / Journey</a> · <a href="${role}/wireframes.fr.excalidraw" download>Excalidraw FR</a> · <a href="${role}/wireframes.en.excalidraw" download>Excalidraw EN</a></p>
<div class="grid">${screens
      .filter((screen) => screen.role === role)
      .map(
        (screen) =>
          `<figure>${locales.map((locale, index) => `<div class="${locale}" lang="${locale}"><figcaption><a href="${role}/${screen.id.toLowerCase()}.${locale}.svg">${screen.id} — ${escape(screen.title[index])}</a></figcaption><img src="${role}/${screen.id.toLowerCase()}.${locale}.svg" width="${W}" height="${H}" alt="${escape(screen.title[index])}. ${escape(screen.intro[index])}"></div>`).join('')}</figure>`,
      )
      .join('')}</div></section>`,
  )
  .join('\n')}
</main></body></html>\n`
outputs.set('index.html', html)

// HTML is intentionally compared structurally so Prettier may normalize whitespace on disk.
const normalizeHtml = (value) => value.replace(/\s+/g, '').replace(/\/>/g, '>').replace(/;}/g, '}')
let failures = 0
for (const [relative, content] of outputs) {
  const path = join(root, relative)
  if (check) {
    const existing = await readFile(path, 'utf8').catch(() => '')
    const equal = relative.endsWith('.html')
      ? normalizeHtml(existing) === normalizeHtml(content)
      : existing === content
    if (!equal) {
      console.error(`Out of date: ${relative}`)
      failures++
    }
  } else {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}
if (failures) process.exitCode = 1
else
  console.log(
    `${check ? 'Checked' : 'Generated'} ${screens.length} bilingual screens, ${outputs.size} artifacts.`,
  )
