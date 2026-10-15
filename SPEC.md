# 1 Million Boxes specification

This describes the implemented application. Postgres is authoritative for the
board, box claims, team scores, completion and player quotas. Neon Realtime
supplies snapshots and incremental changes to browser clients.

## Game rules

There is one game, `game_id = 1`, with 1,000×1,000 boxes and 2,002,000 edges.
Players draw any available edge without turn order. The team that draws a box's
fourth edge claims it. One edge can complete two boxes.

| Team ID | Team   | Packed owner |
| ------- | ------ | ------------ |
| 0       | Red    | 1            |
| 1       | Blue   | 2            |
| 2       | Green  | 3            |
| 3       | Yellow | 4            |

Packed owner `0` means empty. Team scores count claimed boxes. The default
`board_complete` mode ends when all one million boxes are claimed; the highest
score wins, with ties allowed. `shared/game-config.ts` also supports
`first_to_score`, with a target of 1,000 boxes. Changing that mode requires
restarting the API and rebuilding the frontend together.

## Identity and quota

`GET /api/team` assigns a UUID and a random team on the first visit. A valid
existing identity is reused. The HTTP-only `boxes_identity` cookie contains
`playerId.teamId.signature`; the signature is an HMAC-SHA256 truncated to 32
hexadecimal characters. The cookie has `Path=/`, `SameSite=Lax` and a one-year
lifetime, plus `Secure` when `NODE_ENV=production`.

The API verifies the cookie before quota reads and draws. Request bodies cannot
choose the player, team or rules. This is anonymous demo identity, not an account
system: clearing cookies creates a new identity.

Each player has a persistent token bucket:

- Capacity and starting balance: eight lines.
- Refill: one line every 3,000 milliseconds, capped at eight.
- Accepted move cost: one line.
- Completing one box grants two lines; completing two grants four, capped at eight.
- Draw validation allows 500 milliseconds of refill timing leeway.

Refills are calculated lazily from timestamps. Draw enforcement uses the Postgres
clock after waiting for move locks. `GET /api/quota` projects the stored quota
using the API clock without leeway; it is a read-only display value. Browser
quota is optimistic and reconciled with API responses. Quota rows remain until
the administrative reset; there is no background refill or cleanup task.

## Coordinates and tile encoding

Horizontal edge `(x,y)` has ID `y*1000+x`, where `0≤x<1000`, `0≤y≤1000`.
Vertical edge `(x,y)` has ID `1,001,000+y*1001+x`, where `0≤x≤1000`, `0≤y<1000`.
Box `(x,y)` has ID `y*1000+x`, where both coordinates are below 1000.

The board is divided into 125×125 tiles of 8×8 boxes. Tile IDs are row-major:
`floor(y/8)*125+floor(x/8)`. Every edge is stored exactly once:

1. Edge owner slots 0–63 are the boxes' top edges, in row-major order.
2. Slots 64–127 are their left edges, in row-major order.
3. Tiles in the bottom row append eight outer bottom edges.
4. Tiles in the right column append eight outer right edges, after bottom edges
   if both boundaries apply.

Box owner slots 0–63 are also row-major. Each owner uses three bits, least
significant bit first, continuing across byte boundaries. `shared/tiles.ts` and
the SQL helpers implement the same codec.

| Tile                     | Edge bytes | Box bytes | Total packed bytes |
| ------------------------ | ---------- | --------- | ------------------ |
| Interior                 | 48         | 24        | 72                 |
| Bottom or right boundary | 51         | 24        | 75                 |
| Bottom-right corner      | 54         | 24        | 78                 |

The full board contains 15,625 tiles and 1,125,750 packed owner bytes. Box owners
are explicitly stored, so an unordered snapshot cannot change who claimed a box.

## Database schema

`server/schema.sql` creates three tables:

| Table           | Key                   | Stored state                                                                                        |
| --------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `games`         | `game_id`             | `started_at` reset generation in epoch milliseconds, `edges_placed`, four team `scores`, `complete` |
| `board_tiles`   | `(game_id,tile_id)`   | Monotonic `revision`, packed `edges bytea`, packed `boxes bytea`                                    |
| `player_quotas` | `(game_id,player_id)` | `tokens`, `last_refill_at`, `last_seen_at` in epoch milliseconds                                    |

`pnpm db:init` installs the schema and functions, inserts a missing game, and seeds
missing empty tiles in a transaction. It preserves an existing board. This is
idempotent initialization, not a versioned migration system. Board dimensions
and tile size are fixed by both schema constraints and initialization SQL;
changing them requires coordinated schema and application changes.

The API keeps a connection pool, configuration and capability issuer in memory.
It has no authoritative board, score, player session or quota cache. API
instances sharing the same database and signing secrets use the same game state.
Neon Realtime maintains its query graphs, subscriptions and proxy connections.

## Draw transaction

The API executes one autocommit statement:

```sql
SELECT boxes_draw($1::uuid, $2::integer, $3::integer, $4::jsonb) AS result;
```

The arguments are verified player identity, team ID, edge ID and server-supplied
rules. `server/draw.sql` performs the whole move inside Postgres:

1. Validate the edge and identity, then compute adjacent boxes and all edges
   required to check them.
2. Acquire `FOR KEY SHARE` on the game row to coordinate with reset.
3. Insert a missing quota row and lock it with `FOR UPDATE`. Concurrent first
   moves by one player therefore share one bucket.
4. Deduplicate required tiles and lock them with `ORDER BY tile_id FOR UPDATE`.
   Checks across tile edges and corners include neighboring tiles, up to four.
5. Refill quota using the database clock after lock waits. Reject a complete
   game, an occupied edge or an exhausted quota.
6. Deduct the cost, set the edge, and check both adjacent boxes against the
   locked buffers. Set explicit box owners and apply claim bonuses.
7. Write each dirty tile once and increase its revision. Update player quota.
8. Atomically increment current game counters and recheck completion. A move
   that loses a race with game completion is rolled back.
9. Return the claim count, quota and top-level transaction ID.

Moves that overlap in their required tiles serialize. Other tiles can be checked
and updated concurrently. The final score/counter write still takes a short
shared game-row lock. No application-to-database round trips occur while the
function holds move locks.

Expected rejection uses a PL/pgSQL exception subtransaction to undo every move
write, including a newly created quota row, before returning an error result.
Unexpected SQL errors abort the statement. The Node driver resolves the query
after autocommit completes, so HTTP success is sent only after commit.

## HTTP API

All `/api/*` responses use `Cache-Control: no-store`.

| Route               | Purpose                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `GET /api/health`   | Returns `{ok:true}` when the API is running                                    |
| `GET /api/team`     | Returns `{playerId,teamId,team}` and sets identity if needed                   |
| `GET /api/quota`    | Returns `{ok:true,quotaRemaining,refillIn}` for a verified identity            |
| `GET /api/realtime` | Returns `{url,query,gameQuery,startedAt}` with sealed fixed-query capabilities |
| `POST /api/draw`    | Accepts `{edgeId}` and executes the move                                       |

`refillIn` is seconds until the next refill, or zero at full quota. A successful
draw returns `{ok:true,txid,boxesClaimed,quotaRemaining,refillIn}` with status 200;
`txid` is a decimal string. Expected failures return `{ok:false,code}` with
quota fields when the move reached quota validation:

| Status | Code              | Meaning                                 |
| ------ | ----------------- | --------------------------------------- |
| 400    | `INVALID_REQUEST` | Malformed JSON or an invalid edge field |
| 400    | `INVALID_EDGE`    | Edge outside the board                  |
| 401    | `NO_IDENTITY`     | Missing or invalid signed identity      |
| 409    | `EDGE_TAKEN`      | Edge already owned                      |
| 410    | `GAME_COMPLETE`   | Game ended before this move committed   |
| 429    | `QUOTA_EXHAUSTED` | No line available                       |
| 503    | `DATABASE_ERROR`  | An unexpected server/database error     |

## Neon Realtime and browser state

The application subscribes directly to the authoritative board. There is no
separate change log, REST snapshot handoff or query sharding.

### Shared queries

All browsers subscribe to these two queries with parameter `[1]`:

```sql
SELECT tile_id, revision, edges, boxes FROM board_tiles WHERE game_id = $1;
SELECT started_at FROM games WHERE game_id = $1;
```

The board query is an unordered projection of primary-keyed tile rows. It needs
no `ORDER BY`, `LIMIT`, joins or aggregates. Every viewer uses the same query
and parameter. Parameterized query families share engine query graphs, and
matching parameters share the query variant; the Realtime proxy fans out
publications to subscribed connections. Sending data to each browser still
costs bandwidth and serialization work. Initial snapshots are obtained for
joining subscriptions; the application does not maintain a shared snapshot cache.

The metadata query contains only the reset generation. Team scores and edge
counts in the UI are derived from explicit tile owners, avoiding a live aggregate
query.

### Capabilities and recovery

`GET /api/realtime` returns sealed board and metadata query capabilities, the
WebSocket URL and the current `startedAt`. The API issuer uses the database name
from `DATABASE_URL`, so sealed queries address the same database as writes.
The signing secret stays on the API server. The API seals only these fixed
queries and does not accept browser SQL. Browsers connect directly to the
configured Neon Realtime endpoint.

`QueryRefreshController` renews both capabilities through the same bootstrap
endpoint, using the SDK's expiration scheduling. The SDK defaults to
60-second capabilities. Subscription errors and exhausted renewals close the
connection and obtain fresh capabilities and snapshots after a 1.5-second delay.
This also handles terminal `upstream_rejected` responses after a service restart
or a bulk board reset. The hook checks the game generation during bootstrap as
well as through the metadata query.

### Browser state and rendering

`src/hooks/useBoardRealtime.ts` subscribes with `materialize:false`. The app
handles `onReset` and `onBatch` directly rather than retaining a second complete
materialized board in the SDK. `bytea` fields arrive as `Uint8Array`;
`shared/tiles.ts` decodes their owners.

The browser console logs bootstrap duration, the subscribe call, connection
readiness, admission and snapshot start/completion for each subscription (`s1`
is the board, `s2` is game metadata). `Game state loaded` reports milliseconds
from subscribe to the complete snapshot and to state installation, plus the
installation duration. A separate entry measures the wait for the first canvas
render after installation. Incremental update sizes are grouped once per second.

Sizes use decimal kB (1,000 bytes): `packedKB` counts decoded owner bytes;
`protocolRowsKB` counts those rows' protocol v1 JSON, including opaque row keys
and base64 wrappers. The SDK exposes decoded rows rather than transport frames,
so this count excludes message envelopes, row separators, control messages,
WebSocket/TCP overhead and compression. It must not be read as an exact network
traffic measurement. No row contents or query capabilities are logged.

A reset must contain exactly 15,625 tiles and installs them into a fresh
`GameState`. Incremental upserts replace the changed tile owners. A removed tile
or invalid tile causes reconnection. Box ownership is explicitly stored and does
not depend on tile delivery order.

The board canvas backing store follows the device pixel ratio. Cached grid and
dot tiles are keyed by zoom bucket and display density, with geometry kept in
CSS pixels. Bitmap box fills use nearest-neighbour sampling only within their
own draw calls; grid and dot textures retain smooth antialiasing.
The minimap also matches its responsive CSS size at device pixel density and
redraws its bitmap and viewport outline when resized.

Edge picking covers the full line segment and its endpoints, selecting the
nearest line where hit areas overlap. Mouse and touch retain separate hit widths
and minimum zoom levels.

Local moves play a short synthesized pencil scratch after passing client checks.
The draw response plays a rising chime when it confirms one or two box claims.
Snapshots and other players' moves stay silent. Web Audio starts lazily from a
draw gesture; the sound toggle above the zoom controls persists its preference in local storage
and immediately silences scheduled sounds. Sound is enabled by default and
audio failures do not affect gameplay.

`pnpm simulate` adds synthetic play through `GameStore.draw()` and the normal
Postgres draw function. Bots use distinct identities, four teams and real quotas;
no board reset or direct packed-state writes are needed. An unpaced run seeds
visible patches, while a target move rate generates a finite stream of committed
Realtime updates. The script accepts `DATABASE_URL` or `--local` to select the
running local development database, and exits cleanly on Ctrl+C.
The separate `--complete` mode bulk-seeds to a requested percentage of completed
boxes. It takes the exclusive game lock, installs current tiles in the shared
rule oracle, applies randomly ordered free edges, and commits changed packed
tiles and matching counters in one transaction. Existing owners, player quotas
and `started_at` are preserved; the result arrives as one Realtime transaction.

Rendering uses typed arrays and canvas with pan, zoom, a minimap and batched
`requestAnimationFrame` updates. Snapshot hydration avoids move animations;
incremental edge changes generate brief minimap animations. Personal box count
is browser-local, credited from successful draw responses and persisted in
localStorage; it is not a database leaderboard.

Mouse players draw with a team-coloured pencil cursor and an eight-segment move
dial. The next segment fills continuously towards the browser's server-aligned
refill deadline; spending, refills and bonuses update the same optimistic quota
state. Spending removes a segment immediately, while refills and bonuses fill
segments smoothly. A spend followed by a box bonus keeps the number element
and refill sweep stable, without restarting their animation for each count. The pencil tip is the pointer hotspot, and the dial flips near board
edges. Pointer movement updates only the overlay transform. Native cursor
hiding remains enabled across the mouse-capable board, independently of
movement frames; controls retain their normal cursor. Accepted mouse clicks
animate the pencil tip along the selected edge and back to the pointer in 260ms,
while the moves dial stays at the pointer and the write proceeds immediately.
The same animation clock reveals the canvas edge behind the pencil, clipping
its existing hand-drawn path so its shape stays unchanged. Only the active
edge’s small surrounding strip is repainted per frame. Early Realtime
confirmation updates ownership without bypassing the reveal; cancellation
restores the full current edge immediately.
Taken edges and attempts without moves do not trigger a stroke. Moving the
pointer, leaving the board or zooming cancels the stroke; touch and reduced-motion
users retain immediate drawing without the pencil animation. The same dial
appears slightly larger in the bottom-left when the pencil cursor is hidden,
including on touch devices, and remains available to assistive technology.

Controls use consistent 1px rounded borders, raised edges and subtle press
feedback. Team
badges and score chips keep the original team colours; score chips echo claimed
boxes, and the minimap has a labelled frame. The UI keeps the Inter font and
Neon accent without changing board rendering or the original logo.

The board fills the area below the header. The move dial and learn-more link
float over its bottom edge without a footer bar; gaps between controls still
accept drawing input. The minimap and vertical zoom buttons share the moves
dial’s bottom alignment on wider screens. On narrow screens the learn-more
link stays at the bottom alongside the minimap and zoom buttons, with the fixed
moves dial above it. The link keeps this position when the dial follows the
mouse cursor.

A blocked draw shows “Out of moves! Recharging...” and briefly shakes the cursor
or fixed move dial; repeated attempts restart the shake. The prompt clears when
a move refills. Reduced-motion preferences disable shakes and the refill sweep
and shorten other feedback animations.

### Write confirmation

After a successful draw, the browser calls `awaitTxId(txid, 15000)` on its board
subscription. This ties move confirmation to the shared live query. If
confirmation times out, the client reconnects and reports that the move was
saved. It keeps the server's quota result and does not resend or undo the move.

## Initial payload

The complete board's 1,125,750 packed owner bytes become 1,501,000 bytes of
base64 owner strings. Tile sizes and boundary encoding are described above.

In the public JSON protocol, a binary cell is represented as
`{"base64":"..."}`. Scalar cell values are strings, which the SDK parses into
their declared types. Rows also carry an opaque 64-character row ID, column
names, revisions and publication framing. The base64 total alone therefore
understates the initial query payload.

A full-size synthetic probe measured 3,527,299 JSON application bytes
(approximately 3.36 MiB) for 15,625 rows. That probe omitted the 750 binary bytes
for outer boundary edges and used slightly different column names. The current
board should be budgeted at roughly 3.5 MB of initial application data, rather
than the 1.5 MB of base64 values. Revisions, protocol versions and framing can
change the exact number. WebSocket, TCP and TLS overhead are additional.

This board fits the 16 MiB initial-query budget of the engine version used for
the demo. That limit is an engine setting/version detail, not a promise about
every Neon deployment. The app uses one board query; fixed shards would add
complexity without helping this board's current snapshot size.

## Update traffic and capacity

An upsert transmits the whole projected tile. A normal move changes one tile;
a cross-boundary claim can change two. Up to four tiles may be locked for
validation even though fewer are written. Multiple row changes can be batched
by the protocol.

An earlier one-subscriber synthetic probe measured approximately 505 application
bytes per tile update, including publication framing. At one changed tile per
accepted move, this gives the following rough bandwidth estimates:

| Accepted moves/second | Per viewer | Across 1,000 viewers |
| --------------------- | ---------- | -------------------- |
| 10                    | 5 KB/s     | 5 MB/s               |
| 100                   | 50 KB/s    | 50 MB/s              |

These are arithmetic estimates, not measured capacity results. They omit extra
claim tiles, transport overhead, simultaneous joins and slow-client recovery.
The query graph can be shared while egress still grows with viewers. Qualification
should measure sustained moves, concurrent joins, proxy CPU and bandwidth before
changing this design.

## Reset and operation

`pnpm db:reset` is an administrative operation against the configured database.
It takes `FOR UPDATE` on the game row, waits for active moves, then atomically
clears tile owners, increments tile revisions, deletes quotas, resets counters
and advances `started_at` monotonically. There is no public reset endpoint or
automatic reset after completion.

The metadata subscription and reconnect bootstrap both check `started_at`.
A changed generation clears browser quota/personal-score caches and reloads the
page. The signed player/team cookie is retained. Previous games and individual
moves are not archived.

Vercel serves the static frontend and routes `/api/*` to `api/index.ts`, which
creates the shared Hono application from `server/app.ts`. The Node.js function
reuses a five-connection Postgres pool against Neon's pooled endpoint; Vercel
Fluid compute manages idle connections. It runs in `iad1` by default, with a
30-second request limit. No schema initialization runs on a function cold start.

`pnpm db:init` uses `DATABASE_URL_UNPOOLED` (falling back to `DATABASE_URL`) to
install the schema, draw function and missing tiles before deployment. It
preserves existing play. Neither the local API nor the Vercel function runs
schema setup on startup. Disposable test and local fixture launchers run the
setup script once before starting the API, against their own database.
Host environment variables take priority over `.env.local`, then `.env`.

Use the Neon connection details described in [README.md](README.md), a common
origin for frontend and REST routes, and HTTPS with `NODE_ENV=production` for
secure cookies. `neon.ts` declares `preview.realtime.allowedOrigins`, enabling
Realtime for the branch and allowing local development plus the deployed game.
`pnpm exec neon config plan` reviews the policy; `pnpm exec neon deploy` applies
it. `pnpm exec neon env pull` writes `NEON_REALTIME_URL` and
`NEON_REALTIME_SECRET` alongside the Postgres URLs. The application accepts the
previous `REALTIME_PUBLIC_URL` / `REALTIME_SECRET` names as fallbacks for existing
hosts. The signing and
identity secrets stay in Vercel's server environment; the browser receives only
short-lived query capabilities and the public WebSocket URL.

## Verification

Unit tests cover tile ownership, packing and unordered hydration. The disposable
full-stack suite exercises the actual Postgres extension, Realtime proxy, SDK
and API: snapshots, duplicates, quota refills, single and double claims, tile
and reset locks, rollback, transaction confirmation, capability renewal,
proxy restart and reset recovery. Browser tests cover independent players,
canvas draws, mobile layouts and rendered recovery.

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands and fixture requirements.
