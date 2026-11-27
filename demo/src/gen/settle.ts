// The generator's tidy-up, driven by the tile table (core/tileset.ts): wherever a prop's need is
// not met it becomes what the table names, or goes. It asks exactly the questions the checker
// asks, so what is settled here cannot be reported there, and nothing here knows about trees or
// cliffs. (That raised ground always keeps a top is not settled here: the terrain model itself
// fits faces to the room they have, see core/shape.ts.)
import { D, type Dimension } from '../core/types';
import { NEEDS, PROPS, tileCtx } from '../core/tileset';

export function settleTiles(dim: Dimension): void {
  const c = tileCtx(dim);
  const n = dim.w * dim.h;
  for (let i = 0; i < n; i++) {
    // a replacement has needs of its own, so look again (a few times is plenty: chains are short)
    for (let pass = 0; pass < 3 && dim.deco[i]; pass++) {
      const spec = PROPS[dim.deco[i]];
      if (!spec || dim.deco[i] === D.HOUSE) break; // buildings are placed whole, never tidied away
      const unmet = spec.needs.find((need) => !NEEDS[need].holds(c, i));
      if (!unmet) break;
      dim.deco[i] = spec.instead?.[unmet] ?? D.NONE;
    }
  }
}
