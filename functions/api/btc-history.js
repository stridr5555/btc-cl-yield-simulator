const DAY_MS = 86_400_000

function isoDate(time) {
  return new Date(time).toISOString().slice(0, 10)
}

function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      ...(init.headers ?? {}),
    },
  })
}

async function fetchYahooHistory(start, end) {
  const url = new URL('https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD')
  url.searchParams.set('period1', String(Math.floor(start / 1000)))
  url.searchParams.set('period2', String(Math.floor(end / 1000)))
  url.searchParams.set('interval', '1d')
  url.searchParams.set('events', 'history')

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 compatible btc-cl-yield-simulator',
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`)

  const payload = await response.json()
  const result = payload.chart?.result?.[0]
  const timestamps = result?.timestamp ?? []
  const closes = result?.indicators?.quote?.[0]?.close ?? []

  return timestamps
    .map((timestamp, index) => ({
      date: isoDate(timestamp * 1000),
      price: Number(closes[index]),
      source: 'Yahoo Finance BTC-USD daily close',
    }))
    .filter((point) => Number.isFinite(point.price) && point.price > 0)
}

async function fetchBinanceHistory(start, end) {
  const prices = []
  let cursor = start

  for (let page = 0; page < 20 && cursor <= end; page += 1) {
    const url = new URL('https://api.binance.us/api/v3/klines')
    url.searchParams.set('symbol', 'BTCUSDT')
    url.searchParams.set('interval', '1d')
    url.searchParams.set('startTime', String(cursor))
    url.searchParams.set('endTime', String(end))
    url.searchParams.set('limit', '1000')

    const response = await fetch(url)
    if (!response.ok) throw new Error(`Binance.US returned ${response.status}`)

    const candles = await response.json()
    if (!Array.isArray(candles) || candles.length === 0) break

    candles.forEach((candle) => {
      prices.push({
        date: isoDate(candle[0]),
        price: Number(candle[4]),
        source: 'Binance.US BTCUSDT daily close',
      })
    })

    const lastOpen = Number(candles.at(-1)?.[0])
    cursor = lastOpen + DAY_MS
  }

  return prices
}

export async function onRequestGet({ request }) {
  const requestUrl = new URL(request.url)
  const startDate = requestUrl.searchParams.get('startDate')
  const endDate = requestUrl.searchParams.get('endDate')
  const start = new Date(`${startDate}T00:00:00Z`).getTime()
  const end = new Date(`${endDate}T23:59:59Z`).getTime()

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    return json({ error: 'Invalid startDate/endDate' }, { status: 400 })
  }

  try {
    let prices = await fetchBinanceHistory(start, end)
    if (prices.length === 0) prices = await fetchYahooHistory(start, end)

    return json({ prices })
  } catch (binanceError) {
    try {
      const prices = await fetchYahooHistory(start, end)
      return json({ prices })
    } catch (yahooError) {
      return json({ error: `${binanceError.message}; ${yahooError.message}` }, { status: 502 })
    }
  }
}
