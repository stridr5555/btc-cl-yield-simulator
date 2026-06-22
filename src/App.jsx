import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  BarChart3,
  CalendarDays,
  CircleDollarSign,
  Download,
  Info,
  LineChart as LineIcon,
  RefreshCcw,
  SlidersHorizontal,
  Wallet,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

const DAY_MS = 86_400_000

function toIsoDate(date) {
  return date.toISOString().slice(0, 10)
}

function dateYearsAgo(years, endDate = new Date()) {
  const date = new Date(endDate)
  date.setDate(date.getDate() - Math.round(years * 365))
  return toIsoDate(date)
}

const DEFAULTS = {
  initialValue: 10_000,
  apr: 500,
  rangePct: 4,
  compoundThreshold: 2,
  harvestThreshold: 50,
  startDate: dateYearsAgo(4),
  endDate: toIsoDate(new Date()),
  spendHarvests: true,
  rebalanceMode: 'auto',
  rebalanceDelayHours: 36,
}

function formatUsd(value, digits = 0) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0)
}

function formatPct(value, digits = 1) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(digits)}%`
}

function compactUsd(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)
}

function niceDate(date) {
  const parsedDate =
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
      : new Date(date)

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  }).format(parsedDate)
}

function syntheticBtcSeries(startDate = DEFAULTS.startDate, endDate = DEFAULTS.endDate) {
  const points = []
  const start = new Date(`${startDate}T00:00:00`).getTime()
  const end = new Date(`${endDate}T00:00:00`).getTime()
  const totalDays = Math.max(1, Math.round((end - start) / DAY_MS))
  const anchors = [
    [0, 29_500],
    [0.12, 19_200],
    [0.27, 16_200],
    [0.45, 30_500],
    [0.62, 43_000],
    [0.78, 69_000],
    [0.9, 96_000],
    [1, 108_000],
  ]

  for (let i = 0; i <= totalDays; i += 1) {
    const t = i / totalDays
    const upperIndex = anchors.findIndex(([x]) => x >= t)
    const hi = anchors[Math.max(upperIndex, 1)]
    const lo = anchors[Math.max(upperIndex - 1, 0)]
    const span = hi[0] - lo[0] || 1
    const local = (t - lo[0]) / span
    const trend = lo[1] + (hi[1] - lo[1]) * local
    const cycle = Math.sin(i / 17) * 0.025 + Math.sin(i / 53) * 0.055
    points.push({
      date: new Date(start + i * DAY_MS).toISOString().slice(0, 10),
      price: Math.max(1_000, trend * (1 + cycle)),
      source: 'fallback',
    })
  }
  return points
}

async function fetchBtcHistory(startDate, endDate) {
  const url = `/api/btc-history?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`BTC history API returned ${response.status}`)
  const payload = await response.json()
  const seen = new Map()
  payload.prices.forEach(({ date, price, source }) => {
    if (Number.isFinite(price) && price > 0) seen.set(date, { date, price, source })
  })
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function sqrtPrice(price) {
  return Math.sqrt(Math.max(price, 0.00000001))
}

function liquidityUnitAmounts(price, lower, upper) {
  const sqrtP = sqrtPrice(price)
  const sqrtA = sqrtPrice(lower)
  const sqrtB = sqrtPrice(upper)

  if (price <= lower) {
    return {
      btc: (sqrtB - sqrtA) / (sqrtA * sqrtB),
      stable: 0,
    }
  }

  if (price >= upper) {
    return {
      btc: 0,
      stable: sqrtB - sqrtA,
    }
  }

  return {
    btc: (sqrtB - sqrtP) / (sqrtP * sqrtB),
    stable: sqrtP - sqrtA,
  }
}

function createPosition(value, price, rangePct) {
  const half = rangePct / 100
  const lower = price * (1 - half)
  const upper = price * (1 + half)
  return createPositionWithBounds(value, price, lower, upper)
}

function createPositionWithBounds(value, price, lower, upper) {
  const unit = liquidityUnitAmounts(price, lower, upper)
  const unitValue = unit.btc * price + unit.stable
  const liquidity = unitValue > 0 ? value / unitValue : 0
  return {
    liquidity,
    lower,
    upper,
    center: price,
    rangeValue: value,
  }
}

function valuePosition(position, price) {
  const unit = liquidityUnitAmounts(price, position.lower, position.upper)
  const btc = unit.btc * position.liquidity
  const stable = unit.stable * position.liquidity
  return {
    btc,
    stable,
    value: btc * price + stable,
    btcShare: btc * price,
    stableShare: stable,
  }
}

function simulateStrategy(points, settings, mode) {
  if (!points.length) return []

  let position = createPosition(settings.initialValue, points[0].price, settings.rangePct)
  const initialHold = valuePosition(position, points[0].price)
  const initialBtc = settings.initialValue / points[0].price
  const initialHalfBtc = settings.initialValue / 2 / points[0].price
  const initialHalfStable = settings.initialValue / 2
  let pendingFees = 0
  let totalFees = 0
  let spent = 0
  let compounds = 0
  let harvests = 0
  let rebalances = 0
  let maxValue = settings.initialValue
  let daysInRange = 0
  let outOfRangeDays = 0
  const delayedRebalanceDays = Math.max(1, Math.ceil(settings.rebalanceDelayHours / 24))

  return points.map((point, index) => {
    let current = valuePosition(position, point.price)
    const outOfRange = point.price < position.lower || point.price > position.upper
    outOfRangeDays = outOfRange ? outOfRangeDays + 1 : 0

    const shouldRebalance =
      index > 0 &&
      outOfRange &&
      (settings.rebalanceMode === 'auto' ||
        (settings.rebalanceMode === 'passive' && outOfRangeDays >= delayedRebalanceDays))

    if (shouldRebalance) {
      position = createPosition(current.value, point.price, settings.rangePct)
      current = valuePosition(position, point.price)
      rebalances += 1
      outOfRangeDays = 0
    }

    const inRange = point.price >= position.lower && point.price <= position.upper
    if (inRange) {
      daysInRange += 1
      const dailyFees = current.value * (settings.apr / 100 / 365)
      pendingFees += dailyFees
      totalFees += dailyFees
    }

    if (mode === 'compound') {
      const eventCount =
        settings.compoundThreshold > 0 ? Math.floor(pendingFees / settings.compoundThreshold) : 0
      const reinvestAmount = eventCount * settings.compoundThreshold
      if (reinvestAmount > 0 && (settings.rebalanceMode === 'auto' || inRange)) {
        current = valuePosition(position, point.price)
        position =
          settings.rebalanceMode === 'auto'
            ? createPosition(current.value + reinvestAmount, point.price, settings.rangePct)
            : createPositionWithBounds(current.value + reinvestAmount, point.price, position.lower, position.upper)
        pendingFees -= reinvestAmount
        compounds += eventCount
      }
    } else {
      const eventCount =
        settings.harvestThreshold > 0 ? Math.floor(pendingFees / settings.harvestThreshold) : 0
      const harvestAmount = eventCount * settings.harvestThreshold
      if (harvestAmount > 0) {
        pendingFees -= harvestAmount
        spent += settings.spendHarvests ? harvestAmount : 0
        harvests += eventCount
      }
    }

    current = valuePosition(position, point.price)
    const walletValue = current.value + pendingFees + spent
    maxValue = Math.max(maxValue, walletValue)
    const hodlValue = initialHold.btc * point.price + initialHold.stable
    const pureBtcValue = initialBtc * point.price
    const balancedHoldValue = initialHalfBtc * point.price + initialHalfStable

    return {
      date: point.date,
      label: niceDate(point.date),
      price: point.price,
      lower: position.lower,
      upper: position.upper,
      btc: current.btc,
      stable: current.stable,
      btcShare: current.btcShare,
      stableShare: current.stableShare,
      lpValue: current.value,
      pendingFees,
      totalFees,
      spent,
      walletValue,
      hodlValue,
      pureBtcValue,
      balancedHoldValue,
      sqrtDragVsBtc: pureBtcValue > 0 ? ((current.value - pureBtcValue) / pureBtcValue) * 100 : 0,
      sqrtDragVs5050:
        balancedHoldValue > 0 ? ((current.value - balancedHoldValue) / balancedHoldValue) * 100 : 0,
      ilVsHodl: hodlValue > 0 ? ((current.value + pendingFees - hodlValue) / hodlValue) * 100 : 0,
      drawdown: maxValue > 0 ? ((walletValue - maxValue) / maxValue) * 100 : 0,
      inRange: inRange ? 1 : 0,
      outOfRangeDays,
      rebalances,
      compounds,
      harvests,
      daysInRange,
    }
  })
}

function buildSimulation(points, settings) {
  const compound = simulateStrategy(points, settings, 'compound')
  const harvest = simulateStrategy(points, settings, 'harvest')

  return compound.map((row, index) => {
    const other = harvest[index]
    return {
      ...row,
      compoundValue: row.walletValue,
      compoundLp: row.lpValue,
      compoundFees: row.totalFees,
      compoundPending: row.pendingFees,
      compoundDrawdown: row.drawdown,
      compoundIl: row.ilVsHodl,
      compoundRebalances: row.rebalances,
      compoundBtcShare: row.btcShare,
      compoundStableShare: row.stableShare,
      harvestValue: other.walletValue,
      harvestLp: other.lpValue,
      harvestSpent: other.spent,
      harvestFees: other.totalFees,
      harvestPending: other.pendingFees,
      harvestDrawdown: other.drawdown,
      harvestIl: other.ilVsHodl,
      harvestRebalances: other.rebalances,
      harvestBtcShare: other.btcShare,
      harvestStableShare: other.stableShare,
      hodlValue: row.hodlValue,
      pureBtcValue: row.pureBtcValue,
      balancedHoldValue: row.balancedHoldValue,
      sqrtDragVsBtc: row.sqrtDragVsBtc,
      sqrtDragVs5050: row.sqrtDragVs5050,
      lower: row.lower,
      upper: row.upper,
      compoundEvents: row.compounds,
      harvestEvents: other.harvests,
      inRange: row.inRange,
    }
  })
}

function metricDelta(finalValue, initialValue) {
  return ((finalValue - initialValue) / initialValue) * 100
}

function chartSample(rows, target = 420) {
  const stride = Math.max(1, Math.floor(rows.length / target))
  return rows.filter((_, index) => index % stride === 0 || index === rows.length - 1)
}

function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`).getTime()
  const end = new Date(`${endDate}T00:00:00`).getTime()
  return Math.max(1, Math.round((end - start) / DAY_MS))
}

function Kpi({ icon: Icon, label, value, hint, accent }) {
  return (
    <div className="kpi">
      <div className="kpi-icon" style={{ color: accent }}>
        <Icon size={18} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{hint}</small>
      </div>
    </div>
  )
}

function Field({ label, value, suffix, min, max, step, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-row">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {suffix && <em>{suffix}</em>}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function DateField({ label, value, min, max, onChange }) {
  return (
    <label className="field date-field">
      <span>{label}</span>
      <div className="input-row">
        <input
          type="date"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </label>
  )
}

function App() {
  const [settings, setSettings] = useState(DEFAULTS)
  const [history, setHistory] = useState(() => syntheticBtcSeries(DEFAULTS.startDate, DEFAULTS.endDate))
  const [source, setSource] = useState('Fallback cycle data while live BTC loads')
  const [focus, setFocus] = useState('overview')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fallback = syntheticBtcSeries(settings.startDate, settings.endDate)
    setHistory(fallback)
    setSource('Fallback cycle data while live BTC loads')
    setLoading(true)
    fetchBtcHistory(settings.startDate, settings.endDate)
      .then((rows) => {
        if (!cancelled && rows.length > 20) {
          setHistory(rows)
          setSource(rows[0]?.source ?? 'BTC/USD range history')
        }
      })
      .catch((error) => {
        if (!cancelled) setSource(`Fallback cycle data (${error.message})`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [settings.startDate, settings.endDate])

  const simulation = useMemo(() => buildSimulation(history, settings), [history, settings])
  const rows = useMemo(() => chartSample(simulation, 700), [simulation])
  const final = simulation.at(-1) ?? {}
  const first = simulation[0] ?? {}
  const selectedDays = daysBetween(settings.startDate, settings.endDate)
  const bear = useMemo(
    () => history.reduce((low, point) => (point.price < low.price ? point : low), history[0] ?? { price: 0 }),
    [history],
  )
  const top = useMemo(
    () => history.reduce((high, point) => (point.price > high.price ? point : high), history[0] ?? { price: 0 }),
    [history],
  )

  const allocation = [
    { name: 'Compound BTC', value: final.compoundBtcShare ?? 0, fill: '#167a7f' },
    { name: 'Compound Stable', value: final.compoundStableShare ?? 0, fill: '#9fb7bd' },
    { name: 'Harvest BTC', value: final.harvestBtcShare ?? 0, fill: '#2364aa' },
    { name: 'Harvest Stable', value: final.harvestStableShare ?? 0, fill: '#e0a32f' },
  ]

  const eventData = [
    { name: 'Compounds', value: final.compoundEvents ?? 0, fill: '#167a7f' },
    { name: 'Harvests', value: final.harvestEvents ?? 0, fill: '#e0a32f' },
    { name: 'Rebalances', value: final.compoundRebalances ?? 0, fill: '#c6533f' },
  ]

  function updateSetting(key, value) {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  function setRangeYears(years) {
    const endDate = toIsoDate(new Date())
    setSettings((current) => ({
      ...current,
      startDate: dateYearsAgo(years, new Date(`${endDate}T00:00:00`)),
      endDate,
    }))
  }

  function setFullHistory() {
    setSettings((current) => ({
      ...current,
      startDate: '2013-04-28',
      endDate: toIsoDate(new Date()),
    }))
  }

  function downloadCsv() {
    const headers = [
      'date',
      'btc_price',
      'compound_value',
      'harvest_value',
      'harvest_spent',
      'hodl_value',
      'pure_btc_value',
      'static_50_50_value',
      'range_lower',
      'range_upper',
      'sqrt_drag_vs_btc_pct',
      'sqrt_drag_vs_50_50_pct',
      'compound_il_pct',
      'harvest_il_pct',
    ]
    const lines = simulation.map((row) =>
      [
        row.date,
        row.price,
        row.compoundValue,
        row.harvestValue,
        row.harvestSpent,
        row.hodlValue,
        row.pureBtcValue,
        row.balancedHoldValue,
        row.lower,
        row.upper,
        row.sqrtDragVsBtc,
        row.sqrtDragVs5050,
        row.compoundIl,
        row.harvestIl,
      ].join(','),
    )
    const blob = new Blob([[headers.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'btc-cl-yield-simulation.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="app-shell">
      <aside className="control-panel">
        <div className="brand">
          <div className="mark">
            <Activity size={22} />
          </div>
          <div>
            <h1>BTC CL Yield Lab</h1>
            <p>Concentrated liquidity simulator</p>
          </div>
        </div>

        <div className="panel-section">
          <div className="section-title">
            <SlidersHorizontal size={16} />
            Position Inputs
          </div>
          <Field
            label="Starting portfolio"
            value={settings.initialValue}
            min={1000}
            max={100000}
            step={500}
            suffix="USD"
            onChange={(value) => updateSetting('initialValue', value)}
          />
          <Field
            label="Default APR"
            value={settings.apr}
            min={0}
            max={1000}
            step={25}
            suffix="%"
            onChange={(value) => updateSetting('apr', value)}
          />
          <Field
            label="Rebalance band"
            value={settings.rangePct}
            min={1}
            max={25}
            step={0.5}
            suffix="+/- %"
            onChange={(value) => updateSetting('rangePct', value)}
          />
          <DateField
            label="Start date"
            value={settings.startDate}
            min="2013-04-28"
            max={settings.endDate}
            onChange={(value) => updateSetting('startDate', value)}
          />
          <DateField
            label="End date"
            value={settings.endDate}
            min={settings.startDate}
            max={toIsoDate(new Date())}
            onChange={(value) => updateSetting('endDate', value)}
          />
          <div className="range-presets" aria-label="Quick date ranges">
            <button type="button" onClick={() => setRangeYears(1)}>
              1Y
            </button>
            <button type="button" onClick={() => setRangeYears(4)}>
              4Y
            </button>
            <button type="button" onClick={() => setRangeYears(8)}>
              8Y
            </button>
            <button type="button" onClick={setFullHistory}>
              Max
            </button>
          </div>
        </div>

        <div className="panel-section compact">
          <div className="section-title">
            <RefreshCcw size={16} />
            Cash Flow Rules
          </div>
          <Field
            label="Compound trigger"
            value={settings.compoundThreshold}
            min={1}
            max={50}
            step={1}
            suffix="USD"
            onChange={(value) => updateSetting('compoundThreshold', value)}
          />
          <Field
            label="Harvest trigger"
            value={settings.harvestThreshold}
            min={5}
            max={250}
            step={5}
            suffix="USD"
            onChange={(value) => updateSetting('harvestThreshold', value)}
          />
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.spendHarvests}
              onChange={(event) => updateSetting('spendHarvests', event.target.checked)}
            />
            <span>Count harvested fees as spent cash</span>
          </label>
          <div className="segmented-control" aria-label="Rebalance behavior">
            <span>Rebalance behavior</span>
            <div>
              <button
                type="button"
                className={settings.rebalanceMode === 'auto' ? 'active' : ''}
                onClick={() => updateSetting('rebalanceMode', 'auto')}
              >
                Auto recenter
              </button>
              <button
                type="button"
                className={settings.rebalanceMode === 'passive' ? 'active' : ''}
                onClick={() => updateSetting('rebalanceMode', 'passive')}
              >
                Delayed range
              </button>
            </div>
          </div>
          <Field
            label="Delayed rebalance"
            value={settings.rebalanceDelayHours}
            min={24}
            max={48}
            step={12}
            suffix="hours"
            onChange={(value) => updateSetting('rebalanceDelayHours', value)}
          />
        </div>

        <button type="button" className="download" onClick={downloadCsv}>
          <Download size={16} />
          Export CSV
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h2>Bear-bottom to cycle-top replay</h2>
            <p>
              {source}. {loading ? 'Refreshing live BTC data...' : `${history.length} points loaded.`}{' '}
              Window: {niceDate(settings.startDate)} - {niceDate(settings.endDate)} ({selectedDays} days).
            </p>
          </div>
          <nav className="tabs" aria-label="Chart focus">
            {[
              ['overview', LineIcon, 'Overview'],
              ['risk', BarChart3, 'Risk'],
              ['range', Activity, 'Range'],
            ].map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                className={focus === id ? 'active' : ''}
                onClick={() => setFocus(id)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </nav>
        </header>

        <section className="kpi-grid">
          <Kpi
            icon={Wallet}
            label="Compound every $2"
            value={formatUsd(final.compoundValue)}
            hint={`${formatPct(metricDelta(final.compoundValue, settings.initialValue))} total return`}
            accent="#167a7f"
          />
          <Kpi
            icon={CircleDollarSign}
            label="Harvest $50 and spend"
            value={formatUsd(final.harvestValue)}
            hint={`${formatUsd(final.harvestSpent)} spent from harvested fees`}
            accent="#e0a32f"
          />
          <Kpi
            icon={Activity}
            label="Range low"
            value={formatUsd(bear.price)}
            hint={bear.date ? niceDate(bear.date) : 'No price point'}
            accent="#2364aa"
          />
          <Kpi
            icon={CalendarDays}
            label="Selected window"
            value={`${(selectedDays / 365).toFixed(1)}Y`}
            hint={`High in range: ${formatUsd(top.price)} on ${top.date ? niceDate(top.date) : 'n/a'}`}
            accent="#c6533f"
          />
        </section>

        <section className={`chart-grid ${focus}`}>
          <div className="chart-card primary">
            <div className="chart-head">
              <div>
                <h3>Portfolio value versus BTC price</h3>
                <p>Drag the lower range selector to zoom; hover the lines for exact values.</p>
              </div>
              <span>{first.date ? `${niceDate(first.date)} - ${niceDate(final.date)}` : 'Simulation'}</span>
            </div>
            <ResponsiveContainer width="100%" height={360}>
              <ComposedChart data={rows} syncId="simulation">
                <CartesianGrid stroke="#dce5e7" vertical={false} />
                <XAxis dataKey="label" minTickGap={54} tickLine={false} axisLine={false} />
                <YAxis
                  yAxisId="left"
                  tickFormatter={compactUsd}
                  tickLine={false}
                  axisLine={false}
                  width={70}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickFormatter={compactUsd}
                  tickLine={false}
                  axisLine={false}
                  width={70}
                />
                <Tooltip formatter={(value) => formatUsd(value, 2)} labelFormatter={(value) => value} />
                <Legend />
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="price"
                  name="BTC price"
                  stroke="#9a6840"
                  fill="#f4d9b2"
                  strokeWidth={2}
                  fillOpacity={0.28}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="compoundValue"
                  name="Compound value"
                  stroke="#167a7f"
                  strokeWidth={3}
                  dot={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="harvestValue"
                  name="Harvest + spent"
                  stroke="#e0a32f"
                  strokeWidth={3}
                  dot={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="hodlValue"
                  name="Initial CL tokens held"
                  stroke="#5f6f75"
                  strokeDasharray="5 6"
                  dot={false}
                />
                <Brush
                  dataKey="label"
                  height={28}
                  travellerWidth={10}
                  stroke="#167a7f"
                  fill="#f2f8f8"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-card">
            <div className="chart-head">
              <div>
                <h3>Range and rebalances</h3>
                <p>
                  {settings.rebalanceMode === 'auto'
                    ? 'Band recenters whenever BTC exits the active range.'
                    : `Band waits ${settings.rebalanceDelayHours} hours outside range before re-centering.`}
                </p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={rows} syncId="simulation">
                <CartesianGrid stroke="#dce5e7" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis tickFormatter={compactUsd} tickLine={false} axisLine={false} width={64} />
                <Tooltip formatter={(value) => formatUsd(value, 2)} />
                <Area dataKey="upper" name="Upper band" stroke="#8db8bd" fill="#d8ecee" fillOpacity={0.68} />
                <Area dataKey="lower" name="Lower band" stroke="#8db8bd" fill="#ffffff" fillOpacity={1} />
                <Line dataKey="price" name="BTC price" stroke="#2364aa" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-card">
            <div className="chart-head">
              <div>
                <h3>Drawdown profile</h3>
                <p>Peak-to-trough stress after fee policy effects.</p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={rows} syncId="simulation">
                <CartesianGrid stroke="#dce5e7" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} width={48} />
                <Tooltip formatter={(value) => formatPct(value, 2)} />
                <ReferenceLine y={0} stroke="#8c989b" />
                <Line
                  dataKey="compoundDrawdown"
                  name="Compound drawdown"
                  stroke="#167a7f"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  dataKey="harvestDrawdown"
                  name="Harvest drawdown"
                  stroke="#e0a32f"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-card">
            <div className="chart-head">
              <div>
                <h3>Impermanent loss lens</h3>
                <p>LP principal versus passively holding the deposited BTC/stable amounts.</p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={rows} syncId="simulation">
                <CartesianGrid stroke="#dce5e7" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} width={48} />
                <Tooltip formatter={(value) => formatPct(value, 2)} />
                <ReferenceLine y={0} stroke="#8c989b" />
                <Line dataKey="compoundIl" name="Compound IL lens" stroke="#167a7f" strokeWidth={2} dot={false} />
                <Line dataKey="harvestIl" name="Harvest IL lens" stroke="#e0a32f" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-card">
            <div className="chart-head">
              <div>
                <h3>Sqrt exposure drag</h3>
                <p>LP principal compared with all-BTC and static 50/50 holds from the same start value.</p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={rows} syncId="simulation">
                <CartesianGrid stroke="#dce5e7" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis tickFormatter={compactUsd} tickLine={false} axisLine={false} width={70} />
                <Tooltip formatter={(value) => formatUsd(value, 2)} />
                <Legend />
                <Line
                  dataKey="compoundLp"
                  name="LP principal"
                  stroke="#167a7f"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  dataKey="pureBtcValue"
                  name="All BTC hold"
                  stroke="#2364aa"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  dataKey="balancedHoldValue"
                  name="Static 50/50 hold"
                  stroke="#5f6f75"
                  strokeDasharray="5 6"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-card split">
            <div>
              <div className="chart-head">
                <div>
                  <h3>Final asset mix</h3>
                  <p>BTC versus stable value in each active position.</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={230}>
                <PieChart>
                  <Pie data={allocation} innerRadius={54} outerRadius={88} paddingAngle={2} dataKey="value">
                    {allocation.map((entry) => (
                      <Cell key={entry.name} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatUsd(value, 2)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div>
              <div className="chart-head">
                <div>
                  <h3>Event counts</h3>
                  <p>Fee operations and price-band resets.</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={eventData}>
                  <CartesianGrid stroke="#dce5e7" vertical={false} />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} width={46} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {eventData.map((entry) => (
                      <Cell key={entry.name} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>
      </section>

      <aside className="insight-panel">
        <div className="panel-section">
          <div className="section-title">
            <Info size={16} />
            Model Notes
          </div>
          <ul className="notes">
            <li>BTC is token0 and the stablecoin is token1; price is stable per BTC.</li>
            <li>Liquidity uses Uniswap v3 sqrt-price amount0/amount1 formulas.</li>
            <li>Fees accrue daily at APR / 365 while the position is inside range.</li>
            <li>
              {settings.rebalanceMode === 'auto'
                ? 'Auto mode recenters into a fresh +/- range at the daily close when price exits.'
                : `Delayed mode leaves the band alone first; fees stop while out of range, then it recenters after ${settings.rebalanceDelayHours} hours outside.`}
            </li>
            <li>Gas, slippage, protocol fees, MEV, taxes, and pool volume limits are excluded.</li>
          </ul>
        </div>

        <div className="result-card winner">
          <span>Ending spread</span>
          <strong>{formatUsd((final.compoundValue ?? 0) - (final.harvestValue ?? 0))}</strong>
          <p>Compound strategy advantage after accounting for spent harvest cash.</p>
        </div>

        <div className="stat-list">
          <div>
            <span>Compound fees earned</span>
            <strong>{formatUsd(final.compoundFees)}</strong>
          </div>
          <div>
            <span>Harvest fees earned</span>
            <strong>{formatUsd(final.harvestFees)}</strong>
          </div>
          <div>
            <span>Range resets</span>
            <strong>{final.compoundRebalances ?? 0}</strong>
          </div>
          <div>
            <span>Last active band</span>
            <strong>
              {formatUsd(final.lower)} - {formatUsd(final.upper)}
            </strong>
          </div>
        </div>
      </aside>
    </main>
  )
}

export default App
