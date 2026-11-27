// Graphics settings: how the map is drawn, never what is generated. Changing one must not
// regenerate the world. Described by metadata so the settings UI is built from this list.
// The renderer owns this file: add a def here and it shows up in the UI.

export interface GraphicsDef {
  key: string;
  label: string;
  group: string;
  type: 'int' | 'float' | 'bool' | 'enum';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string; help?: string }[];
  /** numbers: the only values allowed; anything else snaps to the nearest */
  values?: number[];
  default: number | boolean | string;
  help: string;
  /** extra words the search should match */
  keywords?: string;
}

export type GraphicsSettings = Record<string, number | boolean | string>;

const L = 'Graphics: light', S = 'Graphics: shadows', DT = 'Graphics: detail', W = 'Graphics: water', WL = 'Graphics: walls', P = 'Graphics: post', O = 'Graphics: overlay', C = 'Graphics: camera';

export const GRAPHICS_DEFS: GraphicsDef[] = [
  // light
  { key: 'exposure', label: 'Exposure', group: L, type: 'float', min: 0.25, max: 3, step: 0.05, default: 1, help: 'Overall brightness before tone mapping, on top of each scene\'s own exposure. Lower it where bright scenes wash out.', keywords: 'brightness tone blown out' },
  { key: 'toneMap', label: 'Tone mapping', group: L, type: 'enum', options: [{ value: 'filmic', label: 'Filmic', help: 'Soft shoulder, keeps bright skies from clipping' }, { value: 'reinhard', label: 'Reinhard', help: 'Gentle, slightly flat' }, { value: 'punchy', label: 'Punchy', help: 'Contrasty, clips highlights earlier' }, { value: 'none', label: 'None (clamp)' }], default: 'filmic', help: 'How bright values are squeezed into the screen range.', keywords: 'tonemap hdr aces curve' },
  { key: 'ambient', label: 'Ambient light', group: L, type: 'float', min: 0, max: 2.5, step: 0.05, default: 1, help: 'Strength of the sky / cave fill light that reaches everything.', keywords: 'fill dark brightness' },
  { key: 'sunStrength', label: 'Sun / moon strength', group: L, type: 'float', min: 0, max: 2, step: 0.05, default: 1, help: 'Strength of the key light from the sun (or the moon at night).', keywords: 'key light directional' },
  { key: 'pointLights', label: 'Point light intensity', group: L, type: 'float', min: 0, max: 3, step: 0.05, default: 1, help: 'Brightness of lanterns, windows, crystals, lava and torches.', keywords: 'lamps torches glow' },
  { key: 'maxLights', label: 'Max point lights', group: L, type: 'int', min: 0, max: 28, step: 1, default: 28, help: 'How many point lights near the view are evaluated per pixel. Lower is faster.', keywords: 'performance lights count' },
  { key: 'bloom', label: 'Bloom', group: L, type: 'float', min: 0, max: 2, step: 0.05, default: 1, help: 'Strength of the glow around bright and emissive pixels.', keywords: 'glow' },
  { key: 'bloomThreshold', label: 'Bloom threshold', group: L, type: 'float', min: 0, max: 2, step: 0.05, default: 0.85, help: 'How bright a pixel must be (after exposure) before it glows.', keywords: 'glow' },
  { key: 'bloomRadius', label: 'Bloom radius', group: L, type: 'float', min: 0.5, max: 3, step: 0.1, default: 1, help: 'How far the glow spreads.', keywords: 'glow size blur' },
  // shadows
  { key: 'shadows', label: 'Shadows', group: S, type: 'enum', options: [{ value: 'baked', label: 'From models', help: 'Projected from each sprite\'s baked 3D height map, for the current sun' }, { value: 'flat', label: 'Flat', help: 'A flattened, sheared copy of each sprite\'s silhouette' }, { value: 'off', label: 'Off' }], default: 'baked', help: 'How things standing on the ground cast shadows. Shadows are computed in world space, so they never depend on what is on screen.', keywords: 'shade sun' },
  { key: 'shadowStrength', label: 'Shadow strength', group: S, type: 'float', min: 0, max: 1, step: 0.05, default: 0.7, help: 'How much of the sun a shadow blocks.', keywords: 'shade darkness' },
  { key: 'shadowSoftness', label: 'Shadow softness', group: S, type: 'float', min: 0, max: 1, step: 0.05, default: 0.25, help: 'Blurs shadow edges by up to a few pixels (0 keeps hard pixel edges).', keywords: 'shade blur penumbra' },
  { key: 'terrainShadows', label: 'Cliff shadows', group: S, type: 'bool', default: true, help: 'Raised ground and cliffs cast shadows from the tile heights. Independent of "Shadows" on purpose: stays on when prop shadows are off.', keywords: 'shade cliff terrain' },
  { key: 'contactShadows', label: 'Contact shadows', group: S, type: 'float', min: 0, max: 1, step: 0.05, default: 0.4, help: 'Darkening where props and walls meet the ground. Independent of "Shadows" on purpose (it is ambient occlusion, not sun shadow).', keywords: 'ao ambient occlusion grounding' },
  { key: 'lightShadows', label: 'Point-light shadows', group: S, type: 'enum', options: [{ value: 'off', label: 'Off' }, { value: '4', label: 'Nearest 4' }, { value: '8', label: 'Nearest 8' }, { value: 'all', label: 'All active' }], default: '8', help: 'Walls, props and creatures cast shadows from torches, lanterns and crystals when zoomed in (the strongest lights on screen first). Each light costs about 12 texture reads per pixel.', keywords: 'torch shadow occlusion lights' },
  { key: 'lightShadowsZoom', label: 'Point-light shadows from zoom', group: S, type: 'float', min: 4, max: 64, step: 1, default: 20, help: 'Pixels per tile above which point-light shadows switch on (faded in over a few px/tile).', keywords: 'torch shadow zoom threshold' },
  { key: 'lightShadowsSoftness', label: 'Point-light shadow softness', group: S, type: 'float', min: 0, max: 1, step: 0.05, default: 0.3, help: 'Soft (1) or hard pixel (0) edges of point-light shadows.', keywords: 'torch shadow blur' },
  // detail
  { key: 'detailDistance', label: 'Detail distance', group: DT, type: 'float', min: 2, max: 24, step: 0.5, default: 4, help: 'Zoom level (pixels per tile) below which the low-resolution overview replaces full-detail tiles and sprites.', keywords: 'dither lod overview distance' },
  { key: 'detailFade', label: 'Detail fade', group: DT, type: 'float', min: 0, max: 12, step: 0.5, default: 4, help: 'How many pixels per tile the cross-fade between overview and full detail lasts.', keywords: 'dither lod' },
  { key: 'spriteResolution', label: 'Texture resolution', group: DT, type: 'int', min: 16, max: 128, step: 16, values: [16, 32, 64, 128], default: 16, help: 'Texels per tile of every texture in the world: ground, wall faces, masks, decals, trees, props, objects, buildings, creatures and characters, with the lighting, shadow and water grids following. 16, 32, 64 or 128. Changing it bakes everything again at the new size (standing sprites as they are needed).', keywords: 'pixel size sprite texture resolution detail hd bake' },
  { key: 'animationFps', label: 'Animation frame rate', group: DT, type: 'int', min: 4, max: 17, step: 1, default: 7, help: 'Frames per second of creature animations. A walk cycle always lasts the same time; a higher rate draws it in more frames (4 fps: 2 frames, 7: 4, 17: 10), which are baked as they are needed.', keywords: 'animation fps frames smooth choppy walk cycle' },
  { key: 'mipmaps', label: 'Mipmaps', group: DT, type: 'bool', default: true, help: 'When zoomed out, average the pixels that fall on one screen pixel instead of picking one. Applies to the terrain and to every sprite (trees, props, objects, characters), on colour, shading and glow alike. Stops them shimmering while the view moves; off is crisper but noisier.', keywords: 'mip aliasing shimmer flicker zoom out filter smooth' },
  { key: 'dither', label: 'Dithered fade', group: DT, type: 'bool', default: true, help: 'Cross-fade with an ordered pixel dither (on) or switch hard at the detail distance (off).', keywords: 'dither lod transition' },
  { key: 'outlineCreatures', label: 'Outline: creatures', group: DT, type: 'enum', options: [{ value: 'off', label: 'Off' }, { value: 'subtle', label: 'Subtle' }, { value: 'strong', label: 'Strong' }], default: 'subtle', help: 'A 1 px darker rim (a darker shade of the sprite\'s own edge colour) around enemies, NPCs, bosses and the start marker.', keywords: 'outline edge readability enemies npc' },
  { key: 'outlineObjects', label: 'Outline: objects', group: DT, type: 'enum', options: [{ value: 'off', label: 'Off' }, { value: 'subtle', label: 'Subtle' }, { value: 'strong', label: 'Strong' }], default: 'subtle', help: 'Rim around chests, gates, entrances, sources and stairs.', keywords: 'outline edge readability chest gate' },
  { key: 'outlineProps', label: 'Outline: props', group: DT, type: 'enum', options: [{ value: 'off', label: 'Off' }, { value: 'subtle', label: 'Subtle' }, { value: 'strong', label: 'Strong' }], default: 'off', help: 'Rim around trees, rocks and buildings.', keywords: 'outline edge trees houses' },
  { key: 'renderScale', label: 'Render scale', group: DT, type: 'float', min: 0.35, max: 2, step: 0.05, default: 1, help: 'Internal resolution relative to the screen (capped by the device pixel ratio). Lower is faster and chunkier.', keywords: 'resolution performance pixels dpr' },
  { key: 'maxPixels', label: 'Max internal megapixels', group: DT, type: 'float', min: 0.3, max: 6, step: 0.1, default: 1.6, help: 'Upper bound on the lit renderer\'s internal resolution, in millions of pixels.', keywords: 'resolution performance cap' },
  { key: 'particles', label: 'Particle density', group: DT, type: 'float', min: 0, max: 2, step: 0.05, default: 1, help: 'Fireflies, embers, snow, mist and sparkles.', keywords: 'effects ambient' },
  { key: 'animation', label: 'Creature animation', group: DT, type: 'bool', default: true, help: 'Animate enemies and NPCs (they always stand still with reduced motion).', keywords: 'motion wander enemies' },
  // walls
  { key: 'wallRoom', label: 'Wall faces: rooms', group: WL, type: 'float', min: 4, max: 24, step: 1, default: 14, help: 'Indoors and underground every wall leans away from the floor, so all four show a face. This is how wide each face is on screen, in texture pixels (a tile is 16).', keywords: 'dungeon cave interior wall face size splay' },
  { key: 'wallSouth', label: 'Wall faces: outdoors, facing south', group: WL, type: 'float', min: 0, max: 24, step: 1, default: 10, help: 'Outdoors the face that looks toward the camera is the tall one. This is added to its height: 0 is an upright wall.', keywords: 'cliff castle wall face size overworld' },
  { key: 'wallSide', label: 'Wall faces: outdoors, sides', group: WL, type: 'float', min: 0, max: 16, step: 1, default: 5, help: 'Width of the faces that look east and west outdoors.', keywords: 'cliff castle wall face size overworld left right' },
  { key: 'wallNorth', label: 'Wall faces: outdoors, facing north', group: WL, type: 'float', min: 0, max: 16, step: 1, default: 6, help: 'Width of the face that looks away from the camera outdoors. A wall never covers the ground behind it, whatever this is set to.', keywords: 'cliff castle wall face size overworld up back' },
  { key: 'wallLip', label: 'Wall faces: thin bevel', group: WL, type: 'float', min: 0, max: 6, step: 0.5, default: 1.5, help: 'Width of the bevel on walls that show no side faces (low walls, kerbs, water edges).', keywords: 'lip bevel kerb' },
  // water
  { key: 'water', label: 'Water animation', group: W, type: 'float', min: 0, max: 2, step: 0.05, default: 1, help: 'How strongly water, lava and waterfalls move.', keywords: 'waves river flow' },
  { key: 'waterFoam', label: 'Water foam', group: W, type: 'float', min: 0, max: 2, step: 0.05, default: 1, help: 'Amount of drifting foam streaks on the open sea and of flow streaks on rivers (surf along coasts is always drawn).', keywords: 'whitecaps waves streaks' },
  { key: 'waterGlint', label: 'Speculars: brightness', group: W, type: 'float', min: 0, max: 4, step: 0.05, default: 1, help: 'How bright the sun and moon glints on water are. 0 switches them off.', keywords: 'specular sparkle glint sea highlight' },
  { key: 'waterGlintDensity', label: 'Speculars: density', group: W, type: 'float', min: 0, max: 8, step: 0.1, default: 1, help: 'How many glints there are. 1 is sparse; 8 covers the crests in sparkle.', keywords: 'specular sparkle glint count amount' },
  { key: 'waterGlintSize', label: 'Speculars: size', group: W, type: 'int', min: 1, max: 8, step: 1, default: 4, help: 'Size of one glint in texture pixels (a tile is 16).', keywords: 'specular sparkle glint pixel' },
  { key: 'waterGlintCrest', label: 'Speculars: crest focus', group: W, type: 'float', min: 0, max: 1.25, step: 0.05, default: 1, help: 'How strictly glints keep to the crests of the swell. 0 scatters them over all water; higher values leave only the tops of the highest waves.', keywords: 'specular sparkle glint waves swell spread' },
  { key: 'waterGlintLowSun', label: 'Speculars: low-sun boost', group: W, type: 'float', min: 0, max: 4, step: 0.1, default: 1, help: 'How much brighter glints get when the sun or moon is near the horizon. 0 keeps them the same all day.', keywords: 'specular sparkle glint sunset dusk dawn time' },
  { key: 'waterGlintLights', label: 'Speculars: from lamps', group: W, type: 'float', min: 0, max: 4, step: 0.05, default: 1, help: 'Glints that torches, lanterns and other point lights make on water near them.', keywords: 'specular sparkle glint torch point light cave' },
  // post
  { key: 'saturation', label: 'Saturation', group: P, type: 'float', min: 0, max: 2, step: 0.05, default: 1, help: 'Colour intensity after lighting (1 = each scene\'s own grade).', keywords: 'colour grade vivid' },
  { key: 'contrast', label: 'Contrast', group: P, type: 'float', min: 0.5, max: 1.6, step: 0.02, default: 1, help: 'Contrast after lighting (1 = each scene\'s own grade).', keywords: 'grade' },
  { key: 'vignette', label: 'Vignette', group: P, type: 'float', min: 0, max: 2, step: 0.05, default: 1, help: 'Darkening toward the screen corners.', keywords: 'corners frame' },
  { key: 'fogDarkness', label: 'Unreachable darkness', group: P, type: 'float', min: 0, max: 1, step: 0.05, default: 0.45, help: 'How much zones you cannot reach yet are darkened.', keywords: 'fog of war unreachable' },
  { key: 'fogDesaturation', label: 'Unreachable desaturation', group: P, type: 'float', min: 0, max: 1, step: 0.05, default: 0.8, help: 'How much colour zones you cannot reach yet lose.', keywords: 'fog of war grey' },
  // camera
  { key: 'integerZoom', label: 'Integer zoom', group: C, type: 'bool', default: false, help: 'When zoomed in past one screen pixel per source pixel, snap the zoom to whole multiples (2x, 3x, ...) so every source pixel is drawn the same size.', keywords: 'pixel perfect uneven pixels scale' },
  { key: 'pixelSnap', label: 'Camera snapping', group: C, type: 'enum', options: [{ value: 'world', label: 'World pixel', help: 'The camera moves in whole source (texture) pixels: art never shifts by part of a pixel' }, { value: 'screen', label: 'Screen pixel', help: 'Camera position rounded to whole device pixels: no half-pixel shimmer, motion as smooth as the display allows' }, { value: 'none', label: 'None', help: 'Unrounded, sub-pixel camera' }], default: 'screen', help: 'How the camera position is rounded while panning.', keywords: 'shimmer crawl jitter pixel snap' },
  // overlay
  { key: 'labels', label: 'Region labels', group: O, type: 'bool', default: true, help: 'Show region and river names when zoomed out.', keywords: 'names text' },
  { key: 'labelSize', label: 'Label size', group: O, type: 'float', min: 0.6, max: 2, step: 0.05, default: 1, help: 'Size of region labels.', keywords: 'text font' },
  { key: 'pins', label: 'Map pins', group: O, type: 'bool', default: true, help: 'Show pins for objects when zoomed out.', keywords: 'markers icons' },
  { key: 'pinSize', label: 'Pin size', group: O, type: 'float', min: 0.5, max: 2, step: 0.05, default: 1, help: 'Size of the map pins shown when zoomed out.', keywords: 'markers icons' },
  { key: 'pinDensity', label: 'Pin density', group: O, type: 'float', min: 0, max: 2, step: 0.05, default: 1, help: 'How many pins are kept when zoomed out (0 = none).', keywords: 'markers declutter' },
];

export function defaultGraphics(): GraphicsSettings {
  return Object.fromEntries(GRAPHICS_DEFS.map((d) => [d.key, d.default]));
}

export function normalizeGraphics(partial?: Record<string, unknown> | null): GraphicsSettings {
  const g = defaultGraphics();
  for (const d of GRAPHICS_DEFS) {
    const v = partial?.[d.key];
    if (d.type === 'bool') { if (typeof v === 'boolean') g[d.key] = v; }
    else if (d.type === 'enum') { if (d.options!.some((o) => o.value === v)) g[d.key] = v as string; }
    else if (typeof v === 'number' && Number.isFinite(v)) {
      const c = Math.max(d.min!, Math.min(d.max!, v));
      g[d.key] = d.values ? d.values.reduce((a, b) => (Math.abs(b - c) < Math.abs(a - c) ? b : a)) : d.type === 'int' ? Math.round(c) : c;
    }
  }
  return g;
}

/** typed view used by the renderers */
export interface Gfx {
  exposure: number; toneMap: string; ambient: number; sunStrength: number; pointLights: number; maxLights: number;
  bloom: number; bloomThreshold: number; bloomRadius: number;
  shadows: 'baked' | 'flat' | 'off'; shadowStrength: number; shadowSoftness: number; terrainShadows: boolean; contactShadows: number;
  detailDistance: number; detailFade: number; dither: boolean; mipmaps: boolean; spriteResolution: number; renderScale: number; maxPixels: number;
  particles: number; water: number; waterFoam: number; animation: boolean;
  wallRoom: number; wallSouth: number; wallSide: number; wallNorth: number; wallLip: number;
  waterGlint: number; waterGlintDensity: number; waterGlintSize: number; waterGlintCrest: number; waterGlintLowSun: number; waterGlintLights: number;
  saturation: number; contrast: number; vignette: number; fogDarkness: number; fogDesaturation: number;
  pixelSnap: 'world' | 'screen' | 'none'; integerZoom: boolean;
  animationFps: number; outlineCreatures: 'off' | 'subtle' | 'strong'; outlineObjects: 'off' | 'subtle' | 'strong'; outlineProps: 'off' | 'subtle' | 'strong';
  pins: boolean; lightShadows: 'off' | '4' | '8' | 'all'; lightShadowsZoom: number; lightShadowsSoftness: number; labels: boolean; labelSize: number; pinSize: number; pinDensity: number;
}

export function gfx(g: GraphicsSettings): Gfx {
  return normalizeGraphics(g) as unknown as Gfx;
}
