# scapper-cron

Scraper headless con Playwright y modo stealth para esquivar Cloudflare. Incluye un monitor especializado para nuevos pares en DexScreener con filtros configurables por JSON, notificación por Telegram y **ejecución automática de compras on-chain** a través de un contrato inteligente desplegado en Base.

## Requisitos

- Node.js 18+
- Chromium (se instala con Playwright)

## Instalación

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Edita `.env` con tus credenciales:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_CHAT_ID=-1001234567890

# Solo necesarias si alguna estrategia tiene dryRun: false
INFURA_API_KEY=your_infura_api_key_here
PRIVATE_KEY=0xyour_wallet_private_key_here
CONTRACT_ADDRESS=0xyour_deployed_contract_address_here
```

---

## `index.js` — Monitor de pares DexScreener

Scraper especializado para DexScreener. Construye la URL de búsqueda a partir de un fichero de configuración JSON, extrae la tabla de pares, aplica filtros post-scrape, calcula métricas y notifica por Telegram solo los pares nuevos. Cuando `dryRun` es `false`, ejecuta automáticamente una compra del token detectado a través del contrato UniswapTrader.

### Uso

**Paso 1 — Arrancar Chrome con el puerto de depuración:**

```bash
bash browser-manager/_start.sh
```

Este script abre Chrome con `--remote-debugging-port=9222`, necesario para que el scraper pueda leer el DOM de DexScreener. Espera a que Chrome cargue la página antes de continuar.

**Paso 2 — Ejecutar el monitor:**

```bash
node index.js --config <id>
```

El ID corresponde a `configs/config.<id>.json`. Ejemplo:

```bash
node index.js --config st1
```

---

## Configuraciones

Las configuraciones viven en `configs/config.<id>.json`. Cada fichero define completamente la estrategia: qué URL construir, qué filtros aplicar, cómo operar y dónde guardar el history.

### Crear una nueva configuración

1. Crea `configs/config.<mi-estrategia>.json`
2. Ejecuta con `node index.js --config <mi-estrategia>`

El fichero `history/<historyFile>` se crea automáticamente en la primera ejecución.

### Referencia de campos

#### Campos obligatorios

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `name` | string | Nombre legible de la estrategia (aparece en el mensaje de Telegram) |
| `historyFile` | string | Nombre del fichero de history (se guarda en `history/`) |
| `chain` | string | Blockchain a monitorizar: `base`, `solana`, `ethereum`, `bsc`… |

#### Parámetros de URL (filtros de DexScreener)

Estos campos se traducen directamente a query params de la URL de DexScreener. Los campos ausentes o `null` se omiten.

| Campo | Param URL | Descripción |
|-------|-----------|-------------|
| `rankBy` | `rankBy` | Criterio de ordenación: `trendingScoreH6`, `trendingScoreH24`, `volume`… |
| `order` | `order` | Dirección: `desc` / `asc` |
| `minLiq` | `minLiq` | Liquidez mínima en USD |
| `maxLiq` | `maxLiq` | Liquidez máxima en USD |
| `minMarketCap` | `minMarketCap` | Market cap mínimo en USD |
| `maxMarketCap` | `maxMarketCap` | Market cap máximo en USD |
| `minAge` | `minAge` | Edad mínima del par en horas |
| `maxAge` | `maxAge` | Edad máxima del par en horas |
| `min24HTxns` | `min24HTxns` | Mínimo de transacciones en las últimas 24h |
| `max24HTxns` | `max24HTxns` | Máximo de transacciones en las últimas 24h |
| `min24HChg` | `min24HChg` | Cambio de precio mínimo en 24h (%) |
| `max24HChg` | `max24HChg` | Cambio de precio máximo en 24h (%) |
| `min6HChg` | `min6HChg` | Cambio de precio mínimo en 6h (%) |
| `max6HChg` | `max6HChg` | Cambio de precio máximo en 6h (%) |
| `min1HChg` | `min1HChg` | Cambio de precio mínimo en 1h (%) |
| `max1HChg` | `max1HChg` | Cambio de precio máximo en 1h (%) |
| `min5MChg` | `min5MChg` | Cambio de precio mínimo en 5m (%) |
| `max5MChg` | `max5MChg` | Cambio de precio máximo en 5m (%) |
| `profile` | `profile` | `1` solo pares con icono, `0` sin restricción |

#### Filtros post-scrape

Estos filtros se aplican sobre los datos ya extraídos. Son útiles para métricas que DexScreener no expone como parámetro de URL.

| Campo | Descripción |
|-------|-------------|
| `minMakers` | Descarta pares con menos traders/makers que este valor |
| `maxMakers` | Descarta pares con más traders/makers que este valor |
| `nonZero5MChg` | Si `true`, descarta pares cuyo cambio en 5m sea exactamente 0% |
| `nonZero1HChg` | Si `true`, descarta pares cuyo cambio en 1h sea exactamente 0% |
| `nonZero6HChg` | Si `true`, descarta pares cuyo cambio en 6h sea exactamente 0% |
| `nonZero24HChg` | Si `true`, descarta pares cuyo cambio en 24h sea exactamente 0% |

> **Por qué existe `nonZeroXXXChg`:** cuando el mínimo es negativo (p.ej. `min24HChg: -30`) los tokens muertos con `0%` de cambio pasan el filtro URL porque `0 >= -30`. Los flags `nonZero` los eliminan en el post-scrape. El valor por defecto es `true`.

#### Campos de trading (on-chain)

> Requieren las variables de entorno `INFURA_API_KEY`, `PRIVATE_KEY` y `CONTRACT_ADDRESS`. Ver [TRADE.md](./TRADE.md) para la guía completa.

| Campo | Tipo | Default | Descripción |
|-------|------|---------|-------------|
| `dryRun` | boolean | `false` | Si `false`, ejecuta la compra real. Si `true`, solo notifica sin operar. |
| `ethPerTrade` | number | `0.01` | ETH a gastar por compra (en unidades ETH, no wei) |
| `slippageBps` | number | `300` | Slippage máximo tolerado en basis points (100 = 1%) |

> El contrato `UniswapTrader` prueba automáticamente Uniswap V4 → V3 → V2 en cada operación. Los tokens comprados quedan en el contrato; usa `withdraw()` / `withdrawToken()` para recuperarlos (ver `atomic-test/`).

| Campo | Descripción |
|-------|-------------|
| `notify` | Si `true`, envía el mensaje de Telegram. Default: `false` |

### Ejemplo de configuración completa

```json
{
    "name": "Estrategia Agresiva",
    "historyFile": "history-agresiva.json",

    "chain": "base",
    "rankBy": "trendingScoreH24",
    "order": "desc",

    "minMarketCap": 20000,
    "maxMarketCap": 150000,

    "minLiq": 15000,
    "maxLiq": 1000000,

    "minAge": 2,
    "maxAge": 24,

    "min24HChg": -30,
    "min1HChg": -30,
    "min5MChg": -30,

    "minMakers": 100,

    "dryRun": false,
    "ethPerTrade": 0.05,
    "slippageBps": 200,

    "notify": true
}
```

---

### Pipeline de ejecución

```
Config JSON
  │
  ├─ Construir URL de DexScreener
  │
  ├─ Scrape headless (Playwright + stealth)
  │
  ├─ [Filtro post-scrape] minMakers / maxMakers
  ├─ [Filtro post-scrape] nonZero5MChg / nonZero1HChg / nonZero6HChg / nonZero24HChg
  │
  ├─ Comparar con history/<historyFile>
  │   ├─ Ya notificado → ignorar
  │   └─ Nuevo → continuar
  │
  ├─ Calcular métricas (Vol/Liq, Vol/MCap, Txns/Mkr)
  │
  ├─ [Si dryRun = false]
  │   ├─ Resolver token address via API DexScreener
  │   ├─ Llamar a UniswapTrader.buyToken() en Base (routing V4→V3→V2)
  │   ├─ Tokens comprados quedan en el contrato
  │   └─ Registrar resultado (✅ / ❌)
  │
  ├─ Notificar por Telegram (incluye resultado de compra)
  │
  └─ Guardar en history/<historyFile>
```

### Métricas calculadas

Para cada par nuevo se calculan tres ratios:

| Métrica | Fórmula | Verde | Rojo |
|---------|---------|-------|------|
| Vol/Liq | `volumen / liquidez` | >= 0.5 | < 0.5 |
| Vol/MCap | `volumen / market cap` | > 0.05 | <= 0.05 |
| Txns/Mkr | `transacciones / traders` | entre 1 y 12 | fuera de rango |

### Mensaje de Telegram

Con `dryRun: false` y compra ejecutada:
```
🚨 Nuevo par detectado — Estrategia Agresiva

CALI / WETH
Cali

Market Cap: $173K
Liquidity:  $38K
Makers:     462
Edad:       2d
Precio:     $0.002341

── Métricas ──
Vol/Liq   🟢  6.55
Vol/MCap  🟢  1.44
Txns/Mkr  🟢  2.28

✅ Compra ejecutada: 0.05 ETH
  Token: 0xAbC...
  Tx: 0x1a2b...

https://dexscreener.com/base/0xa526...
```

### Automatizar con cron

```bash
# Cada 5 minutos
*/5 * * * * cd /ruta/al/proyecto && node index.js --config st1 >> logs/st1.log 2>&1
```

---

## Estructura del proyecto

```
scapper-cron/
├── atomic-test/
│   ├── buy.js                  # Prueba manual de buyToken
│   ├── sell.js                 # Prueba manual de sellToken
│   ├── withdraw.js             # Prueba manual de withdraw / withdrawToken
│   └── README.md               # Guía de uso de los scripts de prueba
├── configs/
│   └── config.<id>.json        # Ficheros de configuración por estrategia
├── history/
│   └── history-<id>.json       # Pares notificados (auto-generado)
├── logs/                       # Logs de ejecución (opcional)
├── solidity/
│   └── UniswapTrader.sol       # Contrato inteligente de trading en Base (V4/V3/V2)
├── src/
│   ├── scraper.js              # Módulo Playwright + stealth
│   ├── trader.js               # Módulo web3: buy/sell/withdraw via ethers.js
│   ├── cli.js                  # CLI genérico con Commander
│   └── api.js                  # Servidor HTTP REST
├── index.js                    # Monitor DexScreener + Telegram + trading
├── .env                        # Variables de entorno (no commitear)
├── .env.example                # Plantilla de variables de entorno
├── TRADE.md                    # Documentación completa del sistema de trading
└── package.json
```

---

## Notas técnicas

- El scraper usa **`playwright-extra`** con **`puppeteer-extra-plugin-stealth`** para pasar los challenges de Cloudflare. El plugin parchea ~20 propiedades del browser (`navigator.webdriver`, Canvas fingerprint, WebGL, etc.).
- Se envían headers HTTP realistas (User-Agent de Chrome real, `Sec-*`, `Accept-*`) en todas las peticiones.
- Los valores monetarios de DexScreener (`$1.3M`, `$285K`) se parsean a número para filtros y métricas.
- El directorio `history/` y el fichero JSON se crean automáticamente si no existen.
- La integración on-chain usa **ethers.js v6** y se conecta a Base Mainnet vía Infura. Ver [TRADE.md](./TRADE.md) para todos los detalles.
