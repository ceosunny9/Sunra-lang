/**
 * Sunra's extended standard library.
 *
 * The public API is synchronous because the prototype interpreter is synchronous,
 * but the underlying handles are deliberately event-driven. TCP and WebSocket
 * callbacks append to a receive queue; a Sunra program can poll that queue with
 * `receive`. In a browser, the same API uses the platform WebSocket and
 * localStorage where available. In Node, optional built-ins are acquired through
 * `process.getBuiltinModule` at runtime, rather than static `node:` imports, so
 * the browser bundle remains browser-compatible.
 *
 * Graphics and audio are portable command/data buffers. The interpreter can
 * inspect, serialize, and test them; a browser host can consume the JSON command
 * stream with Canvas/WebGL/WebAudio without changing the Sunra program.
 */

import {
  bool,
  display,
  float,
  int,
  list,
  namespace,
  native,
  numeric,
  record,
  str,
  UNIT,
  type Value,
} from "./values.js";
import { SimRng, type SunraRng } from "./rng.js";

interface StdlibHost {
  current: () => SunraRng;
  setCurrent: (rng: SunraRng) => void;
}

const asNumber = (value: Value, label: string): number => {
  try {
    return numeric(value);
  } catch {
    throw new Error(`${label} must be numeric`);
  }
};

const asString = (value: Value, label: string): string => {
  if (value.t !== "str") throw new Error(`${label} must be a Str`);
  return value.v;
};

const asList = (value: Value, label: string): Value[] => {
  if (value.t !== "list") throw new Error(`${label} must be a List`);
  return value.v;
};

const asRecord = (value: Value, label: string): Map<string, Value> => {
  if (value.t !== "record") throw new Error(`${label} must be a record`);
  return value.v;
};

const field = (value: Value, name: string): Value => {
  const found = asRecord(value, "handle").get(name);
  if (!found) throw new Error(`handle has no field \`${name}\``);
  return found;
};

const idOf = (value: Value): number => asNumber(field(value, "id"), "handle id");

function handle(typeName: string, id: number, extra: Record<string, Value> = {}): Value {
  return record(new Map([["id", int(id)], ...Object.entries(extra)]), typeName);
}

function jsonValue(value: Value): unknown {
  switch (value.t) {
    case "unit":
      return null;
    case "int":
    case "float":
      return value.v;
    case "str":
    case "bool":
      return value.v;
    case "list":
      return value.v.map(jsonValue);
    case "money":
      return { amount: Number(value.v) / 10_000, currency: value.currency };
    case "record": {
      const output: Record<string, unknown> = {};
      for (const [key, item] of value.v) output[key] = jsonValue(item);
      return output;
    }
    default:
      return display(value);
  }
}

function fromJson(value: unknown): Value {
  if (value === null || value === undefined) return UNIT;
  if (typeof value === "boolean") return bool(value);
  if (typeof value === "number") return Number.isInteger(value) ? int(value) : float(value);
  if (typeof value === "string") return str(value);
  if (Array.isArray(value)) return list(value.map(fromJson));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fromJson(item)] as [string, Value]);
    return record(new Map(entries), "JsonObject");
  }
  return str(String(value));
}

function builtIn(name: string): any {
  const processObject = (globalThis as { process?: { getBuiltinModule?: (module: string) => any } }).process;
  return processObject?.getBuiltinModule?.(name);
}

function browserStorage(): any {
  return (globalThis as { localStorage?: any }).localStorage;
}

// ---------------------------------------------------------------------------
// Advanced random distributions
// ---------------------------------------------------------------------------

function unit(rng: SunraRng): number {
  let value = rng.nextFloat();
  while (value <= Number.EPSILON) value = rng.nextFloat();
  return value;
}

function normalDraw(rng: SunraRng): number {
  const u = unit(rng);
  const v = rng.nextFloat();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function gammaDraw(rng: SunraRng, shape: number, scale: number): number {
  if (!(shape > 0) || !(scale > 0)) throw new Error("gamma shape and scale must be > 0");
  if (shape < 1) {
    return gammaDraw(rng, shape + 1, scale) * Math.pow(unit(rng), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normalDraw(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = unit(rng);
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v * scale;
    }
  }
}

export function makeRandomNamespace(host: StdlibHost): Value {
  return namespace("Random", {
    uniform: native("Random.uniform", 2, (args) => {
      const lo = asNumber(args[0], "uniform lo");
      const hi = asNumber(args[1], "uniform hi");
      if (!(hi >= lo)) throw new Error("uniform hi must be >= lo");
      return float(lo + host.current().nextFloat() * (hi - lo));
    }),
    int: native("Random.int", 2, (args) => int(host.current().range(Math.ceil(asNumber(args[0], "int lo")), Math.floor(asNumber(args[1], "int hi")) + 1))),
    bernoulli: native("Random.bernoulli", 1, (args) => bool(host.current().nextFloat() < asNumber(args[0], "bernoulli p"))),
    normal: native("Random.normal", 2, (args) => float(asNumber(args[0], "normal mean") + normalDraw(host.current()) * asNumber(args[1], "normal sd"))),
    exponential: native("Random.exponential", 1, (args) => {
      const lambda = asNumber(args[0], "exponential lambda");
      if (!(lambda > 0)) throw new Error("exponential lambda must be > 0");
      return float(-Math.log(unit(host.current())) / lambda);
    }),
    gamma: native("Random.gamma", 2, (args) => float(gammaDraw(host.current(), asNumber(args[0], "gamma shape"), asNumber(args[1], "gamma scale")))),
    beta: native("Random.beta", 2, (args) => {
      const a = asNumber(args[0], "beta alpha");
      const b = asNumber(args[1], "beta beta");
      const x = gammaDraw(host.current(), a, 1);
      const y = gammaDraw(host.current(), b, 1);
      return float(x / (x + y));
    }),
    lognormal: native("Random.lognormal", 2, (args) => float(Math.exp(asNumber(args[0], "lognormal mean") + normalDraw(host.current()) * asNumber(args[1], "lognormal sd")))),
    poisson: native("Random.poisson", 1, (args) => {
      const lambda = asNumber(args[0], "poisson lambda");
      if (!(lambda >= 0)) throw new Error("poisson lambda must be >= 0");
      if (lambda === 0) return int(0);
      const threshold = Math.exp(-lambda);
      let product = 1;
      let count = 0;
      while (product > threshold) {
        count += 1;
        product *= unit(host.current());
      }
      return int(count - 1);
    }),
    binomial: native("Random.binomial", 2, (args) => {
      const trials = Math.trunc(asNumber(args[0], "binomial trials"));
      const p = asNumber(args[1], "binomial p");
      if (trials < 0 || p < 0 || p > 1) throw new Error("binomial requires trials >= 0 and p in [0, 1]");
      let successes = 0;
      for (let i = 0; i < trials; i += 1) if (host.current().nextFloat() < p) successes += 1;
      return int(successes);
    }),
    triangular: native("Random.triangular", 3, (args) => {
      const lo = asNumber(args[0], "triangular lo");
      const mode = asNumber(args[1], "triangular mode");
      const hi = asNumber(args[2], "triangular hi");
      if (!(lo <= mode && mode <= hi) || lo === hi) throw new Error("triangular requires lo <= mode <= hi and lo != hi");
      const u = host.current().nextFloat();
      const split = (mode - lo) / (hi - lo);
      return float(u < split ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode)));
    }),
    weightedIndex: native("Random.weightedIndex", 1, (args) => {
      const weights = asList(args[0], "weights").map((v) => asNumber(v, "weight"));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      if (weights.length === 0 || !(total > 0) || weights.some((weight) => weight < 0)) throw new Error("weights must be non-empty, non-negative, and have a positive sum");
      let cursor = host.current().nextFloat() * total;
      for (let i = 0; i < weights.length; i += 1) {
        cursor -= weights[i];
        if (cursor < 0) return int(i);
      }
      return int(weights.length - 1);
    }),
    choice: native("Random.choice", 1, (args) => {
      const values = asList(args[0], "choice values");
      if (values.length === 0) throw new Error("choice requires a non-empty list");
      return values[host.current().range(0, values.length)];
    }),
    shuffle: native("Random.shuffle", 1, (args) => {
      const values = [...asList(args[0], "shuffle values")];
      for (let i = values.length - 1; i > 0; i -= 1) {
        const j = host.current().range(0, i + 1);
        [values[i], values[j]] = [values[j], values[i]];
      }
      return list(values);
    }),
    sample: native("Random.sample", 2, (args) => {
      const values = [...asList(args[0], "sample values")];
      const count = Math.trunc(asNumber(args[1], "sample count"));
      if (count < 0 || count > values.length) throw new Error("sample count must be between 0 and list length");
      const output: Value[] = [];
      for (let i = 0; i < count; i += 1) {
        const index = host.current().range(0, values.length);
        output.push(values.splice(index, 1)[0]);
      }
      return list(output);
    }),
    seed: native("Random.seed", 1, (args) => {
      host.setCurrent(new SimRng(asString(args[0], "seed")));
      return UNIT;
    }),
    draws: native("Random.draws", 0, () => int(host.current().draws)),
  });
}

// ---------------------------------------------------------------------------
// Networking: TCP and WebSocket handles with polling queues
// ---------------------------------------------------------------------------

type NetState = {
  id: number;
  kind: "tcp" | "websocket";
  connected: boolean;
  closed: boolean;
  error: string;
  queue: string[];
  socket?: any;
  server?: any;
  pending: number[];
};

const netStates = new Map<number, NetState>();
let nextNetId = 1;

function netHandle(state: NetState): Value {
  netStates.set(state.id, state);
  return handle(state.kind === "tcp" ? "TcpSocket" : "WebSocket", state.id, {
    connected: bool(state.connected),
  });
}

function refreshNetRecord(value: Value, state: NetState): Value {
  if (value.t !== "record") return value;
  value.v.set("connected", bool(state.connected));
  return value;
}

function makeTcp(host: string, port: number): Value {
  const state: NetState = { id: nextNetId++, kind: "tcp", connected: false, closed: false, error: "", queue: [], pending: [] };
  const net = builtIn("node:net");
  if (!net) {
    state.error = "TCP is unavailable in this host; use a browser WebSocket or a Node runtime";
    return netHandle(state);
  }
  const socket = net.createConnection({ host, port });
  state.socket = socket;
  socket.on("connect", () => { state.connected = true; });
  socket.on("data", (data: any) => state.queue.push(String(data)));
  socket.on("error", (error: any) => { state.error = String(error?.message ?? error); });
  socket.on("close", () => { state.closed = true; state.connected = false; });
  return netHandle(state);
}

function makeWebSocket(url: string): Value {
  const state: NetState = { id: nextNetId++, kind: "websocket", connected: false, closed: false, error: "", queue: [], pending: [] };
  const WebSocketCtor = (globalThis as { WebSocket?: any }).WebSocket;
  if (!WebSocketCtor) {
    state.error = "WebSocket is unavailable in this host";
    return netHandle(state);
  }
  const socket = new WebSocketCtor(url);
  state.socket = socket;
  socket.onopen = () => { state.connected = true; };
  socket.onmessage = (event: any) => state.queue.push(String(event.data));
  socket.onerror = () => { state.error = "WebSocket error"; };
  socket.onclose = () => { state.closed = true; state.connected = false; };
  return netHandle(state);
}

export function makeNetNamespace(): Value {
  const stateFor = (value: Value): NetState => {
    const state = netStates.get(idOf(value));
    if (!state) throw new Error("unknown network handle");
    return state;
  };
  return namespace("Net", {
    tcpConnect: native("Net.tcpConnect", 2, (args) => makeTcp(asString(args[0], "host"), Math.trunc(asNumber(args[1], "port")))),
    tcpSend: native("Net.tcpSend", 2, (args) => {
      const state = stateFor(args[0]);
      const payload = asString(args[1], "tcp payload");
      if (!state.socket?.write) throw new Error(state.error || "TCP socket is unavailable");
      state.socket.write(payload);
      return int(payload.length);
    }),
    tcpReceive: native("Net.tcpReceive", -1, (args) => {
      const state = stateFor(args[0]);
      const limit = args.length > 1 ? Math.max(0, Math.trunc(asNumber(args[1], "receive limit"))) : Infinity;
      const joined = state.queue.join("");
      state.queue = [];
      return str(Number.isFinite(limit) ? joined.slice(0, limit) : joined);
    }),
    tcpListen: native("Net.tcpListen", 2, (args) => {
      const host = asString(args[0], "listen host");
      const port = Math.trunc(asNumber(args[1], "listen port"));
      const state: NetState = { id: nextNetId++, kind: "tcp", connected: true, closed: false, error: "", queue: [], pending: [] };
      const net = builtIn("node:net");
      if (!net) {
        state.error = "TCP is unavailable in this host";
        return netHandle(state);
      }
      const server = net.createServer((socket: any) => {
        const child: NetState = { id: nextNetId++, kind: "tcp", connected: true, closed: false, error: "", queue: [], pending: [], socket };
        socket.on("data", (data: any) => child.queue.push(String(data)));
        socket.on("error", (error: any) => { child.error = String(error?.message ?? error); });
        socket.on("close", () => { child.closed = true; child.connected = false; });
        netStates.set(child.id, child);
        state.pending.push(child.id);
      });
      state.server = server;
      server.listen(port, host);
      return handle("TcpListener", state.id, { connected: bool(true), port: int(port) });
    }),
    tcpAccept: native("Net.tcpAccept", 1, (args) => {
      const state = stateFor(args[0]);
      const id = state.pending.shift();
      return id === undefined ? UNIT : handle("TcpSocket", id, { connected: bool(netStates.get(id)?.connected ?? false) });
    }),
    websocketConnect: native("Net.websocketConnect", 1, (args) => makeWebSocket(asString(args[0], "WebSocket URL"))),
    websocketSend: native("Net.websocketSend", 2, (args) => {
      const state = stateFor(args[0]);
      if (!state.socket?.send) throw new Error(state.error || "WebSocket is unavailable");
      const payload = asString(args[1], "WebSocket payload");
      state.socket.send(payload);
      return int(payload.length);
    }),
    websocketReceive: native("Net.websocketReceive", 1, (args) => str(stateFor(args[0]).queue.shift() ?? "")),
    connected: native("Net.connected", 1, (args) => bool(stateFor(args[0]).connected)),
    error: native("Net.error", 1, (args) => str(stateFor(args[0]).error)),
    close: native("Net.close", 1, (args) => {
      const state = stateFor(args[0]);
      if (state.socket?.end) state.socket.end();
      if (state.socket?.close) state.socket.close();
      if (state.server?.close) state.server.close();
      state.closed = true;
      state.connected = false;
      return UNIT;
    }),
  });
}

// ---------------------------------------------------------------------------
// Database: synchronous durable key-value stores
// ---------------------------------------------------------------------------

type DbState = { id: number; path: string; data: Map<string, Value>; closed: boolean };
const dbStates = new Map<number, DbState>();
let nextDbId = 1;

function loadDb(path: string): Map<string, Value> {
  try {
    if (path === ":memory:") return new Map();
    const fs = builtIn("node:fs");
    if (fs?.existsSync(path)) {
      const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
      return new Map(Object.entries(parsed).map(([key, value]) => [key, fromJson(value)]));
    }
    const storage = browserStorage();
    const raw = storage?.getItem(path);
    if (raw) return new Map(Object.entries(JSON.parse(raw)).map(([key, value]) => [key, fromJson(value)]));
  } catch {
    throw new Error(`could not open key-value store \`${path}\``);
  }
  return new Map();
}

function persistDb(state: DbState): void {
  if (state.path === ":memory:") return;
  const object: Record<string, unknown> = {};
  for (const [key, value] of state.data) object[key] = jsonValue(value);
  const serialized = JSON.stringify(object, null, 2) + "\n";
  const fs = builtIn("node:fs");
  if (fs?.writeFileSync) fs.writeFileSync(state.path, serialized, "utf8");
  else browserStorage()?.setItem(state.path, serialized);
}

export function makeDbNamespace(): Value {
  const stateFor = (value: Value): DbState => {
    const state = dbStates.get(idOf(value));
    if (!state || state.closed) throw new Error("database handle is closed");
    return state;
  };
  return namespace("Db", {
    open: native("Db.open", 1, (args) => {
      const path = asString(args[0], "database path");
      const state: DbState = { id: nextDbId++, path, data: loadDb(path), closed: false };
      dbStates.set(state.id, state);
      return handle("KeyValueStore", state.id, { path: str(path) });
    }),
    get: native("Db.get", 2, (args) => stateFor(args[0]).data.get(asString(args[1], "key")) ?? UNIT),
    set: native("Db.set", 3, (args) => {
      stateFor(args[0]).data.set(asString(args[1], "key"), args[2]);
      return UNIT;
    }),
    has: native("Db.has", 2, (args) => bool(stateFor(args[0]).data.has(asString(args[1], "key")))),
    delete: native("Db.delete", 2, (args) => bool(stateFor(args[0]).data.delete(asString(args[1], "key")))),
    keys: native("Db.keys", 1, (args) => list([...stateFor(args[0]).data.keys()].sort().map(str))),
    count: native("Db.count", 1, (args) => int(stateFor(args[0]).data.size)),
    flush: native("Db.flush", 1, (args) => { persistDb(stateFor(args[0])); return UNIT; }),
    close: native("Db.close", 1, (args) => {
      const state = stateFor(args[0]);
      persistDb(state);
      state.closed = true;
      return UNIT;
    }),
  });
}

// ---------------------------------------------------------------------------
// Graphics: deterministic Canvas/WebGL command buffers
// ---------------------------------------------------------------------------

type CanvasState = { id: number; width: number; height: number; commands: Array<Record<string, unknown>> };
type GlState = { id: number; canvas: number; commands: Array<Record<string, unknown>> };
const canvases = new Map<number, CanvasState>();
const glContexts = new Map<number, GlState>();
let nextGraphicsId = 1;

function canvasFor(value: Value): CanvasState {
  const state = canvases.get(idOf(value));
  if (!state) throw new Error("unknown canvas handle");
  return state;
}

const colorOf = (value: Value): string => asString(value, "color");

function commandJson(commands: Array<Record<string, unknown>>): string {
  return JSON.stringify(commands);
}

function svgOf(state: CanvasState): string {
  const body = state.commands.map((command) => {
    switch (command.op) {
      case "clear": return `<rect width="${state.width}" height="${state.height}" fill="${command.color}"/>`;
      case "fillRect": return `<rect x="${command.x}" y="${command.y}" width="${command.w}" height="${command.h}" fill="${command.color}"/>`;
      case "strokeRect": return `<rect x="${command.x}" y="${command.y}" width="${command.w}" height="${command.h}" fill="none" stroke="${command.color}"/>`;
      case "line": return `<line x1="${command.x1}" y1="${command.y1}" x2="${command.x2}" y2="${command.y2}" stroke="${command.color}"/>`;
      case "circle": return `<circle cx="${command.cx}" cy="${command.cy}" r="${command.r}" fill="${command.fill ? command.color : "none"}" stroke="${command.fill ? "none" : command.color}"/>`;
      case "text": return `<text x="${command.x}" y="${command.y}" fill="${command.color}">${String(command.text).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c))}</text>`;
      default: return "";
    }
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${state.width}" height="${state.height}" viewBox="0 0 ${state.width} ${state.height}">${body}</svg>`;
}

export function makeGraphicsNamespace(): Value {
  return namespace("Graphics", {
    canvas: native("Graphics.canvas", 2, (args) => {
      const state: CanvasState = { id: nextGraphicsId++, width: Math.trunc(asNumber(args[0], "canvas width")), height: Math.trunc(asNumber(args[1], "canvas height")), commands: [] };
      if (state.width <= 0 || state.height <= 0) throw new Error("canvas dimensions must be positive");
      canvases.set(state.id, state);
      return handle("Canvas", state.id, { width: int(state.width), height: int(state.height) });
    }),
    clear: native("Graphics.clear", 2, (args) => { canvasFor(args[0]).commands.push({ op: "clear", color: colorOf(args[1]) }); return UNIT; }),
    fillRect: native("Graphics.fillRect", 6, (args) => { canvasFor(args[0]).commands.push({ op: "fillRect", x: asNumber(args[1], "x"), y: asNumber(args[2], "y"), w: asNumber(args[3], "width"), h: asNumber(args[4], "height"), color: colorOf(args[5]) }); return UNIT; }),
    strokeRect: native("Graphics.strokeRect", 6, (args) => { canvasFor(args[0]).commands.push({ op: "strokeRect", x: asNumber(args[1], "x"), y: asNumber(args[2], "y"), w: asNumber(args[3], "width"), h: asNumber(args[4], "height"), color: colorOf(args[5]) }); return UNIT; }),
    line: native("Graphics.line", 6, (args) => { canvasFor(args[0]).commands.push({ op: "line", x1: asNumber(args[1], "x1"), y1: asNumber(args[2], "y1"), x2: asNumber(args[3], "x2"), y2: asNumber(args[4], "y2"), color: colorOf(args[5]) }); return UNIT; }),
    circle: native("Graphics.circle", 6, (args) => { canvasFor(args[0]).commands.push({ op: "circle", cx: asNumber(args[1], "cx"), cy: asNumber(args[2], "cy"), r: asNumber(args[3], "radius"), color: colorOf(args[4]), fill: args[5].t === "bool" && args[5].v }); return UNIT; }),
    text: native("Graphics.text", 5, (args) => { canvasFor(args[0]).commands.push({ op: "text", text: asString(args[1], "text"), x: asNumber(args[2], "x"), y: asNumber(args[3], "y"), color: colorOf(args[4]) }); return UNIT; }),
    toJson: native("Graphics.toJson", 1, (args) => str(commandJson(canvasFor(args[0]).commands))),
    toSvg: native("Graphics.toSvg", 1, (args) => str(svgOf(canvasFor(args[0])))),
    commands: native("Graphics.commands", 1, (args) => list(canvasFor(args[0]).commands.map((command) => fromJson(command)))),
    width: native("Graphics.width", 1, (args) => int(canvasFor(args[0]).width)),
    height: native("Graphics.height", 1, (args) => int(canvasFor(args[0]).height)),
    webgl: native("Graphics.webgl", 1, (args) => {
      const canvas = canvasFor(args[0]);
      const state: GlState = { id: nextGraphicsId++, canvas: canvas.id, commands: [] };
      glContexts.set(state.id, state);
      return handle("WebGLContext", state.id, { canvas: int(canvas.id) });
    }),
    webglClear: native("Graphics.webglClear", 5, (args) => { const gl = glContexts.get(idOf(args[0])); if (!gl) throw new Error("unknown WebGL context"); gl.commands.push({ op: "clear", r: asNumber(args[1], "red"), g: asNumber(args[2], "green"), b: asNumber(args[3], "blue"), a: asNumber(args[4], "alpha") }); return UNIT; }),
    webglViewport: native("Graphics.webglViewport", 5, (args) => { const gl = glContexts.get(idOf(args[0])); if (!gl) throw new Error("unknown WebGL context"); gl.commands.push({ op: "viewport", x: asNumber(args[1], "x"), y: asNumber(args[2], "y"), width: asNumber(args[3], "width"), height: asNumber(args[4], "height") }); return UNIT; }),
    webglDraw: native("Graphics.webglDraw", 3, (args) => { const gl = glContexts.get(idOf(args[0])); if (!gl) throw new Error("unknown WebGL context"); gl.commands.push({ op: "draw", mode: asString(args[1], "mode"), count: asNumber(args[2], "count") }); return UNIT; }),
    webglCommands: native("Graphics.webglCommands", 1, (args) => { const gl = glContexts.get(idOf(args[0])); if (!gl) throw new Error("unknown WebGL context"); return str(JSON.stringify(gl.commands)); }),
  });
}

// ---------------------------------------------------------------------------
// Audio: deterministic synthesis descriptions and WAV export
// ---------------------------------------------------------------------------

type Tone = { frequency: number; duration: number; volume: number; start: number };
const audioBuffers = new Map<number, Tone[]>();
let nextAudioId = 1;

function audioFor(value: Value): Tone[] {
  const tones = audioBuffers.get(idOf(value));
  if (!tones) throw new Error("unknown audio buffer");
  return tones;
}

function noteFrequency(name: string): number {
  const match = /^([A-Ga-g])([#s]?)(-?\d+)$/.exec(name.trim());
  if (!match) throw new Error(`invalid note \`${name}\`; use e.g. A4 or C#5`);
  const semitone = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[match[1].toUpperCase()] + (match[2] ? 1 : 0);
  const octave = Number(match[3]);
  return 440 * Math.pow(2, (semitone + (octave - 4) * 12 - 9) / 12);
}

function base64(bytes: number[]): string {
  const text = String.fromCharCode(...bytes);
  const btoaFunction = (globalThis as { btoa?: (input: string) => string }).btoa;
  if (btoaFunction) return btoaFunction(text);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    output += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + (i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? alphabet[n & 63] : "=");
  }
  return output;
}

function wavFor(tones: Tone[], sampleRate = 22_050): string {
  const length = Math.max(1, Math.ceil(Math.max(...tones.map((tone) => tone.start + tone.duration), 0) * sampleRate));
  const samples = new Int16Array(length);
  for (const tone of tones) {
    const start = Math.max(0, Math.floor(tone.start * sampleRate));
    const end = Math.min(length, Math.ceil((tone.start + tone.duration) * sampleRate));
    for (let i = start; i < end; i += 1) {
      const t = (i - start) / sampleRate;
      const envelope = Math.min(1, t * 80, (tone.duration - t) * 20);
      const sample = Math.max(-1, Math.min(1, Math.sin(2 * Math.PI * tone.frequency * t) * tone.volume * envelope));
      const mixed = samples[i] + Math.round(sample * 32767);
      samples[i] = Math.max(-32768, Math.min(32767, mixed));
    }
  }
  const bytes = new Array<number>(44 + samples.length * 2).fill(0);
  const writeAscii = (offset: number, text: string) => [...text].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  const write32 = (offset: number, value: number) => { bytes[offset] = value & 255; bytes[offset + 1] = (value >> 8) & 255; bytes[offset + 2] = (value >> 16) & 255; bytes[offset + 3] = (value >> 24) & 255; };
  const write16 = (offset: number, value: number) => { bytes[offset] = value & 255; bytes[offset + 1] = (value >> 8) & 255; };
  writeAscii(0, "RIFF"); write32(4, 36 + samples.length * 2); writeAscii(8, "WAVE"); writeAscii(12, "fmt "); write32(16, 16); write16(20, 1); write16(22, 1); write32(24, sampleRate); write32(28, sampleRate * 2); write16(32, 2); write16(34, 16); writeAscii(36, "data"); write32(40, samples.length * 2);
  samples.forEach((sample, index) => { const unsigned = sample < 0 ? sample + 65_536 : sample; bytes[44 + index * 2] = unsigned & 255; bytes[45 + index * 2] = (unsigned >> 8) & 255; });
  return base64(bytes);
}

export function makeAudioNamespace(): Value {
  return namespace("Audio", {
    tone: native("Audio.tone", 3, (args) => {
      const tones = [{ frequency: asNumber(args[0], "frequency"), duration: asNumber(args[1], "duration"), volume: asNumber(args[2], "volume"), start: 0 }];
      if (tones[0].frequency <= 0 || tones[0].duration <= 0 || tones[0].volume < 0 || tones[0].volume > 1) throw new Error("tone requires frequency > 0, duration > 0, and volume in [0, 1]");
      const id = nextAudioId++; audioBuffers.set(id, tones); return handle("AudioBuffer", id, { duration: float(tones[0].duration) });
    }),
    note: native("Audio.note", 3, (args) => {
      const tones = [{ frequency: noteFrequency(asString(args[0], "note")), duration: asNumber(args[1], "duration"), volume: asNumber(args[2], "volume"), start: 0 }];
      const id = nextAudioId++; audioBuffers.set(id, tones); return handle("AudioBuffer", id, { duration: float(tones[0].duration) });
    }),
    sequence: native("Audio.sequence", 1, (args) => {
      const source = asList(args[0], "audio buffers"); let cursor = 0; const tones: Tone[] = [];
      for (const item of source) { const current = audioFor(item); for (const tone of current) tones.push({ ...tone, start: tone.start + cursor }); cursor += Math.max(...current.map((tone) => tone.start + tone.duration), 0); }
      const id = nextAudioId++; audioBuffers.set(id, tones); return handle("AudioBuffer", id, { duration: float(cursor) });
    }),
    mix: native("Audio.mix", 1, (args) => { const tones: Tone[] = []; for (const item of asList(args[0], "audio buffers")) tones.push(...audioFor(item)); const id = nextAudioId++; audioBuffers.set(id, tones); return handle("AudioBuffer", id); }),
    toJson: native("Audio.toJson", 1, (args) => str(JSON.stringify(audioFor(args[0])))),
    wavBase64: native("Audio.wavBase64", -1, (args) => str(wavFor(audioFor(args[0]), args.length > 1 ? Math.trunc(asNumber(args[1], "sample rate")) : 22_050))),
    play: native("Audio.play", 1, () => UNIT),
  });
}

// ---------------------------------------------------------------------------
// Public installer
// ---------------------------------------------------------------------------

export function installExtendedStdlib(
  globals: { declare: (name: string, value: Value) => void },
  host: StdlibHost,
): void {
  globals.declare("Random", makeRandomNamespace(host));
  globals.declare("Net", makeNetNamespace());
  globals.declare("Db", makeDbNamespace());
  globals.declare("Graphics", makeGraphicsNamespace());
  globals.declare("Audio", makeAudioNamespace());
}
