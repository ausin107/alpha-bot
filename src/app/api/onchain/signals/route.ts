import { getLargeTokenTransfers, getMoralisChain } from '@/lib/onchain-monitor';

export const dynamic = 'force-dynamic';

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address')?.trim() ?? '';
  const chain = getMoralisChain(searchParams.get('chain') ?? '');
  const requestedPrice = Number(searchParams.get('price'));
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const fromDate = searchParams.get('from_date') ?? undefined;
  const toDate = searchParams.get('to_date') ?? undefined;
  const startBlock = searchParams.get('start_block') ?? undefined;
  const endBlock = searchParams.get('end_block') ?? undefined;

  if (!EVM_ADDRESS.test(address) || !chain) {
    return Response.json(
      { success: false, error: 'A supported EVM contract address and chain (eth, bsc, or base) are required.' },
      { status: 400 },
    );
  }

  try {
    const data = await getLargeTokenTransfers({
      address,
      chain,
      fallbackUsdPrice: Number.isFinite(requestedPrice) && requestedPrice > 0 ? requestedPrice : 0,
      page,
      fromDate,
      toDate,
      startBlock,
      endBlock,
    });
    return Response.json({ success: true, thresholdUsd: 100_000, ...data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to retrieve on-chain signals.';
    const status = message.includes('ETHERSCAN_API_KEY') ? 503 : 502;
    return Response.json({ success: false, error: message }, { status });
  }
}
