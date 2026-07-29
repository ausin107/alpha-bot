import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CACHE_PATH = path.join(process.cwd(), 'data', 'moralis-address-label-cache.json');
const KNOWN_LABEL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UNKNOWN_LABEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AddressLabel = {
  label: string | null;
  entity: string | null;
  source: 'moralis';
  updatedAt: string;
  expiresAt: string;
};

type LabelCache = {
  version: 1;
  labels: Record<string, AddressLabel>;
};

let writeQueue = Promise.resolve();

function cacheKey(chainId: number, address: string) {
  return `${chainId}:${address.toLowerCase()}`;
}

async function readCache(): Promise<LabelCache> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as Partial<LabelCache>;
    return { version: 1, labels: parsed.labels ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, labels: {} };
    throw error;
  }
}

async function writeCache(cache: LabelCache) {
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  const temporaryPath = `${CACHE_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, CACHE_PATH);
}

function isFresh(record: AddressLabel, now: number) {
  return Number.isFinite(Date.parse(record.expiresAt)) && Date.parse(record.expiresAt) > now;
}

export async function getCachedAddressLabels(chainId: number, addresses: Iterable<string>) {
  const cache = await readCache();
  const now = Date.now();
  const labels = new Map<string, AddressLabel>();

  for (const address of addresses) {
    const record = cache.labels[cacheKey(chainId, address)];
    if (record && isFresh(record, now)) labels.set(address.toLowerCase(), record);
  }

  return labels;
}

export async function saveAddressLabels(
  chainId: number,
  updates: Iterable<{ address: string; label?: string | null; entity?: string | null }>,
) {
  const materializedUpdates = [...updates];
  if (materializedUpdates.length === 0) return;

  const task = writeQueue.then(async () => {
    const cache = await readCache();
    const now = new Date();

    for (const update of materializedUpdates) {
      const label = update.label?.trim() || null;
      const entity = update.entity?.trim() || null;
      const ttl = label || entity ? KNOWN_LABEL_TTL_MS : UNKNOWN_LABEL_TTL_MS;
      cache.labels[cacheKey(chainId, update.address)] = {
        label,
        entity,
        source: 'moralis',
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl).toISOString(),
      };
    }

    await writeCache(cache);
  });

  writeQueue = task.catch(() => undefined);
  await task;
}
