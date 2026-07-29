import { getCachedAddressLabels, saveAddressLabels, type AddressLabel } from '@/lib/address-label-cache';

const ETHERSCAN_BASE_URL = 'https://api.etherscan.io/v2/api';
const MORALIS_BASE_URL = 'https://deep-index.moralis.io/api/v2.2';
const TRANSFER_PAGE_SIZE = 1_000;
const TRANSFER_WINDOW_DAYS = 3;
const MAX_MORALIS_LABEL_LOOKUPS_PER_PAGE = 20;

const CHAIN_CONFIG = {
  eth: { chainId: 1 },
  bsc: { chainId: 56 },
  base: { chainId: 8453 },
} as const;

export const SUPPORTED_CHAINS = new Set(Object.keys(CHAIN_CONFIG));

export type OnchainSignalType = 'EXCHANGE_DEPOSIT' | 'EXCHANGE_WITHDRAWAL' | 'EXCHANGE_INTERNAL' | 'WHALE_TRANSFER';

export type ExchangeFlowPoint = {
  bucket: string;
  depositsUsd: number;
  withdrawalsUsd: number;
};

export type OnchainSignal = {
  id: string;
  type: OnchainSignalType;
  timestamp: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  fromLabel: string | null;
  toLabel: string | null;
  fromEntity: string | null;
  toEntity: string | null;
  amount: number;
  amountUsd: number;
  repeatedRouteCount: number;
};

type EtherscanTransfer = {
  hash: string;
  timeStamp?: string;
  blockNumber?: string;
  logIndex: string;
  from: string;
  to: string;
  value: string;
  tokenDecimal: string;
};


type EtherscanResponse = {
  status: string;
  message: string;
  result: string | EtherscanTransfer[];
};

type MoralisTransaction = {
  from_address?: string;
  to_address?: string | null;
  from_address_label?: string | null;
  to_address_label?: string | null;
  from_address_entity?: string | null;
  to_address_entity?: string | null;
};

const EXCHANGE_PATTERN = /binance|coinbase|kraken|okx|bybit|bitget|kucoin|gate\.io|crypto\.com|mexc|htx|huobi|upbit|bithumb/i;

function isExchange(label: string | null | undefined, entity: string | null | undefined) {
  return EXCHANGE_PATTERN.test(`${label ?? ''} ${entity ?? ''}`);
}

function amountFromRaw(value: string, decimals: string) {
  const decimalPlaces = Number(decimals);
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || !/^\d+$/.test(value)) return 0;
  const digits = value.replace(/^0+/, '') || '0';
  if (decimalPlaces === 0) return Number(digits);
  const padded = digits.padStart(decimalPlaces + 1, '0');
  const whole = padded.slice(0, -decimalPlaces);
  const fraction = padded.slice(-decimalPlaces, -decimalPlaces + Math.min(decimalPlaces, 8));
  return Number(`${whole}.${fraction || '0'}`);
}

function labelFor(labels: Map<string, AddressLabel>, address: string) {
  return labels.get(address.toLowerCase()) ?? null;
}

function classifyTransfer(from: AddressLabel | null, to: AddressLabel | null): OnchainSignalType {
  const fromExchange = isExchange(from?.label, from?.entity);
  const toExchange = isExchange(to?.label, to?.entity);
  if (fromExchange && toExchange) return 'EXCHANGE_INTERNAL';
  if (toExchange) return 'EXCHANGE_DEPOSIT';
  if (fromExchange) return 'EXCHANGE_WITHDRAWAL';
  return 'WHALE_TRANSFER';
}

function parseDate(value: string | undefined, fallback: Date) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function timestampToIso(timestamp: string) {
  const numeric = Number(timestamp);
  return Number.isFinite(numeric) ? new Date(numeric * 1_000).toISOString() : new Date().toISOString();
}

async function etherscanRequest(params: Record<string, string>) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error('ETHERSCAN_API_KEY is not configured. Add it to .env.local and restart the dev server.');
  const query = new URLSearchParams({ ...params, apikey: apiKey });
  const response = await fetch(`${ETHERSCAN_BASE_URL}?${query}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Etherscan request failed (${response.status}).`);
  return (await response.json()) as EtherscanResponse;
}

async function blockAtTimestamp(chainId: number, timestamp: number) {
  const payload = await etherscanRequest({ chainid: String(chainId), module: 'block', action: 'getblocknobytime', timestamp: String(timestamp), closest: 'before' });
  if (payload.status !== '1' || typeof payload.result !== 'string' || !/^\d+$/.test(payload.result)) throw new Error(`Etherscan could not resolve the scan window: ${String(payload.result || payload.message)}.`);
  return payload.result;
}

async function getTransferPage({ chainId, address, page, startBlock, endBlock }: { chainId: number; address: string; page: number; startBlock: string; endBlock: string }) {
  const payload = await etherscanRequest({
    chainid: String(chainId), module: 'account', action: 'tokentx', contractaddress: address, startblock: startBlock, endblock: endBlock, page: String(page), offset: String(TRANSFER_PAGE_SIZE), sort: 'asc',
  });
  if (Array.isArray(payload.result)) return payload.result;
  if (/no transactions found/i.test(String(payload.result)) || /no transactions found/i.test(payload.message)) return [];
  throw new Error(`Etherscan token transfers request failed: ${String(payload.result || payload.message)}.`);
}

async function enrichUncachedLabels({ chain, chainId, signals, labels }: {
  chain: string;
  chainId: number;
  signals: Array<{ txHash: string; fromAddress: string; toAddress: string; amountUsd: number }>;
  labels: Map<string, AddressLabel>;
}) {
  const missingSignals = signals.filter((signal) => !labels.has(signal.fromAddress.toLowerCase()) || !labels.has(signal.toAddress.toLowerCase())).sort((left, right) => right.amountUsd - left.amountUsd).slice(0, MAX_MORALIS_LABEL_LOOKUPS_PER_PAGE);
  const apiKey = process.env.MORALIS_API_KEY_2;
  if (missingSignals.length === 0 || !apiKey) return { moralisLookups: 0, labelsLoaded: 0 };

  const updates = new Map<string, { address: string; label: string | null; entity: string | null }>();
  let moralisLookups = 0;
  for (let index = 0; index < missingSignals.length; index += 4) {
    const batch = missingSignals.slice(index, index + 4);
    const results = await Promise.all(batch.map(async (signal) => {
      const response = await fetch(`${MORALIS_BASE_URL}/transaction/${signal.txHash}?chain=${chain}`, { headers: { 'X-API-Key': apiKey }, cache: 'no-store' });
      if (!response.ok) return null;
      moralisLookups += 1;
      return (await response.json()) as MoralisTransaction;
    }));
    for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
      const result = results[resultIndex];
      if (!result) continue;
      const signal = batch[resultIndex];
      for (const address of [signal.fromAddress, signal.toAddress]) {
        if (!labels.has(address.toLowerCase())) updates.set(address.toLowerCase(), { address, label: null, entity: null });
      }
      const candidates = [
        { address: result.from_address, label: result.from_address_label, entity: result.from_address_entity },
        { address: result.to_address, label: result.to_address_label, entity: result.to_address_entity },
      ];
      for (const candidate of candidates) {
        if (!candidate.address) continue;
        const lowerAddress = candidate.address.toLowerCase();
        if (lowerAddress !== signal.fromAddress.toLowerCase() && lowerAddress !== signal.toAddress.toLowerCase()) continue;
        updates.set(lowerAddress, { address: candidate.address, label: candidate.label ?? null, entity: candidate.entity ?? null });
      }
    }
  }

  await saveAddressLabels(chainId, updates.values());
  for (const update of updates.values()) labels.set(update.address.toLowerCase(), { label: update.label, entity: update.entity, source: 'moralis', updatedAt: new Date().toISOString(), expiresAt: '' });
  return { moralisLookups, labelsLoaded: updates.size };
}

export function getMoralisChain(chain: string) {
  const normalized = chain.toLowerCase();
  return SUPPORTED_CHAINS.has(normalized) ? normalized : null;
}

export async function getLargeTokenTransfers({ address, chain, thresholdUsd = 100_000, fallbackUsdPrice = 0, fromDate: requestedFromDate, toDate: requestedToDate, page = 1, startBlock: requestedStartBlock, endBlock: requestedEndBlock }: {
  address: string;
  chain: string;
  thresholdUsd?: number;
  fallbackUsdPrice?: number;
  fromDate?: string;
  toDate?: string;
  page?: number;
  startBlock?: string;
  endBlock?: string;
}) {
  const config = CHAIN_CONFIG[chain as keyof typeof CHAIN_CONFIG];
  if (!config) throw new Error('Unsupported EVM chain.');
  const toDate = parseDate(requestedToDate, new Date());
  const fromDate = parseDate(requestedFromDate, new Date(toDate.getTime() - TRANSFER_WINDOW_DAYS * 24 * 60 * 60 * 1_000));
  const resolveBlock = (timestamp: number) => blockAtTimestamp(config.chainId, timestamp);
  const [startBlock, endBlock] = await Promise.all([
    requestedStartBlock && /^\d+$/.test(requestedStartBlock) ? Promise.resolve(requestedStartBlock) : resolveBlock(Math.floor(fromDate.getTime() / 1_000)),
    requestedEndBlock && /^\d+$/.test(requestedEndBlock) ? Promise.resolve(requestedEndBlock) : resolveBlock(Math.floor(toDate.getTime() / 1_000)),
  ]);
  const transferPage = { transfers: await getTransferPage({ chainId: config.chainId, address, page, startBlock, endBlock }), hasNextPage: false };
  const transfers = transferPage.transfers;
  const usdPrice = fallbackUsdPrice > 0 ? fallbackUsdPrice : 0;
  const routeCounts = new Map<string, number>();
  let largestTransferUsd = 0;
  const largeTransfers = transfers.flatMap((transfer) => {
    const amount = amountFromRaw(transfer.value, transfer.tokenDecimal);
    const amountUsd = amount * usdPrice;
    largestTransferUsd = Math.max(largestTransferUsd, Number.isFinite(amountUsd) ? amountUsd : 0);
    if (!Number.isFinite(amountUsd) || amountUsd < thresholdUsd) return [];
    const route = `${transfer.from.toLowerCase()}:${transfer.to.toLowerCase()}`;
    routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
    return [{ ...transfer, amount, amountUsd }];
  });

  const timestampedLargeTransfers: Array<EtherscanTransfer & { amount: number; amountUsd: number }> = largeTransfers;
  const addresses = timestampedLargeTransfers.flatMap((transfer) => [transfer.from, transfer.to]);
  const labels = await getCachedAddressLabels(config.chainId, addresses);
  const enrichment = await enrichUncachedLabels({ chain, chainId: config.chainId, signals: timestampedLargeTransfers.map((transfer) => ({ txHash: transfer.hash, fromAddress: transfer.from, toAddress: transfer.to, amountUsd: transfer.amountUsd })), labels });
  const signals: OnchainSignal[] = timestampedLargeTransfers.map((transfer) => {
    const from = labelFor(labels, transfer.from);
    const to = labelFor(labels, transfer.to);
    const route = `${transfer.from.toLowerCase()}:${transfer.to.toLowerCase()}`;
    return { id: `${transfer.hash}:${transfer.logIndex}`, type: classifyTransfer(from, to), timestamp: timestampToIso(transfer.timeStamp ?? String(Math.floor(toDate.getTime() / 1_000))), txHash: transfer.hash, fromAddress: transfer.from, toAddress: transfer.to, fromLabel: from?.label ?? null, toLabel: to?.label ?? null, fromEntity: from?.entity ?? null, toEntity: to?.entity ?? null, amount: transfer.amount, amountUsd: transfer.amountUsd, repeatedRouteCount: routeCounts.get(route) ?? 1 };
  });

  const flowByBucket = new Map<string, ExchangeFlowPoint>();
  for (const signal of signals) {
    const bucket = new Date(signal.timestamp).toISOString().slice(0, 13);
    const point = flowByBucket.get(bucket) ?? { bucket, depositsUsd: 0, withdrawalsUsd: 0 };
    if (signal.type === 'EXCHANGE_DEPOSIT') point.depositsUsd += signal.amountUsd;
    if (signal.type === 'EXCHANGE_WITHDRAWAL') point.withdrawalsUsd += signal.amountUsd;
    flowByBucket.set(bucket, point);
  }
  const depositsUsd = signals.filter((signal) => signal.type === 'EXCHANGE_DEPOSIT').reduce((sum, signal) => sum + signal.amountUsd, 0);
  const withdrawalsUsd = signals.filter((signal) => signal.type === 'EXCHANGE_WITHDRAWAL').reduce((sum, signal) => sum + signal.amountUsd, 0);
  return {
    signals,
    usdPrice,
    scannedTransfers: transfers.length,
    largestTransferUsd,
    priceSource: usdPrice ? 'binance' : 'unavailable',
    dataProvider: 'etherscan',
    labelProvider: 'moralis-cache',
    labelCache: { cached: addresses.filter((address) => labels.has(address.toLowerCase())).length, loaded: enrichment.labelsLoaded, moralisLookups: enrichment.moralisLookups },
    transferWindow: { fromDate: fromDate.toISOString(), toDate: toDate.toISOString(), days: TRANSFER_WINDOW_DAYS, startBlock, endBlock, fetchedPages: 1, isTruncated: false },
    nextPage: transfers.length === TRANSFER_PAGE_SIZE ? page + 1 : null,
    summary: { depositsUsd, withdrawalsUsd, netExchangeFlowUsd: depositsUsd - withdrawalsUsd, repeatedRoutes: signals.filter((signal) => signal.repeatedRouteCount >= 3).length, flowTimeline: [...flowByBucket.values()].sort((left, right) => left.bucket.localeCompare(right.bucket)) },
  };
}
