import grid from '../../../../analytics/threat-grid-v1.json';

export const THREAT_GRID = grid as { grid_version: string; columns: number; rows: number; values: number[][] };
export const THREAT_MAX = Math.max(...THREAT_GRID.values.flat());
