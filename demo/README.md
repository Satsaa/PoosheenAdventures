# Worldgen demo (TypeScript)

A small, runnable prototype of the world generator planned for the Rust/Bevy game.
It generates the **logic** of a Zelda-like world first (what unlocks what), turns that
into tile maps, and then re-checks every promise it made.

## Run it

```sh
cd demo
npm install
npm run build        # writes dist/index.html, a single self-contained page
npm test             # generator across hundreds of seeds, in Node
npm run check        # type-check
```

Open `dist/index.html` in a browser. No server needed.

## What is where

| Path | Role |
| --- | --- |
| `src/core/types.ts` | The whole data contract. Plain data, written to port 1:1 to Rust structs and enums. |
| `src/core/req.ts` | Requirement expressions: `has`, `use` (spend a renewable), `all`, `any`. |
| `src/core/solver.ts` | Sphere search. Renewable consumables, worst-case small keys. |
| `src/core/content.ts` | The premade set: items, the gate each one opens, biomes. |
| `src/core/settings.ts` | Generation and item settings, described by metadata so a UI or config file can be generated from them. |
| `src/gen/plan.ts` | Level 0. Fixes the tool order and what each world must contain. |
| `src/gen/lockgraph.ts` | The generic forward lock-and-key builder, used for regions and for dungeon rooms. |
| `src/gen/regions.ts` | World → regions → places. Same routine for overworld, underworld, sky. |
| `src/gen/dungeon.ts` | Place → rooms, with small keys and a boss key. |
| `src/gen/npcs.ts` | NPCs as monotone stage machines; quests. |
| `src/gen/logic.ts` | Orchestrates the above, then adds loops, ledges and extra stairs. |
| `src/gen/stack*.ts`, `interiorTiles.ts`, `tiles.ts` | Tile realisation, and the proof that tiles match the graph. |
| `src/gen/validate.ts` | Lints: solvable, complete, no soft-lock, refills, keys, NPCs, briefs. |
| `src/render/` | Canvas map view (zoom, height layers, particles). Demo only. |
| `src/ui/` | Side panels. Demo only. |

`core/` and `gen/` have no DOM dependency; they are the part that becomes the Rust crate.

## The rules that keep worlds valid

1. **Requirements live on edges and checks**, never on nodes.
2. **Constraints flow down.** A node receives the items guaranteed on entry and an ordered
   list of payloads it must contain. Child seeds derive from the parent seed plus the child id.
3. **Forward construction.** A node is attached with a lock made only from items already
   owned, so the tree is solvable before any solver runs.
4. **Loops are proposals.** Shortcuts, one-way ledges and extra stairs are added after the
   tree and kept only if the lints still pass.
5. **Consumables are renewable or unusable.** Ammo is never counted. Each ammo gate gets a
   free refill on its near side; shops need rupees, which have a free source at the start.
6. **Small keys are worst-case.** A locked door opens in logic only when the player holds
   enough keys for every locked door currently in front of them.
7. **NPCs only move forward**, driven by what the player owns, and never to an unreachable zone.
8. **Tiles are verified.** Walkable tiles are flood-filled into zones; every gate must
   separate exactly the two zones of its edge. A map that disagrees is discarded and the
   next attempt runs from a derived seed, so results stay deterministic per seed.

## Rivers

- A river is a path on the lattice of screen corners, traced downhill before the lock graph
  exists. A course that would cut off a bank too small to use is rejected.
- On a region border it replaces the rim. Through a region it splits that region into two
  banks, which the lock-graph builder then treats as ordinary neighbouring regions joined by a
  bridge (any gate can stand on a bridge).
- River water (`T.WATER`) is swimmable with the Swim Gear; rough water (`T.DEEP`, lake and
  sea rims) never is.
- River logic is read off the painted map: each stretch is a zone, a bank level with the
  water is a two-way shore edge needing the Swim Gear, and a drop in level is a one-way
  waterfall. These are extra edges, so they cannot break a solvable world; one-way edges are
  re-checked and get a ladder or vine (two-way) if they could trap the player.
- Caves can have an underground river across the room, with the treasure on the far bank.

## Sea, islands and outcrops

- Every seed has a `landlocked` value; each side of the map is sea with probability
  `1 - landlocked`. On a sea side the map grows by `oceanSize` screens of open water beyond the
  land's rectangle, so the ocean is a place of its own and not a border a few tiles wide.
- What is not land is a filler region: ocean toward sea sides, mountain range, thicket or wastes
  toward sides where the world goes on.
- Islands are regions. `carveIslands` cuts them out of open sea (water on all eight sides) after
  the mainland is partitioned, and `buildLockGraph` attaches them through "sea candidates":
  pairs of regions on the same sea, usable only once the Boat is owned. That makes the Boat a
  progression item. Without a Boat in the world, a ferryman works every island pier instead.
- A sea crossing is two graph edges, pier to sea to pier, so both piers are required features:
  if the tile pass cannot build one, the attempt fails and the next derived seed is tried.
  Other docks are still optional extras, built where they fit.
- A world that starts on an island (stairs down, beanstalk up) may run on under or over the sea.
- Outcrops are grown tile by tile in the tile pass, so no two have the same outline: reefs of
  rock, sandbars, and cays that may hold a chest or pots. Ground to stand on only appears on a
  sea somebody can sail. `outcrops` is a count per 50 screens of water.

## Floors, tunnels, cave heights and water

- A dungeon may have several floors (`dungeonFloors`). Every floor is its own interior
  dimension on the same room grid, so a staircase joins the room directly above to the room
  directly below at the same tile. Stairs are edges of the same lock graph as doors: rooms on
  all floors are its nodes, vertical neighbours are extra candidates. The page shows a tab per
  floor while you are inside.
- A tunnel is a cave with two mouths (`tunnels`): an edge between two regions is realised as
  mouth, chambers, mouth, with the gate on a passage inside. The graph does not change shape;
  the edge just has more tiles. A cave mouth that finds no open ground opens in the region's
  own rim instead.
- Cave heights (`caveHeights`): underworld regions lie on different levels, so the existing
  stairs, ledges and waterfalls appear underground; tunnels climb from one mouth's height to
  the other's; cave and dungeon rooms may have a raised ledge with stairs.
- Cave water: rivers run through the underworld (`caveRivers`) under the rules of rivers above
  ground, caves have pools, and a swim gate inside a tunnel is a flooded passage.
- Lava (`lava`): pools are grown tile by tile in underworld caves, mostly magma ones. A pool has
  no holes and keeps a full ring of open floor, so it can be walked round and never cuts a
  cave in two. An underworld river that rises in a magma cave runs molten (no swimming), and
  places entered from a magma cave have lava in their pools and pits.
- Free refills are judged per building: a dungeon's entrance hall covers all of its floors.

## Castle and town

- Both are chosen after the region graph is built and before anything is placed, so they are
  ordinary regions with a different look. The castle is the region that holds the Sealed
  Sanctum when that is above ground (the sanctum is then its keep), else the deepest region;
  the town is a roomy region near the start.
- The castle is `blocky`: the border warp is switched off for it, so its outline follows the
  screen grid. Its rim is a stone wall two tiles thick and two levels high, with a tower on
  every outward corner. A river along its border is a moat.
- The town places houses on lots: a lattice of door tiles around the square, nearest first, so
  houses stand in rows and every door is on a street. A few houses can be entered.

## Walls seen from every side

The renderer draws a point at height z that much further up the screen. A box-shaped wall on
the near side of a room therefore hides its own face and covers the floor behind it. So raised
ground is not a box: toward lower ground it slopes, with a run that depends on the side
(`TERRAIN_SHAPE` in `render/lit/shaders.ts`, `surfacePx` in `render/terrain.ts`).

- Pattern 1, rooms (interiors and the underworld): runs chosen so all four faces are about
  equally wide on screen.
- Pattern 2, outdoors (overworld, sky, castle walls): the face that looks south is tall, the
  other three are narrow.
- Pattern 3, lip: the south face as in the dimension's own pattern, the others a thin bevel.
  `Dimension.lip` marks tiles that use it (raised ground too thin for a full north face);
  steps down to water use it too.

Nothing is flat: the slope is real geometry in the G-buffer (height and normal per pixel), and
the height map that sun and lamp shadows are cast over is built from the same function, so
lighting and picture agree. The face sizes are graphics settings ("Graphics: walls").

What the generator guarantees for this: interior walls are two tiles thick, the way out of a
room is a real gap in its south wall, and a height step never lies between two walkable tiles
except at a stairs object (a ledge inside a room has a solid edge row with a gap for the stairs).

## The tile table

`core/tileset.ts` is the one place that says what every ground, prop and object is: where it
belongs (overworld, underworld, sky, interior), which wall patterns it has when it is raised,
and what it needs around it (level ground, a clear view of the wall face behind it, footing).

- `checkTiles` walks every tile of every map and reports each unmet need, wording the report
  from the table: "Pine needs level ground: it stands on the face of a height step". A new tile
  or a new need is checked without writing a new warning. It also checks the rules that hold
  for all tiles: a raised tile has its map's wall pattern and the depth for its north face (or
  the lip), and a height step between two walkable tiles has stairs.
- The result is the "tile table" line in the Checks tab. It is a warning, not a failure: the
  world is still valid and is not generated again.
- `gen/settle.ts` is the generator's tidy-up. It asks the same questions and applies the fix
  the table names: the prop goes, or becomes the low one the table gives (a tree at the foot of
  a cliff becomes a rock), and raised ground without depth takes the lip pattern. Placement of
  chests, creatures and the like asks the table too (`canHold`).
- `test-tiles.ts` plants one violation of each kind and expects it to be named, and expects
  generated worlds to raise none.

## Settings

`generateWorld(seed, settings?)` takes a partial `GenSettings`; anything missing falls back to
the defaults and everything is clamped into range. The same seed with the same settings
always gives the same world.

- **Generation settings** cover world size and region count, the stacked layers, dungeon
  count and size, lock density, loops and ledges, which quests and NPCs exist, and prices.
- **Item settings** switch each tool on or off, say roughly when it appears (start, early,
  any, late) and whether it is loose or a dungeon treasure, and set carry capacities.

Settings that cannot work are not silently fixed. A shop price above any wallet, for
example, shows up as a failed "everything is obtainable" check. `npm test` includes a fuzz
run of random settings across seeds.

## Known simplifications

- A region is one walkable zone (plus gated alcoves). Regions do not have internal puzzles yet.
- The one-way soft-lock check is conservative: it assumes the minimum inventory a player
  must hold at the top of a drop.
- Rooms are single screens; there is no room-internal puzzle generation.
- Tile art is procedural placeholder drawing, not the pre-rendered 3D look planned for Bevy.
