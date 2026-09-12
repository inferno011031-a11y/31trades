# BattleX Backtesting Engine & Custom Chart HUD Specification
*Permanent Architecture & Feature Notes*

## 1. Session Setup & Capital Configuration
- **Initial Balance Selection**:
  - Default preset buttons for standard / prop-firm sizing ($10k, $25k, $50k, $100k, $200k).
  - Custom amount input field (user can type any custom starting balance, e.g. $5,000 or $12,500).
- **Asset-Aware Sizing Engine**:
  - Automatic detection of instrument type (Futures ticks/points for NQ/ES, Forex lots/pips, Crypto contracts).
  - Risk-based sizing calculator (% risk per trade based on selected initial balance).

---

## 2. On-Chart Interactive Floating Execution Card (HUD)
- **Top Header**:
  - Selected Initial Capital vs Current Balance
  - Live Floating / Unrealized P&L
  - Closed P&L of the session
- **Sizing & Lot Controls**:
  - Lot / Contract size selector (+ / - stepper and quick buttons based on asset).
  - Risk calculator display ($ risk and % of capital).
- **Execution Actions**:
  - **Market BUY** button (Green)
  - **Market SELL** button (Red)
  - **PARTIALS** controller (Close 25%, 50%, 75% of active position)
  - **BREAK-EVEN (BE)** trigger (instantly moves Stop Loss to entry price)
  - **CLOSE ALL** position button
- **Direct Chart Canvas Sync**:
  - Active Entry line, Stop Loss line, Take Profit line plotted directly on the chart.
  - Drag-to-adjust TP and SL on the chart canvas.

---

## 3. Session & Strategy Metadata Tagging
- **Trading Session Selector**:
  - User can select which session they are testing: New York Open / AM, London, Asian, New York PM, etc.
  - Helps the trader discover which specific session gives their edge the highest win-rate and profit factor.
- **Timeline / Timeframe Tracking**:
  - Captures the active candle timeframe (1m, 5m, 15m, 1h, 4h) used during the test.
- **Strategy Selector + On-The-Fly Creation**:
  - Dropdown to select existing strategies configured in the journal.
  - **`+ New Strategy` Quick Create**: Trader can create a new strategy tag right on the floating card without having to exit or disrupt their active backtesting session.

---

## 4. Live Backtest Trade Logging (Buy / Sell Execution Records)
- **Automatic Execution Capture**:
  - Every time the user executes a **Buy** or **Sell** during the backtest session, it is immediately logged into a live trade table / drawer in the frontend.
  - **Captured Trade Data**:
    - Trade Type: Long (Buy) / Short (Sell)
    - Position Size: Lots / Contracts / Coins
    - Entry Price & Entry Candle Timestamp
    - Exit Price & Exit Candle Timestamp
    - Stop Loss (SL) & Take Profit (TP) Levels
    - Realized P&L ($ amount and % return on starting capital)
    - Risk-to-Reward Ratio (R:R achieved)
    - Associated Strategy & Session tags
    - Partial exits (e.g. 50% closed at 2R, remainder at BE)
- **Visual On-Chart Trade Markers**:
  - Visual Buy (▲) and Sell (▼) execution markers plotted directly on the chart candles where the trade was taken.

---

## 5. Frontend Filtration & Edge Analysis Integration
- **Post-Session & Live Analytics Filter**:
  - All backtested trades feed directly into frontend filters.
  - Filterable by:
    - **Strategy**: Compare performance of Strategy A vs Strategy B.
    - **Session**: Compare New York vs London vs Asian results.
    - **Timeframe**: Filter 1m scalps vs 5m/15m swings.
    - **Outcome**: Filter Wins, Losses, Break-Evens.
- **Summary Metrics Generated**:
  - Win Rate (%), Total Trades, Net P&L, Max Drawdown, Profit Factor, Average R:R.

