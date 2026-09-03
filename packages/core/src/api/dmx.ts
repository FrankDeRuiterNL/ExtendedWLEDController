/** DTOs for the app-managed DMX / E1.31 patch. */

import type { DmxAllocation, DmxPlanConfig } from '../dmx/plan.js';

export interface DmxPatchEntryDTO {
  deviceId: number;
  name: string;
  ledCount: number | null;
  /** App is managing this device's DMX address. */
  managed: boolean;
  /** The app's assigned allocation, or null if never planned. */
  allocation: DmxAllocation | null;
  /** What the device currently reports in `cfg.if.live.dmx`. */
  deviceReports: {
    universe: number | null;
    startAddress: number;
    mode: number | null;
  };
  /** True when the device's cfg matches `allocation`. */
  inSync: boolean;
  /** Set if the last attempt to write the plan to the device failed. */
  writeError: string | null;
}

export interface DmxPatchConflictDTO {
  deviceIdA: number;
  deviceIdB: number;
  nameA: string;
  nameB: string;
  universes: [number, number];
}

export interface DmxPatchDTO {
  config: DmxPlanConfig;
  entries: DmxPatchEntryDTO[];
  conflicts: DmxPatchConflictDTO[];
  /** Highest universe number in use. */
  highestUniverse: number;
}

export interface UpdateDmxConfigRequest {
  config: Partial<DmxPlanConfig>;
  /** Re-plan and re-write every managed device with the new config. */
  replan?: boolean;
}
