# Tempo Receipt Checker

Paste a transaction hash from **Tempo Moderato testnet** and get a plain-English payment receipt: who paid whom,
in which stablecoin, what the memo says, and which token covered the network fee.

🔗 **Live app:** _published on GitHub Pages — see repository "About" link_
🔗 **Try it now:** open `docs/index.html?tx=0x413b6983673912c1e6e70b33387451298b18e38741457dffbffcc4c31d8f1107`

![Payment receipt with memo](screenshots/01-payment-memo.png)

## Why this exists

Tempo is a payments-first L1 (incubated by Stripe and Paradigm) built for stablecoin settlement at enterprise
scale. Two things make it unlike every other EVM chain:

1. **No native gas token.** Fees are paid directly in a stablecoin (PathUSD, AlphaUSD, BetaUSD, ThetaUSD, …), and
   the fee payer can be a different address than the sender — a merchant can sponsor the receiver's gas.
2. **Built-in payment memos.** TIP-20 tokens (Tempo's ERC-20 extension) support `transferWithMemo`, which attaches
   a 32-byte memo to the transfer as part of the `TransferWithMemo` event — a native invoice/order ID, on-chain,
   without a side database.

A block explorer shows you raw logs. This tool reads the same data and turns it into the thing a merchant, a
marketplace, or their accountant actually wants: **"did this specific payment arrive, for how much, referencing
which invoice, and who paid the fee?"**

## Who it's for

A merchant or marketplace accepting stablecoin payments on Tempo (think a DoorDash-style platform), or their
customer/accountant, who has a transaction hash and needs a verifiable, human-readable receipt instead of a
screenshot of a block explorer.

## How it works

1. Paste a tx hash (or open a `?tx=0x...` link a merchant sent you).
2. The page calls the official public RPC (`rpc.moderato.tempo.xyz`) directly from your browser:
   `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getBlockByNumber("finalized")`.
3. It decodes the receipt's logs:
   - finds the `TransferWithMemo` event (if any) and shows the amount, token, sender, recipient and memo
     (attempted as text, always shown as hex);
   - finds the fee transfer (a plain `Transfer` to Tempo's fee-collector address, in `receipt.feeToken`) and shows
     the fee amount, token and who actually paid it;
   - if there's no recognized stablecoin transfer (e.g. a DEX order or a plain contract call), it says so plainly
     instead of pretending there was a payment.
4. Unknown TIP-20 tokens are looked up live via `symbol()`/`decimals()` — nothing is hardcoded beyond the five
   tokens confirmed live on Moderato (see below), and anything else is labeled "unverified token".

No wallet connect, no signing, no backend, no API key — a static page calling a public JSON-RPC endpoint that
sends `Access-Control-Allow-Origin: *` (verified live).

## Data sources

- RPC: `https://rpc.moderato.tempo.xyz` (chain id `42431`, confirmed via `eth_chainId`)
- Explorer links: `https://explore.testnet.tempo.xyz/tx/{hash}` and `/address/{address}` (Blockscout-based)
- Token registry, event signatures and the fee-collector address below were all derived by directly reading
  thousands of real logs on Moderato — not from secondary sources:

| Token | Address | Decimals |
|---|---|---|
| PathUSD | `0x20c0000000000000000000000000000000000000` | 6 |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` | 6 |
| BetaUSD | `0x20c0000000000000000000000000000000000002` | 6 |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` | 6 |
| OUSD (OpenUSD) | `0x20c0000000000000000000006a37da5c996874be` | 6 |

- `TransferWithMemo(address,address,uint256,bytes32)` — topic0 `0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0`
- Fee collector address: `0xfeec000000000000000000000000000000000000`
- Every Tempo receipt carries `feeToken` and `feePayer` fields regardless of transaction type (`0x0`/`0x2` legacy or
  `0x76` Tempo-native sponsored calls) — confirmed on multiple live receipts.

## Running locally

No build step. Open `docs/index.html` directly in a browser, or serve the `docs/` folder with any static file
server:

```
npx serve docs
```

## Honest limitations

- Only reads a single transaction at a time — no address history / activity feed.
- Memo is shown as hex always; a readable-text guess is shown only when every byte is printable ASCII. Most memos
  observed on testnet today are opaque test bytes, not text — that's normal, not a bug (see the BetaUSD example
  below for a real readable one).
- Cannot verify TIP-403 transfer-policy details specifically — a failed transaction is shown as "Failed" without
  guessing why it reverted.
- Token symbols/decimals for anything outside the five tokens above are fetched live via `eth_call`; if that call
  reverts, the token is shown by address only.
- Built and tested against Tempo **Moderato testnet** only. Do not point this at Tempo mainnet — that is live
  enterprise money, out of scope for this prototype.
- Built by one person with AI assistance (Claude).

## Try it with real transactions

The app ships with five real, verified example transactions (buttons under the input):

- Payment + memo, PathUSD (sponsored fee)
- Payment + memo, BetaUSD (readable memo text, fee paid in a *different* token than the payment)
- Faucet mint (1,000,000 PathUSD)
- A DEX order that moves no plain stablecoin transfer (shows the tool being honest about what it can't find)
- A plain contract call with only a fee, no payment at all

## Screenshots

| | |
|---|---|
| ![memo payment](screenshots/01-payment-memo.png) | ![faucet mint](screenshots/02-faucet-mint.png) |
| ![dex order](screenshots/03-dex-swap.png) | ![no payment](screenshots/04-no-payment.png) |
| ![readable memo, cross-token fee](screenshots/09-betausd.png) | ![mobile](screenshots/08-mobile.png) |
