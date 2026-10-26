// Layout of the Domain A Lobby's outdoor town: the lot, the paved areas, the
// river and the zones that later activities can use. Shared by
// tools/make-town-assets.js (ground, paths, river banks and sky are drawn in
// world coordinates from these numbers) and tools/make-lobby-town-scene.js
// (places the objects), and read by the town tests.
//
// World axes: +x east, +z south (the Lobby's front), +y up; metres. The Lobby
// building keeps its place at the origin and its entrance faces +z.

const FLOOR = { size: [40, 40], center: [0, 3], color: '#3a2f22' };
const EXTENT = { minX: -20, maxX: 20, minZ: -17, maxZ: 23 }; // the floor, as a rectangle

// The building's outer wall faces; the grass leaves a hole at the wall centre lines.
const BUILDING = { minX: -7.2, maxX: 7.2, minZ: -5.6, maxZ: 5.6, entrance: [3.2, 5.6] };
const HOLE = { minX: -7.16, maxX: 7.16, minZ: -5.56, maxZ: 5.56 };

// Heights of the flat ground layers (m). Props stand on y = 0 and sink a few
// centimetres into the layers, which are separated enough not to flicker. The
// water is above 0.05 so the renderer treats it as an obstacle, not a floor covering.
const LAYER = { grass: 0.015, path: 0.03, bank: 0.03, water: 0.06, paving: 0.045, inlay: 0.052 };

// Gravel footpaths: [ax, az, bx, bz, width]. The ring goes round the building;
// the spurs lead to each zone.
const PATH_W = 2.0;
const RING = [
  [-9.4, 7.5, -9.4, -8, PATH_W], [-9.4, -8, 9.4, -8, PATH_W], [9.4, -8, 9.4, 7.5, PATH_W], [-9.4, 7.5, -3, 7.5, PATH_W]
];
const SPURS = [
  [-9.4, 0.8, -12.4, 0.8, PATH_W], // hut
  [-9.4, -8, -11.6, -10.2, PATH_W], [-11.6, -10.2, -11.6, -12.2, PATH_W], // mine
  [9.4, -8, 11.4, -9.4, PATH_W], // overlook
  [9.4, 3.8, 13.2, 3.8, PATH_W], // river pier
  [9.4, 13.8, 15.2, 13.8, PATH_W], // south-east lawn and the bank
  [-3.4, 12.4, -5.8, 12.4, PATH_W] // plaza to market
];
const PATHS = RING.concat(SPURS);

// Paved areas (rectangles [minX, minZ, maxX, maxZ]) and circles.
const PLAZA = { minX: -3.6, maxX: 10.0, minZ: 7.0, maxZ: 17.6 };
const STOOP = { minX: 2.2, maxX: 4.2, minZ: 5.5, maxZ: 7.05 };
const MARKET = { minX: -16.6, maxX: -5.6, minZ: 9.0, maxZ: 19.0 };
const TERRACE = { cx: 12.4, cz: -10.4, r: 2.5 };
const FOUNTAIN = { cx: 3.2, cz: 12.4, r: 1.6 };
const QUARRY = { minX: -15.5, maxX: -8.2, minZ: -12.7, maxZ: -8.6 }; // the rock yard in front of the mine

// The river runs the length of the east side; the water is one solid piece.
const RIVER = { minX: 16.4, maxX: 19.6, minZ: -17.5, maxZ: 23.5 };
const PIER = { minX: 12.8, maxX: 16.9, minZ: 2.8, maxZ: 4.6 };

// The rocky hill with the mine front along the north-west edge.
const MINE = { minX: -19.8, maxX: -4.0, minZ: -17.2, maxZ: -12.8, entranceX: -11.6, entranceW: 2.2, entranceH: 2.6 };
const HUT = { cx: -14.8, cz: 0.8, rotationY: 90, width: 4.4, depth: 3.6 };

// Zones: where a player can stand, and the area kept clear for later use.
// `clear` is [minX, minZ, maxX, maxZ]: nothing solid is placed inside it.
const ZONES = {
  entrance: { label: 'Main entrance', stand: [3.2, 6.4] },
  plaza: { label: 'Main plaza', stand: [7.4, 12.4], clear: [6.9, 8.0, 8.4, 16.2] },
  market: { label: 'Market and social square', stand: [-11, 14], clear: [-14.4, 11.4, -7.8, 16.8] },
  hut: { label: 'Small hut', stand: [-11.4, 0.8], clear: [-12.0, -0.6, -9.6, 2.2] },
  mine: { label: 'Mine and rock yard', stand: [-11.6, -10.4], clear: [-13.6, -11.8, -9.6, -8.9] },
  river: { label: 'River bank and pier', stand: [15.4, 3.7], clear: [12.8, 2.9, 16.0, 4.5] },
  overlook: { label: 'Quiet overlook', stand: [12.0, -10.4], clear: [10.6, -11.8, 13.4, -9.0] },
  lawn: { label: 'South-east lawn', stand: [12.2, 18.6], clear: [11.6, 15.6, 14.0, 19.6] }
};
// The wayfinding signpost on the plaza: one arrow board per zone it points to.
const SIGNPOST = {
  at: [0.6, 8.4],
  boards: [
    { label: 'MARKET', to: ZONES.market.stand },
    { label: 'HUT', to: ZONES.hut.stand },
    { label: 'MINE', to: ZONES.mine.stand },
    { label: 'RIVER', to: ZONES.river.stand },
    { label: 'OVERLOOK', to: ZONES.overlook.stand }
  ]
};
// Corners and middles of the walk around the building.
const PERIMETER = [[-9.4, 7.5], [-9.4, 0.8], [-9.4, -8], [0, -8], [9.4, -8], [9.4, 0], [9.4, 7.5], [3.2, 7.5]];

module.exports = { FLOOR, EXTENT, BUILDING, HOLE, LAYER, PATH_W, PATHS, RING, SPURS, PLAZA, STOOP, MARKET, TERRACE, FOUNTAIN, QUARRY, RIVER, PIER, MINE, HUT, ZONES, SIGNPOST, PERIMETER };
