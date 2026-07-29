'use client';

import React, { useState, useRef, useEffect } from 'react';

interface TokenChartProps {
  symbol: string;
  alphaId: string;
}

interface KlinePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export default function TokenChart({ symbol, alphaId }: TokenChartProps) {
  const [interval, setIntervalState] = useState<string>('1h');
  const [chartType, setChartType] = useState<'candle' | 'area'>('candle');
  const [klines, setKlines] = useState<KlinePoint[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Interaction states for tooltip and vertical tracker line
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Zoom & Pan states
  const [visibleCount, setVisibleCount] = useState<number>(80);
  const [scrollOffset, setScrollOffset] = useState<number>(0);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragRef = useRef({ startX: 0, startOffset: 0 });
  const stateRef = useRef({ klines, scrollOffset, visibleCount });

  useEffect(() => {
    stateRef.current = { klines, scrollOffset, visibleCount };
  }, [klines, scrollOffset, visibleCount]);

  // Map alphaId format (like ALPHA_175 or just 175) to trading pair (e.g. ALPHA_175USDT)
  const getTradingSymbol = () => {
    // If it's already structured, use it. Otherwise construct.
    if (alphaId.startsWith('ALPHA_')) {
      return `${alphaId}USDT`;
    }
    return `ALPHA_${alphaId}USDT`;
  };

  useEffect(() => {
    const fetchKlines = async () => {
      setIsLoading(true);
      setError(null);
      setHoverIndex(null);
      setTooltipPos(null);
      try {
        const tradingSymbol = getTradingSymbol();
        const limit = interval === '1d' ? 365 : interval === '4h' ? 300 : interval === '1h' ? 200 : 100;
        const res = await fetch(`/api/klines?symbol=${tradingSymbol}&interval=${interval}&limit=${limit}`);
        
        if (!res.ok) {
          throw new Error(`Error: ${res.statusText}`);
        }
        
        const json = await res.json();
        
        // Handle wrapping in data or direct list format
        let rawKlines: any[] = [];
        if (Array.isArray(json)) {
          rawKlines = json;
        } else if (json && Array.isArray(json.data)) {
          rawKlines = json.data;
        } else if (json && json.success && Array.isArray(json.data)) {
          rawKlines = json.data;
        }

        if (rawKlines.length === 0) {
          throw new Error('Không có dữ liệu kline cho đồng coin này.');
        }

        const points: KlinePoint[] = rawKlines.map((k: any) => ({
          time: Number(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }));

        // Sort by time ascending
        points.sort((a, b) => a.time - b.time);
        setKlines(points);
        const defaultVisible = Math.min(80, points.length);
        setVisibleCount(defaultVisible);
        setScrollOffset(points.length - defaultVisible);
      } catch (err: any) {
        setError(err.message || 'Lỗi khi tải dữ liệu biểu đồ');
      } finally {
        setIsLoading(false);
      }
    };

    fetchKlines();
  }, [alphaId, interval]);

  // Handle mouse down to start panning
  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    if (klines.length === 0) return;
    e.preventDefault(); // Prevent text selection and default browser drag
    setIsDragging(true);
    const rect = svgRef.current?.getBoundingClientRect();
    const x = e.clientX - (rect?.left || 0);
    dragRef.current = { startX: x, startOffset: scrollOffset };
  };

  // Handle drag panning and hover cursor tracker
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    if (!svgRef.current || klines.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const width = rect.width;
    const padding = 15;
    const chartWidth = width - padding * 2;

    if (isDragging) {
      const dx = x - dragRef.current.startX;
      const candleWidth = chartWidth / visibleCount;
      const indexDelta = Math.round(dx / candleWidth);
      
      const newOffset = dragRef.current.startOffset - indexDelta;
      setScrollOffset(Math.max(0, Math.min(klines.length - visibleCount, newOffset)));
      setHoverIndex(null); // Clear tooltip during pan
      setTooltipPos(null);
    } else {
      // Hover tracking in the visible segment
      const percentX = Math.max(0, Math.min(1, (x - padding) / chartWidth));
      const relativeIndex = Math.round(percentX * (visibleCount - 1));
      const actualIndex = scrollOffset + relativeIndex;

      if (actualIndex >= 0 && actualIndex < klines.length) {
        setHoverIndex(actualIndex);
        setTooltipPos({ x: e.clientX - rect.left + 15, y: Math.max(10, y - 50) });
      }
    }
  };

  // Native wheel listener for non-passive prevention of parent scroll on the wrapper div
  useEffect(() => {
    const wrapperEl = wrapperRef.current;
    if (!wrapperEl) return;

    const handleNativeWheel = (e: WheelEvent) => {
      e.preventDefault(); // Cancel default parent scroll
      
      const currentKlines = stateRef.current.klines;
      if (currentKlines.length === 0) return;

      const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85; // Scroll down zooms out, scroll up zooms in
      
      setVisibleCount((prev) => {
        const nextCount = Math.round(prev * zoomFactor);
        const clamped = Math.max(12, Math.min(currentKlines.length, nextCount));
        
        setScrollOffset((prevOffset) => {
          const diff = prev - clamped;
          const newOffset = prevOffset + Math.round(diff / 2);
          return Math.max(0, Math.min(currentKlines.length - clamped, newOffset));
        });
        
        return clamped;
      });
    };

    wrapperEl.addEventListener('wheel', handleNativeWheel, { passive: false });

    return () => {
      wrapperEl.removeEventListener('wheel', handleNativeWheel);
    };
  }, []);

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
    setHoverIndex(null);
    setTooltipPos(null);
  };

  // Render SVG Elements
  const renderChart = () => {
    if (klines.length === 0) return null;

    const width = 1000; // Increased width for the modal layout
    const height = 220;
    const paddingLeftRight = 15;
    const paddingTopBottom = 20;

    const chartWidth = width - paddingLeftRight * 2;
    const chartHeight = height - paddingTopBottom * 2;

    // Slice active range
    const visibleKlines = klines.slice(scrollOffset, scrollOffset + visibleCount);
    if (visibleKlines.length === 0) return null;

    const closePrices = visibleKlines.map((k) => k.close);
    const highPrices = visibleKlines.map((k) => k.high);
    const lowPrices = visibleKlines.map((k) => k.low);

    // Dynamic price boundaries of visible range
    const minPrice = chartType === 'candle' ? Math.min(...lowPrices) * 0.9995 : Math.min(...closePrices) * 0.9998;
    const maxPrice = chartType === 'candle' ? Math.max(...highPrices) * 1.0005 : Math.max(...closePrices) * 1.0002;
    const priceDiff = maxPrice - minPrice || 1;

    // Generate path points inside visible range
    const points = visibleKlines.map((k, i) => {
      const x = paddingLeftRight + (i / (visibleKlines.length - 1)) * chartWidth;
      const yClose = paddingTopBottom + chartHeight - ((k.close - minPrice) / priceDiff) * chartHeight;
      const yOpen = paddingTopBottom + chartHeight - ((k.open - minPrice) / priceDiff) * chartHeight;
      const yHigh = paddingTopBottom + chartHeight - ((k.high - minPrice) / priceDiff) * chartHeight;
      const yLow = paddingTopBottom + chartHeight - ((k.low - minPrice) / priceDiff) * chartHeight;
      return { x, y: yClose, yClose, yOpen, yHigh, yLow, actualIndex: scrollOffset + i, ...k };
    });

    // Hover index matching
    const activePoint = hoverIndex !== null && hoverIndex >= scrollOffset && hoverIndex < scrollOffset + visibleCount 
      ? points[hoverIndex - scrollOffset] 
      : null;

    // Determine if overall trend of visible segment is positive
    const firstPrice = visibleKlines[0].close;
    const lastPrice = visibleKlines[visibleKlines.length - 1].close;
    const isUpTrend = lastPrice >= firstPrice;
    
    const strokeGradientId = `chart-stroke-${alphaId}`;
    const fillGradientId = `chart-fill-${alphaId}`;

    return (
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={{ cursor: isDragging ? 'grabbing' : 'crosshair', overflow: 'visible', userSelect: 'none' }}
      >
        <defs>
          <linearGradient id={strokeGradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={isUpTrend ? '#00e676' : '#ff3860'} stopOpacity="0.8" />
            <stop offset="100%" stopColor={isUpTrend ? '#00f2fe' : '#ff7675'} stopOpacity="1" />
          </linearGradient>
          <linearGradient id={fillGradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={isUpTrend ? '#00f2fe' : '#ff3860'} stopOpacity="0.25" />
            <stop offset="100%" stopColor={isUpTrend ? '#00f2fe' : '#ff3860'} stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {chartType === 'area' ? (
          <>
            {/* Area path */}
            <path
              d={`${points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')} L ${points[points.length - 1].x} ${height - paddingTopBottom} L ${points[0].x} ${height - paddingTopBottom} Z`}
              fill={`url(#${fillGradientId})`}
            />
            {/* Stroke path */}
            <path
              d={points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')}
              fill="none"
              stroke={`url(#${strokeGradientId})`}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          /* Candlestick Render */
          <g>
            {points.map((p, i) => {
              const isBullish = p.close >= p.open;
              const color = isBullish ? 'var(--trend-up)' : 'var(--trend-down)';
              const bodyTop = Math.min(p.yOpen, p.yClose);
              const bodyBottom = Math.max(p.yOpen, p.yClose);
              const bodyHeight = Math.max(1, bodyBottom - bodyTop);
              const candleWidth = Math.max(2, (chartWidth / points.length) * 0.75);

              return (
                <g key={i}>
                  {/* Wick (High to Low) */}
                  <line
                    x1={p.x}
                    y1={p.yHigh}
                    x2={p.x}
                    y2={p.yLow}
                    stroke={color}
                    strokeWidth="1.2"
                  />
                  {/* Body (Open to Close) */}
                  <rect
                    x={p.x - candleWidth / 2}
                    y={bodyTop}
                    width={candleWidth}
                    height={bodyHeight}
                    fill={isBullish ? 'rgba(0, 230, 118, 0.18)' : 'var(--trend-down)'}
                    stroke={color}
                    strokeWidth="1"
                    rx="1"
                  />
                </g>
              );
            })}
          </g>
        )}

        {/* Hover elements */}
        {activePoint && (
          <>
            {/* Vertical tracking line */}
            <line
              x1={activePoint.x}
              y1={paddingTopBottom}
              x2={activePoint.x}
              y2={height - paddingTopBottom}
              stroke="rgba(255, 255, 255, 0.15)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            {/* Glowing circle point */}
            <circle
              cx={activePoint.x}
              cy={activePoint.y}
              r="6"
              fill={activePoint.close >= activePoint.open ? '#00f2fe' : '#ff3860'}
              stroke="#ffffff"
              strokeWidth="2"
              style={{ filter: 'drop-shadow(0 0 4px rgba(0, 242, 254, 0.8))' }}
            />
          </>
        )}
      </svg>
    );
  };

  const formatPrice = (val: number) => {
    if (val < 0.0001) return `$${val.toFixed(8)}`;
    if (val < 0.01) return `$${val.toFixed(6)}`;
    if (val < 1) return `$${val.toFixed(4)}`;
    return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const getTooltipDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString('vi-VN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Dynamic values for the selected point
  const hoveredPoint = hoverIndex !== null ? klines[hoverIndex] : null;

  return (
    <div className="chart-container">
      <div className="chart-header">
        <div className="chart-title">
          {hoveredPoint ? (
            <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>
              Giá: {formatPrice(hoveredPoint.close)} (Open: {formatPrice(hoveredPoint.open)} | H: {formatPrice(hoveredPoint.high)} | L: {formatPrice(hoveredPoint.low)})
            </span>
          ) : (
            'Lịch sử giá (Kline)'
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="chart-interval-selector">
            {['candle', 'area'].map((type) => (
              <button
                key={type}
                className={chartType === type ? 'active' : ''}
                onClick={() => setChartType(type as 'candle' | 'area')}
                style={{ fontSize: '0.7rem' }}
              >
                {type === 'candle' ? '🕯️ Candle' : '📈 Area'}
              </button>
            ))}
          </div>

          <div className="chart-interval-selector">
            {['15m', '1h', '4h', '1d'].map((item) => (
              <button
                key={item}
                className={interval === item ? 'active' : ''}
                onClick={() => setIntervalState(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div ref={wrapperRef} className="chart-svg-wrapper">
        {isLoading ? (
          <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <div className="skeleton" style={{ width: '100%', height: '100%' }} />
          </div>
        ) : error ? (
          <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--trend-down)', fontSize: '0.8rem' }}>
            ⚠️ {error}
          </div>
        ) : (
          renderChart()
        )}

        {/* Floating Tooltip HTML */}
        {hoveredPoint && tooltipPos && (
          <div
            className="chart-tooltip"
            style={{
              left: `${tooltipPos.x}px`,
              top: `${tooltipPos.y}px`,
            }}
          >
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
              {getTooltipDate(hoveredPoint.time)}
            </span>
            <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>
              C: {formatPrice(hoveredPoint.close)}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
              Vol: {hoveredPoint.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
