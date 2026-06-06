'use strict';

const https = require('https');

/**
 * Obtiene el market cap actual de un token vía DexScreener (sin API key).
 * Devuelve el par con mayor liquidez en Base.
 *
 * @param {string} tokenAddress  Dirección del token (checksummed o lowercase)
 * @returns {Promise<{ marketCap: number|null, symbol: string }>}
 */
function fetchMarketCap(tokenAddress) {
  return new Promise((resolve, reject) => {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

    https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const data  = JSON.parse(raw);
          const pairs = data?.pairs ?? [];

          if (pairs.length === 0) return resolve({ marketCap: null, symbol: '?' });

          // Prioridad: pares de Base ordenados por liquidez desc
          const basePairs = pairs
            .filter(p => p.chainId === 'base')
            .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

          const best   = (basePairs.length > 0 ? basePairs : pairs)[0];
          const mcap   = best?.marketCap ?? best?.fdv ?? null;
          const symbol = best?.baseToken?.symbol ?? '?';

          resolve({ marketCap: mcap, symbol });
        } catch (err) {
          reject(new Error(`Error parseando DexScreener: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

module.exports = { fetchMarketCap };
