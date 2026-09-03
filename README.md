# Extended WLED Controller

A self-hosted control surface and effects engine for multiple WLED instances.
Single Docker container, Node 22 + TypeScript throughout. Single user, no auth
(put it behind your reverse proxy).

**Author:** [Frankvandetechniek.nl](https://frankvandetechniek.nl)

---

## Status — milestone 6 of 7

| # | Milestone | State |
|---|---|---|
| 1 | Registry + metadata-driven native control | ✅ |
| 2 | State proxy (per-device WebSocket, live push) | ✅ |
| 3 | Managed DMX patch + mapping + DDP transport | ✅ |
| 4 | Render engine + effects (layers, scenes, preview) | ✅ |
| 5 | Pixel painter (live DDP stream) + Pixel Scenes | ✅ |
| **6** | **Bake service (single-frame GIF → preset)** | **✅ this build** |
| 7 | Polish (health, fps, DNRGB fallback, per-device white balance, floorplan overlay, fixture shapes) | — |

### What milestone 1 does

- **Device registry** (SQLite): add by IP / hostname / `host:port` / pasted URL.
  On add it reads `/json` (state + info + effects + palettes), `/json/fxdata`
  and `/json/cfg`, and stores capabilities, LED/matrix geometry, filesystem
  space, MAC, architecture, **DMX start address**, realtime timeout and the
  device's gamma / brightness policy.
- **`/json/fxdata` truncation handling.** Real WLED 16.0.x / QuinLED hardware
  serves this chunked and cuts it off under load ~85 % of the time. The client
  retries (default 15×), salvages whole entries from a truncated body, and pads
  the rest so effect ids stay positional. `POST /api/devices/:id/refresh-fxdata`
  retries on demand.
- **Metadata-driven control panel.** Sliders, checkboxes and colour slots are
  built from `/json/fxdata` with the effect's own labels. `RSVD` effects are
  filtered from pickers (ids preserved). White / CCT controls are gated on the
  **per-segment** `info.leds.seglc` bits. 2D-only effects are flagged on 1D
  strips. Every write is a partial `state` POST; brightness zero maps to
  `{on:false}`, never `bri:0`.
- **Health polling** of `/json/info` — `leds.fps`, `freeheap`, `wifi.signal`,
  `live`, WebSocket client count, reachability.
- **Node import**: `GET /api/devices/:id/nodes` reads `/json/nodes`;
  `POST /api/devices/import-nodes` adds the peers you pick.
- MD3 dark UI, FVDT branding.

### What milestone 2 adds

- **One persistent WebSocket per device** (`ws://<device>/ws`), managed by a
  realtime hub. Authoritative state + full `info` (fps, heap, wifi, uptime) come
  from the device's own pushes — the old HTTP health poller is gone. `p`/`pong`
  heartbeat (20 s), exponential-backoff reconnect that never gives up, and an
  HTTP-poll fallback for `-D WLED_DISABLE_WEBSOCKET` builds (`info.ws === -1`).
- **Backend → browser realtime channel** at `/api/ws`. Device state / health /
  connection-status changes are pushed to the UI and applied straight into the
  client cache — the device page updates with **no polling and no user action**,
  including changes made from the device's own web UI or another app.
- Control writes are routed over the device WebSocket when it's open (one
  connection against WLED's 8-client limit), HTTP otherwise. Fire-and-forget:
  the resulting state arrives on the push.
- `GET /api/devices/:id` serves live hub state when connected, DB row otherwise —
  no first-paint flicker. DB writes for state/health are debounced (5 s) and
  flushed on shutdown; the row is just a warm-start cache.
- Connection status (`connecting` / `live` / `polling` / `offline`) is on every
  device DTO and drives the status dots; a **Live** indicator in the header
  shows the browser channel's health.

### What milestone 3 adds

- **App-managed DMX / E1.31 patch.** On device add, the app assigns a
  conflict-free universe block (170 RGB LEDs / universe, one device per universe
  boundary) and **writes it to the device's `cfg.if.live.dmx`** — verified
  against real hardware, no reboot needed. The **Stage** page shows the whole
  patch, flags conflicts, and offers re-plan / re-push / per-device managed
  toggle. A device with more LEDs than fit in one universe spans consecutive
  universes.
- **Fixture / mapping model** (`Installation → Fixture → Geometry → Transform`).
  The **Layout** editor places fixtures (strip / matrix, serpentine + origin
  aware) on a shared virtual canvas; geometry maps wire-index → canvas position
  (never the reverse). Effects render to this canvas in milestone 4.
- **DDP sender.** Fixed 40 Hz, one UDP socket, devices sent sequentially, one
  sequence number per frame, PUSH on the last packet only. **Backpressure: drops
  frames, never queues** — tracks each device's reported render fps. On stop,
  sends `{live:false}` so the strip returns to its preset immediately.
- The **DDP transport test** on the Stage page. *Solid* streams one colour to
  every device — proof the path renders. *Alignment pattern* streams LED 0 white,
  1 red, 2 green, last blue, the rest a dim ramp — the only pattern that reveals a
  ±1 offset or a reversed run. Per-device pixel offset nudges (±1) correct it
  while you watch the strip.
- **Software WLED sink** (`npm run sink`) — a fake device that speaks DDP + the
  JSON API + WebSocket, renders the incoming frame in the terminal, and reports
  packet stats. Milestones 3–4 are verifiable against it with no ESP32 powered
  on. `--leds N`, `--matrix WxH`, `--http-port P`, `--no-ws`.

### What milestone 4 adds

- **Render engine** in `@ewc/core` — effects are **pure functions** of
  `(x, y, t, params)` over the normalised canvas, so the browser preview and the
  DDP frame loop run the *same* code. Ten starter effects: solid, gradient,
  rainbow, plasma, fire, wipe, chase, comet, scanner, sparkle.
- **Scenes** = an ordered **layer stack**. Each layer picks an effect, a blend
  mode (normal / add / screen / multiply / lighten), an opacity, a **canvas
  region** (position + size — the effect renders scaled to that box; LEDs outside
  fall through to the layers below, overlapping boxes blend) and an optional
  **mask** (another effect whose brightness gates the layer). Scenes serialise to
  JSON and save to SQLite.
- **Studio** page — add layers (each starts as a plain solid; change the effect
  in the inspector), name them, set opacity, drag/resize each layer's region box
  on the preview, tune parameters. The preview overlays the fixture LEDs and their
  names so you can see what lights. **Stream the scene**, and while it streams from
  Studio *every* edit (params, region, order, opacity, background…) hot-swaps the
  live stream — phase-locked, no restart or re-blank, so the wall tracks the
  preview exactly. Editing the **Layout** re-maps the fixtures live too. Switching
  scenes while streaming asks for confirmation first.
- The DDP sender's frame producer is now the scene compositor sampled through the
  mapping engine (one `sampleScene` call per LED per frame), replacing the
  milestone-3 solid-colour producer. Backpressure / `{live:false}` release
  unchanged.
- **Devices** pane: the connection pill shows `Wi-Fi <signal>` or
  `Ethernet <speed> Mbps` (speed is a per-device setting — WLED doesn't report
  it; defaults to 100).

### What milestone 5 adds

- **Pixel painter** (**Paint** page) — paint a chosen device/segment's LEDs on a
  per-LED grid (brush / erase / eyedropper, fill, fill-black, brightness). The
  moment the canvas is touched the device switches to a **live DDP stream from the
  painter** — one device, phase-locked, and every edit **hot-swaps** the frame
  producer with no restart or re-blank, so the strip tracks the canvas in real
  time. **Stop &amp; Release** ends the stream and sends `{live:false}` so the
  device returns to its effect immediately. Switching device, or starting to paint
  while a Studio scene is streaming, releases the previous target first (the scene
  case asks for confirmation).
- **Pixel Scenes** — save the current canvas (per-LED colour + brightness + the
  width it was painted for) to SQLite and reload it later onto whichever
  device/segment is selected (mapped by index, truncated / padded). Loading over
  an active paint asks for confirmation, stops the stream, then loads.
- 1-D strips only. A matrix is treated as a 1-D strip in wire order; a real 2-D
  grid needs the pixel mapping verified on a panel first, so the page flags it.
- The `seg.i` static-paint helpers (`@ewc/core` `wled/paint.ts`, `POST
  /api/devices/:id/paint`) are built and unit-tested but **unused** — the painter
  streams over DDP instead, and static bake (milestone 6) is palette / GIF.

### What milestone 6 adds

- **Bake service** — write a painted canvas (or a saved Pixel Scene) to the device
  as a **single-frame GIF**, uploaded to the device filesystem and played with the
  **Image** effect. No stream, no server — it runs on the device. Optionally
  `psave` it as a **preset** so it survives a reboot. **Bake to device** card on
  the Paint page + a **Bake** button per Pixel Scene.
- Free-space gated (`info.fs`), and filenames are **deterministic / overwritten in
  place** — real WLED 16.0.1's `/edit` delete route 404s, so unique names would
  fill the ~1 MB filesystem with no way to clean up.
- Verified `/upload` contract (WLED 16.0.1): multipart field name **`file`**,
  filename **without** a leading `/` — either wrong and WLED returns
  `200 File Uploaded!` while writing nothing. Recorded under "Verified protocol
  facts" in the build spec.
- **Custom-palette bake is not shipped.** Upload + `cpalcount` work, but the
  palette was not selectable via `seg.pal` on Frank's QuinLED build (see the spec
  note). The single-frame GIF is the reliable static bake; animated-GIF-from-scene
  is a milestone-6 follow-up.

### Test against real hardware

1. Add your controller by IP. Confirm info/effects/palettes populate and the
   effect panel shows the right sliders for a few effects (try **Aurora**,
   **Fire 2012**, **Scrolling Text**, **GEQ**).
2. If you see a "truncated `/json/fxdata`" notice, hit **Refresh effect
   metadata** a few times — it should reach "complete".
3. Toggle power, drag brightness, change effect / palette / speed / intensity /
   colours and confirm the strip follows.
4. **DMX patch** (Stage): each device is assigned a universe block and it is
   written to the controller's `cfg.if.live.dmx` with start address `1` (the app
   standardises on `1` so any DDP offset is uniform and correctable with one
   number). Stream the **alignment pattern** and confirm the first physical LED
   is white; nudge the per-device pixel offset if not.
5. **Scenes** (Studio): place your fixtures on the **Layout** canvas, build a
   layer stack, then **Stream this scene**. Confirm the fixtures light in canvas
   order and that editing the layout re-maps them live. Stop releases the strips
   back to their presets.
6. **Paint** page: pick a device, click a few LEDs on the grid — the strip should
   light them **immediately** and keep tracking as you paint more. Drag to paint a
   run; try Fill and the brightness slider. **Stop &amp; Release** — the strip
   returns to its effect. Save the canvas as a **Pixel Scene**, clear it, reload
   it, confirm the strip shows it again. If a Studio scene is streaming when you
   start painting, you should get a confirm prompt first.
7. **Bake** (Paint page → "Bake to device"): paint a canvas, click **Bake canvas**.
   The strip should switch to the Image effect showing your pixels (scaled across
   the strip) with no stream running. Add a preset slot (e.g. `250`), bake again,
   then load that preset from the WLED app — it should still show the image after
   a reboot. Tell me if your device's own WLED UI can select an uploaded **custom
   palette** (Config → Palettes) — that decides whether palette bake is viable.

---

## Run

### Docker (production)

```bash
docker compose up -d --build
# UI on http://<host>:8080
```

State lives in the `ewc-data` volume (`/data/ewc.sqlite`). The compose file uses
bridge networking with `8080:8080` published; all device traffic (WLED HTTP, the
per-device WebSocket, DDP over UDP) is outbound, so bridge NAT is enough. On a
Linux host you can switch to `network_mode: host` (commented in the file).

### Local development

```bash
npm install
npm run dev        # server :8080, Vite UI :5173 (proxies /api)
```

Other scripts: `npm test` (core unit tests), `npm run typecheck`, `npm run build`.

### Configuration

See [`.env.example`](.env.example). Key vars: `EWC_PORT`, `EWC_DATA_DIR`,
`EWC_WLED_BULK_RETRIES`, `EWC_LOG_LEVEL`.

---

## Layout

```
packages/
  core/    Runtime-agnostic WLED domain logic — types, fxdata parser, capability
           decoding, state-patch helpers, truncation salvage, DDP packet
           builder/parser, DMX planner, mapping engine, render engine (pure
           effects + scene compositor), API contracts.
           NO node: imports; shared with the browser.
  server/  Express + better-sqlite3 + ws. Device registry, WLED HTTP client,
           realtime hub (per-device WebSocket), browser WS fan-out, DMX service,
           DDP sender, stream service (solid / pattern / scene), scene store,
           REST API.
  web/     React + Vite + MUI (themed to Material Design 3, dark).
  sink/    Software WLED sink — a fake device for hardware-free testing.
```

`core` test fixtures under `packages/core/test/fixtures/` are real dumps from
WLED 16.0.0 (ESP32) and 16.0.1 (QuinLED Dig-Quad), including a genuine truncated
`/json/fxdata` capture.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/devices` | list with health |
| POST | `/api/devices` | `{host, port?, name?, linkType?}` |
| GET | `/api/devices/:id` | detail: parsed effects, palettes, capabilities, state |
| PATCH | `/api/devices/:id` | `{name?, linkType?, enabled?, brightnessPolicy?}` |
| DELETE | `/api/devices/:id` | |
| POST | `/api/devices/:id/refresh` | re-read the full snapshot |
| POST | `/api/devices/:id/refresh-fxdata` | retry `/json/fxdata` only |
| POST | `/api/devices/:id/state` | partial WLED `state` patch (≤20 fields) |
| POST | `/api/devices/:id/paint` | `seg.i` paint (`{segId?, brightness?, mode:'dense'\|'sparse', pixels?\|painted?}`) |
| POST | `/api/devices/:id/paint/release` | un-freeze the segment (`{segId?}`) |
| GET | `/api/devices/:id/nodes` | discovered peers |
| POST | `/api/devices/import-nodes` | `{hosts:[], linkType?}` |
| WS | `/api/ws` | realtime device state / health / status stream (read-only) |
| GET | `/api/dmx/patch` | the full DMX/E1.31 patch + conflicts |
| POST | `/api/dmx/replan` · `/api/dmx/:id/assign` | re-plan the patch / one device |
| PUT | `/api/dmx/config` · `/api/dmx/:id/managed` | packing config / managed toggle |
| GET | `/api/stream/status` | DDP stream state + per-device stats |
| POST | `/api/stream/solid` · `/api/stream/pattern` · `/api/stream/stop` | start solid / alignment-pattern stream / stop |
| POST | `/api/stream/scene` | stream a scene (`{sceneId}` or inline `{scene}`) |
| POST | `/api/stream/paint` | live pixel-painter stream to one device (`{deviceId, segStart?, brightness, pixels[]}`) |
| POST | `/api/devices/:id/bake` | bake a canvas / Pixel Scene to a GIF preset (`{sceneId?\|pixels[], segId?, preset?, name?}`) |
| GET/POST | `/api/pixel-scenes` · `/api/pixel-scenes/:id` | saved pixel-painter canvases |
| PUT | `/api/stream/:id/pixel-offset` | per-device LED offset compensation |
| GET/PUT | `/api/installation` | the fixture / canvas model |
| GET/POST | `/api/scenes` | list / create saved scenes |
| GET/PUT/DELETE | `/api/scenes/:id` | one saved scene |
