'use strict';

const { ethers }        = require('ethers');
const { ChainId, WETH9 } = require('@uniswap/sdk-core');

// ── Red ───────────────────────────────────────────────────────────────────────

const CHAIN_ID   = ChainId.BASE;                    // 8453
const NATIVE_ETH = ethers.ZeroAddress;              // address(0) — ETH nativo en V4
const WETH_ADDR  = WETH9[CHAIN_ID].address;         // 0x4200000000000000000000000000000000000006

// ── Contratos V4 en Base mainnet ──────────────────────────────────────────────
// Fuente: https://developers.uniswap.org/contracts/v4/deployments

const V4_QUOTER_ADDR = '0x0d5e0f971ed27fbff6c2837bf31316121532048d';
const NO_HOOKS       = ethers.ZeroAddress;

// ── ABIs ──────────────────────────────────────────────────────────────────────

const V4_QUOTER_ABI = [
  // IV4Quoter.quoteExactInputSingle
  // Ref: https://docs.uniswap.org/contracts/v4/reference/periphery/interfaces/IV4Quoter
  `function quoteExactInputSingle(
    tuple(
      tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey,
      bool    zeroForOne,
      uint128 exactAmount,
      bytes   hookData
    ) params
  ) external returns (uint256 amountOut, uint256 gasEstimate)`,
];

const TRADER_ABI = [
  'function buyToken(uint256 ethAmount, address token, uint256 slippageBps, address pool) external',
  'function sellToken(address token, uint256 sellBps, uint256 slippageBps) external',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// ── Configuraciones de pool V4 estándar ──────────────────────────────────────
// Cada fee tier tiene un tickSpacing fijo definido por el protocolo

const POOL_CONFIGS = [
  { fee: 100,   tickSpacing: 1   },  // 0.01 %
  { fee: 500,   tickSpacing: 10  },  // 0.05 %
  { fee: 3000,  tickSpacing: 60  },  // 0.30 %
  { fee: 10000, tickSpacing: 200 },  // 1.00 %
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

/**
 * V4 exige que currency0 < currency1 (orden lexicográfico de direcciones).
 * El ETH nativo (0x000…000) siempre resulta ser currency0 frente a cualquier token.
 */
function sortCurrencies(a, b) {
  return a.toLowerCase() < b.toLowerCase()
    ? { currency0: a, currency1: b }
    : { currency0: b, currency1: a };
}

// ── Pool discovery y quote ────────────────────────────────────────────────────

/**
 * Descubre la mejor pool V4 para el par ETH/token usando el Quoter on-chain.
 *
 * Estrategia:
 *  1. Prueba ETH nativo (address(0)) con los 4 fee tiers estándar.
 *  2. Si no hay pools con liquidez, reintenta con WETH como fallback.
 *  3. Devuelve la configuración con mayor amountOut (mejor precio).
 *
 * @param {string}          tokenAddress  Dirección del token (checksummed o no)
 * @param {bigint}          exactAmount   Cantidad exacta de entrada (en wei)
 * @param {boolean}         isBuy         true = ETH→token | false = token→ETH
 * @param {ethers.Provider} provider
 *
 * @returns {Promise<{
 *   fee:        number,
 *   tickSpacing: number,
 *   amountOut:  bigint,
 *   currency0:  string,
 *   currency1:  string,
 *   zeroForOne: boolean,
 *   ethVariant: string,   // NATIVE_ETH o WETH_ADDR
 * }>}
 */
async function findBestPool(tokenAddress, exactAmount, isBuy, provider) {
  const quoter = new ethers.Contract(V4_QUOTER_ADDR, V4_QUOTER_ABI, provider);
  const token  = ethers.getAddress(tokenAddress);
  const results = [];

  // Intentar primero ETH nativo; si no hay pools, caer en WETH
  for (const ethVariant of [NATIVE_ETH, WETH_ADDR]) {
    const { currency0, currency1 } = sortCurrencies(ethVariant, token);

    // zeroForOne = estamos vendiendo currency0
    // · compra (ETH→token): vendemos ETH, que siempre es currency0 → zeroForOne = (ETH es currency0)
    // · venta (token→ETH): vendemos token, que es currency1 si ETH es currency0 → zeroForOne = !(ETH es currency0)
    const ethIsCurrency0 = currency0.toLowerCase() === ethVariant.toLowerCase();
    const zeroForOne     = isBuy ? ethIsCurrency0 : !ethIsCurrency0;

    for (const { fee, tickSpacing } of POOL_CONFIGS) {
      try {
        const [amountOut] = await quoter.quoteExactInputSingle({
          poolKey: { currency0, currency1, fee, tickSpacing, hooks: NO_HOOKS },
          zeroForOne,
          exactAmount,
          hookData: '0x',
        });

        if (amountOut > 0n) {
          results.push({ fee, tickSpacing, amountOut, currency0, currency1, zeroForOne, ethVariant });
        }
      } catch {
        // Pool sin liquidez o inexistente para este fee tier → ignorar
      }
    }

    // Si encontramos pools con ETH nativo no necesitamos probar WETH
    if (results.length > 0) break;
  }

  if (results.length === 0) {
    throw new Error(
      `No se encontró ninguna pool V4 activa para el token ${tokenAddress}. ` +
      `Comprueba que el token cotiza en Uniswap V4 en Base.`,
    );
  }

  // Mejor precio = mayor amountOut
  results.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  return results[0];
}

// ── buyV4 ─────────────────────────────────────────────────────────────────────

/**
 * Compra tokens via el contrato propio (CONTRACT_ADDRESS).
 *
 * Antes de ejecutar:
 *  · Verifica el balance ETH del contrato.
 *  · Obtiene un quote real del Quoter V4 para loggear el precio esperado.
 *  · Descubre automáticamente la mejor pool disponible (fee tier + ethVariant).
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
 * }>}
 */
async function buyV4({ tokenAddress, amountInEth, slippageBps, poolAddress }) {
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

  // 2. Descubrir mejor pool V4 y obtener quote (ETH → token)
  const best         = await findBestPool(tokenAddress, amountIn, true, provider);
  const amountOutMin = best.amountOut * BigInt(10_000 - slippageBps) / 10_000n;
  const ethLabel     = best.ethVariant === NATIVE_ETH ? 'ETH nativo' : 'WETH';

  console.log(
    `[v4:buy] Pool: fee=${best.fee} tickSpacing=${best.tickSpacing} via ${ethLabel}`,
  );
  console.log(
    `[v4:buy] Quote: ${ethers.formatEther(amountIn)} ETH → ~${best.amountOut.toString()} tokens`,
  );
  console.log(
    `[v4:buy] Min aceptable (${slippageBps} bps): ${amountOutMin.toString()} tokens`,
  );

  // 3. Ejecutar compra via contrato
  if (!poolAddress) throw new Error('buyV4: poolAddress es requerido (pair.pairAddress de DexScreener)');
  const tx      = await contract.buyToken(amountIn, ethers.getAddress(tokenAddress), BigInt(slippageBps), ethers.getAddress(poolAddress));
  const receipt = await tx.wait();

  return {
    txHash:       receipt.hash,
    tokenAddress: ethers.getAddress(tokenAddress),
    amountIn,
    expectedOut:  best.amountOut,
    amountOutMin,
    poolFee:      best.fee,
  };
}

// ── sellV4 ────────────────────────────────────────────────────────────────────

/**
 * Vende tokens via el contrato propio (CONTRACT_ADDRESS).
 *
 * Antes de ejecutar:
 *  · Lee el balance del token en el contrato.
 *  · Obtiene un quote real del Quoter V4 para el importe a vender.
 *  · Descubre automáticamente la mejor pool disponible.
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
 *   expectedEth:  bigint,
 * }>}
 */
async function sellV4({ tokenAddress, sellBps, slippageBps }) {
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

  // 2. Descubrir mejor pool V4 y quote (token → ETH)
  const best     = await findBestPool(tokenAddress, amountToSell, false, provider);
  const ethLabel = best.ethVariant === NATIVE_ETH ? 'ETH nativo' : 'WETH';

  console.log(
    `[v4:sell] Pool: fee=${best.fee} tickSpacing=${best.tickSpacing} via ${ethLabel}`,
  );
  console.log(
    `[v4:sell] Quote: ~${amountToSell.toString()} tokens → ~${ethers.formatEther(best.amountOut)} ETH`,
  );
  console.log(
    `[v4:sell] Vendiendo ${sellBps / 100} % del balance (${ethers.formatEther(balance)} tokens total)`,
  );

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
    expectedEth:  best.amountOut,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { buyV4, sellV4, findBestPool };
