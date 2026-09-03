#!/usr/bin/env -S npx tsx
/**
 * Software WLED sink.
 *
 *   npm run sink -- --leds 150 --http-port 8888 --name "Bench strip"
 *   npm run sink -- --matrix 16x16 --http-port 8889
 *   npm run sink -- --no-ws               # simulate a build with info.ws === -1
 *
 * Binds UDP 4048 and parses DDP; serves the WLED JSON API + WebSocket on
 * --http-port so it registers in the app as a real device. Renders the incoming
 * frame in the terminal and prints packet stats. Milestones 3–4 are meant to be
 * verifiable against this with no ESP32 powered on.
 */
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { DDP_PORT } from '@ewc/core';
import { MockDevice } from './mockDevice.js';
import { DdpReceiver } from './ddpReceiver.js';
import { renderFrame } from './render.js';

interface Args {
  leds: number;
  httpPort: number;
  ddpPort: number;
  name: string;
  matrix: { w: number; h: number } | null;
  ws: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    leds: 150,
    httpPort: 8888,
    ddpPort: DDP_PORT,
    name: 'Software Sink',
    matrix: null,
    ws: true,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i]!;
    switch (arg) {
      case '--leds': a.leds = Number(next()); break;
      case '--http-port': a.httpPort = Number(next()); break;
      case '--ddp-port': a.ddpPort = Number(next()); break;
      case '--name': a.name = next(); break;
      case '--no-ws': a.ws = false; break;
      case '--quiet': a.quiet = true; break;
      case '--matrix': {
        const m = /^(\d+)x(\d+)$/.exec(next());
        if (m) a.matrix = { w: Number(m[1]), h: Number(m[2]) };
        break;
      }
    }
  }
  if (a.matrix) a.leds = a.matrix.w * a.matrix.h;
  return a;
}

const args = parseArgs(process.argv.slice(2));
const mac = ('de51' + Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')).slice(0, 12);

const device = new MockDevice({
  name: args.name,
  ledCount: args.leds,
  matrix: args.matrix,
  mac,
  arch: 'esp32',
  websocket: args.ws,
  dmx: { uni: 1, addr: 1, mode: args.matrix ? 4 : 4 },
});

const receiver = new DdpReceiver(args.leds * 3, args.ddpPort);

// --- WebSocket ----------------------------------------------------------
const wss = args.ws ? new WebSocketServer({ noServer: true }) : null;
const wsClients = new Set<WebSocket>();
const previewClients = new Set<WebSocket>();

let idleUntil = 0;
const isLive = () => Date.now() > idleUntil && receiver.stats.fps > 0;

function pushState(ws?: WebSocket) {
  const msg = JSON.stringify({ state: device.state, info: device.info(wsClients.size, isLive()) });
  if (ws) ws.send(msg);
  else for (const c of wsClients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

wss?.on('connection', (ws) => {
  wsClients.add(ws);
  pushState(ws);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString();
    if (text === 'p') return void ws.send('pong');
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      if (obj['lv'] === true) {
        previewClients.forEach((c) => c !== ws && previewClients.delete(c)); // "one client at a time"
        previewClients.add(ws);
        ws.send(JSON.stringify({ success: true }));
        return;
      }
      if (obj['lv'] === false) return void previewClients.delete(ws);
      if (obj['live'] === false) { idleUntil = Date.now() + 2500; pushState(); return; }
      device.applyPatch(obj);
      pushState();
    } catch {
      ws.send(JSON.stringify({ error: 0 }));
    }
  });
  ws.on('close', () => {
    wsClients.delete(ws);
    previewClients.delete(ws);
  });
  ws.on('error', () => ws.terminate());
});

// --- HTTP JSON API ----------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (body: unknown, code = 200) => {
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': '*',
      'access-control-allow-headers': '*',
    });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'POST' && (url.pathname === '/json' || url.pathname === '/json/state' || url.pathname === '/json/cfg')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const obj = JSON.parse(raw || '{}') as Record<string, unknown>;
        if (url.pathname === '/json/cfg') device.applyCfg(obj);
        else device.applyPatch(obj);
      } catch {
        /* ignore */
      }
      pushState();
      send({ success: true });
    });
    return;
  }

  switch (url.pathname) {
    case '/json':
      return send({
        state: device.state,
        info: device.info(wsClients.size, isLive()),
        effects: device.effectNames,
        palettes: device.palettes,
      });
    case '/json/state':
      return send(device.state);
    case '/json/si':
      return send({ state: device.state, info: device.info(wsClients.size, isLive()) });
    case '/json/info':
      return send(device.info(wsClients.size, isLive()));
    case '/json/eff':
      return send(device.effectNames);
    case '/json/pal':
      return send(device.palettes);
    case '/json/fxdata':
      return send(device.fxdata);
    case '/json/cfg':
      return send(device.cfg());
    case '/json/nodes':
      return send({ nodes: [] });
    default:
      return send({ error: 'not found' }, 404);
  }
});

if (wss) {
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '', 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

// --- preview feed to WS clients that asked for {lv:true} --------------
receiver.on('frame', (buf) => {
  if (previewClients.size === 0) return;
  const header = Buffer.from([0x4c, 1]); // 'L', version 1 (strip)
  const frame = Buffer.concat([header, Buffer.from(buf)]);
  for (const c of previewClients) if (c.readyState === WebSocket.OPEN) c.send(frame);
});

// --- terminal render loop -------------------------------------------
let lastRenderLines = 0;
function draw() {
  if (args.quiet) return;
  const s = receiver.stats;
  const width = Math.max(20, (process.stdout.columns ?? 100) - 2);
  const frame = renderFrame(receiver.buffer, args.leds, {
    format: 'rgb',
    matrix: args.matrix,
    width,
  });
  const status =
    `\x1b[2m${args.name} · ${args.leds} LED${args.leds === 1 ? '' : 's'} · ` +
    `http:${args.httpPort} ddp:${args.ddpPort}${args.ws ? '' : ' (no ws)'}\x1b[0m\n` +
    `\x1b[1m${s.fps} fps\x1b[0m  frames ${s.frames}  packets ${s.packets}  ` +
    `out-of-order ${s.outOfOrder}  invalid ${s.invalid}  wrong-dest ${s.wrongDest}  ` +
    `${(s.bytes / 1024).toFixed(0)} KiB`;

  const out = `${status}\n${frame}`;
  const lines = out.split('\n').length;
  process.stdout.write(`\x1b[${lastRenderLines ? lastRenderLines + 'A' : '0G'}\x1b[0J${out}\n`);
  lastRenderLines = lines;
}

// --- boot -----------------------------------------------------------
async function main() {
  await receiver.start();
  await new Promise<void>((r) => server.listen(args.httpPort, r));

  process.stdout.write(
    `\n  Software WLED sink — "${args.name}"\n` +
      `  HTTP  http://localhost:${args.httpPort}   (add this in the app)\n` +
      `  DDP   udp/${args.ddpPort}\n` +
      `  ${args.leds} LEDs${args.matrix ? ` (${args.matrix.w}×${args.matrix.h} matrix)` : ''}` +
      `${args.ws ? '' : '  ·  WebSocket disabled (info.ws = -1)'}\n\n`,
  );

  if (!args.quiet) setInterval(draw, 100);

  const shutdown = () => {
    receiver.stop();
    server.close();
    process.stdout.write('\nsink stopped\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
