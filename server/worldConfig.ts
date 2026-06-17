// The world definition: an invisible logical grid overlaid on the background
// image. Everything is WALKABLE except the blocked rectangles below.
//
// All coordinates are in grid cells (32 px each over the 1920×1080 image:
// 60 columns × 34 rows). The bridge is the exception — its crossing waypoints
// are in PIXELS, because agents follow them with sub-cell precision so their
// feet stay on the painted planks.
//
// Tune this file against your image with the in-browser debug overlay (press
// G): the grid, blocked rectangles, location radii, AND the bridge path all
// draw over the background. In dev the server restarts on save and the page
// reloads itself — adjust, save, look, repeat.

import type { Point } from './types.js';

export interface BlockedRect {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface LocationCfg {
  name: string;
  x: number;
  y: number;
  radius: number;
}

export interface BridgeCfg {
  /** Crossing waypoints in PIXELS, clearing-side → village-side (feet line). */
  path: Point[];
  /** Walkable grid cell where the clearing-side foot meets land. */
  mouthA: Point;
  /** Walkable grid cell where the village-side foot meets land. */
  mouthB: Point;
  /** Two points (PIXELS) defining the river line, for the which-side test. */
  river: { a: Point; b: Point };
}

export interface WorldConfig {
  cols: number;
  rows: number;
  cellPx: number;
  blocked: BlockedRect[];
  locations: LocationCfg[];
  bridge: BridgeCfg;
}

// Hand-fitted to client/public/assets/background.png (painted forest village):
// cabins top-left & top-right, well top-center, campfire plaza center, market
// & fenced garden on the right, big cottage bottom-right, and the stream that
// runs from the upper-left waterfall down to the lower-right — crossed only by
// the wooden bridge in the lower-center.
export const WORLD_CONFIG: WorldConfig = {
  cols: 60,
  rows: 34,
  cellPx: 32,
  blocked: [
    // --- forest border (the painted tree frame) ---
    { x: 0, y: 0, w: 60, h: 4, label: 'forest north' },
    { x: 0, y: 0, w: 3, h: 34, label: 'forest west' },
    { x: 54, y: 0, w: 6, h: 34, label: 'forest east' },
    { x: 0, y: 31, w: 60, h: 3, label: 'forest south' },
    // --- inner tree clusters kept off the walkable paths ---
    { x: 17, y: 4, w: 6, h: 3, label: 'trees north-mid' },
    { x: 32, y: 4, w: 6, h: 3, label: 'trees north-mid 2' },
    { x: 3, y: 4, w: 5, h: 9, label: 'trees west-upper' },
    { x: 46, y: 4, w: 8, h: 10, label: 'trees east-upper' },
    // --- buildings & furniture (fit to the painting via the grid overlay) ---
    { x: 8, y: 3, w: 9, h: 8, label: 'cottage (Mira)' },
    { x: 37, y: 4, w: 8, h: 7, label: 'cabin north-east' },
    { x: 22, y: 6, w: 5, h: 5, label: 'well' },
    { x: 29, y: 15, w: 4, h: 3, label: 'campfire pit' },
    { x: 45, y: 13, w: 7, h: 6, label: 'market stall' },
    { x: 44, y: 19, w: 8, h: 5, label: 'garden fence' },
    { x: 34, y: 22, w: 10, h: 8, label: 'cottage south' },
    // --- the stream (blocks water-walking). The bridge crossing is scripted
    //     in pixels above this; the deck row is blocked between the two mouths
    //     so A* can't sneak across on the grid — only the scripted path can. ---
    { x: 4, y: 13, w: 7, h: 7, label: 'waterfall pool' },
    { x: 9, y: 19, w: 6, h: 5, label: 'upper stream' },
    { x: 13, y: 23, w: 11, h: 3, label: 'bridge deck + water (impassable on grid)' },
    { x: 18, y: 26, w: 8, h: 4, label: 'lower stream' },
    { x: 22, y: 29, w: 8, h: 3, label: 'lower stream exit' },
    // --- decoration cluster agents shouldn't clip through ---
    { x: 4, y: 11, w: 3, h: 2, label: 'crystals west' },
  ],
  locations: [
    { name: 'Cottage', x: 18, y: 11, radius: 3 },
    { name: 'Well', x: 25, y: 12, radius: 3 },
    { name: 'Campfire', x: 31, y: 16, radius: 4 },
    { name: 'Market Stall', x: 44, y: 16, radius: 3 },
    { name: 'Garden', x: 43, y: 21, radius: 3 },
    { name: 'Bridge', x: 25, y: 24, radius: 2 },
    { name: 'Forest Clearing', x: 7, y: 27, radius: 4 },
  ],
  bridge: {
    // feet centerline along the planks, clearing-side (SW) → village-side (SE)
    path: [
      { x: 398, y: 792 },
      { x: 478, y: 780 },
      { x: 560, y: 763 },
      { x: 648, y: 760 },
      { x: 732, y: 773 },
      { x: 805, y: 792 },
    ],
    mouthA: { x: 12, y: 24 }, // clearing foot  (~398,792)
    mouthB: { x: 25, y: 24 }, // village foot   (~805,792)
    river: { a: { x: 256, y: 512 }, b: { x: 832, y: 1056 } },
  },
};
