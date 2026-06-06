'use strict';

const https   = require('https');
const { ethers } = require('ethers');

// ── ABI ───────────────────────────────────────────────────────────────────────

const TRADER_ABI = [
  // Trading
  'function buyToken(uint256 ethAmount, address token, uint256 slippageBps) external',
  'function sellToken(address token, uint256 sellBps, uint256 slippageBps) external',
  // Withdrawals
  'function withdraw() external',
  'function withdrawToken(address token) external',
  // Events – version: 4 = V4, 3 = V3, 2 = V2
  'event TokenBought(address indexed token, uint256 ethSpent, uint256 tokensReceived, uint8 version, uint24 feeTier)',
  'event TokenSold(address indexed token, uint256 tokensSold, uint256 ethReceived, uint8 version, uint24 feeTier)',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Obtiene el address del token base de un par a partir de la API pública de
 * DexScreener.  No requiere API key.
 *
 * @param {string} chain       e.g. "base"
 * @param {string} pairAddress Dirección del par (LP contract)
 * @returns {Promise<string>}  Address del token base (checksummed)
 */
function fetchTokenAddress(chain, pairAddress) {
  return new Promise((resolve, reject) => {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${chain}/${pairAddress}`;

    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const tokenAddress = data?.pairs?.[0]?.baseToken?.address;
          if (!tokenAddress) {
            return reject(new Error(`DexScreener no devolvió baseToken.address para ${pairAddress}`));
          }
          resolve(ethers.getAddress(tokenAddress)); // checksum
        } catch (err) {
          reject(new Error(`Error parseando respuesta DexScreener: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Extrae la dirección del par (último segmento de la ruta) del href de
 * DexScreener.  Ejemplos de href:
 *   "/base/0xAbc..."
 *   "/base/0xAbc.../0xDef..."  → toma el primer segmento de dirección
 *
 * @param {string} href
 * @returns {string}
 */
function pairAddressFromHref(href) {
  // Elimina query-string y fragment, parte por "/", filtra segmentos vacíos
  const segments = href.split('?')[0].split('#')[0].split('/').filter(Boolean);
  // El par está siempre en el segundo segmento: ["base", "0x..."]
  const candidate = segments[1] ?? '';
  if (!candidate.startsWith('0x')) {
    throw new Error(`No se pudo extraer pairAddress de href: ${href}`);
  }
  return candidate;
}

// ── Función principal de compra ───────────────────────────────────────────────

/**
 * Ejecuta una compra de token a través del contrato UniswapTrader desplegado.
 *
 * @param {Object} opts
 * @param {string} opts.chain          Cadena del par, e.g. "base"
 * @param {string} opts.pairHref       href scrapeado de DexScreener, e.g. "/base/0x..."
 * @param {number} opts.ethPerTrade    ETH a gastar (en unidades ETH, no wei), e.g. 0.01
 * @param {number} opts.slippageBps    Slippage máximo en basis points, e.g. 300
 *
 * @returns {Promise<{ tokenAddress: string, txHash: string, ethSpent: string }>}
 */
async function executeBuy({ chain, pairHref, tokenAddress: directTokenAddress, ethPerTrade, slippageBps }) {
  // 1. Resolver dirección del token (directa o via DexScreener)
  const tokenAddress = directTokenAddress
    ? directTokenAddress
    : await fetchTokenAddress(chain, pairAddressFromHref(pairHref));

  // 2. Conectar proveedor, wallet y contrato
  const { provider, contract } = buildProvider();

  // 3. Verificar balance ETH del contrato
  const contractBalance = await provider.getBalance(process.env.CONTRACT_ADDRESS);
  const ethAmountWei    = ethers.parseEther(ethPerTrade.toString());

  if (contractBalance < ethAmountWei) {
    throw new Error(
      `El contrato solo tiene ${ethers.formatEther(contractBalance)} ETH, ` +
      `se necesitan ${ethPerTrade} ETH para esta compra.`
    );
  }

  // 4. Enviar transacción
  const tx      = await contract.buyToken(ethAmountWei, tokenAddress, BigInt(slippageBps));
  const receipt = await tx.wait();

  return {
    tokenAddress,
    txHash:   receipt.hash,
    ethSpent: ethers.formatEther(ethAmountWei),
  };
}

// ── Helpers compartidos ───────────────────────────────────────────────────────

function buildProvider() {
  const { INFURA_API_KEY, PRIVATE_KEY, CONTRACT_ADDRESS } = process.env;
  if (!INFURA_API_KEY)    throw new Error('Falta INFURA_API_KEY en .env');
  if (!PRIVATE_KEY)       throw new Error('Falta PRIVATE_KEY en .env');
  if (!CONTRACT_ADDRESS)  throw new Error('Falta CONTRACT_ADDRESS en .env');

  const provider = new ethers.JsonRpcProvider(
    `https://base-mainnet.infura.io/v3/${INFURA_API_KEY}`,
  );
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(
    ethers.getAddress(CONTRACT_ADDRESS),
    TRADER_ABI,
    wallet,
  );
  return { provider, wallet, contract };
}

// ── Función de venta ──────────────────────────────────────────────────────────

/**
 * Ejecuta una venta de tokens a través del contrato UniswapTrader.
 * El ETH resultante queda en el contrato; usa executeWithdraw() para sacarlo.
 *
 * @param {Object} opts
 * @param {string} opts.tokenAddress  Dirección del token a vender
 * @param {number} opts.sellBps       Porcentaje del balance a vender en basis points (10000 = 100 %)
 * @param {number} opts.slippageBps   Slippage máximo en basis points
 *
 * @returns {Promise<{ tokenAddress: string, txHash: string }>}
 */
async function executeSell({ tokenAddress, sellBps, slippageBps }) {
  const { contract } = buildProvider();

  const tx      = await contract.sellToken(
    ethers.getAddress(tokenAddress),
    BigInt(sellBps),
    BigInt(slippageBps),
  );
  const receipt = await tx.wait();

  return { tokenAddress, txHash: receipt.hash };
}

// ── Funciones de retirada ─────────────────────────────────────────────────────

/**
 * Retira todo el ETH acumulado en el contrato al owner.
 *
 * @returns {Promise<{ txHash: string }>}
 */
async function executeWithdraw() {
  const { contract } = buildProvider();
  const tx      = await contract.withdraw();
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/**
 * Retira todos los tokens de un tipo acumulados en el contrato al owner.
 *
 * @param {Object} opts
 * @param {string} opts.tokenAddress  Dirección del token a retirar
 *
 * @returns {Promise<{ tokenAddress: string, txHash: string }>}
 */
async function executeWithdrawToken({ tokenAddress }) {
  const { contract } = buildProvider();
  const tx      = await contract.withdrawToken(ethers.getAddress(tokenAddress));
  const receipt = await tx.wait();
  return { tokenAddress, txHash: receipt.hash };
}

module.exports = { executeBuy, executeSell, executeWithdraw, executeWithdrawToken, buildProvider, TRADER_ABI };
