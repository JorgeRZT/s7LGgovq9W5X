const { chromium } = require('playwright');

const CDP_ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://localhost:9222';

/**
 * Conecta al Chrome real ya abierto vía CDP y lee el DOM de la pestaña que
 * coincide con `urlMatch`. No navega, no refresca — solo ejecuta el JS dado.
 *
 * @param {string} urlMatch  - Substring que debe aparecer en la URL de la pestaña
 * @param {string} jsToExecute - Snippet JS que devuelve los datos del DOM
 * @returns {Promise<{ url: string, jsResult: * }>}
 */
async function scrapeFromBrowser(urlMatch, jsToExecute) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  } catch (err) {
    throw new Error(
      `No se pudo conectar al browser en ${CDP_ENDPOINT}.\n` +
      `Asegúrate de que Chrome está abierto con:\n` +
      `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n` +
      `Error original: ${err.message}`
    );
  }

  // Busca la pestaña que tiene la URL de DexScreener
  let page = null;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes(urlMatch)) {
        page = p;
        break;
      }
    }
    if (page) break;
  }

  if (!page) {
    await browser.close();
    throw new Error(
      `No se encontró ninguna pestaña con "${urlMatch}" en la URL.\n` +
      `Abre DexScreener en Chrome con esa URL y vuelve a ejecutar.`
    );
  }

  console.log(`[scraper] Pestaña encontrada: ${page.url()}`);

  const jsResult = await page.evaluate(jsToExecute);

  // No cerramos el browser — es del usuario, no nuestro
  return { url: page.url(), jsResult };
}

module.exports = { scrapeFromBrowser };
