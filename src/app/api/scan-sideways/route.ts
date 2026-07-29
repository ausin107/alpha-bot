import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const interval = searchParams.get('interval') || '1d';
    const limit = parseInt(searchParams.get('limit') || (interval === '4h' ? '7' : '5'), 10);

    // 1. Fetch the complete list of alpha tokens
    const tokensRes = await fetch(
      'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        next: { revalidate: 300 }, // Cache complete list for 5 minutes
      }
    );

    if (!tokensRes.ok) {
      return NextResponse.json(
        { error: `Failed to fetch token list: ${tokensRes.statusText}` },
        { status: tokensRes.status }
      );
    }

    const tokensJson = await tokensRes.json();
    const tokenList = tokensJson.data || tokensJson;

    if (!Array.isArray(tokenList)) {
      return NextResponse.json({ error: 'Invalid token list format' }, { status: 500 });
    }

    // 2. Filter active tokens and sort by 24h volume descending (excluding tokenized stocks ending with lowercase 'on')
    const activeTokens = tokenList
      .filter((t: any) => !t.offline && !t.fullyDelisted && parseFloat(t.volume24h) > 5000 && !t.symbol.endsWith('on'))
      .sort((a: any, b: any) => parseFloat(b.volume24h) - parseFloat(a.volume24h))
      .slice(0, 45); // Focus on top 45 active tokens

    const scanResults: any[] = [];
    
    // Concurrency Helper: process in batches of 5 to avoid hitting Binance rate limits
    const batchSize = 5;
    for (let i = 0; i < activeTokens.length; i += batchSize) {
      const batch = activeTokens.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (token: any) => {
        const alphaId = token.alphaId;
        const tradingSymbol = alphaId.startsWith('ALPHA_') ? `${alphaId}USDT` : `ALPHA_${alphaId}USDT`;
        const klinesUrl = `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?symbol=${tradingSymbol}&interval=${interval}&limit=${limit}`;
        
        try {
          const klinesRes = await fetch(klinesUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            next: { revalidate: 300 }, // Cache individual klines for 5 minutes
          });
          
          if (!klinesRes.ok) return null;
          
          const klinesJson = await klinesRes.json();
          const klines = klinesJson.data || klinesJson;
          
          if (Array.isArray(klines) && klines.length >= 3) {
            const closePrices = klines.map((k: any) => parseFloat(k[4]));
            const minPrice = Math.min(...closePrices);
            const maxPrice = Math.max(...closePrices);
            
            // Avoid division by zero
            if (minPrice === 0) return null;
            const amplitude = ((maxPrice - minPrice) / minPrice) * 100;
            
            return {
              tokenId: token.tokenId,
              alphaId: token.alphaId,
              symbol: token.symbol,
              name: token.name,
              iconUrl: token.iconUrl,
              price: parseFloat(token.price),
              percentChange24h: parseFloat(token.percentChange24h),
              volume24h: parseFloat(token.volume24h),
              amplitude,
              prices: closePrices,
            };
          }
        } catch (err) {
          console.error(`Error scanning klines for ${token.symbol}:`, err);
        }
        return null;
      });
      
      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach((r) => {
        if (r !== null) scanResults.push(r);
      });

      // Brief sleep between batches
      if (i + batchSize < activeTokens.length) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }

    // Sort by amplitude ascending (lowest volatility/sideways first)
    scanResults.sort((a, b) => a.amplitude - b.amplitude);

    return NextResponse.json({
      success: true,
      data: scanResults,
      interval,
      limit,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
