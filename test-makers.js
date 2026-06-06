'use strict';

require('dotenv').config();

const { countUniqueWallets } = require('./src/pooldiscovery');

// Token de ejemplo: DICKBUTT (del example-dexscreener-api/result.json)
const TOKEN_ADDRESS = '0x06Be6776D3a94E758c2B4b047BE9e33185637ba3';
const BLOCKS_BACK   = 100; // ~3 minutos en Base (bloques de ~2s)

async function main() {
  console.log(`Token:       ${TOKEN_ADDRESS}`);
  console.log(`Bloques:     últimos ${BLOCKS_BACK}`);
  console.log('');

  const count = await countUniqueWallets({
    infuraApiKey: process.env.INFURA_API_KEY,
    tokenAddress: TOKEN_ADDRESS,
    blocksBack:   BLOCKS_BACK,
  });

  console.log(`\nWallets únicas: ${count}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
