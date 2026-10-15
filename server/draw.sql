-- Packed owners: 0 is empty; 1-4 identify the team. bytea bit numbering matches
-- the browser's least-significant-bit-first three-bit codec, even across bytes.
CREATE OR REPLACE FUNCTION boxes_owner (p_bytes bytea, p_index integer)
  RETURNS integer
  LANGUAGE sql
  IMMUTABLE STRICT
  AS $$
  SELECT
    get_bit(p_bytes, p_index * 3) | (get_bit(p_bytes, p_index * 3 + 1) << 1) | (get_bit(p_bytes,
      p_index * 3 + 2) << 2)
$$;

CREATE OR REPLACE FUNCTION boxes_set_owner (p_bytes bytea, p_index integer, p_owner integer)
  RETURNS bytea
  LANGUAGE sql
  IMMUTABLE STRICT
  AS $$
  SELECT
    set_bit(set_bit(set_bit(p_bytes, p_index * 3, p_owner & 1), p_index * 3 + 1, (p_owner >> 1) &
      1), p_index * 3 + 2, (p_owner >> 2) & 1)
$$;

-- Each tile owns its boxes' top/left edges. Bottom/right boundary tiles also
-- own the outer edges, so shared edges are stored exactly once on the board.
CREATE OR REPLACE FUNCTION boxes_edge_location (p_edge integer, p_width integer, p_height integer,
  p_tile_size integer)
  RETURNS TABLE (
    tile_id integer,
    owner_index integer)
  LANGUAGE sql
  IMMUTABLE STRICT
  AS $$
  WITH coords AS (
    SELECT
      p_edge < p_width * (p_height + 1) AS horizontal,
      CASE WHEN p_edge < p_width * (p_height + 1) THEN
        p_edge % p_width
      ELSE
        (p_edge - p_width * (p_height + 1)) % (p_width + 1)
      END AS x,
      CASE WHEN p_edge < p_width * (p_height + 1) THEN
        p_edge / p_width
      ELSE
        (p_edge - p_width * (p_height + 1)) / (p_width + 1)
      END AS y
)
  SELECT
    (least (y, p_height - 1) / p_tile_size) * (p_width / p_tile_size) + least (x, p_width - 1) / p_tile_size,
    CASE WHEN horizontal
      AND y = p_height THEN
      2 * p_tile_size * p_tile_size + x % p_tile_size
    WHEN NOT horizontal
      AND x = p_width THEN
      2 * p_tile_size * p_tile_size + CASE WHEN y / p_tile_size = p_height / p_tile_size - 1 THEN
        p_tile_size
      ELSE
        0
      END + y % p_tile_size
    ELSE
      CASE WHEN horizontal THEN
        0
      ELSE
        p_tile_size * p_tile_size
      END + (y % p_tile_size) * p_tile_size + x % p_tile_size
    END
  FROM
    coords
$$;

-- Invoked once in autocommit mode. Rules come from shared/game-config.ts;
-- callers supply only a verified player/team and the selected edge to the API.
CREATE OR REPLACE FUNCTION boxes_draw (p_player uuid, p_team integer, p_edge integer, p_rules jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_width integer := (p_rules ->> 'width')::integer;
  v_height integer := (p_rules ->> 'height')::integer;
  v_tile_size integer := (p_rules ->> 'tileSize')::integer;
  v_max_quota integer := (p_rules ->> 'maxQuota')::integer;
  v_refill_interval integer := (p_rules ->> 'refillIntervalMs')::integer;
  v_leeway integer := (p_rules ->> 'leewayMs')::integer;
  v_horizontal_count integer := v_width * (v_height + 1);
  v_horizontal boolean := p_edge < v_horizontal_count;
  v_x integer;
  v_y integer;
  v_box_x integer[] := '{}';
  v_box_y integer[] := '{}';
  -- Entry 1 is the move; each following group of four is one adjacent box.
  v_edge_ids integer[] := ARRAY[p_edge];
  v_edge_tiles integer[];
  v_edge_indices integer[];
  v_tile_ids integer[];
  v_edges bytea[] := '{}';
  v_boxes bytea[] := '{}';
  v_dirty boolean[];
  v_tile record;
  v_quota record;
  v_complete boolean;
  v_now bigint;
  v_last_refill bigint;
  v_refills bigint;
  v_tokens integer;
  v_initial_tokens integer;
  v_initial_refill_in double precision;
  v_claims integer := 0;
  v_slot integer;
  v_box_slot integer;
  v_box_index integer;
  v_all_owned boolean;
  v_i integer;
  v_j integer;
  v_entry integer;
  v_loaded integer := 0;
  v_status integer;
  v_code text;
BEGIN
  IF p_edge IS NULL OR p_edge < 0 OR p_edge >= v_horizontal_count + v_height * (v_width + 1) THEN
    RETURN jsonb_build_object('ok', FALSE, 'status', 400, 'code', 'INVALID_EDGE');
  END IF;
  IF p_player IS NULL OR p_team IS NULL OR p_team < 0 OR p_team > 3 THEN
    RETURN jsonb_build_object('ok', FALSE, 'status', 400, 'code', 'INVALID_IDENTITY');
  END IF;
  -- Find the one or two adjacent boxes before acquiring locks. Include every
  -- edge needed to check those boxes, not only the edge being placed.
  IF v_horizontal THEN
    v_x := p_edge % v_width;
    v_y := p_edge / v_width;
    IF v_y > 0 THEN
      v_box_x := array_append(v_box_x, v_x);
      v_box_y := array_append(v_box_y, v_y - 1);
    END IF;
    IF v_y < v_height THEN
      v_box_x := array_append(v_box_x, v_x);
      v_box_y := array_append(v_box_y, v_y);
    END IF;
  ELSE
    v_x := (p_edge - v_horizontal_count) % (v_width + 1);
    v_y := (p_edge - v_horizontal_count) / (v_width + 1);
    IF v_x > 0 THEN
      v_box_x := array_append(v_box_x, v_x - 1);
      v_box_y := array_append(v_box_y, v_y);
    END IF;
    IF v_x < v_width THEN
      v_box_x := array_append(v_box_x, v_x);
      v_box_y := array_append(v_box_y, v_y);
    END IF;
  END IF;
  FOR v_i IN 1..cardinality(v_box_x)
  LOOP
    v_edge_ids := v_edge_ids || ARRAY[v_box_y[v_i] * v_width + v_box_x[v_i], (v_box_y[v_i] + 1) *
      v_width + v_box_x[v_i], v_horizontal_count + v_box_y[v_i] * (v_width + 1) + v_box_x[v_i],
      v_horizontal_count + v_box_y[v_i] * (v_width + 1) + v_box_x[v_i] + 1];
  END LOOP;
  -- Deduplicate and sort tile IDs for locking. The parallel edge arrays preserve
  -- the target/box-edge order so each owner can be found in the loaded tile buffers.
  SELECT
    array_agg(DISTINCT location.tile_id ORDER BY location.tile_id),
    array_agg(location.tile_id ORDER BY edge.ordinality),
    array_agg(location.owner_index ORDER BY edge.ordinality) INTO v_tile_ids,
    v_edge_tiles,
    v_edge_indices
  FROM
    unnest(v_edge_ids)
  WITH ORDINALITY AS edge (edge_id, ORDINALITY)
  CROSS JOIN LATERAL boxes_edge_location (edge.edge_id, v_width, v_height, v_tile_size) AS location;
  v_dirty := array_fill(FALSE, ARRAY[cardinality(v_tile_ids)]);
  -- This exception block is a subtransaction: expected rejection rolls back
  -- every write (including a new quota row) before returning a normal result.
  BEGIN
    -- KEY SHARE permits other moves/counter updates; reset's FOR UPDATE waits
    -- for this move to finish before replacing the game's tiles and quotas.
    SELECT
      complete INTO STRICT v_complete
    FROM
      games
    WHERE
      game_id = 1
    FOR KEY SHARE;
    v_now := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    -- Insert before locking: simultaneous first moves must share one token bucket.
    INSERT INTO player_quotas (game_id, player_id, tokens, last_refill_at, last_seen_at)
      VALUES (1, p_player, v_max_quota, v_now, v_now)
    ON CONFLICT (game_id, player_id)
      DO NOTHING;
    SELECT
      tokens,
      last_refill_at INTO STRICT v_quota
    FROM
      player_quotas
    WHERE
      game_id = 1
      AND player_id = p_player
    FOR UPDATE;
    -- All moves lock tiles in the same order to avoid cross-boundary deadlocks.
    -- Buffer slots follow the sorted tile IDs; corner checks can require four tiles.
    FOR v_tile IN
    SELECT
      tile_id,
      edges,
      boxes
    FROM
      board_tiles
    WHERE
      game_id = 1
      AND tile_id = ANY (v_tile_ids)
    ORDER BY
      tile_id
    FOR UPDATE LOOP
      v_edges := array_append(v_edges, v_tile.edges);
      v_boxes := array_append(v_boxes, v_tile.boxes);
      v_loaded := v_loaded + 1;
    END LOOP;
    IF v_loaded <> cardinality(v_tile_ids) THEN
      RAISE EXCEPTION 'Board tiles are missing';
    END IF;
    -- Refill after any lock wait, using the database clock. Preserve this
    -- pre-move quota for rejection, even if a later completion check rolls back.
    v_now := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    v_refills := greatest (0, (v_now - v_quota.last_refill_at + v_leeway) / v_refill_interval);
    v_tokens := least (v_max_quota, v_quota.tokens + v_refills);
    v_last_refill := CASE WHEN v_tokens = v_max_quota THEN
      v_now
    ELSE
      v_quota.last_refill_at + v_refills * v_refill_interval
    END;
    v_initial_tokens := v_tokens;
    v_initial_refill_in := CASE WHEN v_tokens = v_max_quota THEN
      0
    ELSE
      greatest (0, (v_refill_interval - (v_now - v_last_refill)) / 1000.0)
    END;
    v_slot := array_position(v_tile_ids, v_edge_tiles[1]);
    IF v_complete THEN
      v_status := 410;
      v_code := 'GAME_COMPLETE';
    ELSIF boxes_owner (v_edges[v_slot], v_edge_indices[1]) <> 0 THEN
      v_status := 409;
      v_code := 'EDGE_TAKEN';
    ELSIF v_tokens = 0 THEN
      v_status := 429;
      v_code := 'QUOTA_EXHAUSTED';
    END IF;
    IF v_code IS NOT NULL THEN
      RAISE SQLSTATE 'P2001';
    END IF;
    v_tokens := v_tokens - 1;
    v_edges[v_slot] := boxes_set_owner (v_edges[v_slot], v_edge_indices[1], p_team + 1);
    v_dirty[v_slot] := TRUE;
    -- Check both adjacent boxes against the changed buffers. Persist explicit
    -- owners so browsers never infer the winner from unordered tile arrival.
    FOR v_i IN 1..cardinality(v_box_x)
    LOOP
      v_box_slot := array_position(v_tile_ids, (v_box_y[v_i] / v_tile_size) * (v_width /
        v_tile_size) + v_box_x[v_i] / v_tile_size);
      v_box_index := (v_box_y[v_i] % v_tile_size) * v_tile_size + v_box_x[v_i] % v_tile_size;
      IF boxes_owner (v_boxes[v_box_slot], v_box_index) <> 0 THEN
        CONTINUE;
      END IF;
      v_all_owned := TRUE;
      FOR v_j IN 1..4 LOOP
        v_entry := 1 + (v_i - 1) * 4 + v_j;
        v_slot := array_position(v_tile_ids, v_edge_tiles[v_entry]);
        IF boxes_owner (v_edges[v_slot], v_edge_indices[v_entry]) = 0 THEN
          v_all_owned := FALSE;
          EXIT;
        END IF;
      END LOOP;
      IF v_all_owned THEN
        v_boxes[v_box_slot] := boxes_set_owner (v_boxes[v_box_slot], v_box_index, p_team + 1);
        v_dirty[v_box_slot] := TRUE;
        v_claims := v_claims + 1;
      END IF;
    END LOOP;
    IF v_claims > 0 THEN
      v_tokens := least (v_max_quota, v_tokens + CASE WHEN v_claims = 2 THEN
          (p_rules ->> 'bonusDouble')::integer
        ELSE
          (p_rules ->> 'bonusSingle')::integer
        END);
    END IF;
    -- Write each dirty tile once; locks already cover all tiles read for validation.
    FOR v_i IN 1..cardinality(v_tile_ids)
    LOOP
      IF v_dirty[v_i] THEN
        UPDATE
          board_tiles
        SET
          edges = v_edges[v_i],
          boxes = v_boxes[v_i],
          revision = revision + 1
        WHERE
          game_id = 1
          AND tile_id = v_tile_ids[v_i];
      END IF;
    END LOOP;
    UPDATE
      player_quotas
    SET
      tokens = v_tokens,
      last_refill_at = v_last_refill,
      last_seen_at = v_now
    WHERE
      game_id = 1
      AND player_id = p_player;
    -- Last write: increment current counters and recheck completion atomically.
    UPDATE
      games
    SET
      scores[p_team + 1] = scores[p_team + 1] + v_claims,
      edges_placed = edges_placed + 1,
      complete = CASE WHEN p_rules ->> 'endMode' = 'board_complete' THEN
        scores[1] + scores[2] + scores[3] + scores[4] + v_claims >= v_width * v_height
      ELSE
        scores[p_team + 1] + v_claims >= (p_rules ->> 'scoreTarget')::integer
      END
    WHERE
      game_id = 1
      AND NOT complete;
    IF NOT FOUND THEN
      v_status := 410;
      v_code := 'GAME_COMPLETE';
      RAISE SQLSTATE 'P2001';
    END IF;
    -- The API awaits autocommit before responding with this transaction ID.
    RETURN jsonb_build_object('ok', TRUE, 'status', 200, 'boxesClaimed',
      v_claims, 'txid', pg_current_xact_id ()::text, 'quotaRemaining', v_tokens,
      'refillIn', CASE WHEN v_tokens = v_max_quota THEN
      0
    ELSE
      greatest (0, (v_refill_interval - (v_now - v_last_refill)) / 1000.0)
    END);
  EXCEPTION
    WHEN SQLSTATE 'P2001' THEN
      -- Handle only our expected rejection signal. Other SQL errors propagate
      -- and abort the statement; this block has already undone every move write.
      IF v_code IS NULL THEN
        RAISE;
      END IF;
      RETURN jsonb_build_object(
        'ok', FALSE, 'status', v_status, 'code', v_code,
        'quotaRemaining', v_initial_tokens, 'refillIn', v_initial_refill_in
      );
  END;
END
$$;
