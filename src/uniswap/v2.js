'use strict';

const { ethers }        = require('ethers');
const { ChainId, WETH9 } = require('@uniswap/sdk-core');

// ── Red ───────────────────────────────────────────────────────────────────────

const CHAIN_ID  = ChainId.BASE;            // 8453
const WETH_ADDR = WETH9[CHAIN_ID].address; // 0x4200000000000000000000000000000000000006

// ── Contratos V2 en Base mainnet ──────────────────────────────────────────────
// Fuente: https://developers.uniswap.org/contracts/v2/deployments

const V2_FACTORY_ADDR = '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6';
const V2_ROUTER_ADDR  = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';

// ── ABIs ──────────────────────────────────────────────────────────────────────

const V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
];

const V2_ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
];

const TRADER_ABI = [
  'function buyToken(uint256 ethAmount, address token, uint256 slippageBps) external',
  'function sellToken(address token, uint256 sellBps, uint256 slippageBps) external',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildProvider() {
  const { INFURA_API_KEY, PRIVATE_KEY, CONTRACT_ADDRESS } = process.env;
  if (!INFURA_API_KEY)   throw new Error('Falta INFURA_API_KEY en .env');
  if (!PRIVATE_KEY)      throw new Error('Falta PRIVATE_KEY en .env');
  if (!CONTRACT_ADDRESS) throw new Error('Falta CONTRACT_ADDRESS en .env');

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

// ── Pool discovery y quote ────────────────────────────────────────────────────

/**
 * Verifica si existe la pool V2 WETH/token y obtiene un quote.
 *
 * V2 no tiene fee tiers: hay como máximo un par por combinación de tokens.
 *
 * @param {string}          tokenAddress  Dirección del token
 * @param {bigint}          amountIn      Cantidad exacta de entrada (en wei)
 * @param {boolean}         isBuy         true = WETH→token | false = token→WETH
 * @param {ethers.Provider} provider
 *
 * @returns {Promise<{
 *   pairAddress: string,
 *   amountOut:   bigint,
 *   path:        string[],
 * }>}
 */
async function findPoolAndQuote(tokenAddress, amountIn, isBuy, provider) {
  const factory = new ethers.Contract(V2_FACTORY_ADDR, V2_FACTORY_ABI, provider);
  const router  = new ethers.Contract(V2_ROUTER_ADDR,  V2_ROUTER_ABI,  provider);
  const token   = ethers.getAddress(tokenAddress);

  // V2: un único par por combinación de tokens
  const pairAddress = await factory.getPair(WETH_ADDR, token);

  if (pairAddress === ethers.ZeroAddress) {
    throw new Error(
      `No existe pool V2 para el token ${tokenAddress}. ` +
      `Comprueba que cotiza en Uniswap V2 en Base.`,
    );
  }

  // Ruta según dirección del swap
  const path = isBuy
    ? [WETH_ADDR, token]   // WETH → token
    : [token, WETH_ADDR];  // token → WETH

  const amounts    = await router.getAmountsOut(amountIn, path);
  const amountOut  = amounts[amounts.length - 1];

  return { pairAddress, amountOut, path };
}

// ── buyV2 ─────────────────────────────────────────────────────────────────────

/**
 * Compra tokens via el contrato propio (CONTRACT_ADDRESS).
 *
 * Antes de ejecutar:
 *  · Verifica que existe la pool V2 WETH/token.
 *  · Verifica el balance ETH del contrato.
 *  · Obtiene un quote real con getAmountsOut del Router.
 *
 * @param {Object} opts
 * @param {string} opts.tokenAddress  Dirección del token a comprar
 * @param {number} opts.amountInEth   ETH a gastar (en ETH, no wei), e.g. 0.05
 * @param {number} opts.slippageBps   Slippage máximo en basis points (e.g. 200 = 2 %)
 *
 * @returns {Promise<{
 *   txHash:       string,
 *   tokenAddress: string,
 *   amountIn:     bigint,
 *   expectedOut:  bigint,
 *   amountOutMin: bigint,
 *   pairAddress:  string,
 * }>}
 */
async function buyV2({ tokenAddress, amountInEth, slippageBps }) {
  const { provider, contract } = buildProvider();

  const amountIn = ethers.parseEther(amountInEth.toString());

  // 1. Verificar fondos del contrato
  const contractBalance = await provider.getBalance(process.env.CONTRACT_ADDRESS);
  if (contractBalance < amountIn) {
    throw new Error(
      `Balance insuficiente: el contrato tiene ${ethers.formatEther(contractBalance)} ETH ` +
      `y se necesitan ${amountInEth} ETH.`,
    );
  }

  // 2. Verificar pool y obtener quote (WETH → token)
  const { pairAddress, amountOut } = await findPoolAndQuote(tokenAddress, amountIn, true, provider);
  const amountOutMin = amountOut * BigInt(10_000 - slippageBps) / 10_000n;

  console.log(`[v2:buy] Par: ${pairAddress}`);
  console.log(`[v2:buy] Quote: ${ethers.formatEther(amountIn)} ETH → ~${amountOut.toString()} tokens`);
  console.log(`[v2:buy] Min aceptable (${slippageBps} bps): ${amountOutMin.toString()} tokens`);

  // 3. Ejecutar compra via contrato
  const tx      = await contract.buyToken(amountIn, ethers.getAddress(tokenAddress), BigInt(slippageBps));
  const receipt = await tx.wait();

  return {
    txHash:       receipt.hash,
    tokenAddress: ethers.getAddress(tokenAddress),
    amountIn,
    expectedOut:  amountOut,
    amountOutMin,
    pairAddress,
  };
}

// ── sellV2 ────────────────────────────────────────────────────────────────────

/**
 * Vende tokens via el contrato propio (CONTRACT_ADDRESS).
 *
 * Antes de ejecutar:
 *  · Lee el balance del token en el contrato.
 *  · Verifica que existe la pool V2 y obtiene un quote (token → WETH).
 *
 * @param {Object} opts
 * @param {string} opts.tokenAddress  Dirección del token a vender
 * @param {number} opts.sellBps       Porcentaje del balance a vender en bp (10000 = 100 %)
 * @param {number} opts.slippageBps   Slippage máximo en basis points (e.g. 200 = 2 %)
 *
 * @returns {Promise<{
 *   txHash:       string,
 *   tokenAddress: string,
 *   pairAddress:  string,
 *   expectedEth:  bigint,
 * }>}
 */
async function sellV2({ tokenAddress, sellBps, slippageBps }) {
  const { provider, contract } = buildProvider();

  // 1. Leer balance del token en el contrato
  const tokenContract = new ethers.Contract(ethers.getAddress(tokenAddress), ERC20_ABI, provider);
  const balance       = await tokenContract.balanceOf(process.env.CONTRACT_ADDRESS);

  if (balance === 0n) {
    throw new Error(
      `El contrato no tiene balance del token ${tokenAddress}. ` +
      `¿Ya se vendió o la dirección es incorrecta?`,
    );
  }

  // Calcular la cantidad que venderá el contrato (replica la lógica de sellToken)
  const amountToSell = balance * BigInt(sellBps) / 10_000n;

  // 2. Verificar pool y obtener quote (token → WETH)
  const { pairAddress, amountOut } = await findPoolAndQuote(tokenAddress, amountToSell, false, provider);

  console.log(`[v2:sell] Par: ${pairAddress}`);
  console.log(`[v2:sell] Quote: ~${amountToSell.toString()} tokens → ~${ethers.formatEther(amountOut)} ETH`);
  console.log(`[v2:sell] Vendiendo ${sellBps / 100} % del balance (${balance.toString()} tokens total)`);

  // 3. Ejecutar venta via contrato
  const tx      = await contract.sellToken(
    ethers.getAddress(tokenAddress),
    BigInt(sellBps),
    BigInt(slippageBps),
  );
  const receipt = await tx.wait();

  return {
    txHash:       receipt.hash,
    tokenAddress: ethers.getAddress(tokenAddress),
    pairAddress,
    expectedEth:  amountOut,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { buyV2, sellV2, findPoolAndQuote };
