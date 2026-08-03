'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import TokenList, { Token } from '../components/TokenList';
import TokenDetails from '../components/TokenDetails';
import OnchainAnalysisModal, { OnchainToken } from '../components/OnchainAnalysisModal';
import FuturesOiScanner from '../components/FuturesOiScanner';

type PumpScanResult = {
  source: MarketTab;
  alphaId?: string;
  tokenId?: string;
  contractAddress?: string;
  chainId?: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name: string;
  iconUrl?: string;
  price: number;
  percentChange24h: number;
  volume24h: number;
  marketCap: number;
  futuresMarkets: ('USDT_M' | 'COIN_M')[];
  score: {
    score: number;
    triggerScore: number;
    cycleScore: number;
    level: 'HIGH' | 'WATCH' | 'LOW';
    phase: 'ACCELERATION_READY' | 'EARLY_CYCLE' | 'TRIGGER_ONLY' | 'NO_CLEAR_SETUP';
    confidence: 'FULL' | 'PARTIAL' | 'SHORT';
    breakdown: {
      trigger: Record<string, number>;
      cycle: Record<string, number>;
    };
    metrics: {
      historyDays: number;
      contextWindowDays: number;
      volumeRatio: number;
      tradeRatio: number;
      volumePercentile180d: number | null;
      tradePercentile180d: number | null;
      rangePercentile180d: number | null;
      lowerWickPercentile180d: number | null;
      upperWickPercentile180d: number | null;
      averageLowerWick: number;
      averageUpperWick: number;
      return3d: number;
      averageDailyRange: number;
      cycleAgeDays: number | null;
      pricePosition90d: number | null;
      return30d: number | null;
      return90d: number | null;
    };
  };
};

type MarketTab = 'alpha' | 'spot';
type DashboardTab = MarketTab | 'futures';

type ShakeoutScanResult = {
  source: MarketTab;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  alphaId?: string;
  tokenId?: string;
  name?: string;
  futuresMarkets: ('USDT_M' | 'COIN_M')[];
  latestOpenTime: number;
  structure: {
    score: number;
    phase: 'BREAKOUT_CONFIRMED' | 'ARMED_FOR_BREAKOUT' | 'STRUCTURE_FORMING' | 'NO_STRUCTURE';
    metrics: {
      support: number;
      resistance: number;
      rangeWidth: number;
      testPumpOffsetDays: number | null;
      bearTrapOffsetDays: number | null;
      drySupplyRatio: number | null;
      closeVsResistance: number;
      breakoutVolumeRatio: number;
    };
  };
};

export default function Home() {
  const [marketTab, setMarketTab] = useState<DashboardTab>('alpha');
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selectedToken, setSelectedToken] = useState<Token | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  
  // Refresh configuration
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [countdown, setCountdown] = useState<number>(1200);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isScanMenuOpen, setIsScanMenuOpen] = useState<boolean>(false);

  const handleSelectToken = (token: Token) => {
    setSelectedToken(token);
    setIsModalOpen(true);
  };

  const handleOpenOnchainScan = (token: Token) => {
    setOnchainToken({
      alphaId: token.alphaId,
      symbol: token.symbol,
      name: token.name,
      contractAddress: token.contractAddress,
      chainId: String(token.chainId),
      price: Number(token.price),
    });
  };

  // Sideways scanner states
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanResults, setScanResults] = useState<any[] | null>(null);
  const [isScanModalOpen, setIsScanModalOpen] = useState<boolean>(false);
  const [scanInterval, setScanInterval] = useState<string>('1d');
  const [scanLimit, setScanLimit] = useState<number>(5);

  // Pump-pattern scanner states. Results are persisted by the API in data/pump-score-cache.json.
  const [isPumpScanModalOpen, setIsPumpScanModalOpen] = useState<boolean>(false);
  const [isPumpScanning, setIsPumpScanning] = useState<boolean>(false);
  const [pumpMarket, setPumpMarket] = useState<MarketTab>('alpha');
  const [pumpResults, setPumpResults] = useState<PumpScanResult[] | null>(null);
  const [onchainToken, setOnchainToken] = useState<OnchainToken | null>(null);
  const [pumpScanInfo, setPumpScanInfo] = useState<{ cached: boolean; generatedAt: string; scannedTokens: number; chainFilteredOutTokens: number; futuresFilteredOutTokens: number; filteredOutTokens: number; failedTokens: number; scoreFilteredOutTokens: number } | null>(null);

  const [isShakeoutModalOpen, setIsShakeoutModalOpen] = useState<boolean>(false);
  const [isShakeoutScanning, setIsShakeoutScanning] = useState<boolean>(false);
  const [shakeoutMarket, setShakeoutMarket] = useState<MarketTab>('alpha');
  const [shakeoutResults, setShakeoutResults] = useState<ShakeoutScanResult[] | null>(null);
  const [shakeoutInfo, setShakeoutInfo] = useState<{ cached: boolean; generatedAt: string; totalCandidates: number; futuresFilteredOutCandidates: number; scannedCandidates: number; failedCandidates: number } | null>(null);

  const handleScanSideways = () => {
    setIsScanModalOpen(true);
  };

  const loadPumpScan = async (market: MarketTab, force = false) => {
    setIsPumpScanning(true);
    try {
      const res = await fetch(`/api/scan-pump?market=${market}${force ? '&force=1' : ''}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Không thể quét điểm pump');
      setPumpResults(json.results);
      setPumpScanInfo({
        cached: json.cached,
        generatedAt: json.generatedAt,
        scannedTokens: json.scannedTokens,
        chainFilteredOutTokens: json.chainFilteredOutTokens,
        futuresFilteredOutTokens: json.futuresFilteredOutTokens,
        filteredOutTokens: json.filteredOutTokens,
        failedTokens: json.failedTokens,
        scoreFilteredOutTokens: json.scoreFilteredOutTokens,
      });
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'Lỗi hệ thống khi quét điểm pump.';
      alert(message);
    } finally {
      setIsPumpScanning(false);
    }
  };

  const handleScanPump = () => {
    if (marketTab === 'futures') return;
    setPumpMarket(marketTab);
    setPumpResults(null);
    setPumpScanInfo(null);
    setIsPumpScanModalOpen(true);
    void loadPumpScan(marketTab);
  };

  const loadShakeoutScan = async (market: MarketTab, force = false) => {
    setIsShakeoutScanning(true);
    try {
      const res = await fetch(`/api/scan-shakeout?market=${market}${force ? '&force=1' : ''}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Không thể quét cấu trúc shakeout');
      setShakeoutResults(json.results);
      setShakeoutInfo({
        cached: json.cached,
        generatedAt: json.generatedAt,
        totalCandidates: json.totalCandidates,
        futuresFilteredOutCandidates: json.futuresFilteredOutCandidates,
        scannedCandidates: json.scannedCandidates,
        failedCandidates: json.failedCandidates,
      });
    } catch (err: unknown) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Lỗi hệ thống khi quét cấu trúc shakeout.');
    } finally {
      setIsShakeoutScanning(false);
    }
  };

  const handleScanShakeout = () => {
    if (marketTab === 'futures') return;
    setShakeoutMarket(marketTab);
    setShakeoutResults(null);
    setShakeoutInfo(null);
    setIsShakeoutModalOpen(true);
    void loadShakeoutScan(marketTab);
  };

  // Run scan when modal is opened or settings change
  useEffect(() => {
    if (!isScanModalOpen) return;

    const triggerScan = async () => {
      setIsScanning(true);
      setScanResults(null);
      try {
        const res = await fetch(`/api/scan-sideways?interval=${scanInterval}&limit=${scanLimit}`);
        if (!res.ok) throw new Error('Không thể chạy scan sideways');
        const json = await res.json();
        if (json && json.success) {
          setScanResults(json.data);
        } else {
          throw new Error(json.error || 'Lỗi quét dữ liệu');
        }
      } catch (err: any) {
        console.error(err);
        alert(err.message || 'Lỗi hệ thống khi quét sideways.');
      } finally {
        setIsScanning(false);
      }
    };

    triggerScan();
  }, [isScanModalOpen, scanInterval, scanLimit]);

  const handleSelectFromScan = (scannedToken: any) => {
    setIsScanModalOpen(false);
    const fullToken = tokens.find((t) => t.alphaId === scannedToken.alphaId);
    if (fullToken) {
      handleSelectToken(fullToken);
    } else {
      const fallbackToken: Token = {
        alphaId: scannedToken.alphaId,
        symbol: scannedToken.symbol,
        name: scannedToken.name,
        iconUrl: scannedToken.iconUrl,
        price: scannedToken.price,
        percentChange24h: scannedToken.percentChange24h,
        volume24h: scannedToken.volume24h,
        chainId: '56',
        chainIconUrl: '',
        chainName: 'BSC',
        contractAddress: '0x0000000000000000000000000000000000000000',
        marketCap: 0,
        fdv: 0,
        liquidity: 0,
        totalSupply: 0,
        circulatingSupply: 0,
        holders: 0,
      };
      handleSelectToken(fallbackToken);
    }
  };

  // Fetch all tokens from proxy API
  const fetchTokens = useCallback(async (isManual = false) => {
    if (isManual) setIsRefreshing(true);
    setError(null);
    try {
      const res = await fetch('/api/tokens');
      if (!res.ok) {
        throw new Error(`Lỗi tải dữ liệu: ${res.statusText}`);
      }
      const json = await res.json();
      
      let tokenArray: Token[] = [];
      if (json && Array.isArray(json.data)) {
        tokenArray = json.data;
      } else if (json && Array.isArray(json)) {
        tokenArray = json;
      } else if (json && json.success && Array.isArray(json.data)) {
        tokenArray = json.data;
      }

      setTokens(tokenArray);
      
      // Update selected token data if already selected to reflect new price/change
      setSelectedToken((prev) => {
        if (!prev) {
          // Default select the first token if none selected
          return tokenArray.length > 0 ? tokenArray[0] : null;
        }
        const updated = tokenArray.find((t) => t.alphaId === prev.alphaId);
        return updated || prev;
      });
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Không thể kết nối đến máy chủ API Binance.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
      setCountdown(1200); // Reset countdown timer
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  // Format seconds to MM:SS display
  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Countdown timer for auto refresh
  useEffect(() => {
    if (!autoRefresh || isLoading) return;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchTokens();
          return 1200;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [autoRefresh, isLoading, fetchTokens]);

  // Calculations for overview metrics
  const getStats = () => {
    if (tokens.length === 0) return { count: 0, avgChange: 0, topGainer: null, topVolume: null };

    let totalChange = 0;
    let topGainer: Token = tokens[0];
    let topVolume: Token = tokens[0];

    tokens.forEach((t) => {
      const change = typeof t.percentChange24h === 'number' ? t.percentChange24h : parseFloat(t.percentChange24h) || 0;
      const vol = typeof t.volume24h === 'number' ? t.volume24h : parseFloat(t.volume24h) || 0;
      
      totalChange += change;

      const topGainerChange = typeof topGainer.percentChange24h === 'number' ? topGainer.percentChange24h : parseFloat(topGainer.percentChange24h) || 0;
      if (change > topGainerChange) {
        topGainer = t;
      }

      const topVolumeVal = typeof topVolume.volume24h === 'number' ? topVolume.volume24h : parseFloat(topVolume.volume24h) || 0;
      if (vol > topVolumeVal) {
        topVolume = t;
      }
    });

    return {
      count: tokens.length,
      avgChange: totalChange / tokens.length,
      topGainer,
      topVolume,
    };
  };

  const stats = getStats();

  const formatPrice = (val: string | number | undefined) => {
    if (val === undefined) return '$0.00';
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(num)) return '$0.00';
    if (num < 0.0001) return `$${num.toFixed(8)}`;
    if (num < 0.01) return `$${num.toFixed(6)}`;
    if (num < 1) return `$${num.toFixed(4)}`;
    return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <main className="app-container">
      {/* Header */}
      <header className="header-section">
        <div className="logo-group">
          <div className="logo-icon">B</div>
          <div className="logo-text">
            <h1>BINANCE ALPHA</h1>
            <p>Bảng theo dõi và thống kê đồng coin Web3 giai đoạn đầu</p>
          </div>
        </div>

        {/* Refresh controllers */}
        <div className="controls-group">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                style={{ accentColor: 'var(--primary-cyan)', width: '15px', height: '15px' }}
              />
              Tự động cập nhật
            </label>
            {autoRefresh && (
              <span className="mono" style={{ background: 'rgba(255,255,255,0.04)', padding: '0.2rem 0.5rem', borderRadius: '4px', border: '1px solid var(--border-color)', color: 'var(--primary-cyan)' }}>
                {formatCountdown(countdown)}
              </span>
            )}
          </div>

          {marketTab === 'alpha' && (
            <>
              <button
                className={`action-btn ${isRefreshing ? 'active' : ''}`}
                onClick={() => fetchTokens(true)}
                disabled={isLoading || isRefreshing}
              >
                <span className={`refresh-icon-text ${isRefreshing ? 'spin' : ''}`}>🔄</span>
                Làm mới
              </button>

              <button
                className="action-btn scan-legacy"
                onClick={handleScanSideways}
                disabled={isLoading}
                style={{ 
                  background: 'linear-gradient(135deg, rgba(0, 242, 254, 0.12) 0%, rgba(79, 172, 254, 0.12) 100%)', 
                  borderColor: 'var(--primary-cyan)',
                  color: 'var(--primary-cyan)',
                }}
              >
                <span>🔍</span> Quét Sideways
              </button>

              <button
                className="action-btn scan-legacy"
                onClick={handleScanPump}
                disabled={isLoading}
                style={{
                  background: 'linear-gradient(135deg, rgba(255, 184, 0, 0.16) 0%, rgba(255, 98, 0, 0.14) 100%)',
                  borderColor: '#ffb800',
                  color: '#ffd166',
                }}
              >
                <span>⚡</span> Quét tín hiệu Pump
              </button>
            </>
          )}

          {marketTab !== 'futures' && <button
              className="action-btn scan-legacy"
              onClick={handleScanShakeout}
              disabled={isShakeoutScanning}
              style={{
                background: 'linear-gradient(135deg, rgba(155, 89, 182, 0.2) 0%, rgba(52, 152, 219, 0.14) 100%)',
                borderColor: '#b18cff',
                color: '#d4c2ff',
              }}
            >
              <span>🧭</span> Quét cấu trúc {marketTab === 'spot' ? 'Spot' : 'Alpha'}
            </button>}
          {marketTab !== 'futures' && <div style={{ position: 'relative' }}>
            <button
              className={`action-btn ${isScanMenuOpen ? 'active' : ''}`}
              onClick={() => setIsScanMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={isScanMenuOpen}
              style={{ borderColor: 'var(--primary-cyan)', color: 'var(--primary-cyan)' }}
            >
              🔎 Quét <span style={{ fontSize: '0.7rem' }}>▾</span>
            </button>
            {isScanMenuOpen && (
              <div className="glass-panel" role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 0.5rem)', zIndex: 50, minWidth: '225px', padding: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <button className="action-btn" role="menuitem" disabled={marketTab !== 'alpha' || isLoading} onClick={() => { setIsScanMenuOpen(false); handleScanSideways(); }} style={{ justifyContent: 'flex-start', border: 0, color: 'var(--primary-cyan)' }}>🔍 Quét Sideways</button>
                <button className="action-btn" role="menuitem" disabled={isPumpScanning || (marketTab === 'alpha' && isLoading)} onClick={() => { setIsScanMenuOpen(false); handleScanPump(); }} style={{ justifyContent: 'flex-start', border: 0, color: '#ffd166' }}>⚡ Quét tín hiệu Pump {marketTab === 'spot' ? 'Spot' : 'Alpha'}</button>
                <button className="action-btn" role="menuitem" disabled={isShakeoutScanning} onClick={() => { setIsScanMenuOpen(false); handleScanShakeout(); }} style={{ justifyContent: 'flex-start', border: 0, color: '#d4c2ff' }}>🧭 Quét cấu trúc {marketTab === 'spot' ? 'Spot' : 'Alpha'}</button>
              </div>
            )}
          </div>}
        </div>
      </header>

      <section className="glass-panel" style={{ display: 'flex', gap: '0.6rem', padding: '0.55rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="action-btn"
          onClick={() => setMarketTab('alpha')}
          style={{
            borderColor: marketTab === 'alpha' ? 'var(--primary-cyan)' : 'var(--border-color)',
            color: marketTab === 'alpha' ? 'var(--primary-cyan)' : 'var(--text-secondary)',
            background: marketTab === 'alpha' ? 'rgba(0, 242, 254, 0.1)' : 'transparent',
          }}
        >
          Binance Alpha
        </button>
        <button
          className="action-btn"
          onClick={() => setMarketTab('spot')}
          style={{
            borderColor: marketTab === 'spot' ? '#d4c2ff' : 'var(--border-color)',
            color: marketTab === 'spot' ? '#d4c2ff' : 'var(--text-secondary)',
            background: marketTab === 'spot' ? 'rgba(155, 89, 182, 0.12)' : 'transparent',
          }}
        >
          Binance Spot / USDT
        </button>
        <button
          className="action-btn"
          onClick={() => setMarketTab('futures')}
          style={{
            borderColor: marketTab === 'futures' ? '#f0b90b' : 'var(--border-color)',
            color: marketTab === 'futures' ? '#ffd166' : 'var(--text-secondary)',
            background: marketTab === 'futures' ? 'rgba(240, 185, 11, 0.1)' : 'transparent',
          }}
        >
          Futures OI Radar
        </button>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: '0.35rem' }}>
          {marketTab === 'alpha'
            ? 'Dữ liệu Alpha và các bộ lọc BSC/Futures hiện tại.'
            : marketTab === 'spot'
              ? 'Quét toàn bộ cặp Spot đang TRADING có quote asset USDT.'
              : 'Xếp hạng USDⓈ-M perpetual có Open Interest tăng bất thường.'}
        </span>
      </section>

      {/* Stats Cards */}
      {marketTab === 'alpha' && <section className="stats-overview">
        <div className="glass-panel stat-card">
          <div className="stat-icon">🪙</div>
          <div className="stat-info">
            <span className="stat-label">Tổng Số Coins Alpha</span>
            <span className="stat-value">{isLoading ? '...' : stats.count}</span>
            <span className="stat-desc" style={{ color: 'var(--text-muted)' }}>Đang giao dịch trên sàn</span>
          </div>
        </div>

        <div className="glass-panel stat-card">
          <div className="stat-icon">📊</div>
          <div className="stat-info">
            <span className="stat-label">Biến Động Trung Bình 24h</span>
            <span 
              className="stat-value"
              style={{ color: stats.avgChange >= 0 ? 'var(--trend-up)' : 'var(--trend-down)' }}
            >
              {isLoading ? '...' : `${stats.avgChange >= 0 ? '+' : ''}${stats.avgChange.toFixed(2)}%`}
            </span>
            <span className="stat-desc" style={{ color: 'var(--text-muted)' }}>Xu thế chung thị trường</span>
          </div>
        </div>

        <div className="glass-panel stat-card">
          <div className="stat-icon">🔥</div>
          <div className="stat-info">
            <span className="stat-label">Tăng Mạnh Nhất 24h</span>
            <span className="stat-value" style={{ color: 'var(--trend-up)' }}>
              {isLoading || !stats.topGainer ? '...' : stats.topGainer.symbol}
            </span>
            <span className="stat-desc" style={{ color: 'var(--trend-up)' }}>
              {isLoading || !stats.topGainer 
                ? '...' 
                : `${formatPrice(stats.topGainer.price)} (${parseFloat(String(stats.topGainer.percentChange24h)) >= 0 ? '+' : ''}${parseFloat(String(stats.topGainer.percentChange24h)).toFixed(2)}%)`}
            </span>
          </div>
        </div>

        <div className="glass-panel stat-card">
          <div className="stat-icon">💎</div>
          <div className="stat-info">
            <span className="stat-label">Volume Lớn Nhất</span>
            <span className="stat-value">
              {isLoading || !stats.topVolume ? '...' : stats.topVolume.symbol}
            </span>
            <span className="stat-desc" style={{ color: 'var(--text-secondary)' }}>
              {isLoading || !stats.topVolume 
                ? '...' 
                : `Vol: $${(parseFloat(String(stats.topVolume.volume24h)) / 1e6).toFixed(2)}M`}
            </span>
          </div>
        </div>
      </section>}

      {/* Main Grid Layout */}
      {error && (
        <div 
          className="glass-panel" 
          style={{ 
            padding: '1.25rem', 
            background: 'rgba(255, 56, 96, 0.08)', 
            borderColor: 'var(--trend-down)', 
            color: 'var(--trend-down)', 
            borderRadius: '12px',
            fontSize: '0.9rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}
        >
          <span>⚠️</span> {error}
        </div>
      )}

      {marketTab === 'alpha' ? (
        <div className="dashboard-grid">
          <TokenList
            tokens={tokens}
            selectedToken={selectedToken}
            onSelectToken={handleSelectToken}
            onScanOnchain={handleOpenOnchainScan}
            isLoading={isLoading}
          />
        </div>
      ) : marketTab === 'spot' ? (
        <section className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <div>
            <h2 style={{ color: 'var(--text-primary)', fontSize: '1.2rem' }}>Binance Spot — toàn bộ cặp */USDT</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', marginTop: '0.4rem', maxWidth: '760px' }}>
              Tab này chỉ quét các cặp Spot/USDT có Futures Binance đang giao dịch để tìm cấu trúc test pump, bear trap, tái tích luỹ, cạn cung và breakout. Mỗi lần quét lấy tối đa 200 nến ngày/cặp; kết quả được cache riêng.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button className="action-btn" onClick={handleScanShakeout} disabled={isShakeoutScanning} style={{ borderColor: '#b18cff', color: '#d4c2ff' }}>
              {isShakeoutScanning ? 'Đang quét Spot...' : '🧭 Quét cấu trúc Spot / USDT'}
            </button>
            <button
              className="action-btn"
              onClick={handleScanPump}
              disabled={isPumpScanning}
              style={{ borderColor: '#ffb800', color: '#ffd166' }}
            >
              {isPumpScanning ? 'Đang quét Pump...' : '⚡ Quét tín hiệu Pump Spot'}
            </button>
          </div>
        </section>
      ) : (
        <FuturesOiScanner />
      )}

      {/* Selected Token Details & Chart Modal */}
      {isModalOpen && selectedToken && (
        <TokenDetails 
          token={selectedToken} 
          onClose={() => {
            setIsModalOpen(false);
            setSelectedToken(null);
          }} 
        />
      )}

      {onchainToken && <OnchainAnalysisModal token={onchainToken} onClose={() => setOnchainToken(null)} />}

      {/* Shakeout structure scanner modal */}
      {isShakeoutModalOpen && (
        <div className="modal-overlay" onClick={() => !isShakeoutScanning && setIsShakeoutModalOpen(false)}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()} style={{ maxWidth: '1120px' }}>
            <button className="modal-close-btn" onClick={() => setIsShakeoutModalOpen(false)} disabled={isShakeoutScanning}>&times;</button>
            <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.9rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div>
                  <h2 style={{ fontSize: '1.4rem', color: 'var(--text-primary)' }}>🧭 Quét cấu trúc Shakeout — {shakeoutMarket === 'spot' ? 'Binance Spot / USDT' : 'Binance Alpha'}</h2>
                  <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginTop: '4px', maxWidth: '720px' }}>
                    Điều kiện đầu vào: token phải có Futures Binance đang TRADING (USDⓈ-M hoặc COIN-M). Sau đó mẫu cần nhiều pha: failed test pump, bear trap hồi phục, quay lại range, cụm thanh khoản thấp và breakout bằng giá đóng cửa.
                  </p>
                </div>
                <button className="action-btn" onClick={() => void loadShakeoutScan(shakeoutMarket, true)} disabled={isShakeoutScanning} style={{ fontSize: '0.78rem', padding: '0.45rem 0.75rem' }}>
                  {isShakeoutScanning ? 'Đang quét...' : '↻ Quét dữ liệu mới'}
                </button>
              </div>
              {shakeoutInfo && (
                <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {shakeoutInfo.cached ? 'Đang dùng kết quả đã lưu' : 'Đã tính và lưu kết quả mới'} · loại {shakeoutInfo.futuresFilteredOutCandidates} cặp không có Futures Binance · quét {shakeoutInfo.scannedCandidates}/{shakeoutInfo.totalCandidates} cặp · {shakeoutResults?.length ?? 0} setup sẵn sàng/xác nhận breakout · {shakeoutInfo.failedCandidates} cặp chưa đạt cấu trúc hành động · cập nhật {new Date(shakeoutInfo.generatedAt).toLocaleString('vi-VN')}
                </div>
              )}
            </div>

            {isShakeoutScanning ? (
              <div style={{ padding: '4rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
                <div className="pulse-animation" style={{ fontSize: '2.5rem' }}>🧭</div>
                <div style={{ color: '#d4c2ff', fontWeight: 700 }}>Đang kiểm tra cấu trúc giá trên tối đa 200 nến ngày mỗi cặp...</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textAlign: 'center' }}>Quét Spot toàn thị trường có thể mất lâu hơn Alpha trong lần đầu; lần sau sẽ đọc cache.</div>
              </div>
            ) : shakeoutResults && shakeoutResults.length > 0 ? (
              <div style={{ marginTop: '1rem', maxHeight: '60vh', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <table style={{ width: '100%', minWidth: '1080px', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ position: 'sticky', top: 0, background: '#121923', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                      <th style={{ padding: '0.75rem' }}>#</th>
                      <th style={{ padding: '0.75rem' }}>Cặp</th>
                      <th style={{ padding: '0.75rem' }}>Futures</th>
                      <th style={{ padding: '0.75rem' }}>Điểm / Pha</th>
                      <th style={{ padding: '0.75rem' }}>Support / Resistance</th>
                      <th style={{ padding: '0.75rem' }}>Test / Trap</th>
                      <th style={{ padding: '0.75rem' }}>Supply / Breakout</th>
                      <th style={{ padding: '0.75rem', textAlign: 'right' }}>Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shakeoutResults.map((result, index) => {
                      const structure = result.structure;
                      const phaseLabel = structure.phase === 'BREAKOUT_CONFIRMED' ? 'BREAKOUT XÁC NHẬN'
                        : structure.phase === 'ARMED_FOR_BREAKOUT' ? 'SẴN SÀNG BREAKOUT'
                          : 'CẤU TRÚC ĐANG HÌNH THÀNH';
                      const phaseColor = structure.phase === 'BREAKOUT_CONFIRMED' ? 'var(--trend-up)'
                        : structure.phase === 'ARMED_FOR_BREAKOUT' ? '#ffd166' : '#d4c2ff';
                      const spotUrl = `https://www.binance.com/en/trade/${result.baseAsset}_${result.quoteAsset}?type=spot`;
                      return (
                        <tr key={`${result.source}-${result.symbol}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                          <td style={{ padding: '0.75rem', fontFamily: 'monospace' }}>{index + 1}</td>
                          <td style={{ padding: '0.75rem' }}>
                            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{result.baseAsset}/{result.quoteAsset}</div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.68rem' }}>{result.source === 'spot' ? 'Binance Spot' : result.name || 'Binance Alpha'}</div>
                          </td>
                          <td style={{ padding: '0.75rem', fontFamily: 'monospace', color: '#d4c2ff', fontSize: '0.72rem' }}>
                            {result.futuresMarkets.join(' + ')}
                          </td>
                          <td style={{ padding: '0.75rem' }}>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color: phaseColor }}>{structure.score}/100</div>
                            <div style={{ fontSize: '0.67rem', color: phaseColor }}>{phaseLabel}</div>
                          </td>
                          <td style={{ padding: '0.75rem', fontFamily: 'monospace' }}>
                            <div>{structure.metrics.support.toPrecision(5)} / {structure.metrics.resistance.toPrecision(5)}</div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.67rem' }}>range {(structure.metrics.rangeWidth * 100).toFixed(1)}%</div>
                          </td>
                          <td style={{ padding: '0.75rem' }}>
                            <div>test {structure.metrics.testPumpOffsetDays === null ? '—' : `${structure.metrics.testPumpOffsetDays}d trước`}</div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.67rem' }}>trap {structure.metrics.bearTrapOffsetDays === null ? '—' : `${structure.metrics.bearTrapOffsetDays}d trước`}</div>
                          </td>
                          <td style={{ padding: '0.75rem' }}>
                            <div>dry {structure.metrics.drySupplyRatio === null ? '—' : `${(structure.metrics.drySupplyRatio * 100).toFixed(0)}%`}</div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.67rem' }}>close/R {(structure.metrics.closeVsResistance * 100).toFixed(1)}% · vol {(structure.metrics.breakoutVolumeRatio).toFixed(1)}x</div>
                          </td>
                          <td style={{ padding: '0.75rem', textAlign: 'right' }}>
                            {result.source === 'alpha' ? (
                              <button className="action-btn" style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem' }} onClick={() => {
                                setIsShakeoutModalOpen(false);
                                handleSelectFromScan(result);
                              }}>Xem chart</button>
                            ) : (
                              <a href={spotUrl} target="_blank" rel="noreferrer" className="action-btn" style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem', textDecoration: 'none' }}>Mở Spot ↗</a>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Chưa có cấu trúc nào đạt ngưỡng 60 điểm trong lần quét này.</div>
            )}
          </div>
        </div>
      )}

      {/* Pump-pattern Scanner Modal */}
      {isPumpScanModalOpen && (
        <div className="modal-overlay" onClick={() => !isPumpScanning && setIsPumpScanModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '1280px' }}>
            <button className="modal-close-btn" onClick={() => setIsPumpScanModalOpen(false)} disabled={isPumpScanning}>&times;</button>
            <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.9rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div>
                  <h2 style={{ fontSize: '1.4rem', color: 'var(--text-primary)' }}>⚡ Xếp hạng chu kỳ & tín hiệu Pump — {pumpMarket === 'spot' ? 'Binance Spot / USDT' : 'Binance Alpha'}</h2>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '4px', maxWidth: '680px' }}>
                    {pumpMarket === 'spot'
                      ? 'Quét các cặp Spot/USDT đang giao dịch, volume 24h trên $5M và có Futures Binance. Danh sách chỉ giữ các cặp có điểm trên 50/100.'
                      : 'Chỉ quét BSC (chain 56), có Futures Binance đang giao dịch, vốn hoá $2M–$200M và volume 24h trên $100K. Danh sách cuối chỉ giữ token có điểm trên 50/100; mỗi token có thể quét on-chain riêng trong 3 ngày gần nhất.'}
                  </p>
                </div>
                <button
                  className="action-btn"
                  onClick={() => void loadPumpScan(pumpMarket, true)}
                  disabled={isPumpScanning}
                  style={{ fontSize: '0.78rem', padding: '0.45rem 0.75rem' }}
                >
                  {isPumpScanning ? 'Đang quét...' : '↻ Quét dữ liệu mới'}
                </button>
              </div>
              {pumpScanInfo && (
                <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {pumpScanInfo.cached ? 'Đang dùng kết quả đã lưu' : 'Đã tính và lưu kết quả mới'} · quét {pumpScanInfo.scannedTokens} {pumpMarket === 'spot' ? 'cặp Spot/USDT' : 'token BSC'} có Futures Binance · {pumpMarket === 'alpha' && <>loại {pumpScanInfo.chainFilteredOutTokens} token khác mạng · </>}loại {pumpScanInfo.filteredOutTokens} {pumpMarket === 'spot' ? 'cặp có volume thấp' : 'token theo vốn hoá/volume'} · loại {pumpScanInfo.futuresFilteredOutTokens} {pumpMarket === 'spot' ? 'cặp' : 'token'} không có Futures Binance · bỏ qua {pumpScanInfo.failedTokens} {pumpMarket === 'spot' ? 'cặp' : 'token'} thiếu dữ liệu · ẩn {pumpScanInfo.scoreFilteredOutTokens} {pumpMarket === 'spot' ? 'cặp' : 'token'} điểm ≤50 · cập nhật {new Date(pumpScanInfo.generatedAt).toLocaleString('vi-VN')}
                </div>
              )}
            </div>

            {isPumpScanning ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 1rem', gap: '0.75rem' }}>
                <div className="pulse-animation" style={{ fontSize: '2.5rem' }}>⚡</div>
                <div style={{ fontWeight: 'bold', color: '#ffd166' }}>Đang tải tối đa 200 nến ngày và chấm điểm toàn bộ {pumpMarket === 'spot' ? 'cặp Spot/USDT' : 'token Alpha'}...</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'center' }}>Kết quả sẽ được lưu để các lần mở sau không phải tải và tính lại.</div>
              </div>
            ) : pumpResults && pumpResults.length > 0 ? (
              <div style={{ marginTop: '1rem', maxHeight: '60vh', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.1)' }}>
                <table style={{ width: '100%', minWidth: '1080px', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ position: 'sticky', top: 0, background: '#121923', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                      <th style={{ padding: '0.75rem' }}>#</th>
                      <th style={{ padding: '0.75rem' }}>Token</th>
                      <th style={{ padding: '0.75rem' }}>Điểm</th>
                      <th style={{ padding: '0.75rem' }}>Pha / dữ liệu</th>
                      <th style={{ padding: '0.75rem' }}>Futures</th>
                      <th style={{ padding: '0.75rem' }}>Chu kỳ 90d</th>
                      <th style={{ padding: '0.75rem' }}>Vol 7d/14d</th>
                      <th style={{ padding: '0.75rem' }}>Lệnh 7d/14d</th>
                      <th style={{ padding: '0.75rem' }}>Râu dưới / trên</th>
                      <th style={{ padding: '0.75rem' }}>Biến động 3d</th>
                      <th style={{ padding: '0.75rem', textAlign: 'right' }}>Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pumpResults.map((result, index) => {
                      const color = result.score.level === 'HIGH' ? 'var(--trend-up)' : result.score.level === 'WATCH' ? '#ffd166' : 'var(--text-secondary)';
                      const label = result.score.level === 'HIGH' ? 'CAO' : result.score.level === 'WATCH' ? 'THEO DÕI' : 'THẤP';
                      const metrics = result.score.metrics;
                      const phaseLabel = result.score.phase === 'ACCELERATION_READY'
                        ? 'SẴN SÀNG TĂNG TỐC'
                        : result.score.phase === 'EARLY_CYCLE'
                          ? 'CHU KỲ ĐANG XÂY'
                          : result.score.phase === 'TRIGGER_ONLY'
                            ? 'TRIGGER NGẮN HẠN'
                            : 'CHƯA RÕ';
                      const confidenceLabel = result.score.confidence === 'FULL'
                        ? 'ĐỦ 200D'
                        : result.score.confidence === 'PARTIAL'
                          ? `${metrics.historyDays}D`
                          : `NGẮN ${metrics.historyDays}D`;
                      return (
                        <tr
                          key={`${result.source}-${result.symbol}`}
                          onClick={() => {
                            if (result.source !== 'alpha') return;
                            setIsPumpScanModalOpen(false);
                            handleSelectFromScan(result);
                          }}
                          className="scan-row-hover"
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: result.source === 'alpha' ? 'pointer' : 'default' }}
                        >
                          <td style={{ padding: '0.75rem', fontFamily: 'monospace' }}>{index + 1}</td>
                          <td style={{ padding: '0.75rem' }}>
                            <div style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>{result.symbol}</div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{result.name}</div>
                          </td>
                          <td style={{ padding: '0.75rem' }} title={`Trigger: ${result.score.triggerScore}/65 · Chu kỳ: ${result.score.cycleScore}/35`}>
                            <div style={{ fontWeight: 'bold', color, fontSize: '1rem' }}>{result.score.score}/100</div>
                            <div style={{ fontSize: '0.66rem', color }}>{label}</div>
                          </td>
                          <td style={{ padding: '0.75rem' }}>
                            <div style={{ fontSize: '0.7rem', fontWeight: 700, color }}>{phaseLabel}</div>
                            <div style={{ fontSize: '0.67rem', color: 'var(--text-secondary)' }}>{confidenceLabel} · T {result.score.triggerScore}/65</div>
                          </td>
                          <td style={{ padding: '0.75rem', fontSize: '0.7rem', fontWeight: 700, color: 'var(--primary-cyan)' }}>
                            {result.futuresMarkets.map((market) => market === 'USDT_M' ? 'USDⓈ-M' : 'COIN-M').join(' + ')}
                          </td>
                          <td style={{ padding: '0.75rem' }}>
                            <div>{metrics.cycleAgeDays === null ? 'Chưa đủ' : `${metrics.cycleAgeDays} ngày từ đáy`}</div>
                            <div style={{ fontSize: '0.67rem', color: 'var(--text-secondary)' }}>
                              {metrics.pricePosition90d === null ? 'Thiếu 90D' : `vị trí ${(metrics.pricePosition90d * 100).toFixed(0)}% · C ${result.score.cycleScore}/35`}
                            </div>
                          </td>
                          <td style={{ padding: '0.75rem' }}>{metrics.volumeRatio.toFixed(2)}x</td>
                          <td style={{ padding: '0.75rem' }}>{metrics.tradeRatio.toFixed(2)}x</td>
                          <td style={{ padding: '0.75rem' }}>{(metrics.averageLowerWick * 100).toFixed(1)}% / {(metrics.averageUpperWick * 100).toFixed(1)}%</td>
                          <td style={{ padding: '0.75rem', color: metrics.return3d <= 0 ? 'var(--trend-down)' : 'var(--trend-up)' }}>{metrics.return3d >= 0 ? '+' : ''}{(metrics.return3d * 100).toFixed(1)}%</td>
                          <td style={{ padding: '0.75rem', textAlign: 'right' }}>
                            <div style={{ display: 'inline-flex', gap: '0.4rem' }}>
                              {result.source === 'spot' ? (
                                <a href={`https://www.binance.com/en/trade/${result.baseAsset}_${result.quoteAsset}?type=spot`} target="_blank" rel="noreferrer" className="action-btn" style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem', textDecoration: 'none' }}>
                                  Mở Spot ↗
                                </a>
                              ) : (
                                <>
                                  <button
                                    className="action-btn"
                                    style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem' }}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setIsPumpScanModalOpen(false);
                                      handleSelectFromScan(result);
                                    }}
                                  >
                                    Xem chart
                                  </button>
                                  <button
                                    className="action-btn"
                                    disabled={!/^0x[a-fA-F0-9]{40}$/.test(result.contractAddress ?? '')}
                                    title={/^0x[a-fA-F0-9]{40}$/.test(result.contractAddress ?? '') ? 'Quét các giao dịch on-chain > $100K' : 'Binance không trả về contract hợp lệ cho token này'}
                                    style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem', borderColor: '#ffb800', color: '#ffd166' }}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (!result.alphaId || !result.contractAddress || !result.chainId) return;
                                      setOnchainToken({
                                        alphaId: result.alphaId,
                                        symbol: result.symbol,
                                        name: result.name,
                                        contractAddress: result.contractAddress,
                                        chainId: result.chainId,
                                        price: result.price,
                                      });
                                    }}
                                  >
                                    Quét on-chain
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-secondary)' }}>Chưa có kết quả. Hãy quét dữ liệu mới.</div>
            )}
          </div>
        </div>
      )}

      {/* Sideways Scanner Modal */}
      {isScanModalOpen && (
        <div className="modal-overlay" onClick={() => !isScanning && setIsScanModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px' }}>
            <button className="modal-close-btn" onClick={() => setIsScanModalOpen(false)} disabled={isScanning}>&times;</button>
            
            <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.8rem' }}>
              <h2 style={{ fontSize: '1.4rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>🔍</span> Máy Quét Sideways Biên Độ Thấp
              </h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                Quét 45 token hoạt động hàng đầu trên Binance Alpha, tìm các đồng coin tích lũy với biên độ dao động hẹp.
              </p>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 'bold' }}>Chu kỳ tích lũy:</span>
                <div className="chart-interval-selector">
                  <button 
                    className={scanInterval === '1d' && scanLimit === 5 ? 'active' : ''} 
                    onClick={() => { setScanInterval('1d'); setScanLimit(5); }}
                    disabled={isScanning}
                    style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                  >
                    📅 Khung 1 Ngày (Tích lũy 4-5 ngày)
                  </button>
                  <button 
                    className={scanInterval === '4h' && scanLimit === 7 ? 'active' : ''} 
                    onClick={() => { setScanInterval('4h'); setScanLimit(7); }}
                    disabled={isScanning}
                    style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                  >
                    ⏱️ Khung 4 Giờ (Tích lũy 6-7 nến)
                  </button>
                </div>
              </div>
            </div>

            {isScanning ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 1rem', gap: '1rem' }}>
                <div className="pulse-animation" style={{ fontSize: '2.5rem' }}>⚡</div>
                <div style={{ fontSize: '1rem', fontWeight: 'bold', color: 'var(--primary-cyan)' }}>Đang phân tích các kline nến của Binance...</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'center', maxWidth: '400px' }}>
                  Hệ thống đang truy cập dữ liệu kline ({scanInterval === '1d' ? '5 ngày qua' : '7 nến 4h qua'}) của từng token, tính toán biên độ đỉnh-đáy và sắp xếp mức độ tích lũy. Vui lòng đợi trong giây lát...
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {scanResults && scanResults.length > 0 ? (
                  <>
                    <div style={{ maxHeight: '55vh', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.1)' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', textAlign: 'left' }}>
                        <thead>
                          <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                            <th style={{ padding: '0.8rem 1rem' }}>Hạng</th>
                            <th style={{ padding: '0.8rem 1rem' }}>Đồng coin</th>
                            <th style={{ padding: '0.8rem 1rem' }}>Giá</th>
                            <th style={{ padding: '0.8rem 1rem' }}>Vol 24h</th>
                            <th style={{ padding: '0.8rem 1rem' }}>Biên độ ({scanInterval === '1d' ? '5 ngày' : '7 nến 4h'})</th>
                            <th style={{ padding: '0.8rem 1rem', textAlign: 'right' }}>Thao tác</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scanResults.map((r, index) => {
                            const isVeryLow = r.amplitude <= 5;
                            const isLow = r.amplitude <= 10;
                            const ampColor = isVeryLow ? 'var(--trend-up)' : isLow ? 'var(--primary-cyan)' : 'var(--text-secondary)';
                            const ampText = isVeryLow ? 'Cực thấp (Tích lũy chặt)' : isLow ? 'Thấp (Sideways)' : 'Trung bình';

                            return (
                              <tr 
                                key={r.tokenId} 
                                style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer' }}
                                onClick={() => handleSelectFromScan(r)}
                                className="scan-row-hover"
                              >
                                <td style={{ padding: '0.8rem 1rem', fontFamily: 'monospace', fontWeight: 'bold' }}>#{index + 1}</td>
                                <td style={{ padding: '0.8rem 1rem' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div className="token-avatar" style={{ width: '24px', height: '24px', fontSize: '0.7rem', position: 'relative', overflow: 'hidden', padding: 0 }}>
                                      {r.iconUrl ? (
                                        <Image 
                                          src={r.iconUrl} 
                                          alt={r.symbol} 
                                          fill
                                          sizes="24px"
                                          style={{ borderRadius: '50%', objectFit: 'cover' }} 
                                        />
                                      ) : (
                                        <span>{r.symbol.slice(0,2)}</span>
                                      )}
                                    </div>
                                    <div>
                                      <div style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>{r.symbol}</div>
                                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{r.name}</div>
                                    </div>
                                  </div>
                                </td>
                                <td style={{ padding: '0.8rem 1rem', fontWeight: '500' }}>
                                  {r.price < 0.0001 ? `$${r.price.toFixed(8)}` : r.price < 1 ? `$${r.price.toFixed(4)}` : `$${r.price.toFixed(2)}`}
                                </td>
                                <td style={{ padding: '0.8rem 1rem', color: 'var(--text-secondary)' }}>
                                  ${(r.volume24h / 1e6).toFixed(2)}M
                                </td>
                                <td style={{ padding: '0.8rem 1rem' }}>
                                  <div style={{ fontWeight: 'bold', color: ampColor }}>
                                    {r.amplitude.toFixed(2)}%
                                  </div>
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                                    {ampText}
                                  </div>
                                </td>
                                <td style={{ padding: '0.8rem 1rem', textAlign: 'right' }}>
                                  <button 
                                    className="action-btn" 
                                    style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem' }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSelectFromScan(r);
                                    }}
                                  >
                                    Xem Chart 📈
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                    Không có kết quả quét nào được tìm thấy. Vui lòng thử lại.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="footer-section">
        <p>
          Dữ liệu được cập nhật trực tiếp từ API Binance Alpha. Phát triển bằng Next.js & Vanilla CSS.
        </p>
        <p style={{ marginTop: '0.5rem' }}>
          &copy; 2026 Binance Alpha Dashboard. Dành cho mục đích tham khảo thông tin thị trường.
        </p>
      </footer>
    </main>
  );
}
