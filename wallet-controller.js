#!/usr/bin/env node
'use strict';

/**
 * wallet-controller.js
 *
 * Lee wallet.json y, para cada token en estado "holding":
 *   1. Obtiene el market cap actual vía DexScreener.
 *   2. Si el mcap subió >= 90% respecto al de entrada → vende el 100%.
 *   3. Envía notificación Telegram en caso de venta exitosa.
 *   4. Actualiza wallet.json con el resultado (éxito o fallo).
 *   5. Retries de venta: hasta MAX_SELL_RETRIES; si se supera → status "failed".
 *
 * Uso:
 *   node wallet-controller.js
 */

require('dotenv').config();

const { executeSell }    = require('./src/trader');
const { sendTelegram }   = require('./src/telegram');
const { fetchMarketCap } = require('./src/market');
const { loadWallet, saveWallet } = require('./src/wallet');

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SLIPPAGE_BPS     = 500;   // 5% slippage en ventas
const TARGET_GAIN_PCT  = 90;    // vender cuando mcap sube ≥ 90%
const MAX_SELL_RETRIES = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMcap(usd) {
  if (!usd) return '—';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

function notify(text) {
  return sendTelegram(text, { token: TELEGRAM_TOKEN, chatId: TELEGRAM_CHAT_ID })
    .catch(err => console.error('[Telegram] Error:', err.message));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const wallet = loadWallet();

  const holdings = wallet.filter(
    e => e.status === 'holding' && e.sellRetries < MAX_SELL_RETRIES,
  );

  console.log(`[${new Date().toISOString()}] Wallet: ${wallet.length} entradas, ${holdings.length} en "holding" con retries disponibles`);

  if (holdings.length === 0) {
    console.log('Nada que revisar. Saliendo.');
    return;
  }

  for (const entry of holdings) {
    console.log(`\n  → Revisando ${entry.symbol} (${entry.tokenAddress})`);

    // 1. Obtener market cap actual
    let currentMcap = null;
    try {
      const mcData = await fetchMarketCap(entry.tokenAddress);
      currentMcap  = mcData.marketCap;
    } catch (err) {
      console.warn(`  [MarketCap] Error obteniendo mcap: ${err.message}`);
    }

    if (!currentMcap) {
      console.log(`  → No se pudo obtener market cap. Saltando.`);
      continue;
    }

    if (!entry.marketCapEntry) {
      console.log(`  → Sin marketCapEntry registrado. Saltando.`);
      continue;
    }

    const gainPct = ((currentMcap - entry.marketCapEntry) / entry.marketCapEntry) * 100;
    console.log(`  → MCap entrada: ${fmtMcap(entry.marketCapEntry)} | actual: ${fmtMcap(currentMcap)} | variación: ${gainPct.toFixed(1)}%`);

    if (gainPct < TARGET_GAIN_PCT) {
      console.log(`  → Aún no alcanza +${TARGET_GAIN_PCT}%. Nada que hacer.`);
      continue;
    }

    // 2. Vender
    console.log(`  → +${gainPct.toFixed(1)}% ≥ ${TARGET_GAIN_PCT}% — iniciando venta...`);

    try {
      const sellResult = await executeSell({
        tokenAddress: entry.tokenAddress,
        sellBps:      10000, // 100%
        slippageBps:  SLIPPAGE_BPS,
      });

      // Éxito — actualizar entrada
      entry.status        = 'sold';
      entry.marketCapExit = currentMcap;
      entry.profitPct     = parseFloat(gainPct.toFixed(2));
      entry.txHashSell    = sellResult.txHash;
      entry.soldAt        = new Date().toISOString();

      console.log(`  → Venta OK | tx: ${sellResult.txHash} | beneficio: +${entry.profitPct}%`);

      // 3. Telegram — venta exitosa
      await notify([
        `💰 <b>Token vendido — beneficio +${entry.profitPct}%</b>`,
        ``,
        `<b>${entry.symbol}</b>  <code>${entry.tokenAddress}</code>`,
        ``,
        `<b>MCap entrada:</b>  ${fmtMcap(entry.marketCapEntry)}`,
        `<b>MCap salida:</b>   ${fmtMcap(entry.marketCapExit)}`,
        `<b>Variación:</b>     +${entry.profitPct}%`,
        ``,
        `<b>ETH invertido:</b> ${entry.ethSpent} ETH`,
        `<b>Tx venta:</b>      <code>${entry.txHashSell}</code>`,
      ].join('\n'));

    } catch (err) {
      entry.sellRetries += 1;
      console.error(`  → Venta FALLIDA (intento ${entry.sellRetries}/${MAX_SELL_RETRIES}): ${err.message}`);

      if (entry.sellRetries >= MAX_SELL_RETRIES) {
        entry.status = 'failed';
        console.error(`  → Máximo de retries alcanzado. Marcando como "failed".`);

        await notify([
          `⚠️ <b>Venta fallida — máximo de reintentos alcanzado</b>`,
          ``,
          `<b>${entry.symbol}</b>  <code>${entry.tokenAddress}</code>`,
          `<b>MCap actual:</b> ${fmtMcap(currentMcap)}`,
          `<b>Reintentos:</b>  ${entry.sellRetries}`,
          `<b>Error:</b>       ${err.message}`,
        ].join('\n'));
      }
    }
  }

  // 4. Persistir cambios
  saveWallet(wallet);
  console.log(`\nWallet guardado.`);
}

main().catch((err) => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
