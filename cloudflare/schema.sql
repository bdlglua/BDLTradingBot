-- À exécuter une fois dans la console D1. Ne supprimez pas ce journal.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  quote TEXT NOT NULL,
  token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','expired','submitted','executed','unknown')),
  expires INTEGER NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created DESC);
CREATE INDEX IF NOT EXISTS orders_expiry ON orders(state, expires);
CREATE TABLE IF NOT EXISTS gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('idle','requesting','pending','submitted','unknown')),
  release_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO gate(id, owner, phase, release_at) VALUES (1, NULL, 'idle', 0);
