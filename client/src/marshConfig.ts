// World 2 — the Marsh Outpost. A purely client-side world reached through the
// portal in the village. The map is assets/marsh_background.png (1920×1080, same
// 60×34 / 32px grid as the village). Agents here roam client-side for now.
//
// WALKABILITY is a deliberate FIRST PASS: only the outer border is blocked so the
// whole marsh is walkable. Tune it the same way as the village — enter the marsh,
// press G to see the grid, and add blocked rectangles below to fence off the water
// channels and structures, then save (the page hot-reloads).

import type { GridInfo, Point } from './types';

export interface MarshAgentDef {
  id: string;
  name: string;
  color: string;
  /** Spawn cell (also its idle "home" the roam wanders around). */
  home: Point;
  role: string;
}

export const MARSH_GRID: GridInfo = {
  cols: 60,
  rows: 34,
  cellPx: 32,
  blocked: [
    // outer frame (dark marsh/forest edge). Carve the water with G + more rects.
    { x: 0, y: 0, w: 60, h: 3, label: 'marsh north' },
    { x: 0, y: 31, w: 60, h: 3, label: 'marsh south' },
    { x: 0, y: 0, w: 3, h: 34, label: 'marsh west' },
    { x: 57, y: 0, w: 3, h: 34, label: 'marsh east' },
  ],
};

// Named landmarks (drawn as faint labels + clickable, like the village).
export const MARSH_LOCATIONS: Array<{ name: string; x: number; y: number; radius: number }> = [
  { name: 'The Beacon', x: 30, y: 12, radius: 4 },
  { name: 'Field Camp', x: 30, y: 26, radius: 4 },
];

// The four Marsh Outpost agents (Armada "field operations" crew). Personas are
// placeholders for the eventual AI wiring — rename/repurpose freely.
export const MARSH_AGENTS: MarshAgentDef[] = [
  { id: 'kael', name: 'Kael', color: '#6fd3c2', home: { x: 12, y: 9 }, role: 'Field inspector — scouts loss sites and logs first impressions.' },
  { id: 'lyra', name: 'Lyra', color: '#ffd166', home: { x: 48, y: 10 }, role: 'Surveyor — maps damage and measurements across the property.' },
  { id: 'nola', name: 'Nola', color: '#f78da7', home: { x: 12, y: 24 }, role: 'Logistics — stages equipment and coordinates the crew.' },
  { id: 'soren', name: 'Soren', color: '#9d8cff', home: { x: 47, y: 24 }, role: 'Client liaison — keeps homeowners informed on the ground.' },
];

// Where "you" arrive when stepping through the village portal, and the return
// portal that takes you back. Kept a few cells apart so arriving doesn't instantly
// re-trigger the portal you land next to.
export const MARSH_PLAYER_SPAWN: Point = { x: 30, y: 27 };
export const MARSH_RETURN_PORTAL: Point = { x: 25, y: 27 };

// The village-side portal cell (upper-right forest edge). Tune to taste — render
// a marker overlay or press G in the village to line it up with the path.
export const VILLAGE_PORTAL_CELL: Point = { x: 45, y: 11 };
