import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const res = await fetch(
      'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        next: { revalidate: 10 }, // Cache for 10 seconds to stay fresh but avoid hitting rate limits
      }
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to fetch from Binance: ${res.status} ${res.statusText}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    if (data && Array.isArray(data.data)) {
      data.data = data.data.filter((t: any) => !t.symbol.endsWith('on'));
    }
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
