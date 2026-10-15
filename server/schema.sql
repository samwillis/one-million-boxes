-- One shared board. The game row holds counters and the reset generation.
CREATE TABLE IF NOT EXISTS games (
  game_id integer PRIMARY KEY CHECK (game_id = 1),
  started_at bigint NOT NULL,
  edges_placed integer NOT NULL DEFAULT 0,
  scores integer[] NOT NULL DEFAULT ARRAY[0, 0, 0, 0],
  complete boolean NOT NULL DEFAULT FALSE
);

-- Owners use three bits each: 0 is empty; 1-4 identify the team. Only tiles
-- on the bottom/right boundary store the extra outer edges (three bytes each).
CREATE TABLE IF NOT EXISTS board_tiles (
  game_id integer NOT NULL REFERENCES games (game_id),
  tile_id integer NOT NULL CHECK (tile_id >= 0 AND tile_id < 15625),
  revision integer NOT NULL DEFAULT 0,
  edges bytea NOT NULL,
  boxes bytea NOT NULL CHECK (octet_length(boxes) = 24),
  PRIMARY KEY (game_id, tile_id),
  CHECK (octet_length(edges) = 48 + CASE WHEN tile_id / 125 = 124 THEN
    3
  ELSE
    0
  END + CASE WHEN tile_id % 125 = 124 THEN
    3
  ELSE
    0
  END)
);

-- A persistent token bucket per signed player identity. Refills are computed
-- lazily from timestamps; no background refill timer or in-memory bucket.
CREATE TABLE IF NOT EXISTS player_quotas (
  game_id integer NOT NULL REFERENCES games (game_id),
  player_id uuid NOT NULL,
  -- Database setup installs the upper bound from the shared game configuration.
  tokens integer NOT NULL CHECK (tokens >= 0),
  last_refill_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  PRIMARY KEY (game_id, player_id)
);
