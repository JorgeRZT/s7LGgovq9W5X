'use strict';

const https = require('https');

const BASE_URL = 'https://api.dexscreener.com';

// ── Helper ────────────────────────────────────────────────────────────────────

function get(path) {
  return new Promise((resolve, reject) => {
    https.get(`${BASE_URL}${path}`, { headers: { Accept: 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error(`DexScreener: error parseando respuesta: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

// ── Funciones exportadas ──────────────────────────────────────────────────────

/**
 * Devuelve el JSON completo de DexScreener para un par dado su pool address.
 *
 * @param {string} poolAddress  Dirección de la pool (e.g. "0x92d90f...")
 * @param {string} [chain="base"]
 * @returns {Promise<Object>}   Respuesta cruda de DexScreener
 */
function fetchPairByPool(poolAddress, chain = 'base') {
  return get(`/latest/dex/pairs/${chain}/${poolAddress}`);
}

/**
 * Devuelve el JSON completo de DexScreener para un token dado su address.
 * Puede devolver múltiples pares en distintas chains/DEXes.
 *
 * @param {string} tokenAddress
 * @returns {Promise<Object>}
 */
function fetchPairsByToken(tokenAddress) {
  return get(`/latest/dex/tokens/${tokenAddress}`);
}

/**
 * Devuelve los últimos token profiles de DexScreener (todas las chains).
 * @returns {Promise<Array>}
 */
function fetchTokenProfiles() {
  return get('/token-profiles/latest/v1');
}

module.exports = { fetchPairByPool, fetchPairsByToken, fetchTokenProfiles };
