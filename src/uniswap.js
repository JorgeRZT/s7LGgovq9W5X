'use strict';

const { ethers } = require('ethers');

// ── Constantes de red (Base mainnet) ──────────────────────────────────────────

const WETH       = '0x4200000000000000000000000000000000000006';
const NATIVE_ETH = ethers.ZeroAddress; // address(0)

// Routers
const V2_ROUTER = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'; // UniswapV2Router02
const V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481'; // SwapRouter02
const V4_ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43'; // Universal Router (con soporte V4)

// ── ABIs ──────────────────────────────────────────────────────────────────────

const ABI_V2_PAIR = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const ABI_V2_ROUTER = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory)',
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)',
];

const ABI_V3_POOL = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
];

const ABI_V3_ROUTER = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

const ABI_V4_ROUTER = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) payable',
];

// ── Códigos de acción de Uniswap V4 Periphery (Actions.sol) ──────────────────
// Ref: https://github.com/Uniswap/v4-periphery/blob/main/src/libraries/Actions.sol
const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x04,
  SETTLE_ALL:           0x09,
  TAKE_ALL:             0x0c,
};

// Comandos del Universal Router
const UR_COMMANDS = {
  V4_SWAP: 0x10,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildProvider() {
  const { INFURA_API_KEY, PRIVATE_KEY } = process.env;
  if (!INFURA_API_KEY) throw new Error('Falta INFURA_API_KEY en .env');
  if (!PRIVATE_KEY)    throw new Error('Falta PRIVATE_KEY en .env');

  const provider = new ethers.JsonRpcProvider(
    `https://base-mainnet.infura.io/v3/${INFURA_API_KEY}`,
  );
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  return { provider, wallet };
}

function deadline(seconds = 300) {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

// ── swapV2 ────────────────────────────────────────────────────────────────────

/**
 * Swap ETH → token a través de una pool de Uniswap V2 concreta.
 *
 * El amountOutMin se calcula con getAmountsOut del router aplicando slippageBps.
 *
 * @param {Object} opts
 * @param {string} opts.poolAddress  Dirección del par V2 (e.g. "0x...")
 * @param {number} opts.amountInEth  ETH a gastar en unidades ETH (e.g. 0.01)
 * @param {number} opts.slippageBps  Slippage máximo en basis points (e.g. 200 = 2%)
 * @param {string} [opts.recipient]  Wallet que recibe los tokens (por defecto: signer)
 * @returns {Promise<{ txHash: string, tokenOut: string, amountIn: bigint }>}
 */
async function swapV2({ poolAddress, amountInEth, slippageBps, recipient }) {
  const { provider, wallet } = buildProvider();
  const rec = recipient ? ethers.getAddress(recipient) : wallet.address;

  // 1. Leer los tokens del par para saber cuál es el token de salida
  const pair   = new ethers.Contract(ethers.getAddress(poolAddress), ABI_V2_PAIR, provider);
  const token0 = await pair.token0();
  const token1 = await pair.token1();

  const wethLower = WETH.toLowerCase();
  let tokenOut;
  if (token0.toLowerCase() === wethLower) {
    tokenOut = token1;
  } else if (token1.toLowerCase() === wethLower) {
    tokenOut = token0;
  } else {
    throw new Error(
      `swapV2: ninguno de los tokens del par es WETH.\n` +
      `  token0=${token0}\n  token1=${token1}\n  pool=${poolAddress}`,
    );
  }

  const amountIn = ethers.parseEther(amountInEth.toString());

  // 2. Estimar output con getAmountsOut y aplicar slippage
  const router = new ethers.Contract(V2_ROUTER, ABI_V2_ROUTER, wallet);
  const amounts = await router.getAmountsOut(amountIn, [WETH, tokenOut]);
  const amountOutMin = amounts[1] * BigInt(10_000 - slippageBps) / 10_000n;

  // 3. Ejecutar swap: ETH → WETH → tokenOut a través del par indicado
  const tx = await router.swapExactETHForTokens(
    amountOutMin,
    [WETH, tokenOut],
    rec,
    deadline(),
    { value: amountIn },
  );
  const receipt = await tx.wait();

  return {
    txHash:   receipt.hash,
    tokenOut: ethers.getAddress(tokenOut),
    amountIn,
  };
}

// ── swapV3 ────────────────────────────────────────────────────────────────────

/**
 * Swap ETH → token a través de una pool de Uniswap V3 concreta.
 *
 * La pool determina el fee tier; el SwapRouter02 enruta exactamente a esa pool.
 *
 * NOTA: amountOutMinimum se pone a 0 porque calcular el output esperado de V3
 * requeriría leer slot0 y los decimales de los tokens. Pasa un slippageBps bajo
 * y monitorea el resultado, o implementa la estimación con el Quoter de V3 si
 * necesitas protección exacta contra slippage.
 *
 * @param {Object} opts
 * @param {string} opts.poolAddress  Dirección de la pool V3 (e.g. "0x...")
 * @param {number} opts.amountInEth  ETH a gastar en unidades ETH
 * @param {number} opts.slippageBps  (reservado; ver NOTA arriba)
 * @param {string} [opts.recipient]  Wallet que recibe los tokens (por defecto: signer)
 * @returns {Promise<{ txHash: string, tokenOut: string, amountIn: bigint }>}
 */
async function swapV3({ poolAddress, amountInEth, slippageBps, recipient }) {
  const { provider, wallet } = buildProvider();
  const rec = recipient ? ethers.getAddress(recipient) : wallet.address;

  // 1. Leer fee y tokens de la pool
  const pool = new ethers.Contract(ethers.getAddress(poolAddress), ABI_V3_POOL, provider);
  const [token0, token1, fee] = await Promise.all([pool.token0(), pool.token1(), pool.fee()]);

  const wethLower = WETH.toLowerCase();
  let tokenOut;
  if (token0.toLowerCase() === wethLower) {
    tokenOut = token1;
  } else if (token1.toLowerCase() === wethLower) {
    tokenOut = token0;
  } else {
    throw new Error(
      `swapV3: ninguno de los tokens de la pool es WETH.\n` +
      `  token0=${token0}\n  token1=${token1}\n  pool=${poolAddress}`,
    );
  }

  const amountIn = ethers.parseEther(amountInEth.toString());

  // 2. Ejecutar swap via SwapRouter02
  //    tokenIn = WETH + msg.value = ETH → el router wrappea el ETH automáticamente
  const router = new ethers.Contract(V3_ROUTER, ABI_V3_ROUTER, wallet);
  const tx = await router.exactInputSingle(
    {
      tokenIn:           WETH,
      tokenOut:          ethers.getAddress(tokenOut),
      fee,
      recipient:         rec,
      amountIn,
      amountOutMinimum:  0n, // ver NOTA en JSDoc
      sqrtPriceLimitX96: 0n, // sin límite de precio
    },
    { value: amountIn },
  );
  const receipt = await tx.wait();

  return {
    txHash:   receipt.hash,
    tokenOut: ethers.getAddress(tokenOut),
    amountIn,
  };
}

// ── swapV4 ────────────────────────────────────────────────────────────────────

/**
 * Swap ETH → token a través de una pool de Uniswap V4 concreta.
 *
 * En V4 la pool se identifica por su PoolKey (no por una dirección de contrato).
 * Esta función usa el Universal Router con el comando V4_SWAP y las acciones:
 *   SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL
 *
 * Si currency0 es address(0) (ETH nativo), el ETH se envía como msg.value.
 * Si la pool usa WETH como currency0, aprueba WETH al Universal Router antes.
 *
 * @param {Object} opts
 * @param {Object} opts.poolKey
 * @param {string} opts.poolKey.currency0    address(0) para ETH nativo, o ERC-20
 * @param {string} opts.poolKey.currency1    Dirección del token de salida
 * @param {number} opts.poolKey.fee          Fee tier (e.g. 3000)
 * @param {number} opts.poolKey.tickSpacing  Tick spacing (e.g. 60 para fee 3000)
 * @param {string} opts.poolKey.hooks        Dirección hooks (address(0) si no hay)
 * @param {number} opts.amountInEth          ETH a gastar en unidades ETH
 * @param {number} opts.slippageBps          (reservado; amountOutMinimum = 0 actualmente)
 * @param {string} [opts.recipient]          Wallet que recibe los tokens (por defecto: signer)
 * @returns {Promise<{ txHash: string, amountIn: bigint }>}
 */
async function swapV4({ poolKey, amountInEth, slippageBps, recipient }) {
  const { wallet } = buildProvider();

  const amountIn = ethers.parseEther(amountInEth.toString());

  // Determinar dirección del swap
  const currency0Lower = poolKey.currency0.toLowerCase();
  const isNativeIn     = currency0Lower === ethers.ZeroAddress.toLowerCase();
  const isWethIn       = currency0Lower === WETH.toLowerCase();
  const zeroForOne     = isNativeIn || isWethIn; // vendemos currency0, compramos currency1

  const currencyIn  = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  // ── Codificar las tres acciones V4 ────────────────────────────────────────

  // Acción 1: SWAP_EXACT_IN_SINGLE
  const swapActionParams = abiCoder.encode(
    [
      'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
      'bool',    // zeroForOne
      'uint128', // amountIn
      'uint128', // amountOutMinimum
      'bytes',   // hookData
    ],
    [
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      zeroForOne,
      amountIn,
      0n, // amountOutMinimum — añade estimación con Quoter V4 si necesitas slippage exacto
      '0x',
    ],
  );

  // Acción 2: SETTLE_ALL — paga el input currency (ETH o WETH) desde msg.value / wallet
  const settleParams = abiCoder.encode(
    ['address', 'uint256'],
    [currencyIn, amountIn],
  );

  // Acción 3: TAKE_ALL — recibe el output currency; va al caller (msgSender en V4Router)
  const takeParams = abiCoder.encode(
    ['address', 'uint256'],
    [currencyOut, 0n], // minAmount = 0; el router revierte si no recibe nada
  );

  // Bytes de acciones V4 (secuencia de uint8)
  const actionsBytes = ethers.hexlify(new Uint8Array([
    V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
    V4_ACTIONS.SETTLE_ALL,
    V4_ACTIONS.TAKE_ALL,
  ]));

  // Input para el comando V4_SWAP del Universal Router
  const v4SwapInput = abiCoder.encode(
    ['bytes', 'bytes[]'],
    [actionsBytes, [swapActionParams, settleParams, takeParams]],
  );

  // ── Ejecutar via Universal Router ─────────────────────────────────────────
  const commands = ethers.hexlify(new Uint8Array([UR_COMMANDS.V4_SWAP]));
  const dl       = deadline();

  const router = new ethers.Contract(V4_ROUTER, ABI_V4_ROUTER, wallet);
  const tx = await router.execute(
    commands,
    [v4SwapInput],
    dl,
    { value: isNativeIn ? amountIn : 0n },
  );
  const receipt = await tx.wait();

  return { txHash: receipt.hash, amountIn };
}

module.exports = { swapV2, swapV3, swapV4 };
