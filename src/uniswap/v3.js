'use strict';

const { ethers }        = require('ethers');
const { ChainId, WETH9 } = require('@uniswap/sdk-core');

// ── Red ───────────────────────────────────────────────────────────────────────

const CHAIN_ID  = ChainId.BASE;            // 8453
const WETH_ADDR = WETH9[CHAIN_ID].address; // 0x4200000000000000000000000000000000000006

// ── Contratos V3 en Base mainnet ──────────────────────────────────────────────
// Fuente: https://developers.uniswap.org/contracts/v3/deployments

const V3_QUOTER_ADDR  = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'; // QuoterV2
const V3_FACTORY_ADDR = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

// ── ABIs ──────────────────────────────────────────────────────────────────────

// IQuoterV2.quoteExactInputSingle
// Ref: https://docs.uniswap.org/contracts/v3/reference/periphery/interfaces/IQuoterV2
const V3_QUOTER_ABI = [
  `function quoteExactInputSingle(
    tuple(
      address tokenIn,
      address tokenOut,
      uint256 amountIn,
      uint24  fee,
      uint160 sqrtPriceLimitX96
    ) params
  ) external returns (
    uint256 amountOut,
    uint160 sqrtPriceX96After,
    uint32  initializedTicksCrossed,
    uint256 gasEstimate
  )`,
];

// IUniswapV3Factory.getPool para verificar que la pool existe
const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const TRADER_ABI = [
  'function buyToken(uint256 ethAmount, address token, uint256 slippageBps) external',
  'function sellToken(address token, uint256 sellBps, uint256 slippageBps) external',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

// ── Configuraciones de pool V3 estándar ──────────────────────────────────────
// V3 soporta fee tiers 100, 500, 3000 y 10000 (en Base también el 100)

const FEE_TIERS = [100, 500, 3000, 10000]; // ordenados de más barato a más caro

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
 * Descubre la mejor pool V3 para el par WETH/token usando el QuoterV2 on-chain.
 *
 * Prueba los fee tiers estándar (100, 500, 3000, 10000) y devuelve el que
 * ofrece el mayor amountOut para el importe dado.
 *
 * @param {string}          tokenAddress  Dirección del token
 * @param {bigint}          amountIn      Cantidad exacta de entrada (en wei)
 * @param {boolean}         isBuy         true = WETH→token | false = token→WETH
 * @param {ethers.Provider} provider
 *
 * @returns {Promise<{
 *   fee:         number,
 *   poolAddress: string,
 *   amountOut:   bigint,
 *   tokenIn:     string,
 *   tokenOut:    string,
 * }>}
 */
async function findBestPool(tokenAddress, amountIn, isBuy, provider) {
  const quoter  = new ethers.Contract(V3_QUOTER_ADDR,  V3_QUOTER_ABI,  provider);
  const factory = new ethers.Contract(V3_FACTORY_ADDR, V3_FACTORY_ABI, provider);
  const token   = ethers.getAddress(tokenAddress);

  const tokenIn  = isBuy ? WETH_ADDR : token;
  const tokenOut = isBuy ? token     : WETH_ADDR;

  const results = [];

  for (const fee of FEE_TIERS) {
    // Verificar existencia de la pool antes de cotizar (evita reverts innecesarios)
    const poolAddress = await factory.getPool(WETH_ADDR, token, fee);
    if (poolAddress === ethers.ZeroAddress) continue;

    try {
      const [amountOut] = await quoter.quoteExactInputSingle({
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
      });

      if (amountOut > 0n) {
        results.push({ fee, poolAddress, amountOut, tokenIn, tokenOut });
      }
    } catch {
      // Pool existe pero sin liquidez suficiente para el importe → ignorar
    }
  }

  if (results.length === 0) {
    throw new Error(
      `No se encontró ninguna pool V3 activa para el token ${tokenAddress}. ` +
      `Comprueba que cotiza en Uniswap V3 en Base.`,
    );
  }

  // Mejor precio = mayor amountOut
  results.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  return results[0];
}

// ── buyV3 ─────────────────────────────────────────────────────────────────────

/**
 * Compra tokens via el contrato propio (CONTRACT_ADDRESS).
 *
 * Antes de ejecutar:
 *  · Verifica el balance ETH del contrato.
 *  · Descubre automáticamente la mejor pool V3 disponible (fee tier).
 *  · Obtiene un quote real con el QuoterV2 on-chain.
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
 *   poolFee:      number,
 *   poolAddress:  string,
 * }>}
 */
async function buyV3({ tokenAddress, amountInEth, slippageBps }) {
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

  // 2. Descubrir mejor pool V3 y obtener quote (WETH → token)
  const best         = await findBestPool(tokenAddress, amountIn, true, provider);
  const amountOutMin = best.amountOut * BigInt(10_000 - slippageBps) / 10_000n;

  console.log(`[v3:buy] Pool: fee=${best.fee} addr=${best.poolAddress}`);
  console.log(`[v3:buy] Quote: ${ethers.formatEther(amountIn)} ETH → ~${best.amountOut.toString()} tokens`);
  console.log(`[v3:buy] Min aceptable (${slippageBps} bps): ${amountOutMin.toString()} tokens`);

  // 3. Ejecutar compra via contrato
  const tx      = await contract.buyToken(amountIn, ethers.getAddress(tokenAddress), BigInt(slippageBps));
  const receipt = await tx.wait();

  return {
    txHash:       receipt.hash,
    tokenAddress: ethers.getAddress(tokenAddress),
    amountIn,
    expectedOut:  best.amountOut,
    amountOutMin,
    poolFee:      best.fee,
    poolAddress:  best.poolAddress,
  };
}

// ── sellV3 ────────────────────────────────────────────────────────────────────

/**
 * Vende tokens via el contrato propio (CONTRACT_ADDRESS).
 *
 * Antes de ejecutar:
 *  · Lee el balance del token en el contrato.
 *  · Descubre automáticamente la mejor pool V3 disponible.
 *  · Obtiene un quote real para el importe a vender.
 *
 * @param {Object} opts
 * @param {string} opts.tokenAddress  Dirección del token a vender
 * @param {number} opts.sellBps       Porcentaje del balance a vender en bp (10000 = 100 %)
 * @param {number} opts.slippageBps   Slippage máximo en basis points (e.g. 200 = 2 %)
 *
 * @returns {Promise<{
 *   txHash:       string,
 *   tokenAddress: string,
 *   poolFee:      number,
 *   poolAddress:  string,
 *   expectedEth:  bigint,
 * }>}
 */
async function sellV3({ tokenAddress, sellBps, slippageBps }) {
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

  // 2. Descubrir mejor pool V3 y quote (token → WETH)
  const best = await findBestPool(tokenAddress, amountToSell, false, provider);

  console.log(`[v3:sell] Pool: fee=${best.fee} addr=${best.poolAddress}`);
  console.log(`[v3:sell] Quote: ~${amountToSell.toString()} tokens → ~${ethers.formatEther(best.amountOut)} ETH`);
  console.log(`[v3:sell] Vendiendo ${sellBps / 100} % del balance (${balance.toString()} tokens total)`);

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
    poolFee:      best.fee,
    poolAddress:  best.poolAddress,
    expectedEth:  best.amountOut,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { buyV3, sellV3, findBestPool };
