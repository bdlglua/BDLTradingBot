-- Complément de schema.sql : conserve les ordres existants.
CREATE TABLE IF NOT EXISTS automation_config (
  id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}', strategy TEXT, enabled INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO automation_config(id) VALUES(1);
CREATE TABLE IF NOT EXISTS automation_prices (
  asset TEXT NOT NULL, slot INTEGER NOT NULL, price TEXT NOT NULL, currency TEXT NOT NULL,
  PRIMARY KEY(asset, slot)
);
CREATE TABLE IF NOT EXISTS automation_position (
  asset TEXT PRIMARY KEY, quantity TEXT NOT NULL, entry TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY, asset TEXT NOT NULL, slot INTEGER NOT NULL, revision INTEGER NOT NULL,
  state TEXT NOT NULL, day TEXT NOT NULL, budget_cents INTEGER NOT NULL DEFAULT 0,
  side TEXT, quote_id TEXT, detail TEXT NOT NULL DEFAULT '', created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS automation_run_state ON automation_runs(state);
CREATE INDEX IF NOT EXISTS automation_day ON automation_runs(day, side, state);
CREATE TABLE IF NOT EXISTS automation_notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, candidate TEXT, updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_research (
  id INTEGER PRIMARY KEY CHECK(id=1), result TEXT NOT NULL
);
