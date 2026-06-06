#!/usr/bin/env node
'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { fetchPairByPool, fetchPairsByToken, fetchTokenProfiles } = require('./src/dexscreener-api');
const { executeBuy, buildProvider } = require('./src/trader');
const { sendTelegram }           = require('./src/telegram');
const { fetchMarketCap }         = require('./src/market');
const { loadWallet, saveWallet } = require('./src/wallet');

console.log(new Date().toISOString(), 'Iniciando estrategia:', process.argv.slice(2).join(' '));

// ── Args ──────────────────────────────────────────────────────────────────────

const configFlagIdx = process.argv.indexOf('--config');
const configId      = configFlagIdx !== -1 ? process.argv[configFlagIdx + 1] : null;

if (!configId) {
  console.error('Uso: node index-v2.js --config <id>');
  console.error('Ejemplo: node index-v2.js --config st3');
  process.exit(1);
}

const configPath = path.resolve(__dirname, 'configs', `config.${configId}.json`);
if (!fs.existsSync(configPath)) {
  console.error(`Config no encontrado: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// ── Config ────────────────────────────────────────────────────────────────────

const STRATEGY_NAME    = config.name    ?? configId;
const NOTIFY           = config.notify  ?? false;
const DRY_RUN          = config.dryRun  ?? true;
const SLIPPAGE_BPS     = config.slippageBps ?? 300;
const HISTORY_FILE     = path.resolve(__dirname, 'history', config.historyFile);
const DISCOVERY_FILE   = path.resolve(__dirname, 'discovery.json');
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const WETH       = '0x4200000000000000000000000000000000000006';
const NATIVE_ETH = ethers.ZeroAddress; // address(0) = ETH nativo en V4

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Pool helpers ──────────────────────────────────────────────────────────────

/**
 * Clave de deduplicación: la dirección de la pool (v2/v3) o el poolId (v4).
 */
function poolKey(p) {
  return (p.pool ?? p.poolId ?? p.tokenAddress ?? '').toLowerCase();
}

/**
 * Devuelve la dirección del token que NO es ETH/WETH en el par,
 * que es el token que hay que comprar.
 */
function nonEthToken(p) {
  const weth   = WETH.toLowerCase();
  const native = NATIVE_ETH.toLowerCase();

  if (p.version === 'token-profile') {
    return p.tokenAddress;
  }

  if (p.version === 'v4') {
    // En V4, currency0 siempre es ETH nativo (address(0))
    return p.currency1;
  }

  const t0 = (p.token0 ?? '').toLowerCase();
  return (t0 === weth || t0 === native) ? p.token1 : p.token0;
}

// ── Persistencia ──────────────────────────────────────────────────────────────

function loadDiscovery() {
  if (!fs.existsSync(DISCOVERY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8')); } catch { return []; }
}

function saveDiscovery(pools) {
  fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(pools, null, 2));
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return { notified: [] };
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return { notified: [] }; }
}

function saveHistory(h) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2));
}

function notify(text) {
  if (!NOTIFY) { console.log('[notify] desactivado — omitido'); return Promise.resolve(null); }
  return sendTelegram(text, { token: TELEGRAM_TOKEN, chatId: TELEGRAM_CHAT_ID });
}

// ── Filtros ───────────────────────────────────────────────────────────────────

/**
 * Aplica los filtros del config sobre un par de DexScreener.
 * Devuelve { pass: true } o { pass: false, reason: string }.
 *
 * Filtros soportados desde config:
 *   minMarketCap / maxMarketCap  → pair.marketCap
 *   minLiq / maxLiq              → pair.liquidity.usd
 *   minAge / maxAge (horas)      → calculado desde pair.pairCreatedAt
 *   min/max 24HChg/6HChg/1HChg/5MChg → pair.priceChange.*
 *   profile: 1 = requiere info.imageUrl, 0 = requiere sin imageUrl
 *   nonZero5MChg/1HChg/6HChg/24HChg → cambio ≠ 0 (default: true)
 *   minMakers / maxMakers        → pair.makers (si lo devuelve DexScreener)
 */
function applyFilters(pair, cfg) {
  const liq    = pair.liquidity?.usd   ?? null;
  const mcap   = pair.marketCap        ?? null;
  const chg24h = pair.priceChange?.h24 ?? null;
  const chg6h  = pair.priceChange?.h6  ?? null;
  const chg1h  = pair.priceChange?.h1  ?? null;
  const chg5m  = pair.priceChange?.m5  ?? null;
  const ageH   = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 3_600_000
    : null;
  const hasImg = !!(pair.info?.imageUrl);

  // Transacciones h24: suma de buys + sells
  const txns24h = pair.txns?.h24 != null
    ? (pair.txns.h24.buys ?? 0) + (pair.txns.h24.sells ?? 0)
    : null;

  // Estimación de makers: la mitad de las transacciones h24
  const makers = txns24h !== null ? Math.round(txns24h / 2) : null;

  // [activo, pasa, etiqueta para el log]
  const checks = [
    [cfg.minMarketCap != null,   mcap   !== null && mcap   >= cfg.minMarketCap,  `minMarketCap ${cfg.minMarketCap}`],
    [cfg.maxMarketCap != null,   mcap   !== null && mcap   <= cfg.maxMarketCap,  `maxMarketCap ${cfg.maxMarketCap}`],
    [cfg.minLiq       != null,   liq    !== null && liq    >= cfg.minLiq,        `minLiq ${cfg.minLiq}`],
    [cfg.maxLiq       != null,   liq    !== null && liq    <= cfg.maxLiq,        `maxLiq ${cfg.maxLiq}`],
    [cfg.minAge       != null,   ageH   !== null && ageH   >= cfg.minAge,        `minAge ${cfg.minAge}h`],
    [cfg.maxAge       != null,   ageH   !== null && ageH   <= cfg.maxAge,        `maxAge ${cfg.maxAge}h`],
    [cfg.min24HChg    != null,   chg24h !== null && chg24h >= cfg.min24HChg,     `min24HChg ${cfg.min24HChg}`],
    [cfg.max24HChg    != null,   chg24h !== null && chg24h <= cfg.max24HChg,     `max24HChg ${cfg.max24HChg}`],
    [cfg.min6HChg     != null,   chg6h  !== null && chg6h  >= cfg.min6HChg,      `min6HChg ${cfg.min6HChg}`],
    [cfg.max6HChg     != null,   chg6h  !== null && chg6h  <= cfg.max6HChg,      `max6HChg ${cfg.max6HChg}`],
    [cfg.min1HChg     != null,   chg1h  !== null && chg1h  >= cfg.min1HChg,      `min1HChg ${cfg.min1HChg}`],
    [cfg.max1HChg     != null,   chg1h  !== null && chg1h  <= cfg.max1HChg,      `max1HChg ${cfg.max1HChg}`],
    [cfg.min5MChg     != null,   chg5m  !== null && chg5m  >= cfg.min5MChg,      `min5MChg ${cfg.min5MChg}`],
    [cfg.max5MChg     != null,   chg5m  !== null && chg5m  <= cfg.max5MChg,      `max5MChg ${cfg.max5MChg}`],
    // txns h24 (buys + sells)
    [cfg.minTxns24h   != null,   txns24h !== null && txns24h >= cfg.minTxns24h,  `minTxns24h ${cfg.minTxns24h}`],
    [cfg.maxTxns24h   != null,   txns24h !== null && txns24h <= cfg.maxTxns24h,  `maxTxns24h ${cfg.maxTxns24h}`],
    // makers estimados = txns24h / 3
    [cfg.minMakers    != null,   makers  !== null && makers  >= cfg.minMakers,    `minMakers ${cfg.minMakers} (≈txns/3=${makers})`],
    [cfg.maxMakers    != null,   makers  !== null && makers  <= cfg.maxMakers,    `maxMakers ${cfg.maxMakers} (≈txns/3=${makers})`],
    // profile: 1 = con imagen, 0 = sin imagen, undefined = sin filtro
    [cfg.profile === 1,  hasImg,  'profile=1 (requiere imageUrl)'],
    [cfg.profile === 0, !hasImg,  'profile=0 (requiere sin imageUrl)'],
    // nonZero: descarta tokens sin actividad (cambio == 0%)
    [(cfg.nonZero5MChg  ?? true) && chg5m  !== null, chg5m  !== 0, 'nonZero5MChg'],
    [(cfg.nonZero1HChg  ?? true) && chg1h  !== null, chg1h  !== 0, 'nonZero1HChg'],
    [(cfg.nonZero6HChg  ?? true) && chg6h  !== null, chg6h  !== 0, 'nonZero6HChg'],
    [(cfg.nonZero24HChg ?? true) && chg24h !== null, chg24h !== 0, 'nonZero24HChg'],
  ];

  for (const [active, passes, label] of checks) {
    if (active && !passes) return { pass: false, reason: label };
  }

  return { pass: true };
}

// ── Métricas ──────────────────────────────────────────────────────────────────

function icon(cond) { return cond ? '🟢' : '🔴'; }

function buildScores(pair) {
  const vol    = pair.volume?.h24    ?? 0;
  const liq    = pair.liquidity?.usd ?? 0;
  const mcap   = pair.marketCap      ?? 0;
  const txns   = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
  const makers = pair.makers          ?? null;

  const volLiq  = liq  > 0 ? vol / liq  : 0;
  const volMcap = mcap > 0 ? vol / mcap : 0;
  const txnsMkr = makers !== null && makers > 0 ? txns / makers : null;

  return {
    volLiq:  `Vol/Liq   ${icon(volLiq  >= 0.5)} ${volLiq.toFixed(2)}`,
    volMcap: `Vol/MCap  ${icon(volMcap > 0.05)} ${volMcap.toFixed(2)}`,
    txnsMkr: txnsMkr !== null
      ? `Txns/Mkr  ${txnsMkr < 1 || txnsMkr > 12 ? '🔴' : '🟢'} ${txnsMkr.toFixed(2)}`
      : `Txns/Mkr  — (sin datos)`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. Descubrir tokens nuevos via DexScreener token profiles (solo Base) ──

  const profiles = await fetchTokenProfiles();
  const fresh = profiles
    .filter(p => p.chainId === 'base')
    .map(p => ({
      version:      'token-profile',
      tokenAddress: p.tokenAddress,
      discoveredAt: new Date().toISOString(),
    }));

  // ── 2. Append en discovery.json (dedup por pool address / poolId) ─────────

  let existing = loadDiscovery();
  if (config.maxAge != null) {
    const maxAgeMs = config.maxAge * 3_600_000;
    const before   = existing.length;
    existing = existing.filter(p =>
      !p.discoveredAt || (Date.now() - new Date(p.discoveredAt).getTime()) <= maxAgeMs,
    );
    if (existing.length < before)
      console.log(`[discovery] Eliminados ${before - existing.length} items con más de ${config.maxAge}h`);
  }
  const knownKeys   = new Set(existing.map(poolKey));
  const newPools    = fresh.filter(p => !knownKeys.has(poolKey(p)));

  console.log(`[discovery] ${fresh.length} encontradas · ${newPools.length} nuevas · ${existing.length} ya conocidas`);

  // allDiscovery es la lista viva que mutaremos durante el loop
  const allDiscovery = [...existing, ...newPools];
  saveDiscovery(allDiscovery);

  // ── 3. Para cada pool no descartada: consultar DexScreener y aplicar filtros ──

  const history        = loadHistory();
  const knownHist      = new Set(history.notified.map(e => e.poolKey));
  let   discoveryDirty = false; // flag para saber si hay que re-guardar

  const poolsToEvaluate = allDiscovery.filter(p => !p.discarded);
  console.log(`[evaluación] ${poolsToEvaluate.length} pools a evaluar (${allDiscovery.length - poolsToEvaluate.length} descartadas)`);

  for (const pool of poolsToEvaluate) {
    const key   = poolKey(pool);
    const token = nonEthToken(pool);

    console.log(`\n[pool] ${pool.version.toUpperCase()} | ${key}`);

    // 3a. Consultar DexScreener
    let pair;
    try {
      if (pool.version === 'token-profile') {
        const data       = await fetchPairsByToken(pool.tokenAddress);
        const candidates = (data?.pairs ?? []).filter(p => p.chainId === (config.chain ?? 'base'));
        pair = candidates.find(p => p.dexId === 'uniswap') ?? candidates[0] ?? null;
      } else {
        const data = await fetchPairByPool(key, config.chain ?? 'base');
        pair = data?.pair ?? data?.pairs?.[0] ?? null;
      }
      await sleep(500); // evitar rate limit de DexScreener
    } catch (err) {
      console.warn(`  [DexScreener] Error: ${err.message} — omitiendo`);
      continue;
    }

    if (!pair) {
      const entry = allDiscovery.find(p => poolKey(p) === key);
      if (entry) {
        entry.notIndexedCount = (entry.notIndexedCount ?? 0) + 1;
        discoveryDirty = true;
        if (entry.notIndexedCount >= 4) {
          console.log(`  [DexScreener] Sin datos — pool no indexada ${entry.notIndexedCount}x → marcando discarded`);
          entry.discarded = true;
        } else {
          console.log(`  [DexScreener] Sin datos — pool aún no indexada (intento ${entry.notIndexedCount}/4)`);
        }
      }
      continue;
    }

    // 3b. Si el dexId no es uniswap, marcar como discarded y saltar
    if (pair.dexId !== 'uniswap') {
      console.log(`  ✗ dexId="${pair.dexId}" (no es uniswap) — marcando discarded`);
      const entry = allDiscovery.find(p => poolKey(p) === key);
      if (entry) { entry.discarded = true; discoveryDirty = true; }
      continue;
    }

    // 3b2. Si el marketCap supera 2x maxMarketCap, marcar como discarded permanentemente
    if (config.maxMarketCap != null && pair.marketCap != null && pair.marketCap > config.maxMarketCap * 2) {
      console.log(`  ✗ MarketCap demasiado alto ($${(pair.marketCap / 1000).toFixed(1)}K > 2× maxMarketCap $${(config.maxMarketCap / 1000).toFixed(1)}K) — marcando discarded`);
      const entry = allDiscovery.find(p => poolKey(p) === key);
      if (entry) { entry.discarded = true; discoveryDirty = true; }
      continue;
    }

    // 3c. Si el par es más antiguo que cfg.maxAge, eliminar de discovery y saltar
    if (config.maxAge != null && pair.pairCreatedAt != null) {
      const ageH = (Date.now() - pair.pairCreatedAt) / 3_600_000;
      if (ageH > config.maxAge) {
        console.log(`  ✗ Par demasiado antiguo (${ageH.toFixed(1)}h > maxAge ${config.maxAge}h) — eliminando de discovery`);
        const idx = allDiscovery.findIndex(p => poolKey(p) === key);
        if (idx !== -1) { allDiscovery.splice(idx, 1); discoveryDirty = true; }
        continue;
      }
    }

    // 3d. Aplicar filtros del config
    const { pass, reason } = applyFilters(pair, config);
    if (!pass) {
      console.log(`  ✗ Descartada por: ${reason}`);
      continue;
    }

    // 3c. Comprobar si ya fue procesada en esta estrategia
    if (knownHist.has(key)) {
      console.log(`  ✓ Pasa filtros pero ya fue procesada — omitiendo`);
      continue;
    }

    console.log(`  ✓ PASA todos los filtros → ${pair.baseToken?.symbol} / ${pair.quoteToken?.symbol}`);

    // ── 4a. Compra on-chain ────────────────────────────────────────────────

    const { provider: _prov } = buildProvider();
    const contractBalanceWei  = await _prov.getBalance(process.env.CONTRACT_ADDRESS);
    const ethPerTradeWei      = contractBalanceWei * 33n / 100n;
    const ethPerTradeDynamic  = Number(ethers.formatEther(ethPerTradeWei));

    let buyLine = `  [DRY RUN — compra simulada: ${ethPerTradeDynamic.toFixed(6)} ETH (33% balance)]`;
    let buyOk   = true;

    if (!DRY_RUN) {
      console.log(`  → Comprando ${ethPerTradeDynamic.toFixed(6)} ETH de ${pair.baseToken?.symbol}...`);
      try {
        const buyResult = await executeBuy({
          chain:        config.chain ?? 'base',
          tokenAddress: token,
          ethPerTrade:  ethPerTradeDynamic,
          slippageBps:  SLIPPAGE_BPS,
        });

        let marketCapEntry = null;
        try {
          const mcData = await fetchMarketCap(buyResult.tokenAddress);
          marketCapEntry = mcData.marketCap;
        } catch (mcErr) {
          console.warn(`  [MarketCap] ${mcErr.message}`);
        }

        const wallet = loadWallet();
        wallet.push({
          tokenAddress:  buyResult.tokenAddress,
          symbol:        pair.baseToken?.symbol ?? '?',
          marketCapEntry,
          purchasedAt:   new Date().toISOString(),
          ethSpent:      buyResult.ethSpent,
          txHashBuy:     buyResult.txHash,
          status:        'holding',
          marketCapExit: null,
          profitPct:     null,
          txHashSell:    null,
          soldAt:        null,
          sellRetries:   0,
        });
        saveWallet(wallet);

        const mcapStr = marketCapEntry ? `$${(marketCapEntry / 1000).toFixed(1)}K` : '—';
        buyLine = `✅ Compra ejecutada: <b>${buyResult.ethSpent} ETH</b>\nToken: <code>${buyResult.tokenAddress}</code>\nMCap entrada: ${mcapStr}\nTx: <code>${buyResult.txHash}</code>`;
        console.log(`  → Compra OK — tx: ${buyResult.txHash}`);
      } catch (err) {
        buyOk   = false;
        buyLine = `❌ Compra fallida: ${err.message}`;
        console.error(`  → Compra FALLIDA:`, err.message);
      }
    }

    // ── 4b. Notificar por Telegram ─────────────────────────────────────────

    const s   = buildScores(pair);
    const age = pair.pairCreatedAt
      ? `${((Date.now() - pair.pairCreatedAt) / 3_600_000).toFixed(1)}h`
      : '—';

    const msg = [
      `🚨 <b>Nueva pool detectada — ${STRATEGY_NAME}</b>`,
      ``,
      `<b>${pair.baseToken?.symbol ?? '—'}</b> / ${pair.quoteToken?.symbol ?? '—'}`,
      `<i>${pair.baseToken?.name ?? '—'}</i>`,
      ``,
      `<b>Market Cap:</b> $${((pair.marketCap ?? 0) / 1000).toFixed(1)}K`,
      `<b>Liquidity:</b>  $${((pair.liquidity?.usd ?? 0) / 1000).toFixed(1)}K`,
      `<b>Edad:</b>       ${age}`,
      `<b>Precio:</b>     $${pair.priceUsd ?? '—'}`,
      ``,
      `<b>Cambios:</b>  5m: ${pair.priceChange?.m5 ?? '—'}%  1h: ${pair.priceChange?.h1 ?? '—'}%  6h: ${pair.priceChange?.h6 ?? '—'}%  24h: ${pair.priceChange?.h24 ?? '—'}%`,
      ``,
      `<b>── Métricas ──</b>`,
      `<code>${s.volLiq}</code>`,
      `<code>${s.volMcap}</code>`,
      `<code>${s.txnsMkr}</code>`,
      ``,
      buyLine,
      ``,
      `<a href="${pair.url}">${pair.url}</a>`,
    ].join('\n');

    try {
      await notify(msg);
    } catch (err) {
      console.error(`  [Telegram] Error:`, err.message);
    }

    // ── 4c. Guardar en history ─────────────────────────────────────────────

    history.notified.push({
      poolKey:    key,
      version:    pool.version,
      token:      pair.baseToken?.address ?? token,
      symbol:     pair.baseToken?.symbol  ?? '?',
      notifiedAt: new Date().toISOString(),
      dryRun:     DRY_RUN,
      buyOk:      DRY_RUN ? null : buyOk,
    });

    knownHist.add(key);
  }

  // ── 5. Persistir history y discovery (si hubo mutaciones) ───────────────

  saveHistory(history);
  console.log(`\nHistory guardado: ${history.notified.length} entradas.`);

  if (discoveryDirty) {
    saveDiscovery(allDiscovery);
    console.log(`Discovery actualizado: ${allDiscovery.length} entradas.`);
  }
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
