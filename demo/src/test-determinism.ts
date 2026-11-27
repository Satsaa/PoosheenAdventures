import { generateWorld } from './gen/index';
import { useSmallDefaults } from './core/settings';
useSmallDefaults();
const strip = (w: unknown) => JSON.stringify(w, (k, v) => (k === 'stats' ? undefined : ArrayBuffer.isView(v) ? Array.from(v as unknown as number[]) : v));
let diff = 0;
for (let i = 0; i < 25; i++) if (strip(generateWorld('det' + i)) !== strip(generateWorld('det' + i))) diff++;
console.log('DETERMINISM', diff === 0 ? 'ok: 25 seeds generated twice, byte-identical' : `FAILED on ${diff} seeds`);
process.exit(diff ? 1 : 0);
