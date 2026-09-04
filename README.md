# Extended WLED Controller

A self-hosted control surface and effects engine for multiple WLED instances.
Single Docker container, Node 22 + TypeScript throughout. Single user, no auth
(put it behind your reverse proxy).

The browser never talks to a device directly — every request (WLED HTTP, the
per-device WebSocket, DDP/DNRGB over UDP) goes through the backend.

**Author:** [Frankvandetechniek.nl](https://frankvandetechniek.nl)

---

## Features

### Devices

- **Add by** IP, hostname, `host:port`, or a pasted URL. On add the backend reads
  `/json` (state + info + effects + palettes), `/json/fxdata` and `/json/cfg`,
  and stores capabilities, LED / matrix geometry, filesystem space, MAC,
  architecture, DMX start address, realtime timeout and the device's gamma /
  brightness policy.
- **`/json/fxdata` truncation handling.** Real WLED 16.0.x / QuinLED hardware
  serves this chunked and cuts it off under load. The client retries (15× by
  default), salvages whole entries from a truncated body, and pads the rest so
  effect ids stay positional. "Refresh effect metadata" retries on demand.
- **Metadata-driven native control panel.** Sliders, checkboxes and colour slots
  are built from `/json/fxdata` with the effect's own labels. Reserved effects
  are hidden (ids preserved), white / CCT controls are gated on the per-segment
  `seglc` bits, 2D-only effects are flagged on 1D strips. Every write is a
  partial `state` POST; brightness zero maps to `{on:false}`, never `bri:0`.
- **Live, push-based state.** One persistent WebSocket per device carries
  authoritative state + full `info` (fps, heap, wifi, uptime). A backend → browser
  channel forwards it into the UI, so the device page reflects changes made from
  the device's own web UI or any other app **with no polling and no refresh**.
- **Connection status** (`connecting` / `live` / `polling` / `offline`) on every
  device, a **Live** indicator for the browser channel, and a `Wi-Fi <signal>` /
  `Ethernet <speed> Mbps` pill (Ethernet speed is a per-device setting — WLED
  doesn't report it).
- **Refresh** re-reads the full snapshot, including the LED count, so assigning
  more LEDs in WLED updates the count here too.
- **Node import** — read `/json/nodes` and add the peers you pick.

### Layout

- Place fixtures on a shared **virtual canvas**. Fixture geometry maps
  wire-index → canvas position (never the reverse); everything downstream
  (preview, stream, power planner) reads that one mapping.
- **Geometry types:** strip, **matrix**, raw point list, or a **shape** its LEDs
  lay along — line, rectangle, square, triangle, diamond, circle, or a **custom**
  path you draw on the canvas (click / right-click to drop vertices, first vertex
  is LED 0, **Enter** finishes an open path, click back on point 0 to close a
  loop, **Esc** cancels).
- **Matrix wiring** is editable: horizontal or vertical, zigzag or one-way, and
  which corner holds pixel 0 (all four). The selected matrix draws its wire path
  as an overlay so you can check it against the panel.
- **Drag + corner-resize** a selected fixture on the canvas (symmetric about the
  centre, aspect-locked for square shapes, correct under rotation); the inspector
  keeps numeric width / height.
- **Floorplan reference image** — upload a plan, position and scale it under the
  grid, toggle it on the preview. Preview-only; it never reaches the wire.
- Fixture name labels on the canvas.

### Hardware

An installer's **power & data planner**. Grain is one device output = one
continuous strip; fixtures are named sections whose LEDs run on in wire order,
so power is always computed for the whole output.

- **LED-type table** — 11 common chips (WS2812B / WS2813 / SK6812 / SK6812-RGBW /
  APA102 / WS2801 at 5 V; WS2811 / WS2815 / GS8208 / UCS1903 / TM1814 at 12 V),
  each with voltage, mA-per-LED at full white, typical LEDs-per-metre and a
  recommended max run before injection.
- **Max power** — `LEDs × mA/LED` → amps and watts, with a realistic-usage note.
- **PSU recommendation** — sized to `max × 1.25`, snapped up to a standard rating,
  to sit at the **start** of the strip.
- **Data-line load** — this output's LED count against a refresh-rate budget,
  shown as a percentage.
- **Power injection points** — how many the run needs for an even voltage drop,
  and markers drawn on the plot at their approximate physical spots (mapped
  through the fixture rotations), with roughly how many metres from the strip
  start each one is.

### Scenes

A scene is an ordered **layer stack** composited over a background. Every layer
has a blend mode (normal / add / screen / multiply / lighten), an opacity, and a
**canvas region** (position + size — the layer renders scaled to that box; LEDs
outside it fall through to the layers below, overlapping boxes blend).

- **FX layers** — one of 10 pure-function effects (Solid, Gradient, Rainbow,
  Plasma, Fire, Wipe, Chase, Comet, Scanner, Sparkle), with per-effect parameters
  and an optional **mask** (another effect whose brightness gates the layer).
- **Media layers** — an uploaded image or video (`.mp4` / `.mov`). The browser
  decodes and downscales, so `@ewc/core` never runs a codec. Video is transcoded
  server-side to a small no-audio clip and gets **trim in / out**, a playback
  type (loop / hold last frame / hide when stopped) and transport controls. The
  region locks to the media's native aspect.
- **Text layers** — a string drawn on the canvas: pick a font (Inter, Oswald,
  Roboto Slab, JetBrains Mono), bold / italic / strikethrough, size in px, and a
  colour. The browser rasterises it and it pixel-maps onto the fixtures like a
  media layer.
- **Live preview** — a canvas that runs the *same* compositor as the DDP loop,
  with the fixture LEDs and names overlaid, rendered near its on-screen size so
  edges stay sharp. A **Show output** mode blacks the canvas and lights only the
  fixtures as they'd appear on the wall; an independent **Show floorplan** toggle
  overlays the plan (it stays visible in output mode too).
- **Stream the scene** to every fixture. While it streams, *every* edit — params,
  region, order, opacity, background, a Layout change — **hot-swaps** the live
  stream, phase-locked, with no restart or re-blank, so the wall tracks the
  preview exactly. Switching scenes mid-stream asks first.
- Scenes save to SQLite.

### Rundown

An ordered list of **cues** that plays scenes on the output as a show.

- Each cue holds a **number**, a name, a **target scene**, a **trigger**
  (Manual / **Follow +N s** after the previous cue starts / **Wait +N s** after
  it finishes), a **fade in**, a **duration** (`h:mm:ss`, `m:ss` or bare
  seconds) and a **fade out**.
- **Transport bar** — GO / Stop, the running cue with its phase (fading in /
  live / fading out / holding at black), a progress bar, and a live countdown to
  the next auto-cue.
- The fade is a master output level applied to every channel inside the 40 Hz
  send loop, so a multi-second fade comes out smooth.
- Cue table: reorder, per-row GO, edit, delete. Edits are saved on demand and
  take effect on the next GO; a running cue keeps its timing. After the last
  cue's fade-out the output holds at black until you press Stop, which releases
  the devices back to their presets.

### Paint

- Paint a device / segment's LEDs on a **per-LED grid** (brush, erase,
  eyedropper, fill, fill-black, brightness). Touching the canvas starts a **live
  one-device DDP stream from the painter**; every edit hot-swaps the frame with
  no restart or re-blank, so the strip tracks the canvas in real time.
- **Stop & Release** ends the stream and the device returns to its effect.
  Switching device, or painting while a scene is streaming, releases the previous
  target first (the scene case asks to confirm).
- **Pixel Scenes** — save the canvas (per-LED colour + brightness + the width it
  was painted for) to SQLite and reload it onto whichever device / segment is
  selected.
- **Bake** — write a painted canvas or Pixel Scene to the device as a
  single-frame GIF, uploaded to its filesystem and shown with the **Image**
  effect. No stream, no server involvement once baked; optionally `psave` it as a
  preset so it survives a reboot.

### System

- **Managed DMX / E1.31 patch.** On device add the app assigns a conflict-free
  universe block (170 RGB LEDs / universe, one device per universe boundary) and
  writes it to the device's `cfg.if.live.dmx` — no reboot. The page shows the
  whole patch, flags conflicts, and offers re-plan / re-push / per-device managed
  toggle. Devices with more LEDs than one universe span consecutive universes.
- **DDP settings & test.** Stream a solid colour to every device (path proof), or
  an **alignment pattern** (LED 0 white, 1 red, 2 green, last blue, the rest a dim
  ramp) — the only pattern that reveals a ±1 offset or a reversed run. A
  per-device solid tests one strip without disturbing the rest.
- **Per-device realtime output** — transport (**DDP** or the legacy **DNRGB** UDP
  fallback), a frame-rate cap, a **±1 pixel offset** to compensate an addressing
  shift, and a **Kelvin white-balance** correction for RGB-only strips (applied
  in the stream and mirrored in the preview).

### Under the hood

- **Effects are pure functions** of `(x, y, t, params)` over the normalised
  canvas, so the browser preview and the DDP frame loop run identical code.
- **Software WLED sink** (`npm run sink`) — a fake device that speaks DDP + the
  JSON API + WebSocket, renders the incoming frame in the terminal and reports
  packet stats. The realtime paths are verifiable with no ESP32 powered on.
  Flags: `--leds N`, `--matrix WxH`, `--http-port P`, `--no-ws`.
- Material Design 3 dark UI, FVDT branding.

---

## Network Protocols

Four protocols reach the devices, each for a different job.

### WLED JSON HTTP API — setup & control

Plain HTTP to `http://<device>/json*`.

- **On add / refresh:** `GET /json`, `/json/info`, `/json/fxdata`, `/json/cfg`,
  `/json/nodes` to read state, capabilities, effect metadata and peers.
- **Control writes:** partial `POST /json/state` (only the fields that changed).
  Used whenever the device WebSocket isn't open.
- **Stream release:** `POST /json/state {"live":false}` on stop, so the strip
  drops realtime and returns to its preset immediately instead of waiting out the
  realtime timeout.
- **Bake:** multipart `POST /edit` (field name **`file`**, filename **without** a
  leading `/` — get either wrong and WLED replies `200` while writing nothing).

### WLED WebSocket — live state

One persistent connection per device at `ws://<device>/ws`.

- Inbound `{"state":…,"info":…}` frames are treated as **authoritative** — the app
  has no separate health poller.
- An app-level `p` → `pong` heartbeat (20 s interval, 16 s deadline) with
  exponential-backoff reconnect that never gives up. Builds compiled without
  WebSocket support (`info.ws === -1`) fall back to HTTP polling.
- Control writes are routed here when the socket is open — one connection against
  WLED's ~8-client limit — and the resulting state comes back on the next push.
- Binary `{"lv":true}` live-view frames are ignored.

### DDP (Distributed Display Protocol) — realtime pixel streaming

The **primary** output path. UDP to port **4048**, which WLED listens on
unconditionally (no device config, no reboot).

- 10-byte header: flags, 4-bit sequence, data type (`0x0B` RGB / `0x1B` RGBW),
  destination id, a **big-endian byte offset**, and the payload length. Pixel
  data follows.
- One sequence number **per frame**, shared by every packet of that frame,
  cycling 1→15. The **PUSH** flag is set on the **last packet only**, so a frame
  renders atomically.
- The sender runs at a fixed **40 Hz**, one UDP socket, devices sent
  **sequentially** within a tick (never parallel bursts), payload chunked at
  ~1440 bytes.
- **Backpressure drops frames, never queues** — it tracks each device's reported
  render fps and skips a frame for a device that's falling behind, because a
  queued UDP stream to a struggling ESP becomes lag that never recovers.
- WLED adds the device's configured E1.31 start address to the pixel index; the
  app standardises that address on `1` and exposes a per-device **±1 pixel
  offset** to correct any residual shift.

### DNRGB (legacy WLED realtime UDP) — fallback

A per-device escape hatch for firmwares or networks where DDP misbehaves. UDP to
port **21324**.

- 4-byte header: protocol byte `4`, a **timeout** byte (2 s — a short value means
  the strip self-heals to its preset within a couple of seconds if the
  `{live:false}` release is ever lost), then a 2-byte big-endian **start LED
  index**. RGB triplets follow, up to **489 LEDs per packet**.
- **RGB only** — no white channel — and no PUSH flag; WLED renders each packet as
  it arrives. The stream service forces RGB output for a DNRGB device so every
  producer emits the right width.

### E1.31 / sACN — managed patch, not an output path

The app **plans and writes** a conflict-free E1.31 universe patch into each
device's `cfg.if.live.dmx` so an external lighting console can address the
fixtures directly. The app's own realtime output never uses E1.31 — it streams
DDP (or DNRGB).

---

## Run

### Docker (production)

```bash
docker compose up -d --build
# UI on http://<host>:8080
```

State lives in the `ewc-data` volume (`/data/ewc.sqlite`, plus `/data/media` and
`/data/floorplan`). The compose file uses bridge networking with `8080:8080`
published; all device traffic is outbound, so bridge NAT is enough. On a Linux
host you can switch to `network_mode: host` (commented in the file). The runtime
image bundles **ffmpeg** for video media layers.

### Local development

```bash
npm install
npm run dev        # server :8080, Vite UI :5173 (proxies /api)
```

Other scripts: `npm test` (core + server unit tests), `npm run typecheck`,
`npm run build`, `npm run sink` (software device).

### Configuration

See [`.env.example`](.env.example). Key vars: `EWC_PORT`, `EWC_DATA_DIR`,
`EWC_WLED_BULK_RETRIES`, `EWC_LOG_LEVEL`.

---

## Project layout

```
packages/
  core/    Runtime-agnostic WLED domain logic — types, fxdata parser, capability
           decoding, state-patch helpers, truncation salvage, DDP + DNRGB packet
           builders, DMX planner, mapping engine, render engine (pure effects +
           scene compositor), rundown model, hardware power math, API contracts.
           NO node: imports; shared verbatim with the browser.
  server/  Express + better-sqlite3 + ws. Device registry, WLED HTTP client,
           realtime hub (per-device WebSocket), browser WS fan-out, DMX service,
           DDP sender, stream service (solid / pattern / scene / paint), rundown
           engine, scene + pixel-scene + rundown stores, media store + transcode,
           bake service, REST API.
  web/     React + Vite + MUI (Material Design 3, dark). Pages: Devices, Layout,
           Hardware, Scenes, Rundown, Paint, System.
  sink/    Software WLED sink — a fake device for hardware-free testing.
```

`core` test fixtures under `packages/core/test/fixtures/` are real dumps from
WLED 16.0.0 (ESP32) and 16.0.1 (QuinLED Dig-Quad), including a genuine truncated
`/json/fxdata` capture.

---

## Verifying with hardware

1. Add your controller by IP. Confirm info / effects / palettes populate and the
   effect panel shows the right sliders for a few effects (try **Aurora**,
   **Fire 2012**, **Scrolling Text**, **GEQ**). If you see a truncated
   `/json/fxdata` notice, hit **Refresh effect metadata** until it reads
   "complete".
2. Toggle power, drag brightness, change effect / palette / speed / intensity /
   colours and confirm the strip follows. Change something from the WLED app and
   confirm this UI updates on its own.
3. **System → DMX patch:** each device is assigned a universe block written to
   its `cfg.if.live.dmx` with start address `1`. Stream the **alignment pattern**
   and confirm the first physical LED is white; nudge the per-device pixel offset
   if not.
4. **Layout:** place your fixtures, set matrix wiring if any, then go to
   **Scenes**, build a layer stack and **Stream this scene**. Confirm the
   fixtures light in canvas order and that editing the Layout re-maps them live.
   Stop releases the strips.
5. **Paint:** pick a device, click a few LEDs — the strip should light them
   immediately and keep tracking as you paint. Try Fill and the brightness
   slider. **Stop & Release** returns the strip to its effect. Save a Pixel
   Scene, clear, reload, confirm it comes back.
6. **Bake** (Paint → "Bake to device"): bake a canvas, confirm the strip shows it
   via the Image effect with no stream running. Add a preset slot, bake again,
   load that preset from the WLED app, confirm it survives a reboot.
7. **Rundown:** build two cues against saved scenes with a fade in / duration /
   fade out and a Follow trigger on the second. GO. Confirm the first fades in,
   holds, and the second takes over on schedule; **Stop** releases the devices.

---

## API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | version + uptime |
| GET | `/api/devices` | list with health |
| POST | `/api/devices` | `{host, port?, name?, linkType?}` |
| GET | `/api/devices/:id` | detail: parsed effects, palettes, capabilities, state |
| PATCH | `/api/devices/:id` | `{name?, linkType?, enabled?, brightnessPolicy?}` |
| DELETE | `/api/devices/:id` | |
| POST | `/api/devices/:id/refresh` | re-read the full snapshot (incl. LED count) |
| POST | `/api/devices/:id/refresh-fxdata` | retry `/json/fxdata` only |
| POST | `/api/devices/:id/state` | partial WLED `state` patch (≤20 fields) |
| POST | `/api/devices/:id/bake` | bake a canvas / Pixel Scene to a GIF preset |
| GET | `/api/devices/:id/nodes` | discovered peers |
| POST | `/api/devices/import-nodes` | `{hosts:[], linkType?}` |
| WS | `/api/ws` | realtime device state / health / status (read-only) |
| GET | `/api/dmx/patch` | the full DMX / E1.31 patch + conflicts |
| POST | `/api/dmx/replan` · `/api/dmx/:id/assign` | re-plan the patch / one device |
| PUT | `/api/dmx/config` · `/api/dmx/:id/managed` | packing config / managed toggle |
| GET | `/api/stream/status` | stream state + per-device stats |
| POST | `/api/stream/solid` · `/api/stream/pattern` · `/api/stream/stop` | start / stop a test stream |
| POST | `/api/stream/:id/solid` | solid to one device |
| POST | `/api/stream/scene` | stream a scene (`{sceneId}` or inline `{scene}`) |
| POST | `/api/stream/paint` | live pixel-painter stream to one device |
| PUT | `/api/stream/:id/config` | transport / fps cap / white balance |
| PUT | `/api/stream/:id/pixel-offset` | per-device LED offset compensation |
| GET/POST | `/api/scenes` · GET/PUT/DELETE `/api/scenes/:id` | saved scenes |
| GET/PUT | `/api/rundown` | the cue list |
| GET | `/api/rundown/status` | live playback state |
| POST | `/api/rundown/go` · `/api/rundown/go/:cueId` · `/api/rundown/stop` | GO / jump / stop |
| GET/POST | `/api/pixel-scenes` · `/api/pixel-scenes/:id` | saved pixel-painter canvases |
| POST/GET | `/api/media` · `/api/media/:id` | media asset upload (image RGBA / video) + fetch |
| GET/PUT | `/api/installation` | the fixture / canvas model |
| GET/PUT/DELETE | `/api/installation/floorplan` | floorplan reference image |
