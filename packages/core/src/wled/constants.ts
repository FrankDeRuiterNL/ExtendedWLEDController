/** WLED protocol constants. Values verified against the build spec. */

/** HTTP port WLED serves on by default. */
export const WLED_HTTP_PORT = 80;

/** DDP realtime UDP port. Listener is always on; no device config needed. */
export const DDP_PORT = 4048;

/** Legacy realtime UDP port (WARLS/DRGB/DRGBW/DNRGB). */
export const LEGACY_REALTIME_PORT = 21324;

/** WebSocket path on the device. */
export const WLED_WS_PATH = '/ws';

/** Max WebSocket text frame the device will accept, by architecture. */
export const WS_MAX_TEXT_FRAME = { esp32: 1428, esp8266: 528 } as const;

/** Concurrent WebSocket client limit, by architecture. */
export const WS_CLIENT_LIMIT = { esp32: 8, esp8266: 3 } as const;

/** Hard `MAX_LEDS` ceilings, by architecture family. */
export const MAX_LEDS = {
  esp32: 16384,
  'esp32-s3': 16384,
  'esp32-p4': 16384,
  'esp32-s2': 2048,
  'esp32-c3': 4096,
  esp8266: 1536,
} as const;

/** Realistic frame-rate ceiling — WiFi jitter bound, not protocol bound. */
export const FPS_CEILING = 40;

/** `info.ws === WS_UNSUPPORTED` means the build has no WebSocket — poll instead. */
export const WS_UNSUPPORTED = -1;

/** `info.ndc === NODE_DISCOVERY_DISABLED` means node discovery is off. */
export const NODE_DISCOVERY_DISABLED = -1;
