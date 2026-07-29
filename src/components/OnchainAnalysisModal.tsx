'use client';

import { useEffect, useMemo, useState } from 'react';

export type OnchainToken = {
  alphaId: string;
  symbol: string;
  name: string;
  contractAddress: string;
  chainId: string;
  price?: number;
};

type SignalType = 'EXCHANGE_DEPOSIT' | 'EXCHANGE_WITHDRAWAL' | 'EXCHANGE_INTERNAL' | 'WHALE_TRANSFER';

type Signal = {
  id: string;
  type: SignalType;
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

type FlowPoint = { bucket: string; depositsUsd: number; withdrawalsUsd: number };
type Response = {
  success: boolean;
  error?: string;
  thresholdUsd?: number;
  usdPrice?: number;
  scannedTransfers?: number;
  largestTransferUsd?: number;
  priceSource?: 'binance' | 'unavailable';
  dataProvider?: 'etherscan';
  labelProvider?: 'moralis-cache';
  labelCache?: { cached: number; loaded: number; moralisLookups: number };
  transferWindow?: { fromDate: string; toDate: string; days: number; startBlock: string; endBlock: string; fetchedPages: number; isTruncated: boolean };
  nextPage?: number | null;
  signals?: Signal[];
  summary?: { depositsUsd: number; withdrawalsUsd: number; netExchangeFlowUsd: number; repeatedRoutes: number; flowTimeline: FlowPoint[] };
};

const CHAIN_BY_ID: Record<string, string> = { '1': 'eth', '56': 'bsc', '8453': 'base' };
const EXPLORER_BY_CHAIN: Record<string, string> = { eth: 'etherscan.io', bsc: 'bscscan.com', base: 'basescan.org' };
const TYPE_LABEL: Record<SignalType, string> = {
  EXCHANGE_DEPOSIT: 'Nạp lên sàn',
  EXCHANGE_WITHDRAWAL: 'Rút từ sàn',
  EXCHANGE_INTERNAL: 'Nội bộ sàn',
  WHALE_TRANSFER: 'Chuyển lớn',
};

function compact(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function walletName(address: string, label: string | null, entity: string | null) {
  return label || entity || shortAddress(address);
}

function signalColor(type: SignalType) {
  if (type === 'EXCHANGE_DEPOSIT') return '#ff7a9d';
  if (type === 'EXCHANGE_WITHDRAWAL') return 'var(--trend-up)';
  return type === 'WHALE_TRANSFER' ? 'var(--primary-cyan)' : 'var(--text-secondary)';
}

function mergePage(current: Response | null, page: Response, pageCount: number): Response {
  if (!current || !current.summary || !page.summary) {
    return {
      ...page,
      transferWindow: page.transferWindow ? { ...page.transferWindow, fetchedPages: pageCount } : undefined,
    };
  }

  const flowByBucket = new Map(current.summary.flowTimeline.map((point) => [point.bucket, { ...point }]));
  for (const point of page.summary.flowTimeline) {
    const existing = flowByBucket.get(point.bucket) ?? { bucket: point.bucket, depositsUsd: 0, withdrawalsUsd: 0 };
    existing.depositsUsd += point.depositsUsd;
    existing.withdrawalsUsd += point.withdrawalsUsd;
    flowByBucket.set(point.bucket, existing);
  }

  return {
    ...page,
    scannedTransfers: (current.scannedTransfers ?? 0) + (page.scannedTransfers ?? 0),
    largestTransferUsd: Math.max(current.largestTransferUsd ?? 0, page.largestTransferUsd ?? 0),
    signals: [...(current.signals ?? []), ...(page.signals ?? [])],
    summary: {
      depositsUsd: current.summary.depositsUsd + page.summary.depositsUsd,
      withdrawalsUsd: current.summary.withdrawalsUsd + page.summary.withdrawalsUsd,
      netExchangeFlowUsd: current.summary.netExchangeFlowUsd + page.summary.netExchangeFlowUsd,
      repeatedRoutes: current.summary.repeatedRoutes + page.summary.repeatedRoutes,
      flowTimeline: [...flowByBucket.values()].sort((left, right) => left.bucket.localeCompare(right.bucket)),
    },
    transferWindow: page.transferWindow ? { ...page.transferWindow, fetchedPages: pageCount } : undefined,
  };
}

function FlowChart({ points }: { points: FlowPoint[] }) {
  const maxValue = Math.max(1, ...points.flatMap((point) => [point.depositsUsd, point.withdrawalsUsd]));
  if (points.length === 0) return <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Chưa có luồng nạp/rút sàn trong tập giao dịch này.</p>;

  return (
    <div style={{ display: 'flex', alignItems: 'end', height: '160px', gap: '6px', overflowX: 'auto', padding: '0.5rem 0 0.25rem' }}>
      {points.map((point) => {
        const label = new Date(`${point.bucket}:00:00.000Z`).toLocaleString('vi-VN', { hour: '2-digit', day: '2-digit', month: '2-digit' });
        return (
          <div key={point.bucket} title={`${label}\nNạp: $${compact(point.depositsUsd)}\nRút: $${compact(point.withdrawalsUsd)}`} style={{ minWidth: '26px', flex: 1, height: '100%', display: 'flex', alignItems: 'end', justifyContent: 'center', gap: '2px' }}>
            <div style={{ width: '9px', minHeight: point.depositsUsd ? '3px' : 0, height: `${(point.depositsUsd / maxValue) * 100}%`, background: '#ff7a9d', borderRadius: '3px 3px 0 0' }} />
            <div style={{ width: '9px', minHeight: point.withdrawalsUsd ? '3px' : 0, height: `${(point.withdrawalsUsd / maxValue) * 100}%`, background: 'var(--trend-up)', borderRadius: '3px 3px 0 0' }} />
          </div>
        );
      })}
    </div>
  );
}

export default function OnchainAnalysisModal({ token, onClose }: { token: OnchainToken; onClose: () => void }) {
  const [response, setResponse] = useState<Response | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const chain = CHAIN_BY_ID[token.chainId] ?? 'bsc';

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setIsLoading(true);
      setResponse(null);
      try {
        let nextPage: number | null = 1;
        let fromDate: string | null = null;
        let toDate: string | null = null;
        let startBlock: string | null = null;
        let endBlock: string | null = null;
        let aggregate: Response | null = null;
        let pageCount = 0;
        const seenPages = new Set<number>();

        do {
          const params = new URLSearchParams({ address: token.contractAddress, chain });
          if (token.price && token.price > 0) params.set('price', String(token.price));
          if (nextPage) params.set('page', String(nextPage));
          if (fromDate) params.set('from_date', fromDate);
          if (toDate) params.set('to_date', toDate);
          if (startBlock) params.set('start_block', startBlock);
          if (endBlock) params.set('end_block', endBlock);
          const result = await fetch(`/api/onchain/signals?${params}`, { signal: controller.signal, cache: 'no-store' });
          const page = (await result.json()) as Response;
          if (!page.success) {
            setResponse(page);
            return;
          }

          pageCount += 1;
          aggregate = mergePage(aggregate, page, pageCount);
          setResponse(aggregate);
          fromDate = page.transferWindow?.fromDate ?? fromDate;
          toDate = page.transferWindow?.toDate ?? toDate;
          startBlock = page.transferWindow?.startBlock ?? startBlock;
          endBlock = page.transferWindow?.endBlock ?? endBlock;
          nextPage = page.nextPage ?? null;
          if (nextPage && seenPages.has(nextPage)) break;
          if (nextPage) seenPages.add(nextPage);
        } while (nextPage && !controller.signal.aborted);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setResponse({ success: false, error: 'Không thể kết nối tới dịch vụ on-chain.' });
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [chain, token.contractAddress]);

  const transactions = useMemo(() => response?.signals ?? [], [response]);
  const explorer = EXPLORER_BY_CHAIN[chain];

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 10000 }}>
      <div className="modal-content" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '1180px' }}>
        <button className="modal-close-btn" onClick={onClose}>×</button>
        <header style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.35rem', color: 'var(--text-primary)' }}>On-chain flow · {token.symbol}</h2>
          <p style={{ marginTop: '0.3rem', color: 'var(--text-secondary)', fontSize: '0.83rem' }}>{token.name} · Etherscan quét ERC-20 transfer trong 3 ngày gần nhất; Moralis 2 chỉ bổ sung nhãn ví chưa có trong cache cho giao dịch ≥ $100K.</p>
        </header>

        {isLoading && <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--primary-cyan)' }}>Đang quét toàn bộ transfer 3 ngày… đã đọc {response?.scannedTransfers ?? 0} transfer / {response?.transferWindow?.fetchedPages ?? 0} trang.</div>}
        {response && !response.success && <div style={{ color: 'var(--trend-down)', padding: '1.5rem 0' }}>{response.error}</div>}
        {response?.success && response.summary && (
          <>
            <section className="stats-overview" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
              <div className="glass-panel stat-card"><div className="stat-info"><span className="stat-label">Nạp lên sàn</span><span className="stat-value" style={{ color: '#ff7a9d' }}>${compact(response.summary.depositsUsd)}</span></div></div>
              <div className="glass-panel stat-card"><div className="stat-info"><span className="stat-label">Rút từ sàn</span><span className="stat-value" style={{ color: 'var(--trend-up)' }}>${compact(response.summary.withdrawalsUsd)}</span></div></div>
              <div className="glass-panel stat-card"><div className="stat-info"><span className="stat-label">Netflow vào sàn</span><span className="stat-value" style={{ color: response.summary.netExchangeFlowUsd >= 0 ? '#ff7a9d' : 'var(--trend-up)' }}>{response.summary.netExchangeFlowUsd >= 0 ? '+' : '-'}${compact(Math.abs(response.summary.netExchangeFlowUsd))}</span></div></div>
              <div className="glass-panel stat-card"><div className="stat-info"><span className="stat-label">Luồng ví lặp</span><span className="stat-value">{response.summary.repeatedRoutes}</span><span className="stat-desc" style={{ color: 'var(--text-muted)' }}>cùng tuyến ≥ 3 lần</span></div></div>
            </section>

            <section className="glass-panel" style={{ padding: '1rem 1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}><div><h3 style={{ fontSize: '0.95rem' }}>Biểu đồ lượng nạp / rút sàn</h3><p style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>Hồng: nạp sàn · Xanh: rút sàn · rê chuột để xem giá trị.</p></div><span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{response.scannedTransfers} transfer / {response.transferWindow?.fetchedPages ?? 0} trang trong toàn bộ 3D · Etherscan · nhãn cache {response.labelCache?.cached ?? 0}, mới từ Moralis {response.labelCache?.loaded ?? 0} · giá ${response.usdPrice?.toLocaleString(undefined, { maximumFractionDigits: 8 })} ({response.priceSource === 'binance' ? 'Binance fallback' : response.priceSource})</span></div>
              <FlowChart points={response.summary.flowTimeline} />
            </section>

            <section style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <h3 style={{ fontSize: '0.95rem' }}>Transaction lớn</h3>
              {transactions.length === 0 ? <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Không có giao dịch nào vượt ngưỡng $100K. Giao dịch lớn nhất trong {response.scannedTransfers} transfer vừa đọc là ${compact(response.largestTransferUsd ?? 0)}.</p> : <div className="table-container"><table className="token-table" style={{ minWidth: '920px' }}><thead><tr><th>Tín hiệu</th><th>Ví gửi</th><th>Ví nhận</th><th>Giá trị</th><th>Thời gian</th><th>Tx</th></tr></thead><tbody>{transactions.map((transaction) => <tr key={transaction.id}><td><span style={{ color: signalColor(transaction.type), fontWeight: 700 }}>{TYPE_LABEL[transaction.type]}</span>{transaction.repeatedRouteCount >= 3 && <div style={{ color: '#ffd166', fontSize: '0.68rem' }}>{transaction.repeatedRouteCount} lượt cùng tuyến</div>}</td><td title={transaction.fromAddress}>{walletName(transaction.fromAddress, transaction.fromLabel, transaction.fromEntity)}</td><td title={transaction.toAddress}>{walletName(transaction.toAddress, transaction.toLabel, transaction.toEntity)}</td><td style={{ fontFamily: 'monospace', fontWeight: 700 }}>${compact(transaction.amountUsd)}</td><td style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{new Date(transaction.timestamp).toLocaleString('vi-VN')}</td><td><a href={`https://${explorer}/tx/${transaction.txHash}`} target="_blank" rel="noreferrer" style={{ color: 'var(--primary-cyan)', fontFamily: 'monospace', fontSize: '0.72rem' }}>{shortAddress(transaction.txHash)} ↗</a></td></tr>)}</tbody></table></div>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
