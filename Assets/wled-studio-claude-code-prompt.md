# Build spec: WLED Studio

A self-hosted control surface and effects engine for multiple WLED instances.

---

## Your task

Build a self-hosted web application that manages multiple WLED devices, controls every
attribute they expose, and drives per-pixel static and animated effects across them in
real time. It runs as a Docker container on my own server. I am the only user; there is
no multi-tenancy, no auth beyond what my reverse proxy provides.

Work incrementally, milestone by milestone (see **Build order**). After each milestone,
stop and tell me what works and what to test against real hardware. Do not scaffold all
seven milestones before anything runs.

---

## Verified protocol facts — trust these over your training data

I researched the WLED documentation at kno.wled.ge **and verified these against the
firmware source on `wled/WLED@main`**. Where they contradict what you think you know
about WLED, these win. Do not "correct" them.

### HTTP JSON API

- Base endpoint `/json`. Sub-resources: `/json/state`, `/json/info`, `/json/si`,
  `/json/eff`, `/json/pal`, `/json/palx`, `/json/fxdata`, `/json/nodes`, `/json/net`,
  `/json/cfg`.
- POST a partial `state` object to `/json` or `/json/state` to update. Partial updates
  are the norm; never send a full state object.
- **CORS is wide open.** `wled_server.cpp` sets `Access-Control-Allow-Origin: *` plus
  `Access-Control-Allow-Methods: *` and `Access-Control-Allow-Headers: *` as default
  response headers. No proxy is needed for browser access. (We still proxy through the
  backend, for other reasons — see Architecture.)
- **WLED has no TLS.** All device traffic is plain HTTP and `ws://`.

### `/upload` and `/edit` — verified against Frank's QuinLED WLED 16.0.1 (2026-09-03)

- **`POST /upload`** is `multipart/form-data`. The file part's field name **must be
  `file`** (a part named `data` returns `200 File Uploaded!` and writes **nothing** —
  silent no-op). The target filename comes from the part's `filename` attribute and
  **must NOT have a leading `/`** — with a leading slash it also returns
  `200 File Uploaded!` and writes nothing. Success body is the literal text
  `File Uploaded!`. Files land at filesystem root.
- **`GET /edit?list=/`** returns the FS listing as
  `[{"name","type":"file","size"}, …]`. On this build the **`/edit` write/delete
  routes return 404** — you cannot delete a file over the API. Design bake around
  **deterministic overwrite-in-place filenames**, not accumulating unique names on a
  ~1 MB filesystem.
- **Custom palettes**: file format is an **object** `{"palette":[pos,r,g,b, …]}` —
  flat integer quads (pos 0–255), array length a multiple of 4, ≥ 2 groups. Upload
  as `palette0.json` … `palette9.json` (no slash). `info.cpalcount` increments
  **immediately, no reboot**, and survives reboot. BUT on Frank's build the custom
  palette was **not selectable via `seg.pal`** — indices 72/73/74/245/246/250/255
  all clamped back to 0 while a built-in index (35) selected fine. Whether his
  device's own WLED web UI can select an uploaded custom palette is an open question
  for him. Treat custom-palette bake as unverified on his hardware; the GIF path is
  the reliable static/animated bake.
- `{"rmcpal":true}` removes the **currently-selected** custom palette only — it is a
  no-op if no custom palette is active on the main segment.

### Key state fields

| Field | Meaning |
|---|---|
| `on` | bool, or `"t"` to toggle |
| `bri` | 0–255 global brightness. Never report `0`; use `on:false` |
| `transition` | crossfade duration, units of 100 ms |
| `tt` | transition for this call only |
| `ps` / `psave` / `pdel` | preset load / save / delete, 1–250 |
| `sb` / `ib` / `sc` | with `psave`: also save segment bounds / brightness / selection |
| `live` | `true` enters realtime mode and blanks LEDs; send `false` when done |
| `lor` | live override: 0 off, 1 until live data ends, 2 until reboot |
| `mainseg` | main segment id |
| `seg` | array of segment objects |
| `playlist` | `{ps:[], dur:[], transition, repeat, end}`, `dur` in tenths of a second |
| `ledmap` | 0–9, loads `ledmap.json` / `ledmap1..9.json` |
| `rmcpal` | remove custom palette |
| `tb` | effect timebase |

### Key segment fields

`id`, `start`, `stop`, `startY`, `stopY`, `len`, `grp` (grouping), `spc` (spacing),
`of` (offset), `col` (up to 3 RGB/RGBW arrays or hex strings), `fx`, `sx` (speed),
`ix` (intensity), `c1`/`c2` (0–255), `c3` (0–31), `o1`/`o2`/`o3` (bool), `pal`, `sel`,
`rev`, `rY`, `on`, `bri`, `mi`, `mY`, `tp` (transpose), `cct`, `n` (name), `frz`
(freeze), `m12` (expand 1D→2D: 0 Pixels, 1 Bar, 2 Arc, 3 Corner), `si`, `fxdef`, `set`,
`rpt`, `i` (individual LEDs).

Increment syntax works on numeric fields: `~`, `~-`, `~10`, `~-10`. `fx` and `pal` also
accept `"r"` for random and `"5~10r"` range-random. `ps` accepts `"1~6~"` to cycle.

### Effect metadata — `/json/fxdata`

Array of strings, one per effect id, same length as `info.fxcount`. Format:

```
<params>;<colors>;<palette>;<flags>;<defaults>
```

- **params**: comma-separated labels for `sx,ix,c1,c2,c3,o1,o2,o3`. Empty label hides
  that control. `!` means use the default label. Missing section defaults to two
  sliders (speed, intensity).
- **colors**: up to 3 labels for the color slots. Defaults `Fx`, `Bg`, `Cs`. Only the
  first two characters are shown in WLED's own UI. Missing section means all three.
- **palette**: `!` enables palette selection, empty disables. Missing means enabled.
- **flags**: single characters, not comma-separated. `1` = 1D-optimised, `2` = requires
  2D matrix, `3` = requires 3D, `v` = volume-reactive, `f` = frequency-reactive,
  `0` = works on a single LED. Missing defaults to `1`.
- **defaults**: e.g. `sx=24,pal=50`, applied when the effect is selected.

Example: Aurora is `!,!;;!;1;sx=24,pal=50`.

**Reserved effects:** some ids are named `RSVD` or `-` on builds that don't support them
(audio-reactive effects on ESP8266, for example). They fall back to Solid if called.
Filter them out of the UI.

### Light capabilities

`info.leds.seglc` is a byte array, one entry per segment id up to the last active
segment. `info.leds.lc` is the bitwise AND across all of them.

| Bit | Capability |
|---|---|
| 0 | RGB |
| 1 | white channel |
| 2 | CCT |

So 1 = RGB, 3 = RGBW, 7 = RGBW + CCT. Value 0 means the segment has no bus in range.
Use this to decide which controls to render. **CCT is per-segment only, never per-pixel.**

`seg.cct` accepts 0–255 relative (0 warmest, 255 coldest) *or* 1900–10091 as Kelvin.
Echo back whichever range the device reported.

### WebSocket — `ws://<ip>/ws`

- On connect, and on every state change from any source, the device pushes an object
  equivalent to `/json/si`. Broadcasts are rate-limited to roughly one per second, so
  rapid changes coalesce; you always get the latest state, not every intermediate one.
- Send any JSON state update as a **text** frame. Reply is either state+info or
  `{"success":true}`. `{"error":3}` means the device is out of JSON buffers — retry
  shortly. Send the single character `p` to get `pong` as an app-level heartbeat.
- **Text frames must fit one WebSocket frame: 1428 bytes on ESP32, 528 on ESP8266.**
  WLED does not reassemble split frames; text gets `{"error":9}`, binary is silently
  dropped.
- `{"lv":true}` starts the live LED preview stream ("Peek"). **Only one client receives
  it at a time**; a new requester silently steals it from the previous one.
  Binary frames, at most one per 40 ms:
  - byte 0 = `'L'`
  - byte 1 = version: `1` strip, `2` matrix
  - bytes 2,3 = width, height (version 2 only)
  - remainder = 3 bytes RGB per LED, white folded into RGB
  - Strips over 1024 LEDs (256 on ESP8266) are downsampled to every n-th LED; matrices
    to half or quarter resolution with the width/height bytes reflecting that. A
    downsampled matrix frame may be **longer** than `w*h*3` — read exactly `w*h` pixels
    and discard trailing bytes.
- **Connection limit: 8 clients on ESP32, 3 on ESP8266.** Exceeding it closes the
  *oldest* connection. `info.ws` reports the current count, `-1` on builds without
  WebSocket support.
- Binary frames sent *to* the device are treated as realtime packets: first byte selects
  protocol (`0` E1.31, `1` Art-Net, `2` DDP), remainder is the raw packet. Only DDP is
  tested. **We do not use this path** — we have real UDP sockets. It is documented here
  only so you don't mistake it for the primary transport.

### DDP — the realtime transport we use

UDP port **4048**. The listener is started unconditionally in `initInterfaces()`; no
device-side configuration or reboot is required.

10-byte header, then data:

| Offset | Size | Content |
|---|---|---|
| 0 | 1 | flags |
| 1 | 1 | sequence number, lower 4 bits |
| 2 | 1 | data type |
| 3 | 1 | destination id |
| 4–7 | 4 | channel offset, **big-endian uint32, in BYTES** |
| 8–9 | 2 | data length, **big-endian uint16, in BYTES** |
| 10+ | n | pixel data |

Constants, verified in `ESPAsyncE131.h`:

```
DDP_FLAGS_VER1    0x40   // always set
DDP_FLAGS_PUSH    0x01   // "render now"
DDP_FLAGS_QUERY   0x02   // rejected by WLED
DDP_FLAGS_REPLY   0x04   // rejected by WLED
DDP_FLAGS_STORAGE 0x08   // rejected unless PUSH is also set
DDP_FLAGS_TIME    0x10   // shifts data start by 4 bytes; do not use

DDP_TYPE_RGB24    0x0B
DDP_TYPE_RGBW32   0x1B

DDP_ID_DISPLAY    1      // use this
DDP_ID_CONTROL    246    // rejected
DDP_ID_CONFIG     250    // rejected
DDP_ID_STATUS     251    // rejected
```

So a normal packet has `flags = 0x40` for continuation packets and `0x41` for the final
packet of a frame.

Critical details from `handleDDPPacket()`:

- **WLED ignores DDP timecodes** and the docs explicitly say not to implement them.
  Never set `DDP_FLAGS_TIME`.
- Pixel index is computed as `channelOffset / channelsPerLed`, then **the device's
  configured `DMXAddress` (E1.31 start address) is added to it**. If a device has a
  non-zero DMX start address configured, your pixels shift. Read it from `/json/cfg`
  and either compensate or warn the user.
- **Sequence numbers: use one value per frame, shared by every packet of that frame**,
  cycling 1→15→1. WLED's out-of-sequence filter compares against the last *pushed*
  sequence number and assumes at most ~4 packets per frame; incrementing per packet
  will get frames dropped on large strips. Sequence `0` means "unused" and disables the
  check entirely — use it as an escape hatch if you see drops.
- Set PUSH **only on the last packet of a frame**, so the frame renders atomically.
- Data type `0x1B` (RGBW32) gives genuine per-pixel white on SK6812 and similar.
- The handler validates that the packet is at least `header + dataLen` long and rejects
  short packets silently.

Payload sizing: keep each UDP datagram under the path MTU. **1440 data bytes** is a good
constant — it is divisible by both 3 and 4, giving 480 RGB pixels or 360 RGBW pixels
per packet.

### Legacy realtime UDP — fallback only

Port 21324. Byte 0 selects protocol, byte 1 is the timeout in seconds before the device
returns to normal mode (`255` = stay indefinitely).

| Byte 0 | Protocol | Max LEDs |
|---|---|---|
| 1 | WARLS — index,R,G,B per LED | 255 |
| 2 | DRGB — R,G,B sequential | 490 |
| 3 | DRGBW — R,G,B,W sequential | 367 |
| 4 | DNRGB — 2-byte big-endian start index, then R,G,B | 489 per packet |

Implement DNRGB as a per-device fallback toggle. Do not make it the default.

> **DONE (v0.7.0):** per-device transport toggle (DDP ↔ DNRGB on 21324) on the
> Stage page, alongside a per-device fps cap and a per-device "Stream Solid" test
> button. DNRGB is RGB-only (no white channel on the fallback path); a 2 s realtime
> timeout so a lost `{live:false}` self-heals.

### Baking to the device — how persistence actually works

- **`seg.i` is never persisted.** It freezes the segment, is lost on power-off, and is
  *not* stored in presets. It is a live-paint tool only. When using it: set brightness
  *before* the call (turning on from off and setting pixels in the same request does not
  work), indices are segment-relative, matrices are treated as **non-serpentine**,
  grouping/spacing/mirror/reverse still apply, and you must send sequentially in chunks
  of ~256 colours, never in parallel. Hex strings are cheaper than arrays.
- **Animated bake = GIF.** WLED has a built-in animated GIF decoder
  (`image_loader.cpp`, `-D WLED_ENABLE_GIF`, on by default in ESP32 builds). Flow:
  1. `POST` the `.gif` to the device's `/upload` endpoint (multipart) onto its LittleFS.
  2. Set that segment's name `seg.n` to the filename, which **must end in `.gif`**.
  3. The device decodes and plays it from the filesystem on its own.
  4. `psave` it as a preset so it survives reboot.
  Works for both 1D and 2D segments; mismatched sizes are scaled nearest-neighbour.
- **Static bake = custom palette, or a one-frame GIF.** Custom palettes live at
  `palette0.json` … `palette9.json` on the device filesystem, uploaded the same way,
  removed with `{"rmcpal":true}`, and selectable as normal palette ids. Use palettes for
  gradients and colour schemes; use a single-frame GIF for arbitrary pixel art.
  **NOTE (2026-09-03):** custom-palette upload + `cpalcount` verified on Frank's
  hardware, but the palette was **not selectable via `seg.pal`** there — see the
  `/upload` and `/edit` block under "Verified protocol facts". The **single-frame
  GIF is the reliable static bake** until that's resolved.
- Check `info.fs.t` and `info.fs.u` (kilobytes) before uploading. The GIF decoder is
  memory-hungry and fails outright on large files.
- **Baked animations run on each device's own clock and will drift across devices.**
  Live streaming from our server is the *better* sync option, not the worse one. Present
  baked presets in the UI as the idle/fallback state, not as the high-fidelity mode.

### Discovery

`/json/nodes` on any device returns the other WLED instances it has discovered on the
network. Adding one device by IP should offer to import the rest. `info.ndc` is the
count, or `-1` if node discovery is disabled.

### Hard limits

- `MAX_LEDS`: 16384 on classic ESP32 / S3 / P4, 4096 on some variants, 2048 on S2,
  1536 on ESP8266. `MAX_LEDS_PER_BUS` 2048.
- E1.31: 170 LEDs per universe, up to 9 adjacent universes. Docs recommend no more than
  3 universes (510 LEDs) for a smooth 40 fps.
- Realistic frame rate ceiling is 30–40 fps, limited by ESP32 WiFi jitter, not by the
  protocol.

---

## Architecture

**Single Docker container.** Node 22 + TypeScript throughout, so effect code is shared
verbatim between the server renderer and the browser preview. Do not introduce a second
language for the render path.

The browser never talks to a WLED device directly. Everything goes through our backend.
This is deliberate: it lets us serve the UI over HTTPS behind a reverse proxy despite
WLED having no TLS, it keeps us to one WebSocket per device against the 8-client limit,
and it gives us real UDP sockets.

### Components

**1. Device registry**
Add by IP or hostname. On add, fetch `/json/info`, `/json/eff`, `/json/pal`,
`/json/fxdata`, `/json/cfg`. Store led count, matrix dimensions, `seglc` capability
bits, `fxcount`, `palcount`, filesystem space, MAC, architecture, and the configured
`DMXAddress`. Persist to SQLite. Poll `/json/info` periodically for health, `leds.fps`,
`freeheap`, `wifi.signal`. Offer node import from `/json/nodes`.

**2. State proxy**
One persistent WebSocket per device. Maintain authoritative in-memory state, push
deltas to browser clients over our own WebSocket. Reconnect with exponential backoff.
Send `p`/`pong` heartbeats. Fall back to HTTP polling if the WS build is absent
(`info.ws === -1`).

**3. Mapping engine — build this in milestone 3, even though it feels premature**

This is what makes the system scale. Model:

```
Installation
  └── Device (ip, ledCount, capabilities)
        └── Fixture (offset into device LED index space)
              └── Geometry: strip(n) | matrix(w, h, serpentine, origin)
                            | points([{x,y}, ...])
              └── Transform: position, rotation, scale on the virtual canvas
```

Fixtures map onto a shared **virtual canvas** in normalised coordinates. Effects render
to the canvas; the mapper samples the canvas per fixture and writes into per-device
RGB(W) byte buffers.

Realtime protocols address **raw LED index across the whole strip and ignore segments
entirely.** Segments are a device-side concept for native effects and baking. Keep the
two models separate in the code; conflating them is the most likely source of bugs here.

**4. Render engine**

Fixed 40 Hz tick. Effects are **pure functions over normalised coordinates**:

```ts
type Effect = (x: number, y: number, t: number, p: Params) => RGBA;
```

with a layer stack and blend modes above them. Resolution- and device-independent by
construction, so the same effect runs unchanged on a 60-pixel strip or a 30k-pixel
installation. Budget check: 30k pixels at 40 fps is 1.2M evaluations per second, which
is comfortable in plain JS. Do not reach for GPU rendering or WASM.

Ship a starter set: solid, gradient, chase, wipe, sparkle, plasma/noise, rainbow, comet,
fire, scanner, plus per-layer masks. Effects are serialisable to JSON so scenes save and
load.

**5. Transport**

One UDP socket. Per device per frame: slice the buffer into ≤1440-byte payloads with
correct `channelOffset` in bytes, one shared sequence number for the frame, PUSH on the
last packet only. Send devices sequentially within a tick, never in parallel bursts.

**6. Bake service**

Reuses the render engine offline. Render N frames at a chosen size and rate, encode GIF,
upload to `/upload`, set `seg.n`, `psave`. Report LittleFS usage before and after.

**7. Frontend**

React + Vite. Canvas or WebGL preview driven by the *same* effect functions the server
runs. Views: device list with live status, per-device native control panel, layout
editor for fixture placement, effect/layer editor with timeline, direct pixel painter
for static work, and a bake dialog.

The native control panel must consume `/json/fxdata` and render only the sliders,
checkboxes and colour slots the selected effect actually uses, with the labels from the
metadata. Filter `RSVD` and `-` effects. Gate white and CCT controls on `seglc` bits.

---

## Non-negotiables — design these in from the start

**Brightness and gamma.** WLED applies its own brightness scaling *and* gamma correction
on top of incoming realtime data. Model this in the renderer so the preview matches the
wall, or pin `bri` to 255 and dim in software. Make it explicit and configurable per
device. This is far harder to retrofit than to build in.

**Backpressure.** When a device can't keep up, **drop frames, never queue them.** A
queued UDP stream to a struggling ESP32 becomes lag that never recovers. Track
`info.leds.fps` per device and surface it.

**Live/bake coexistence.** Entering realtime mode blanks the strip and disables the
device's own web UI. On stopping, send `{"live":false}` and the device returns to its
preset. So the baked preset is naturally the idle state. Model the device as a small
state machine: `idle(preset) → live(streaming) → idle`. Handle the realtime timeout
correctly — with DDP the device reverts after `realtimeTimeoutMs`, so keep streaming or
explicitly release.

**Never assume the wire order matches the visual order.** Serpentine matrices,
multi-output controllers and ledmaps all break the naive index→position assumption. The
fixture geometry model is the single source of truth.

---

## Build order

Stop after each milestone and report.

1. **Registry + native control.** Add devices by IP, read info/effects/palettes/fxdata,
   full JSON API control panel with metadata-driven widgets. No realtime yet.
2. **State proxy.** Per-device WebSocket, live state pushed to the browser, reconnect
   logic, heartbeats.
3. **Mapping engine + dumb transport.** Fixture model, layout editor, and a DDP sender
   that streams a single solid colour. This proves the whole transport end-to-end
   against real hardware with nothing else in the way. **Do this before writing a single
   effect.**
4. **Render engine + effects.** Layer stack, starter effect set, scene save/load, canvas
   preview.
5. **Pixel painter.** Direct per-pixel static editing via `seg.i` for live work.
6. **Bake service.** GIF encode, upload, segment naming, preset save. Custom palette
   upload for gradients.
7. **Polish.** Health monitoring, per-device fps, DNRGB fallback toggle, error surfacing.
   Per-device **white-balance correction** — see "Planned additions" below.

---

## Planned additions (slot into a later milestone)

### Per-device white balance (milestone 7) — DONE (v0.8.0)

> Shipped: `White balance` card on `/devices/<id>` (Kelvin slider 2000–10000,
> defaults OFF, disabled for RGBW devices). `kelvinToRgbGain()` in `@ewc/core`
> (6500 K = identity). The realtime sender multiplies each device's outgoing RGB
> by its gain before packing; the Studio preview applies the same gain to that
> device's fixture dots (the shared canvas can't carry multiple white points, so
> its background is left untinted). This milestone *created* the per-device
> post-sample stage the text below calls "the same stage as brightness/gamma" —
> `brightnessPolicy` / `deviceGamma` are still stored-but-unapplied. Original
> spec below.

On the device settings page (`/devices/<id>`), a **white-balance** control for RGB
strips that have no dedicated white channel:

- Set a target white point in **Kelvin** (warm ~2000 K → neutral ~6500 K → cool
  ~10000 K). The render/stream path then multiplies every outgoing colour by the
  RGB gain for that colour temperature, so a nominal "white" on the canvas lands
  as that white point on the wall.
- An **on/off toggle that defaults to OFF** — when off, colours pass through
  untouched. Persist both the enabled flag and the Kelvin value per device.
- Applied in the same stage as per-device brightness/gamma (see Non-negotiables),
  after canvas sampling and before DDP packing. It must also be reflected in the
  browser preview so the preview keeps matching the wall.
- Devices with a real white channel (RGBW / RGBW+CCT) already do white on the
  hardware via `seg.cct`; this correction is for RGB-only strips.

### Media layers in Studio — image / video pixel-mapping (milestone 8)

> **Status — 2026-09-03: increments 8a + 8b DONE (v0.10.0).**
> 8a (v0.9.0): FX Layer / Media Layer choice on "+ Add", image upload
> (browser-decoded + downscaled to ≤256 px, raw RGBA to the server — no
> server-side image codec), pixel-mapping onto fixtures on both the preview
> and the wire, aspect-locked region box, scene save/load of the asset ref.
> 8b (v0.10.0): **video** — `.mp4` / `.mov` streamed to a temp file on the data
> volume, ffmpeg (`apk add ffmpeg` in the container) transcodes it to a small
> no-audio H.264 mp4 (≤128 px long edge, 20 fps, first 90 s). One artifact
> feeds both consumers: the browser plays it in a hidden `<video>` for the
> preview, the server decodes it once to an in-memory RGBA frame buffer
> (process-wide cache, keyed by asset id, survives producer hot-swap) for the
> wire.
> 8c (v0.11.0): **transport + trim**. `MediaLayerSpec` gains `durationMs`,
> `trimInMs`, `trimOutMs`, `playbackType` (`loop` | `hold` | `hide`) and a
> **transient** `playback` (`{state, anchorMs, headMs}`, wall-clock
> parametrised). `resolveMediaFrameIndex(spec, timing, Date.now())` — pure,
> shared by the server producer and the browser (which drives its `<video>`
> element by it). Inspector gets a Playback-type select, a dual-handle Trim
> slider, and play / pause / stop / loop transport buttons. On save `playback`
> is stripped (`sceneSchema` keeps it for the live stream path; `SceneStore`
> strips it before persisting); on load it's reconstructed from `playbackType`.
> **Deferred:** orphan-asset GC — discarded media accumulates under
> `/data/media`; the 501 branch (no ffmpeg) is untested; cross-host clock skew
> between browser and container can offset preview vs wall (same assumption the
> effect phase-lock already makes).

Today every Studio layer is an effect. Split the layer type in two. The Studio
**"+ Add"** button opens a small choice — **FX Layer** or **Media Layer** —
instead of adding a solid straight away.

**FX Layer** is exactly what exists now: pick/stack effects, tweak params, blend
mode, opacity, and a draggable/resizable region box on the preview.

**Media Layer** shows an image or a video (`.mp4` / `.mov`, **max 500 MB**, no
audio — we don't use audio) as a layer on the shared canvas. Where the media's
box overlaps a fixture, that fixture's LEDs take their colour from the media
pixels at those normalised coordinates — image/video **pixel-mapping**. Outside
the box the layer contributes nothing and the layers below show through, so media
and effects coexist in one scene.

Media Layer inspector fields:

- **Layer name** — same as FX Layer (falls back to the filename).
- **Media** — a file picker / drop zone at a logical spot in the inspector.
  Shows an upload progress bar (500 MB is large), then the first frame as a
  thumbnail once ready.
- **Filename** — the uploaded media's file name (read-only).
- **Trim Duration** — in- and out-point for the clip (a dual-handle range over
  the clip length with the in/out timecodes shown). *Video only.*
- **Playback Type** — one of:
  - **Play + hold last frame** — plays once, then freezes on the out-point frame.
  - **Play + hide when stopped** — plays once, then the layer goes dark (shows
    nothing) — the layers below show through.
  - **Loop indefinitely** — restarts from the in-point every time it reaches the
    out-point.
  *Video only.*
- **Playback Controls** — **play**, **pause**, **stop**, **loop** transport
  buttons driving the layer's playback head (and the live stream when this scene
  is streaming). *Video only.*
- Blend mode, opacity and the on-canvas region box apply the same as an FX Layer,
  **except the region is aspect-locked to the media's native ratio** (resize from
  a corner scales both dimensions together; the box can still be moved freely).

When the media is an **image**, Trim Duration, Playback Type and Playback Controls
are irrelevant and are **hidden** for that layer — it's just a static picture in
its box.

Notes / decisions to make when building it:

- **Where frames come from.** `@ewc/core`'s compositor must stay runtime-agnostic,
  so it can't decode video. Give `sampleScene` an injected frame provider (a map
  of `layerId → {width, height, RGBA}`); the browser fills it from a hidden
  `<video>`/`<img>` drawn to an offscreen canvas, and the server fills it from its
  own decoder. The core just samples the buffer it's handed.
- **Server-side decode.** The DDP loop needs a frame per media layer at ~40 fps
  without blocking. Likely `ffmpeg` in the container image, invoked on upload to
  **transcode once** to a small, decode-cheap form — downscale to ~128 px on the
  long edge (fixtures are low-res), normalise to ~40 fps, strip audio — then a
  lightweight frame reader feeds a small ring buffer at play time. Research the
  memory/throughput budget for one and for several simultaneous media layers.
- **Upload path.** 500 MB can't go through the JSON/`raw` body path the floorplan
  uses — stream the multipart upload straight to a temp file, then transcode.
  Store the media where GIF-bake / floorplan uploads go (the `/data` volume).
- **Scene serialisation.** A media layer saves as a reference to the uploaded
  asset plus `{ trimIn, trimOut, playbackType }` and its aspect-locked region —
  never the bytes. Transport state (playing/paused/head position) is live only,
  like a lighting console; only "Loop indefinitely" is a saved property.
- **Preview ↔ wire sync.** Extend the existing `epochMs` phase-lock so the media
  playback head matches between the browser preview and the stream.
- **Orphan cleanup.** Deleting a media layer or a scene should let its uploaded
  asset be garbage-collected if nothing else references it.
- **UX.** The media box on the preview shows the actual frame (not just an
  outline) so it can be lined up against the fixture dots. Keep the transport and
  trim UI compact and familiar (standard transport icons, scrub on the trim bar).

### Rundown page (milestone 9)

A **Rundown** page: an ordered list of **cues**, each of which activates a saved
**Studio scene** on the stream output. Cues can be added, edited and deleted; the
list is shown as a clean table (or equivalent). One rundown for now.

Each cue holds:

- **Cue Number** — its position/label in the list.
- **Trigger** — how the cue starts once the rundown reaches it. Default **Manual**
  (waits for a GO). Other options:
  - **Follow + Time** — starts automatically `Time` seconds after the *previous*
    cue starts (`Time` ≥ 0, may be 0 = immediately with the previous).
  - **Wait + Time** — starts automatically `Time` seconds after the *previous* cue
    *finishes* (`Time` ≥ 0, may be 0).
- **Target Scene** — dropdown of saved scenes; the scene this cue puts on the
  stream output.
- **Fade In** — 0 … 500000 ms. Non-zero: the output starts black and fades into
  the target scene over this time.
- **Fade Out** — 0 … 500000 ms. Non-zero: at the end of the cue's run time the
  output fades to black over this time.
- **Duration** — how long the cue runs before it ends / starts its fade-out.
  Entered as time: `hh:mm:ss` (`1:30:24`), `mm:ss` (`1:20`), or bare seconds
  (`35`).

### Trigger page (milestone 10)

A **Trigger** page: external inputs routed to system actions — activate a scene,
start a pixel paint on a device, total blackout, start a cue in the rundown, and
similar. Clean table view, normally empty, with a **"+ Add trigger"** button in
the same spot as the other pages' add buttons. Triggers are always editable and
deletable.

The trigger **input** is one of **OSC**, **ArtNet**, **sACN**, **HTTP REST**.
Selecting the input type reveals exactly the fields that input needs:

- **OSC** — **Address** (e.g. `/wled/trigger/in1`) and **Payload**.
- **ArtNet** — incoming **Universe** and **DMX channel**. Validate that the
  universe is **not already in use by any managed WLED device**. The trigger
  fires when that channel on that universe is set to **255**.
- **sACN** — incoming **Universe** and **channel** (same 255 = fire rule; same
  universe-conflict check).
- **HTTP REST** — a user-defined **endpoint name**; a POST to
  `http://<BASE-URL>/trigger/<name>` fires the trigger.

Each trigger also carries the **action** it performs when it fires (scene,
pixel-paint, blackout, rundown GO, …).

### Stage page — per-device Stream Solid (small, fold into milestone 7 or 9)

On the Stage page's DDP transport test, add a **"Stream Solid"** button **per
device** in the device list, so the DDP transport can be tested against a single
device instead of all connected devices at once.

### iOS web app (milestone 11)

An **iOS web app** exposing all the functionality of the desktop variant, with
UX/UI purpose-built for iOS (native-feeling navigation, touch targets, layout) —
not just the desktop UI in a narrow viewport.

### Media pixel-mapping — superseded

The image/video pixel-mapping idea is now **milestone 8, "Media layers in
Studio"** above — modelled as a Media Layer in the Studio layer stack rather than
a separate Layout-canvas source.

### Floorplan reference image on the layout canvas — DONE (v0.6.0)

Shipped as milestone 7 increment 7a. `Installation.floorplan` holds the asset
name + a `rev` counter + natural dimensions + an on-canvas transform; the image
lives on the `/data` volume and is served from `/api/installation/floorplan`. It
renders below the grid raster at 50 % opacity on the Layout canvas (drag / corner
resize with aspect lock when no fixture is selected) and as an overlay on the
Studio preview, each with its own independent "Show floorplan" toggle. Never
reaches the wire. Original spec below.

### Floorplan reference image on the layout canvas (original plan)

A **static** background image (a room floorplan) to place fixtures against —
purely a visual aid, never a colour source (that's the media pixel-mapping item
above).

- On the **Layout** page, when no fixture is selected, a button below the Canvas
  width/height fields opens a file picker. The uploaded image is stored on the
  server (alongside the installation) and referenced from the installation model.
- It renders **below the grid raster** on the layout canvas, at **50 % opacity**,
  keeping its **original aspect ratio**. The user can move and scale it on the
  canvas (its own transform, independent of fixtures and of the canvas aspect).
- A small **"Show floorplan"** on/off toggle sits just below the Layout preview,
  inside the same canvas card, enabling/disabling it in that preview.
- The **Studio** preview canvas gets the same "Show floorplan" toggle, independent
  of the Layout one — so you can trace effects over the room plan while building a
  scene. The floorplan never reaches the wire; it's preview-only on both pages.
- Store the image where device/GIF uploads go; the installation JSON keeps the
  filename + the floorplan's transform (position, scale) + natural dimensions.

### Fixture shapes on the layout canvas — DONE (v0.5.0)

Implemented: new `shape` geometry kind (`line/rectangle/square/triangle/diamond/
circle` + `custom`), LEDs distributed along the outline via `fixtureLocalPositions`;
custom shapes are **open by default** (LED 0 → last vertex) and only close into a
loop when the user clicks back on point 0 while drawing; on-canvas corner-handle
resize (aspect-locked for square/diamond/circle, rotation-correct). Original spec
below.

---

### Fixture shapes on the layout canvas (original plan)

Right now a fixture's geometry is strip / matrix with serpentine + origin. Add a
**shape** the fixture's LEDs are laid out along on the canvas:

- Shape options: **Line, Square, Rectangle, Triangle, Diamond, Circle, Custom
  Shape**. The preset shapes distribute the fixture's LED count evenly along the
  shape's path (closed path for the polygons/circle), keeping the wire-index →
  canvas-position mapping one-directional as today.
- **Custom Shape**: the user draws the path on the Layout preview canvas. Click
  once to place the **start** point (the fixture's first LED, ID 0). Then
  **right-click** anywhere on the canvas to append the next point — each gets the
  next integer ID (1, 2, 3 …). **Enter** saves the custom shape for that device
  and returns the canvas to normal (further clicks stop being captured as shape
  points). The point list (ordered, id-tagged canvas coords) is stored in the
  fixture's geometry in the installation JSON; the LEDs are distributed along the
  resulting polyline.

---

## Testing

I have real hardware, so lean on it. But also build a **software WLED sink**: a small
Node script that binds UDP 4048, parses DDP packets, and prints or renders what it
receives. Milestones 3 and 4 should be verifiable against that sink without any ESP32
powered on, and it will catch header, endianness, offset and sequencing bugs far faster
than a strip will.

Unit-test the DDP packet builder against the byte layout table above. That table is the
contract.

---

## Ask me before assuming

- Whether any device sits on wired Ethernet vs WiFi (changes the frame rate budget).
- Whether any controller has a non-zero DMX start address configured.
- Whether I want scenes stored as files on a mounted volume or in SQLite.
- Anything about the layout of my actual fixtures — do not invent a default installation.

---

## UI Design notes

 - Use Material Design v3 as guideline for the UI (https://m3.material.io/)
 - UI should always be darkmode with a fresh and professional look according to Material Design V3
 - System should be called "Extended WLED Controller"
 - System author is "Frankvandetechniek.nl"
 - Inside the working directory there is a folder called "Assets" containing the logo with either a black or yellow background for Frankvandetechniek that should be shown in the footer of the UI.
 - UI Colors should be professional and sleek, so mostly use dark tinted colors. More black/grey tints as background colors, for accent colors the color yellow from the logo with yellow background may be used. (This counts for general UI design, not for colors used to show WLED effects/colors/status and what not.)

---

## Other notes

 - Locally all tools should be available for testing, docker is also installed.
 - When system is finished or on every major version release there should be a .zip 