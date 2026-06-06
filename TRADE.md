# TRADE.md — Sistema de trading on-chain

Documentación técnica completa del sistema de compra/venta automática de tokens integrado en el monitor de DexScreener. Cuando una estrategia detecta un par nuevo y tiene `dryRun: false`, el bot ejecuta una compra real a través del contrato inteligente `UniswapTrader` desplegado en Base Mainnet.

---

## Índice

1. [Arquitectura general](#arquitectura-general)
2. [Contrato inteligente — UniswapTrader.sol](#contrato-inteligente--uniswaptradersol)
3. [Módulo Node.js — src/trader.js](#módulo-nodejs--srctraderjs)
4. [Scripts de prueba — atomic-test/](#scripts-de-prueba--atomic-test)
5. [Configuración por estrategia](#configuración-por-estrategia)
6. [Variables de entorno](#variables-de-entorno)
7. [Despliegue del contrato](#despliegue-del-contrato)
8. [Flujo de ejecución detallado](#flujo-de-ejecución-detallado)
9. [Gestión de fondos](#gestión-de-fondos)
10. [Seguridad](#seguridad)

---

## Arquitectura general

```
index.js (monitor)
    │
    │  par nuevo detectado + dryRun: false
    ▼
src/trader.js
    │
    ├─ 1. Extrae pairAddress del href de DexScreener
    ├─ 2. Llama a la API pública de DexScreener → obtiene tokenAddress
    ├─ 3. Conecta a Base Mainnet vía Infura (ethers.js v6)
    ├─ 4. Verifica que el contrato tiene ETH suficiente
    └─ 5. Llama a UniswapTrader.buyToken(ethAmount, tokenAddress, slippageBps)
               │
               ▼
        UniswapTrader.sol (Base Mainnet)
               │
               ├─ Intenta Uniswap V4 (PoolManager singleton)
               │   └─ Si falla o no hay liquidez → continúa
               ├─ Intenta Uniswap V3 (fee 500 → 3000 → 10000)
               │   └─ Si falla o no hay liquidez → continúa
               ├─ Intenta Uniswap V2 (par directo WETH/token)
               │   └─ Si no existe el par → revierte
               └─ Tokens comprados quedan en el contrato
```

---

## Contrato inteligente — UniswapTrader.sol

Ubicación: `solidity/UniswapTrader.sol`

### Descripción

Contrato desplegado en Base Mainnet que actúa como ejecutor de swaps. La wallet owner lo financia con ETH por adelantado. Cada llamada a `buyToken` o `sellToken` opera con ese ETH/tokens almacenados en el propio contrato. **Los fondos nunca salen del contrato automáticamente** — tanto los tokens comprados como el ETH recibido en ventas quedan retenidos. Para recuperar fondos usa `withdraw()` o `withdrawToken()`.

### Addresses en Base Mainnet (hardcodeadas)

| Protocolo | Contrato | Address |
|-----------|----------|---------|
| WETH | Wrapped Ether | `0x4200000000000000000000000000000000000006` |
| Uniswap V4 | PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` |
| Uniswap V3 | Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| Uniswap V3 | SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Uniswap V2 | Factory | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` |
| Uniswap V2 | Router02 | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` |

### Funciones públicas

#### `buyToken(uint256 ethAmount, address token, uint256 slippageBps)`

Compra `token` gastando `ethAmount` wei del saldo ETH del propio contrato. Los tokens recibidos **quedan en el contrato**.

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `ethAmount` | `uint256` | Cantidad de ETH a gastar, en wei |
| `token` | `address` | Address del token ERC-20 a comprar |
| `slippageBps` | `uint256` | Slippage máximo en basis points (100 = 1%) |

- Solo puede llamarla el `owner` (wallet que desplegó el contrato).
- Los tokens comprados se quedan en el contrato (no se envían al owner).
- Revierte si el contrato no tiene suficiente ETH o si no hay liquidez en ningún protocolo.

#### `sellToken(address token, uint256 sellBps, uint256 slippageBps)`

Vende un porcentaje del balance de `token` que tiene el contrato, a cambio de ETH. El ETH obtenido **queda en el contrato**.

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `token` | `address` | Address del token ERC-20 a vender |
| `sellBps` | `uint256` | Porcentaje del balance a vender en basis points (10000 = 100%) |
| `slippageBps` | `uint256` | Slippage máximo en basis points |

- El ETH resultante queda en el contrato; usa `withdraw()` para recuperarlo.
- `sellBps: 5000` vende el 50% del balance actual del contrato de ese token.

#### `withdraw()`

Transfiere todo el saldo ETH del contrato a la wallet del owner.

#### `withdrawToken(address token)`

Transfiere todo el saldo de `token` del contrato a la wallet del owner.

#### `receive() external payable`

Permite que el contrato reciba ETH directamente (transferencias y `send`/`transfer`).

### Lógica de routing de pools (V4 → V3 → V2)

Para cada operación, el contrato detecta automáticamente qué versión de Uniswap usar, probando en orden de eficiencia:

```
Para el par WETH ↔ token:

Compra (buyToken):
1. Intenta V4: busca pool en PoolManager con fee 500/3000/10000 → si tiene liquidez → usa V4
2. Si V4 falla o sin liquidez → intenta V3: fee 500 → 3000 → 10000
3. Si ningún V3 tiene liquidez → verifica que exista par V2
4. Usa V2 con swapExactETHForTokensSupportingFeeOnTransferTokens (compatible con tax tokens)
5. Si tampoco hay par V2 → revierte

Venta (sellToken):
1. Intenta V4 → si falla (try/catch) → continúa
2. Intenta V3 → si falla (try/catch) → continúa
3. Usa V2 con swapExactTokensForETHSupportingFeeOnTransferTokens (compatible con tax tokens)
```

> Las funciones `_sellV3` y `_sellV4` son `external` con `require(msg.sender == address(this))` para permitir el patrón `try this._sellV3(...) catch {}` — sin esto Solidity no puede envolver llamadas internas en try/catch.

### Soporte de fee-on-transfer (tax tokens)

Todos los swaps V2 usan las variantes `SupportingFeeOnTransferTokens`:
- `swapExactETHForTokensSupportingFeeOnTransferTokens` para compras
- `swapExactTokensForETHSupportingFeeOnTransferTokens` para ventas

Esto permite operar con tokens que aplican una comisión en cada transferencia (p.ej. tokens con 5-10% tax). Los swaps V3 y V4 pueden fallar para estos tokens en ventas; el fallback a V2 los gestiona correctamente.

### Cálculo de minOutput

El contrato calcula el output mínimo aceptable antes de cada swap:

- **Uniswap V4**: usa el `sqrtPriceX96` del pool para precio spot aproximado.
- **Uniswap V3**: usa el `sqrtPriceX96` del pool (`slot0`) para calcular el precio spot. Es una aproximación que no tiene en cuenta el price impact — adecuada para trades de tamaño moderado.
- **Uniswap V2**: usa balance diff (diferencia de balance antes/después) para medir el output real. El `amountOutMin` se pasa a `0` en compras con tax tokens para que no revierta.

Sobre el precio calculado se aplica el slippage:

```
minOutput = precioEsperado × (10000 − slippageBps) / 10000
```

### Reentrancy guard

Las cuatro funciones públicas (`buyToken`, `sellToken`, `withdraw`, `withdrawToken`) están protegidas con un guard `nonReentrant` basado en una variable de storage `_locked`. El `unlockCallback` de V4 queda fuera intencionadamente (el PoolManager necesita re-entrar durante el flash accounting).

### Eventos emitidos

```solidity
event TokenBought(
  address indexed token,
  uint256 ethSpent,
  uint256 tokensReceived,
  uint8 version,    // 4 = V4, 3 = V3, 2 = V2
  uint24 feeTier
);

event TokenSold(
  address indexed token,
  uint256 tokensSold,
  uint256 ethReceived,
  uint8 version,    // 4 = V4, 3 = V3, 2 = V2
  uint24 feeTier
);
```

---

## Módulo Node.js — src/trader.js

Encapsula toda la lógica de conexión web3 y sirve como capa de abstracción entre `index.js`, los scripts de prueba y el contrato.

### ABI utilizado

```js
const TRADER_ABI = [
  'function buyToken(uint256 ethAmount, address token, uint256 slippageBps) external',
  'function sellToken(address token, uint256 sellBps, uint256 slippageBps) external',
  'function withdraw() external',
  'function withdrawToken(address token) external',
  'event TokenBought(address indexed token, uint256 ethSpent, uint256 tokensReceived, uint8 version, uint24 feeTier)',
  'event TokenSold(address indexed token, uint256 tokensSold, uint256 ethReceived, uint8 version, uint24 feeTier)',
];
```

### `buildProvider()`

Crea y devuelve el proveedor RPC, la wallet y el contrato a partir de las variables de entorno.

```js
const { buildProvider } = require('./src/trader');
const { provider, wallet, contract } = buildProvider();
```

**Lanza error si:** falta `INFURA_API_KEY`, `PRIVATE_KEY` o `CONTRACT_ADDRESS`.

### `executeBuy(opts)`

```js
const { executeBuy } = require('./src/trader');

// Opción A: a partir de un href de DexScreener (modo bot)
await executeBuy({
  chain:       'base',
  pairHref:    '/base/0xAbc123...',
  ethPerTrade: 0.05,   // ETH, no wei
  slippageBps: 200,    // 2%
});

// Opción B: con address de token directa (modo test / manual)
await executeBuy({
  chain:        'base',
  tokenAddress: '0xAbC123...',   // omite la llamada a DexScreener
  ethPerTrade:  0.05,
  slippageBps:  200,
});
```

**Retorna:**
```js
{
  tokenAddress: '0xAbC...',   // address checksummed del token comprado
  txHash:       '0x1a2b...',  // hash de la transacción
  ethSpent:     '0.05',       // ETH gastados (string formateado)
}
```

### `executeSell(opts)`

```js
const { executeSell } = require('./src/trader');

await executeSell({
  tokenAddress: '0xAbC123...',
  sellBps:      10000,  // 100% del balance del contrato
  slippageBps:  300,
});
```

**Retorna:** `{ tokenAddress, txHash }`

### `executeWithdraw()`

Retira todo el ETH del contrato a la wallet owner.

```js
const { executeWithdraw } = require('./src/trader');
const { txHash } = await executeWithdraw();
```

### `executeWithdrawToken(opts)`

Retira todos los tokens de un tipo del contrato a la wallet owner.

```js
const { executeWithdrawToken } = require('./src/trader');
const { txHash } = await executeWithdrawToken({ tokenAddress: '0xAbC...' });
```

---

## Scripts de prueba — atomic-test/

Scripts standalone para probar las funciones del contrato directamente, sin pasar por el bot de scraping. Todos usan `src/trader.js` internamente.

```bash
# Variables de entorno necesarias (del .env raíz):
INFURA_API_KEY, PRIVATE_KEY, CONTRACT_ADDRESS
```

### `atomic-test/buy.js` — Comprar tokens con ETH

```bash
node atomic-test/buy.js --token <address> --eth <amount> --slippage <bps>

# Ejemplos:
node atomic-test/buy.js --token 0xAbc... --eth 0.001 --slippage 300
node atomic-test/buy.js --token 0xAbc... --eth 0.01  --slippage 100
```

| Parámetro | Descripción |
|-----------|-------------|
| `--token` | Dirección del token ERC-20 a comprar |
| `--eth` | ETH a gastar (en ETH, no wei) |
| `--slippage` | Slippage máximo en basis points (300 = 3%) |

### `atomic-test/sell.js` — Vender tokens por ETH

```bash
node atomic-test/sell.js --token <address> --sell <bps> --slippage <bps>

# Ejemplos:
node atomic-test/sell.js --token 0xAbc... --sell 10000 --slippage 300  # 100%
node atomic-test/sell.js --token 0xAbc... --sell 5000  --slippage 300  # 50%
```

| Parámetro | Descripción |
|-----------|-------------|
| `--token` | Dirección del token ERC-20 a vender |
| `--sell` | Porcentaje del balance a vender en bps (10000 = 100%) |
| `--slippage` | Slippage máximo en basis points |

### `atomic-test/withdraw.js` — Retirar fondos al owner

```bash
# Retirar todo el ETH del contrato a tu wallet
node atomic-test/withdraw.js

# Retirar todos los tokens de un tipo
node atomic-test/withdraw.js --token 0xAbc...
```

### Flujo de prueba completo

```bash
# 1. Fondear el contrato con ETH desde MetaMask u otra wallet
#    (enviar ETH a CONTRACT_ADDRESS)

# 2. Comprar tokens
node atomic-test/buy.js --token 0xAbc... --eth 0.001 --slippage 300

# 3. Vender los tokens
node atomic-test/sell.js --token 0xAbc... --sell 10000 --slippage 300

# 4. Retirar el ETH a tu wallet
node atomic-test/withdraw.js
```

---

## Configuración por estrategia

Tres campos opcionales en `configs/config.<id>.json` controlan el comportamiento de trading:

```json
{
  "dryRun":      false,
  "ethPerTrade": 0.05,
  "slippageBps": 200
}
```

| Campo | Tipo | Default | Descripción |
|-------|------|---------|-------------|
| `dryRun` | boolean | `false` | `true` → solo notifica, no opera. `false` → ejecuta compra real. El default es **false**: si no se especifica, el bot opera. |
| `ethPerTrade` | number | `0.01` | ETH a gastar por cada token nuevo detectado. En unidades ETH (no wei). |
| `slippageBps` | number | `300` | Slippage máximo en basis points. `300` = 3%, `100` = 1%, `500` = 5%. |

> El campo `dryRun` es `false` por defecto de forma deliberada: si no se define en el config, el bot **opera en real**. Para pruebas siempre añadir explícitamente `"dryRun": true`.

### Ejemplos por perfil de riesgo

**Conservador** — slippage bajo, importe pequeño:
```json
{
  "dryRun": false,
  "ethPerTrade": 0.01,
  "slippageBps": 150
}
```

**Agresivo** — slippage más amplio para tokens con menor liquidez:
```json
{
  "dryRun": false,
  "ethPerTrade": 0.05,
  "slippageBps": 500
}
```

**Solo alertas** — nunca opera:
```json
{
  "dryRun": true
}
```

---

## Variables de entorno

Añadir al fichero `.env` (basarse en `.env.example`):

```env
# API key de Infura → https://app.infura.io
# Endpoint usado: https://base-mainnet.infura.io/v3/{INFURA_API_KEY}
INFURA_API_KEY=tu_api_key_aqui

# Clave privada de la wallet owner del contrato
# Debe ser la misma wallet que desplegó UniswapTrader
# ⚠️  Nunca la subas a git ni la compartas
PRIVATE_KEY=0xtu_clave_privada_aqui

# Address del contrato UniswapTrader ya desplegado en Base
CONTRACT_ADDRESS=0xtu_contrato_aqui
```

Las tres variables son requeridas en tiempo de ejecución solo cuando alguna estrategia tiene `dryRun: false`. Si todas las estrategias están en dry run, el bot arranca sin ellas.

---

## Despliegue del contrato

El contrato `solidity/UniswapTrader.sol` debe compilarse y desplegarse antes de activar `dryRun: false` en cualquier estrategia.

> **Gas recomendado:** mínimo **3,000,000 gas** para el despliegue. Con menos gas la tx puede completarse sin errores de red pero el contrato quedará sin código (out of gas durante la creación), lo que hace que las llamadas posteriores no hagan nada silenciosamente.

### Con Remix IDE (más sencillo)

1. Abre [remix.ethereum.org](https://remix.ethereum.org) y sube `UniswapTrader.sol`
2. Compila con Solidity `^0.8.24`
3. En **Deploy & Run Transactions**:
   - Environment: **Injected Provider - MetaMask**
   - Network: Base Mainnet en MetaMask
   - Gas limit: **3000000**
4. Despliega y copia la address del contrato

### Con Foundry

```bash
# 1. Instalar Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# 2. Desplegar en Base Mainnet
forge create solidity/UniswapTrader.sol:UniswapTrader \
  --rpc-url https://base-mainnet.infura.io/v3/TU_INFURA_KEY \
  --private-key TU_PRIVATE_KEY \
  --gas-limit 3000000

# La address del contrato desplegado aparece en la salida:
# "Deployed to: 0x..."
```

### Tras el despliegue

1. Copia la address del contrato a `.env` → `CONTRACT_ADDRESS=0x...`
2. **Envía ETH al contrato** desde la wallet owner:
   ```
   Destino: CONTRACT_ADDRESS
   Importe: el ETH que quieras que opere (ej. 0.1 ETH)
   ```
3. El contrato ya está listo. Cada `buyToken` descuenta de ese saldo.

---

## Flujo de ejecución detallado

```
index.js detecta par nuevo
│
├─ dryRun: true
│   └─ Telegram: "🚨 par detectado [DRY RUN]" → history guardado
│
└─ dryRun: false
    │
    ├─ trader.js: pairAddressFromHref(pair.href)
    │   └─ extrae "0xAbc..." del path "/base/0xAbc..."
    │
    ├─ trader.js: fetchTokenAddress('base', '0xAbc...')
    │   └─ GET api.dexscreener.com/latest/dex/pairs/base/0xAbc...
    │       └─ retorna baseToken.address
    │
    ├─ trader.js: conecta ethers.JsonRpcProvider (Infura / Base)
    │
    ├─ trader.js: verifica contractBalance >= ethAmountWei
    │   └─ si no hay ETH → lanza error → Telegram: "❌ Compra fallida: sin ETH"
    │
    ├─ trader.js: contract.buyToken(ethAmountWei, tokenAddress, slippageBps)
    │   │
    │   └─ UniswapTrader.sol:
    │       ├─ Intenta V4: _bestV4Pool() → swap vía PoolManager unlock/callback
    │       │   └─ si falla (try/catch) → continúa con V3
    │       ├─ Intenta V3: _bestV3Fee() → fee 500→3000→10000
    │       │   ├─ si V3 encontrado:
    │       │   │   ├─ _v3SpotAmountOut() → precio spot via sqrtPriceX96
    │       │   │   ├─ minOut = expectedOut × (10000 - slippageBps) / 10000
    │       │   │   └─ V3_ROUTER.exactInputSingle{value: ethAmount}(...)
    │       │   └─ si falla → continúa con V2
    │       └─ Usa V2:
    │           ├─ require(getPair(WETH, token) != address(0)) → revierte si no existe
    │           └─ V2_ROUTER.swapExactETHForTokensSupportingFeeOnTransferTokens(...)
    │               └─ tokens quedan en el contrato
    │
    ├─ tx.wait() → receipt con txHash
    │
    ├─ Telegram: "✅ Compra ejecutada: X ETH | Token: 0x... | Tx: 0x..."
    │
    └─ history: { ...pair, buyOk: true, txHash, dryRun: false }
```

---

## Gestión de fondos

### Depositar ETH en el contrato

Enviar ETH directamente a `CONTRACT_ADDRESS` desde MetaMask u otra wallet, o con cast:

```bash
cast send $CONTRACT_ADDRESS \
  --value 0.1ether \
  --private-key $PRIVATE_KEY \
  --rpc-url https://base-mainnet.infura.io/v3/$INFURA_API_KEY
```

### Retirar ETH del contrato

```bash
# Con el script de prueba
node atomic-test/withdraw.js

# Con cast
cast send $CONTRACT_ADDRESS "withdraw()" \
  --private-key $PRIVATE_KEY \
  --rpc-url https://base-mainnet.infura.io/v3/$INFURA_API_KEY
```

### Retirar tokens del contrato

Los tokens comprados quedan en el contrato hasta que se vendan o se retiren.

```bash
# Con el script de prueba
node atomic-test/withdraw.js --token 0xAbC...

# Con cast
cast send $CONTRACT_ADDRESS "withdrawToken(address)" 0xAbC... \
  --private-key $PRIVATE_KEY \
  --rpc-url https://base-mainnet.infura.io/v3/$INFURA_API_KEY
```

### Consultar saldo ETH del contrato

```bash
cast balance $CONTRACT_ADDRESS \
  --rpc-url https://base-mainnet.infura.io/v3/$INFURA_API_KEY \
  --ether
```

---

## Seguridad

### Custodia de la clave privada

- `PRIVATE_KEY` en `.env` **nunca debe commitearse a git**. El `.gitignore` debe excluir `.env`.
- La clave privada expuesta permite vaciar el contrato y la wallet. Trátala como una contraseña de banco.
- En producción considera usar un HSM o un servicio de gestión de secrets (AWS Secrets Manager, Doppler, etc.).

### Restricciones del contrato

- `buyToken`, `sellToken`, `withdraw` y `withdrawToken` son `onlyOwner`: solo la wallet que desplegó el contrato puede llamarlos.
- Todas las funciones públicas tienen protección `nonReentrant` (guard con variable de storage `_locked`).
- El contrato no tiene funciones `admin` ni `upgradeable`: lo que se despliega es inmutable.
- El contrato solo envía fondos al `owner` hardcodeado en el constructor. Ninguna llamada puede redirigir fondos a otra dirección.

### Riesgos operativos

| Riesgo | Mitigación |
|--------|------------|
| Token sin liquidez o rugpull | El routing prueba V4→V3→V2; si ninguno tiene liquidez, la tx revierte |
| Fee-on-transfer token | V2 usa variantes `SupportingFeeOnTransferTokens`; V3/V4 caen a V2 vía try/catch |
| Slippage excesivo en token muy volátil | Ajustar `slippageBps` por estrategia. Default 300 (3%) |
| Precio spot desviado del real (V3/V4) | La aproximación via sqrtPriceX96 no incluye price impact. Para trades grandes, ampliar slippage |
| Contrato sin ETH suficiente | `trader.js` verifica el saldo antes de enviar la tx; lanza error legible |
| Contrato desplegado sin código | Asegurarse de usar mínimo 3,000,000 gas en el despliegue |
| Múltiples estrategias comprando el mismo token | Cada estrategia tiene su propio historial: puede haber compras duplicadas si el mismo par aparece en varias configs simultáneamente |
