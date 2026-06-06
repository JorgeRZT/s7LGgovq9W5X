#!/usr/bin/env node
'use strict';

const { scrape } = require('./src/scraper');

// ─── Uso como módulo ────────────────────────────────────────────────────────
// const { scrape } = require('./scrape');
// const result = await scrape('https://example.com', { ... });
// ───────────────────────────────────────────────────────────────────────────

module.exports = { scrape };

// ─── Uso directo: node scrape.js <url> [opciones JSON] ─────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error([
      'Uso: node scrape.js <url> [opciones]',
      '',
      'Opciones (como flags individuales):',
      '  --cookies   \'[{"name":"x","value":"y"}]\'',
      '  --js        \'document.title\'',
      '  --header    \'Authorization=Bearer TOKEN\'  (repetible)',
      '  --timeout   30000',
      '  --wait      networkidle | load | domcontentloaded | commit',
      '  --selector  \'.mi-clase\'',
      '  --screenshot captura.png',
      '  --ua        \'Mozilla/5.0 ...\'',
      '  --html      (imprime el HTML completo)',
      '  --json      (imprime el resultado completo en JSON)',
      '',
      'Ejemplos:',
      '  node scrape.js https://example.com',
      '  node scrape.js https://example.com --js "document.title"',
      '  node scrape.js https://example.com --cookies \'[{"name":"sid","value":"abc"}]\'',
      '  node scrape.js https://example.com --json',
      '  node scrape.js https://example.com --screenshot foto.png --html',
    ].join('\n'));
    process.exit(1);
  }

  // Parseo minimalista de flags
  const url = args[0];
  const flags = args.slice(1);

  function flag(name) {
    const idx = flags.indexOf(`--${name}`);
    if (idx === -1) return null;
    return flags[idx + 1] ?? true;
  }

  function flagBool(name) {
    return flags.includes(`--${name}`);
  }

  function flagAll(name) {
    const result = [];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === `--${name}`) result.push(flags[i + 1]);
    }
    return result;
  }

  const cookiesRaw  = flag('cookies');
  const jsSnippet   = flag('js');
  const timeoutMs   = flag('timeout');
  const waitUntil   = flag('wait');
  const selector    = flag('selector');
  const screenshotF = flag('screenshot');
  const userAgent   = flag('ua');
  const printHtml   = flagBool('html');
  const printJson   = flagBool('json');
  const headers     = {};

  for (const h of flagAll('header')) {
    const idx = h.indexOf('=');
    if (idx !== -1) headers[h.slice(0, idx)] = h.slice(idx + 1);
  }

  const options = {
    cookies:         cookiesRaw ? JSON.parse(cookiesRaw) : [],
    jsToExecute:     jsSnippet  ?? null,
    headers,
    timeout:         timeoutMs  ? Number(timeoutMs) : 60_000,
    waitUntil:       waitUntil  ?? 'domcontentloaded',
    waitForSelector: selector   ?? null,
    screenshot:      !!screenshotF,
    userAgent:       userAgent  ?? null,
  };

  scrape(url, options).then((result) => {
    const fs = require('fs');
    const path = require('path');

    if (screenshotF && result.screenshot) {
      fs.writeFileSync(path.resolve(screenshotF), Buffer.from(result.screenshot, 'base64'));
      console.error(`Screenshot guardado en: ${path.resolve(screenshotF)}`);
    }

    if (printJson) {
      const out = { ...result };
      if (out.screenshot) out.screenshot = '<base64 omitido>';
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (printHtml) {
      console.log(result.html);
      return;
    }

    console.log(`Título  : ${result.title}`);
    console.log(`URL     : ${result.url}`);
    console.log(`Cookies : ${result.cookies.length}`);
    if (jsSnippet) console.log(`JS result: ${JSON.stringify(result.jsResult)}`);
    console.log('\n── Texto visible ──────────────────────────────\n');
    console.log(result.text);
  }).catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
