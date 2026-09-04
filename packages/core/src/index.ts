/**
 * @ewc/core — runtime-agnostic WLED domain logic.
 *
 * This package must import cleanly into the browser: NO `node:` built-ins, no
 * Node-only APIs. The server renderer and the browser preview share this code
 * verbatim (build spec, "Architecture").
 */

export * from './wled/state.js';
export * from './wled/info.js';
export * from './wled/cfg.js';
export * from './wled/capabilities.js';
export * from './wled/fxdata.js';
export * from './wled/patch.js';
export * from './wled/paint.js';
export * from './wled/constants.js';

export * from './util/salvage.js';
export * from './ddp/packet.js';
export * from './ddp/legacyUdp.js';
export * from './dmx/plan.js';
export * from './mapping/model.js';
export * from './mapping/engine.js';
export * from './hardware/power.js';

export * from './render/types.js';
export * from './render/color.js';
export * from './render/noise.js';
export * from './render/blend.js';
export * from './render/registry.js';
export * from './render/scene.js';
export * from './render/whiteBalance.js';
export * from './rundown/model.js';

export * from './api/devices.js';
export * from './api/realtime.js';
export * from './api/dmx.js';
export * from './api/scenes.js';
export * from './api/pixelScenes.js';
export * from './api/rundown.js';

/**
 * Single source of truth for the application version. Shown in the UI footer and
 * reported by `/api/health`. Bump per Semantic Versioning (https://semver.org)
 * on every milestone completion or otherwise significant change, and keep the
 * five workspace `package.json` versions in step with it.
 */
export const APP_VERSION = '0.14.2';

/** @deprecated use {@link APP_VERSION} — kept so older callers keep compiling. */
export const CORE_VERSION = APP_VERSION;
