'use strict';

const { ethers } = require('ethers');

// ── Configuración ─────────────────────────────────────────────────────────────

const WETH       = '0x4200000000000000000000000000000000000006';
const NATIVE_ETH = ethers.ZeroAddress;

const FACTORIES = {
  v2: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  v3: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  v4: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
};

const ABI_V2 = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
];

const ABI_V3 = [
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
];

const ABI_V4 = [
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasEth(token0, token1) {
  const t0     = token0.toLowerCase();
  const t1     = token1.toLowerCase();
  const weth   = WETH.toLowerCase();
  const native = NATIVE_ETH.toLowerCase();
  return t0 === weth || t1 === weth || t0 === native || t1 === native;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Función principal exportada ───────────────────────────────────────────────

/**
 * Devuelve las pools ETH/WETH creadas en los últimos `blocksBack` bloques
 * en Uniswap V2, V3 y V4 sobre Base mainnet.
 *
 * @param {Object} opts
 * @param {string} opts.infuraApiKey    API key de Infura
 * @param {number} [opts.blocksBack=10] Número de bloques hacia atrás a escanear
 * @returns {Promise<Array>}
 */
async function discoverPools({ infuraApiKey, blocksBack = 10 }) {
  if (!infuraApiKey) throw new Error('discoverPools: falta infuraApiKey');

  const provider = new ethers.JsonRpcProvider(
    `https://base-mainnet.infura.io/v3/${infuraApiKey}`,
  );

  const latestBlock = await provider.getBlockNumber();
  const fromBlock   = latestBlock - blocksBack;

  console.log(`[pool-discovery] Base mainnet · bloques ${fromBlock} → ${latestBlock}`);

  const discovered = [];

  // ── V2 ──────────────────────────────────────────────────────────────────────

  console.log('[pool-discovery] Consultando Uniswap V2...');
  const v2       = new ethers.Contract(FACTORIES.v2, ABI_V2, provider);
  const v2Events = await v2.queryFilter(v2.filters.PairCreated(), fromBlock, latestBlock);

  for (const ev of v2Events) {
    const { token0, token1, pair } = ev.args;
    if (!hasEth(token0, token1)) continue;
    discovered.push({
      version:      'v2',
      pool:         pair,
      token0,
      token1,
      blockNumber:  ev.blockNumber,
      txHash:       ev.transactionHash,
      discoveredAt: new Date().toISOString(),
    });
  }

  console.log(`[pool-discovery] V2: ${v2Events.length} total · ${discovered.length} con ETH/WETH`);
  await sleep(500);

  // ── V3 ──────────────────────────────────────────────────────────────────────

  console.log('[pool-discovery] Consultando Uniswap V3...');
  const v3       = new ethers.Contract(FACTORIES.v3, ABI_V3, provider);
  const v3Events = await v3.queryFilter(v3.filters.PoolCreated(), fromBlock, latestBlock);

  const beforeV3 = discovered.length;
  for (const ev of v3Events) {
    const { token0, token1, fee, pool } = ev.args;
    if (!hasEth(token0, token1)) continue;
    discovered.push({
      version:      'v3',
      pool,
      token0,
      token1,
      fee:          Number(fee),
      blockNumber:  ev.blockNumber,
      txHash:       ev.transactionHash,
      discoveredAt: new Date().toISOString(),
    });
  }

  console.log(`[pool-discovery] V3: ${v3Events.length} total · ${discovered.length - beforeV3} con ETH/WETH`);
  await sleep(500);

  // ── V4 ──────────────────────────────────────────────────────────────────────

  console.log('[pool-discovery] Consultando Uniswap V4...');
  const v4       = new ethers.Contract(FACTORIES.v4, ABI_V4, provider);
  const v4Events = await v4.queryFilter(v4.filters.Initialize(), fromBlock, latestBlock);

  const beforeV4 = discovered.length;
  for (const ev of v4Events) {
    const { id, currency0, currency1, fee, tickSpacing, hooks } = ev.args;
    if (!hasEth(currency0, currency1)) continue;
    discovered.push({
      version:      'v4',
      poolId:       id,
      currency0,
      currency1,
      fee:          Number(fee),
      tickSpacing:  Number(tickSpacing),
      hooks,
      blockNumber:  ev.blockNumber,
      txHash:       ev.transactionHash,
      discoveredAt: new Date().toISOString(),
    });
  }

  console.log(`[pool-discovery] V4: ${v4Events.length} total · ${discovered.length - beforeV4} con ETH/WETH`);
  console.log(`[pool-discovery] Total: ${discovered.length} pools con ETH/WETH`);

  return discovered;
}

// ── ABIs para swap events ─────────────────────────────────────────────────────

const ABI_V2_FACTORY = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
];

const ABI_V3_FACTORY_FULL = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const ABI_V2_SWAP = [
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
];

const ABI_V3_SWAP = [
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
];

// En V4 el evento Swap incluye el poolId como primer param indexado
const ABI_V4_SWAP = [
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
];

// Fee tiers estándar de V3 (mismos que usa el contrato UniswapTrader)
const V3_FEE_TIERS = [500, 3_000, 10_000];

// Fee + tickSpacing estándar de V4 (igual que las constantes del contrato)
const V4_TICK_SPACINGS = { 500: 10, 3_000: 60, 10_000: 200 };

// ── countUniqueWallets ────────────────────────────────────────────────────────

/**
 * Cuenta las wallets únicas que han realizado swaps del token dado
 * en los últimos `blocksBack` bloques, revisando pools de V2, V3 y V4.
 *
 * Para V2/V3 se recogen sender + to/recipient de los eventos Swap.
 * Para V4 se computa el poolId de cada fee tier y se filtra el evento
 * Swap del PoolManager (sender).
 *
 * @param {Object} opts
 * @param {string} opts.infuraApiKey    API key de Infura
 * @param {string} opts.tokenAddress    Dirección del token ERC-20
 * @param {number} [opts.blocksBack=10] Bloques hacia atrás a escanear
 * @returns {Promise<number>}           Número de wallets únicas
 */
async function countUniqueWallets({ infuraApiKey, tokenAddress, blocksBack = 10 }) {
  if (!infuraApiKey)   throw new Error('countUniqueWallets: falta infuraApiKey');
  if (!tokenAddress)   throw new Error('countUniqueWallets: falta tokenAddress');

  const provider = new ethers.JsonRpcProvider(
    `https://base-mainnet.infura.io/v3/${infuraApiKey}`,
  );

  const latestBlock = await provider.getBlockNumber();
  const fromBlock   = latestBlock - blocksBack;
  const wallets     = new Set();
  const token       = ethers.getAddress(tokenAddress); // checksummed

  // ── V2 ────────────────────────────────────────────────────────────────────

  const v2Factory  = new ethers.Contract(FACTORIES.v2, ABI_V2_FACTORY, provider);
  const v2PairAddr = await v2Factory.getPair(WETH, token);
  await sleep(500);

  if (v2PairAddr !== ethers.ZeroAddress) {
    const v2Pair   = new ethers.Contract(v2PairAddr, ABI_V2_SWAP, provider);
    const v2Events = await v2Pair.queryFilter(v2Pair.filters.Swap(), fromBlock, latestBlock);
    for (const ev of v2Events) {
      wallets.add(ev.args.sender.toLowerCase());
      wallets.add(ev.args.to.toLowerCase());
    }
    console.log(`[wallets] V2 (${v2PairAddr.slice(0, 10)}…): ${v2Events.length} swaps`);
    await sleep(500);
  }

  // ── V3 ────────────────────────────────────────────────────────────────────

  const v3Factory = new ethers.Contract(FACTORIES.v3, ABI_V3_FACTORY_FULL, provider);

  for (const fee of V3_FEE_TIERS) {
    const poolAddr = await v3Factory.getPool(WETH, token, fee);
    await sleep(500);
    if (poolAddr === ethers.ZeroAddress) continue;

    const v3Pool   = new ethers.Contract(poolAddr, ABI_V3_SWAP, provider);
    const v3Events = await v3Pool.queryFilter(v3Pool.filters.Swap(), fromBlock, latestBlock);
    for (const ev of v3Events) {
      wallets.add(ev.args.sender.toLowerCase());
      wallets.add(ev.args.recipient.toLowerCase());
    }
    console.log(`[wallets] V3 fee=${fee} (${poolAddr.slice(0, 10)}…): ${v3Events.length} swaps`);
    await sleep(500);
  }

  // ── V4 ────────────────────────────────────────────────────────────────────
  // Computa el poolId = keccak256(abi.encode(PoolKey)) para cada fee tier
  // estándar y filtra los Swap del PoolManager por ese id.
  //
  // En todos los pares ETH/token de V4:
  //   currency0 = address(0) (ETH nativo, siempre menor)
  //   currency1 = token
  //   hooks     = address(0) (sin hooks)

  const abiCoder  = ethers.AbiCoder.defaultAbiCoder();
  const v4Manager = new ethers.Contract(FACTORIES.v4, ABI_V4_SWAP, provider);

  for (const fee of V3_FEE_TIERS) {
    const tickSpacing = V4_TICK_SPACINGS[fee];
    const encoded     = abiCoder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [ethers.ZeroAddress, token, fee, tickSpacing, ethers.ZeroAddress],
    );
    const poolId = ethers.keccak256(encoded);

    const v4Events = await v4Manager.queryFilter(
      v4Manager.filters.Swap(poolId),
      fromBlock,
      latestBlock,
    );
    for (const ev of v4Events) {
      wallets.add(ev.args.sender.toLowerCase());
    }
    console.log(`[wallets] V4 fee=${fee}: ${v4Events.length} swaps`);
    await sleep(500);
  }

  return wallets.size;
}

module.exports = { discoverPools, countUniqueWallets };
