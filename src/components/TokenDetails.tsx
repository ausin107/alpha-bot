'use client';

import React, { useState, useEffect } from 'react';
import Image from 'next/image';
import TokenChart from './TokenChart';
import { Token } from './TokenList';

const DetailTokenIcon = ({ token }: { token: Token }) => {
  const [hasError, setHasError] = useState(false);
  
  useEffect(() => {
    setHasError(false);
  }, [token.alphaId]);

  return (
    <div className="token-avatar" style={{ width: '42px', height: '42px', fontSize: '1.1rem', position: 'relative', overflow: 'hidden', padding: 0 }}>
      {(!hasError && token.iconUrl) ? (
        <Image 
          src={token.iconUrl} 
          alt={token.symbol} 
          fill
          sizes="42px"
          onError={() => setHasError(true)}
          style={{ objectFit: 'cover' }}
        />
      ) : (
        <span>{token.symbol.slice(0, 2).toUpperCase()}</span>
      )}
    </div>
  );
};

interface TokenDetailsProps {
  token: Token | null;
  onClose: () => void;
}

interface TickerData {
  highPrice?: string | number;
  lowPrice?: string | number;
  priceChange?: string | number;
  priceChangePercent?: string | number;
  volume?: string | number;
  quoteVolume?: string | number;
  openPrice?: string | number;
  lastPrice?: string | number;
}

export default function TokenDetails({ token, onClose }: TokenDetailsProps) {
  const [ticker, setTicker] = useState<TickerData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // Map alphaId format (like ALPHA_175 or just 175) to trading pair (e.g. ALPHA_175USDT)
  const getTradingSymbol = (alphaId: string) => {
    if (alphaId.startsWith('ALPHA_')) {
      return `${alphaId}USDT`;
    }
    return `ALPHA_${alphaId}USDT`;
  };

  useEffect(() => {
    if (!token) return;

    const fetchTicker = async () => {
      setIsLoading(true);
      try {
        const tradingSymbol = getTradingSymbol(token.alphaId);
        const res = await fetch(`/api/ticker?symbol=${tradingSymbol}`);
        if (!res.ok) {
          throw new Error('Không thể tải dữ liệu ticker');
        }
        const json = await res.json();
        
        // Handle wrapper format
        let tickerData = null;
        if (json && json.data) {
          tickerData = json.data;
        } else if (json && json.success && json.data) {
          tickerData = json.data;
        } else {
          tickerData = json;
        }
        setTicker(tickerData);
      } catch (err) {
        console.error('Lỗi khi fetch ticker:', err);
        setTicker(null); // Fallback to basic token data
      } finally {
        setIsLoading(false);
      }
    };

    fetchTicker();
  }, [token]);

  if (!token) return null;

  // Formatting helpers
  const formatPrice = (val: string | number | undefined) => {
    if (val === undefined) return '-';
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(num)) return '-';
    if (num < 0.0001) return `$${num.toFixed(8)}`;
    if (num < 0.01) return `$${num.toFixed(6)}`;
    if (num < 1) return `$${num.toFixed(4)}`;
    return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatLargeNum = (val: string | number | undefined, isCurrency = true) => {
    if (val === undefined) return '-';
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(num)) return '-';
    
    const prefix = isCurrency ? '$' : '';
    if (num >= 1e9) return `${prefix}${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${prefix}${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${prefix}${(num / 1e3).toFixed(2)}K`;
    return `${prefix}${num.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  };

  const formatPercent = (val: string | number | undefined) => {
    if (val === undefined) return '-';
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(num)) return '-';
    const sign = num > 0 ? '+' : '';
    return `${sign}${num.toFixed(2)}%`;
  };

  const handleCopy = () => {
    if (!token.contractAddress) return;
    navigator.clipboard.writeText(token.contractAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Percent change for ticker or token
  const percentChange = ticker?.priceChangePercent !== undefined 
    ? ticker.priceChangePercent 
    : token.percentChange24h;
  const isUp = (typeof percentChange === 'number' ? percentChange : parseFloat(percentChange as string)) >= 0;

  // 24h High and Low fallback
  const highPrice = ticker?.highPrice !== undefined ? ticker.highPrice : (typeof token.price === 'number' ? token.price * 1.05 : parseFloat(token.price) * 1.05);
  const lowPrice = ticker?.lowPrice !== undefined ? ticker.lowPrice : (typeof token.price === 'number' ? token.price * 0.95 : parseFloat(token.price) * 0.95);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close-btn" onClick={onClose}>&times;</button>
        <div className="details-header">
        <div className="details-title-group">
          <DetailTokenIcon token={token} />
          <div className="details-title-info">
            <div className="details-symbol">
              {token.symbol}
              <span className="chain-badge chain-bsc" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
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
            </div>
            <div className="details-name">{token.name}</div>
          </div>
        </div>
        <div className="details-price-group">
          <span className="details-price">{formatPrice(token.price)}</span>
          <span className={`trend-indicator ${isUp ? 'up' : 'down'}`} style={{ marginTop: '4px', alignSelf: 'flex-end' }}>
            {isUp ? '📈' : '📉'} {formatPercent(percentChange)}
          </span>
        </div>
      </div>

      {/* SVG Price Chart */}
      <TokenChart symbol={token.symbol} alphaId={token.alphaId} />

      {/* Financial Metrics */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Thông số thị trường
        </h4>
        
        <div className="metric-grid">
          <div className="metric-item">
            <span className="metric-item-label">Market Cap</span>
            <span className="metric-item-value mono">{formatLargeNum(token.marketCap)}</span>
          </div>

          <div className="metric-item">
            <span className="metric-item-label">FDV</span>
            <span className="metric-item-value mono">{formatLargeNum(token.fdv)}</span>
          </div>

          <div className="metric-item">
            <span className="metric-item-label">Volume 24h</span>
            <span className="metric-item-value mono">
              {isLoading ? 'Loading...' : formatLargeNum(ticker?.volume || token.volume24h, false)}
            </span>
          </div>

          <div className="metric-item">
            <span className="metric-item-label">Thanh khoản (Liquidity)</span>
            <span className="metric-item-value mono">{formatLargeNum(token.liquidity)}</span>
          </div>

          <div className="metric-item">
            <span className="metric-item-label">24h High / Low</span>
            <span className="metric-item-value mono" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
              {isLoading ? 'Loading...' : `${formatPrice(highPrice)} / ${formatPrice(lowPrice)}`}
            </span>
          </div>

          <div className="metric-item">
            <span className="metric-item-label">Tổng số Holders</span>
            <span className="metric-item-value mono">{formatLargeNum(token.holders, false)}</span>
          </div>

          <div className="metric-item">
            <span className="metric-item-label">Circulating Supply</span>
            <span className="metric-item-value mono">{formatLargeNum(token.circulatingSupply, false)}</span>
          </div>

          <div className="metric-item">
            <span className="metric-item-label">Total Supply</span>
            <span className="metric-item-value mono">{formatLargeNum(token.totalSupply, false)}</span>
          </div>

          {token.contractAddress && token.contractAddress !== '0x0' && token.contractAddress !== '0x0000000000000000000000000000000000000000' && (
            <div className="metric-item full-width">
              <span className="metric-item-label">Địa chỉ Contract ({token.chainName || 'BSC'})</span>
              <div 
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'space-between',
                  marginTop: '4px',
                  background: 'rgba(0,0,0,0.2)',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)'
                }}
              >
                <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px' }}>
                  {token.contractAddress}
                </span>
                <button 
                  onClick={handleCopy}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--primary-cyan)',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 'bold',
                    padding: '2px 4px'
                  }}
                >
                  {copied ? 'Copied! ✅' : 'Copy 📋'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
    </div>
  );
}
