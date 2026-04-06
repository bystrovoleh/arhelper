import Database, { type Database as DatabaseType } from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DB_PATH = path.join(__dirname, '..', 'data', 'crhelper.db')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

export const db: DatabaseType = new Database(DB_PATH)

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT UNIQUE,
    pool_address TEXT NOT NULL,
    network TEXT NOT NULL,
    protocol TEXT NOT NULL,
    token0_symbol TEXT NOT NULL,
    token1_symbol TEXT NOT NULL,
    tick_lower INTEGER NOT NULL,
    tick_upper INTEGER NOT NULL,
    liquidity TEXT NOT NULL,
    token0_amount REAL NOT NULL,
    token1_amount REAL NOT NULL,
    entry_price REAL NOT NULL,
    entry_price_usd REAL NOT NULL,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    is_paper INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open',  -- open | closed | rebalanced
    -- On-chain fee tracking (real data)
    fee_growth_global0_entry TEXT,  -- feeGrowthGlobal0X128 at position open
    fee_growth_global1_entry TEXT   -- feeGrowthGlobal1X128 at position open
  );

  CREATE TABLE IF NOT EXISTS position_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    current_price REAL NOT NULL,
    token0_amount REAL NOT NULL,
    token1_amount REAL NOT NULL,
    uncollected_fees0 REAL NOT NULL,
    uncollected_fees1 REAL NOT NULL,
    fees_usd REAL NOT NULL,
    il_pct REAL NOT NULL,
    pnl_usd REAL NOT NULL,
    in_range INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    type TEXT NOT NULL,   -- POSITION_OPENED | POSITION_CLOSED | REBALANCE | SIGNAL | INFO | ERROR
    pool_address TEXT,
    token_id TEXT,
    message TEXT NOT NULL,
    data TEXT            -- JSON blob for extra details
  );

  CREATE TABLE IF NOT EXISTS pool_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at INTEGER NOT NULL,
    pool_address TEXT NOT NULL,
    network TEXT NOT NULL,
    current_price REAL NOT NULL,
    tick INTEGER NOT NULL,
    liquidity TEXT NOT NULL,
    volume_usd_24h REAL,
    tvl_usd REAL,
    apy_base REAL,
    estimated_concentrated_apy REAL
  );

  CREATE TABLE IF NOT EXISTS swap_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id         TEXT NOT NULL,
    tx_hash          TEXT NOT NULL,
    token_in         TEXT NOT NULL,
    amount_in_usd    REAL NOT NULL,
    token_out        TEXT NOT NULL,
    amount_out_usd   REAL NOT NULL,
    price_impact_pct REAL NOT NULL,
    gas_usd          REAL NOT NULL,
    occurred_at      INTEGER NOT NULL
  );
`)

// ─── Indexes ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_positions_status    ON positions(status);
  CREATE INDEX IF NOT EXISTS idx_positions_token_id  ON positions(token_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_token_id  ON position_snapshots(token_id);
  CREATE INDEX IF NOT EXISTS idx_swap_events_token   ON swap_events(token_id);
  CREATE INDEX IF NOT EXISTS idx_pool_snaps_address  ON pool_snapshots(pool_address, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_events_type         ON events(type, occurred_at);
`)

// ─── Migrations ───────────────────────────────────────────────────────────────
// Add new columns to existing DBs safely
const existingCols = (db.prepare(`PRAGMA table_info(positions)`).all() as any[]).map(c => c.name)
if (!existingCols.includes('fee_growth_global0_entry')) {
  db.exec(`ALTER TABLE positions ADD COLUMN fee_growth_global0_entry TEXT`)
}
if (!existingCols.includes('fee_growth_global1_entry')) {
  db.exec(`ALTER TABLE positions ADD COLUMN fee_growth_global1_entry TEXT`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function logEvent(
  type: string,
  message: string,
  extra: { poolAddress?: string; tokenId?: string; data?: object } = {}
) {
  db.prepare(`
    INSERT INTO events (occurred_at, type, pool_address, token_id, message, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Date.now(), type, extra.poolAddress ?? null, extra.tokenId ?? null, message, extra.data ? JSON.stringify(extra.data) : null)
}
