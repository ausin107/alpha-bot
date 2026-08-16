'use client';

import React, { useState } from 'react';
import Image from 'next/image';

export interface Token {
  alphaId: string;
  symbol: string;
  name: string;
  chainId: string | number;
  chainName: string;
  contractAddress: string;
  price: string | number;
  percentChange24h: string | number;
  volume24h: string | number;
  marketCap: string | number;
  fdv: string | number;
  liquidity: string | number;
  totalSupply: string | number;
  circulatingSupply: string | number;
  holders: string | number;
  hasBinanceSpotUsdt?: boolean;
  iconUrl?: string;
  chainIconUrl?: string;
}

const TokenIcon = ({ token }: { token: Token }) => {
  const [hasError, setHasError] = useState(false);
  
  return (
    <div className="token-avatar" style={{ position: 'relative', overflow: 'hidden', padding: 0 }}>
      {(!hasError && token.iconUrl) ? (
        <Image 
          src={token.iconUrl} 
          alt={token.symbol} 
          fill
          sizes="32px"
          onError={() => setHasError(true)}
          style={{ objectFit: 'cover' }}
        />
      ) : (
        <span>{token.symbol.slice(0, 2).toUpperCase()}</span>
      )}
    </div>
  );
};

const ChainBadge = ({ token }: { token: Token }) => {
  return (
    <span className={`chain-badge hide-tablet`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginLeft: '6px', verticalAlign: 'middle' }}>
      {token.chainIconUrl && (
        <Image 
          src={token.chainIconUrl} 
          alt={token.chainName} 
          width={12}
          height={12}
          style={{ borderRadius: '50%', objectFit: 'cover' }} 
        />
      )}
      {token.chainName || 'BSC'}
    </span>
  );
};

interface TokenListProps {
  tokens: Token[];
  selectedToken: Token | null;
  onSelectToken: (token: Token) => void;
  onScanOnchain: (token: Token) => void;
  isLoading: boolean;
}

export default function TokenList({
  tokens,
  selectedToken,
  onSelectToken,
  onScanOnchain,
  isLoading,
}: TokenListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedChain, setSelectedChain] = useState<string>('ALL');
  const [hideSpotUsdt, setHideSpotUsdt] = useState(true);
  const [sortBy, setSortBy] = useState<string>('marketCap');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Helper formatting functions
  const formatPrice = (val: string | number) => {
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(num)) return '$0.00';
    if (num < 0.0001) return `$${num.toFixed(8)}`;
    if (num < 0.01) return `$${num.toFixed(6)}`;
    if (num < 1) return `$${num.toFixed(4)}`;
    return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatPercent = (val: string | number) => {
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(num)) return '0.00%';
    const sign = num > 0 ? '+' : '';
    return `${sign}${num.toFixed(2)}%`;
  };

  const formatLargeNum = (val: string | number) => {
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(num)) return '$0';
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
    return `$${num.toFixed(0)}`;
  };

  const shortenAddress = (addr: string) => {
    if (!addr) return '';
    if (addr === '0x0000000000000000000000000000000000000000' || addr === '0x0') return 'Native';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const handleCopy = (e: React.MouseEvent, addr: string, id: string) => {
    e.stopPropagation();
    if (!addr || addr === '0x0' || addr.startsWith('0x00000')) return;
    navigator.clipboard.writeText(addr);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  // Get unique chains for filter
  const chains = ['ALL', ...Array.from(new Set(tokens.map((t) => t.chainName || 'Other')))];

  // Sorting handler
  const handleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
  };

  // Filter & Sort tokens
  const filteredTokens = tokens
    .filter((token) => {
      const matchesSearch =
        token.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        token.name.toLowerCase().includes(searchQuery.toLowerCase());
      const tokenChain = token.chainName || 'Other';
      const matchesChain = selectedChain === 'ALL' || tokenChain === selectedChain;
      const matchesSpotFilter = !hideSpotUsdt || !token.hasBinanceSpotUsdt;
      return matchesSearch && matchesChain && matchesSpotFilter;
    })
    .sort((a, b) => {
      let valA = a[sortBy as keyof Token];
      let valB = b[sortBy as keyof Token];

      // Convert strings to float for numeric sorting
      if (['price', 'percentChange24h', 'volume24h', 'marketCap', 'liquidity'].includes(sortBy)) {
        valA = typeof valA === 'number' ? valA : parseFloat(valA as string) || 0;
        valB = typeof valB === 'number' ? valB : parseFloat(valB as string) || 0;
      } else {
        // String sort
        valA = String(valA).toLowerCase();
        valB = String(valB).toLowerCase();
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

  const getSortIcon = (field: string) => {
    if (sortBy !== field) return '↕️';
    return sortOrder === 'asc' ? '🔼' : '🔽';
  };

  return (
    <div className="glass-panel list-section">
      <div className="list-header">
        <div className="list-title">
          Tokens Alpha
          <span className="badge-count">
            {isLoading ? '...' : filteredTokens.length}
          </span>
        </div>
        <div className="search-wrapper">
          <input
            type="text"
            placeholder="Tìm theo symbol hoặc tên..."
            className="search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <span className="search-icon">🔍</span>
        </div>
      </div>

      {/* Chain Filters */}
      <div className="filter-row">
        {chains.map((chain) => (
          <button
            key={chain}
            className={`filter-badge ${selectedChain === chain ? 'active' : ''}`}
            onClick={() => setSelectedChain(chain)}
          >
            {chain}
          </button>
        ))}
        <button
          type="button"
          className={`filter-badge ${hideSpotUsdt ? 'active' : ''}`}
          onClick={() => setHideSpotUsdt((hidden) => !hidden)}
          title="Ẩn token đã có cặp Spot / USDT đang giao dịch trên Binance"
        >
          Chưa có Spot / USDT
        </button>
      </div>

      {/* Table Container */}
      <div className="table-container">
        {isLoading ? (
          <div style={{ padding: '2rem' }}>
            <div className="skeleton-row-container">
              {[...Array(6)].map((_, i) => (
                <div key={i} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                  <div className="skeleton skeleton-avatar" />
                  <div style={{ flex: 1 }}>
                    <div className="skeleton skeleton-text" style={{ width: '30%' }} />
                    <div className="skeleton skeleton-text" style={{ width: '50%' }} />
                  </div>
                  <div className="skeleton skeleton-text" style={{ width: '15%' }} />
                  <div className="skeleton skeleton-text" style={{ width: '15%' }} />
                </div>
              ))}
            </div>
          </div>
        ) : filteredTokens.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            Không tìm thấy đồng coin nào phù hợp.
          </div>
        ) : (
          <table className="token-table">
            <thead>
              <tr>
                <th>Coin</th>
                <th className="sortable" onClick={() => handleSort('price')}>
                  Giá {getSortIcon('price')}
                </th>
                <th className="sortable" onClick={() => handleSort('percentChange24h')}>
                  Biến động 24h {getSortIcon('percentChange24h')}
                </th>
                <th className="sortable hide-tablet" onClick={() => handleSort('volume24h')}>
                  Volume 24h {getSortIcon('volume24h')}
                </th>
                <th className="sortable hide-mobile" onClick={() => handleSort('marketCap')}>
                  Market Cap {getSortIcon('marketCap')}
                </th>
                <th className="hide-tablet">Contract</th>
                <th className="hide-tablet">Quét</th>
              </tr>
            </thead>
            <tbody>
              {filteredTokens.map((token) => {
                const percent = typeof token.percentChange24h === 'number' 
                  ? token.percentChange24h 
                  : parseFloat(token.percentChange24h) || 0;
                const isUp = percent >= 0;
                const isSelected = selectedToken?.alphaId === token.alphaId;

                return (
                  <tr
                    key={token.alphaId}
                    className={`token-row ${isSelected ? 'selected' : ''}`}
                    onClick={() => onSelectToken(token)}
                  >
                    <td>
                      <div className="token-info-cell">
                        <TokenIcon token={token} />
                        <div className="token-meta">
                          <span className="token-symbol">
                            {token.symbol}
                            <ChainBadge token={token} />
                          </span>
                          <span className="token-name">{token.name}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="price-text">
                        {formatPrice(token.price)}
                      </span>
                    </td>
                    <td>
                      <span className={`trend-indicator ${isUp ? 'up' : 'down'}`}>
                        {isUp ? '📈' : '📉'} {formatPercent(token.percentChange24h)}
                      </span>
                    </td>
                    <td className="hide-tablet">
                      <span className="price-text">
                        {formatLargeNum(token.volume24h)}
                      </span>
                    </td>
                    <td className="hide-mobile">
                      <span className="price-text">
                        {formatLargeNum(token.marketCap)}
                      </span>
                    </td>
                    <td className="hide-tablet">
                      {token.contractAddress && token.contractAddress !== '0x0' && token.contractAddress !== '0x0000000000000000000000000000000000000000' ? (
                        <div className="address-cell">
                          {shortenAddress(token.contractAddress)}
                          <button
                            className="copy-btn"
                            title="Copy Address"
                            onClick={(e) => handleCopy(e, token.contractAddress, token.alphaId)}
                          >
                            {copiedId === token.alphaId ? '✅' : '📋'}
                          </button>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>Native</span>
                      )}
                    </td>
                    <td className="hide-tablet">
                      <button
                        className="action-btn"
                        disabled={!/^0x[a-fA-F0-9]{40}$/.test(token.contractAddress) || !['1', '56', '8453'].includes(String(token.chainId))}
                        title="Quét giao dịch on-chain lớn của token này"
                        onClick={(event) => {
                          event.stopPropagation();
                          onScanOnchain(token);
                        }}
                        style={{ fontSize: '0.7rem', padding: '0.25rem 0.55rem', borderColor: '#ffb800', color: '#ffd166' }}
                      >
                        Quét
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
