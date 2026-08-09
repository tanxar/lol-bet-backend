const {
  listPendingDeposits,
  completeDeposit,
  markDepositStatus,
  expireStaleDeposits,
  isTxHashUsed,
  roundUsdt,
  creditWalletDeposit
} = require('./ledger');
const { listAllWallets } = require('./wallets');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usdtFromChainValue(value) {
  const raw = typeof value === 'string' ? value : String(value ?? '0');
  return roundUsdt(Number(raw) / 1_000_000);
}

function isRateLimitError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return message.includes('429') || message.includes('rate limit') || message.includes('too many');
}

async function fetchTrc20Transfers(config, depositAddress, minTimestamp) {
  if (!depositAddress) return [];

  const url = new URL(
    `https://api.trongrid.io/v1/accounts/${depositAddress}/transactions/trc20`
  );
  url.searchParams.set('limit', '50');
  url.searchParams.set('contract_address', config.usdtContract);
  url.searchParams.set('only_to', 'true');
  if (minTimestamp) {
    url.searchParams.set('min_timestamp', String(minTimestamp));
  }

  const headers = { Accept: 'application/json' };
  if (config.tronGridApiKey) {
    headers['TRON-PRO-API-KEY'] = config.tronGridApiKey;
  }

  const maxAttempts = Math.max(1, config.tronGridRetryMaxAttempts ?? 3);
  const baseDelayMs = Math.max(1000, config.tronGridRetryBaseMs ?? 4000);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, { headers });
    if (response.ok) {
      const payload = await response.json();
      return Array.isArray(payload.data) ? payload.data : [];
    }

    const body = await response.text();
    const rateLimited = response.status === 429 || isRateLimitError(body);
    if (rateLimited && attempt < maxAttempts) {
      const retryAfterHeader = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : baseDelayMs * attempt;
      console.warn(`[deposit] TronGrid rate limited (${response.status}), retry in ${delayMs}ms`);
      await sleep(delayMs);
      continue;
    }

    throw new Error(`TronGrid ${response.status}: ${body.slice(0, 200)}`);
  }

  return [];
}

function amountsMatch(expected, received) {
  return Math.abs(roundUsdt(expected) - roundUsdt(received)) <= 0.000001;
}

async function processUserWalletDeposits(db, config) {
  const wallets = await listAllWallets(db);
  if (wallets.length === 0) {
    return { scanned: 0, matched: 0, wallets: 0 };
  }

  let matched = 0;
  for (const wallet of wallets) {
    const createdAtMs = new Date(wallet.createdAt).getTime();
    const minTimestamp = Number.isFinite(createdAtMs) ? createdAtMs - 60_000 : undefined;
    let transfers;
    try {
      transfers = await fetchTrc20Transfers(config, wallet.depositAddress, minTimestamp);
    } catch (err) {
      console.warn(
        `[deposit] Failed to scan wallet ${wallet.depositAddress} (${wallet.summoner}): ${err.message}`
      );
      continue;
    }

    for (const transfer of transfers) {
      if (!transfer || transfer.to !== wallet.depositAddress) continue;

      const txHash = transfer.transaction_id;
      if (!txHash || await isTxHashUsed(db, txHash)) continue;

      const receivedAmountUsdt = usdtFromChainValue(transfer.value);
      const result = await creditWalletDeposit(db, config, {
        summoner: wallet.summoner,
        txHash,
        receivedAmountUsdt,
        depositAddress: wallet.depositAddress
      });

      if (result.credited) {
        matched += 1;
        console.log(
          `[deposit] Credited ${result.amount} USDT to ${wallet.summoner} (${wallet.depositAddress}) tx ${txHash}`
        );
      }
    }
  }

  return { scanned: wallets.length, matched, wallets: wallets.length };
}

async function processPendingDeposits(db, config) {
  await expireStaleDeposits(db);
  const walletResult = await processUserWalletDeposits(db, config);

  const pending = await listPendingDeposits(db);
  if (pending.length === 0) {
    return { ...walletResult, pending: 0 };
  }

  let matched = walletResult.matched ?? 0;
  for (const deposit of pending) {
    if (deposit.status !== 'pending' && deposit.status !== 'confirming') continue;

    const createdAtMs = new Date(deposit.createdAt).getTime();
    let transfers;
    try {
      transfers = await fetchTrc20Transfers(config, deposit.depositAddress, createdAtMs - 60_000);
    } catch (err) {
      console.warn(`[deposit] Failed pending scan for ${deposit.id}: ${err.message}`);
      continue;
    }

    const candidate = transfers.find((transfer) => {
      if (!transfer || transfer.to !== deposit.depositAddress) return false;
      if ((transfer.block_timestamp ?? 0) < createdAtMs - 5_000) return false;

      const received = usdtFromChainValue(transfer.value);
      return amountsMatch(deposit.expectedAmountUsdt, received);
    });

    if (!candidate) continue;

    const txHash = candidate.transaction_id;
    if (!txHash || await isTxHashUsed(db, txHash)) continue;

    const receivedAmountUsdt = usdtFromChainValue(candidate.value);
    await markDepositStatus(db, deposit.id, {
      status: 'confirming',
      txHash,
      receivedAmountUsdt
    });

    await completeDeposit(db, deposit, { txHash, receivedAmountUsdt });
    matched += 1;
    console.log(
      `[deposit] Completed pending ${deposit.id} for ${deposit.summoner}: ${receivedAmountUsdt} USDT (${txHash})`
    );
  }

  return {
    scanned: walletResult.scanned,
    matched,
    wallets: walletResult.wallets,
    pending: pending.length
  };
}

function startDepositMonitor(db, config) {
  const activeIntervalMs = Math.max(15_000, config.depositMonitorActiveIntervalMs ?? config.depositMonitorIntervalMs ?? 30_000);
  const idleIntervalMs = Math.max(activeIntervalMs, config.depositMonitorIdleIntervalMs ?? 90_000);
  let timer = null;
  let backoffUntil = 0;

  console.log(
    `USDT TRC-20 monitor enabled for per-user wallets (active ${activeIntervalMs}ms, idle ${idleIntervalMs}ms)`
  );

  const scheduleNext = (delayMs) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runTick, Math.max(1000, delayMs));
  };

  const runTick = async () => {
    const now = Date.now();
    if (now < backoffUntil) {
      scheduleNext(backoffUntil - now);
      return;
    }

    try {
      const result = await processPendingDeposits(db, config);
      if (result.matched > 0) {
        console.log(`[deposit] Monitor credited ${result.matched} deposit(s)`);
      }
      const hasWork = (result.wallets ?? 0) > 0 || (result.pending ?? 0) > 0;
      scheduleNext(hasWork ? activeIntervalMs : idleIntervalMs);
    } catch (err) {
      const delayMs = isRateLimitError(err)
        ? Math.max(5000, (config.tronGridRetryBaseMs ?? 4000) * 2)
        : activeIntervalMs;
      backoffUntil = Date.now() + delayMs;
      console.error(`[deposit] Monitor tick failed: ${err.message} — retry in ${delayMs}ms`);
      scheduleNext(delayMs);
    }
  };

  runTick();
  return timer;
}

module.exports = {
  startDepositMonitor,
  processPendingDeposits,
  processUserWalletDeposits,
  fetchTrc20Transfers,
  usdtFromChainValue
};
