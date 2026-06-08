#!/usr/bin/env node
'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { fetchPairsByToken, fetchTokenProfiles } = require('./src/dexscreener-api');
const { executeBuy, buildProvider } = require('./src/trader');
const { sendTelegram }           = require('./src/telegram');
const { fetchMarketCap }         = require('./src/market');
const { loadWallet, saveWallet } = require('./src/wallet');

console.log(new Date().toISOString(), 'Iniciando estrategia:', process.argv.slice(2).join(' '));

// ── Args ──────────────────────────────────────────────────────────────────────

const configFlagIdx = process.argv.indexOf('--config');
const configId      = configFlagIdx !== -1 ? process.argv[configFlagIdx + 1] : null;

if (!configId) {
  console.error('Uso: node index.js --config <id>');
  console.error('Ejemplo: node index.js --config st3');
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
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Persistencia ──────────────────────────────────────────────────────────────

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
    // makers estimados = txns24h / 2
    [cfg.minMakers    != null,   makers  !== null && makers  >= cfg.minMakers,    `minMakers ${cfg.minMakers} (≈txns/2=${makers})`],
    [cfg.maxMakers    != null,   makers  !== null && makers  <= cfg.maxMakers,    `maxMakers ${cfg.maxMakers} (≈txns/2=${makers})`],
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
  let pools = 0;

  // ── 1. Obtener tokens de Base via DexScreener token profiles ──────────────

  const profiles = await fetchTokenProfiles();
  const tokens   = profiles.filter(p => p.chainId === 'base');

  console.log(`[profiles] ${profiles.length} total · ${tokens.length} en Base`);

  // ── 2. Evaluar cada token ─────────────────────────────────────────────────

  const history   = loadHistory();
  const knownHist = new Set(history.notified.map(e => e.tokenAddress?.toLowerCase()));

  for (const profile of tokens) {
    const tokenAddress = profile.tokenAddress.toLowerCase();

    console.log(`\n[token] ${profile.tokenAddress}`);

    // Saltar si ya fue procesado
    if (knownHist.has(tokenAddress)) {
      console.log(`  ✓ Ya procesado — omitiendo`);
      continue;
    }

    // 2a. Consultar DexScreener para obtener el par
    let pair;
    try {
      const data       = await fetchPairsByToken(profile.tokenAddress);
      const candidates = (data?.pairs ?? []).filter(p => p.chainId === (config.chain ?? 'base'));
      pair = candidates.find(p => p.dexId === 'uniswap') ?? candidates[0] ?? null;
      pools = candidates.find(p => p.dexId === 'uniswap') ? candidates.filter(p => p.dexId === 'uniswap').length : 0;
      await sleep(500); // evitar rate limit de DexScreener
    } catch (err) {
      console.warn(`  [DexScreener] Error: ${err.message} — omitiendo`);
      continue;
    }

    if (!pair) {
      console.log(`  [DexScreener] Sin datos para este token — omitiendo`);
      continue;
    }

    // 2b. Si el dexId no es uniswap, saltar
    if (pair.dexId !== 'uniswap') {
      console.log(`  ✗ dexId="${pair.dexId}" (no es uniswap) — omitiendo`);
      continue;
    }

    // 2c. Si el marketCap supera 2x maxMarketCap, saltar
    if (config.maxMarketCap != null && pair.marketCap != null && pair.marketCap > config.maxMarketCap * 2) {
      console.log(`  ✗ MarketCap demasiado alto ($${(pair.marketCap / 1000).toFixed(1)}K > 2× maxMarketCap $${(config.maxMarketCap / 1000).toFixed(1)}K) — omitiendo`);
      continue;
    }

    // 2d. Aplicar filtros del config
    const { pass, reason } = applyFilters(pair, config);
    if (!pass) {
      console.log(`  ✗ Descartada por: ${reason}`);
      continue;
    }

    console.log(`  ✓ PASA todos los filtros → ${pair.baseToken?.symbol} / ${pair.quoteToken?.symbol}`);

    // ── 3a. Compra on-chain ────────────────────────────────────────────────

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
          tokenAddress: profile.tokenAddress,
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

    // ── 3b. Notificar por Telegram ─────────────────────────────────────────

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
      `<b>Pools:</b>     ${pools}`,
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
      `<a href="${pair.url}">Dex Screener</a>`,
      `<a href="https://app.uniswap.org/swap?outputCurrency=${profile.tokenAddress}&inputCurrency=0x4200000000000000000000000000000000000006&chain=base">Swap en Uniswap</a>`,
    ].join('\n');

    try {
      await notify(msg);
    } catch (err) {
      console.error(`  [Telegram] Error:`, err.message);
    }

    // ── 3c. Guardar en history ─────────────────────────────────────────────

    history.notified.push({
      tokenAddress: profile.tokenAddress,
      symbol:       pair.baseToken?.symbol  ?? '?',
      notifiedAt:   new Date().toISOString(),
      dryRun:       DRY_RUN,
      buyOk:        DRY_RUN ? null : buyOk,
    });

    knownHist.add(tokenAddress);
  }

  // ── 4. Persistir history ──────────────────────────────────────────────────

  saveHistory(history);
  console.log(`\nHistory guardado: ${history.notified.length} entradas.`);
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
