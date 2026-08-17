/**
 * The vocabulary the language server explains to an editor.
 *
 * Every entry here mirrors a symbol that actually exists in the runtime. The
 * names were extracted from `src/runtime/gaming.ts` and
 * `src/codegen/runtime_source.ts` with `scripts/dump-api.mjs`, so completion can
 * never offer a member the interpreter does not implement.
 */

export interface MemberDoc {
  signature: string;
  description: string;
  /** Optional snippet body (LSP insertTextFormat 2). */
  snippet?: string;
}

export interface NamespaceDoc {
  summary: string;
  description: string;
  members: Record<string, MemberDoc>;
}

const member = (signature: string, description: string, snippet?: string): MemberDoc => ({
  signature,
  description,
  snippet,
});

export const NAMESPACE_DOCS: Record<string, NamespaceDoc> = {
  rng: {
    summary: "the random source",
    description:
      "Every method on `rng` carries the `rand` effect, so any function that touches it must declare `uses rand`. That declaration is what makes a paytable auditable: a payout function without it provably cannot consult randomness.",
    members: {
      pick: member("rng.pick(values, count) -> List", "Choose `count` values from a list."),
      weighted: member(
        "rng.weighted(values, weights) -> Value",
        "Weighted selection. Weights need not sum to one.",
      ),
      int: member("rng.int(min, max) -> Int", "Inclusive integer draw."),
      float: member("rng.float() -> Float", "Uniform draw in [0, 1)."),
      bool: member("rng.bool() -> Bool", "Fair coin."),
      chance: member("rng.chance(p) -> Bool", "True with probability `p`."),
      shuffle: member("rng.shuffle(values) -> List", "Return a shuffled copy."),
      seed: member("rng.seed(value) -> Unit", "Install a deterministic simulation seed."),
      draws: member("rng.draws() -> Int", "How many values have been drawn so far."),
      kind: member("rng.kind() -> String", "Inspect the generator mode: secure or seeded."),
    },
  },

  Reel: {
    summary: "slot reels and strips",
    description:
      "Reels are first-class. A strip may be weighted, and `Reel.spin` is the only way to turn one into a row, which keeps the random source in one auditable place.",
    members: {
      of: member("Reel.of(symbols, weights?) -> Reel", "Construct a reel definition."),
      spin: member("Reel.spin(reel, count) -> List", "Draw a row of `count` symbols."),
      grid: member("Reel.grid(reel, rows, cols) -> List", "Draw a two-dimensional grid."),
      count: member("Reel.count(row, symbol) -> Int", "Count matching symbols in a row."),
      isMatch: member("Reel.isMatch(row) -> Bool", "True when every symbol is equal."),
      longestRun: member("Reel.longestRun(row) -> Int", "Length of the longest contiguous run."),
    },
  },

  Deck: {
    summary: "card decks and shoes",
    description:
      "Decks are values, not mutable objects. `Deck.deal` returns the dealt cards and the remaining deck, so a hidden mutation cannot change a shoe behind an auditor's back.",
    members: {
      standard: member("Deck.standard() -> Deck", "A 52-card deck in canonical order."),
      shuffled: member("Deck.shuffled(decks) -> Deck", "A shuffled multi-deck shoe."),
      deal: member("Deck.deal(deck, count) -> List", "Deal without hidden mutation."),
      size: member("Deck.size(deck) -> Int", "Remaining card count."),
    },
  },

  Card: {
    summary: "individual cards",
    description: "A card is a rank and a suit. Pip values follow the game being modelled.",
    members: {
      of: member("Card.of(rank, suit) -> Card", "Create a card, e.g. `Card.of(\"A\", \"S\")`."),
      rank: member("Card.rank(card) -> String", "The rank as written."),
      pip: member("Card.pip(card) -> Int", "Numeric pip value."),
      label: member("Card.label(card) -> String", "Display label such as `As`."),
    },
  },

  Baccarat: {
    summary: "punto banco rules",
    description:
      "The third-card rules are in the standard library because every implementation of them is a place to get regulation wrong. These functions are pure and therefore exhaustively testable.",
    members: {
      total: member("Baccarat.total(hand) -> Int", "Punto banco total, modulo ten."),
      playerDraws: member("Baccarat.playerDraws(player) -> Bool", "Player third-card rule."),
      bankerDraws: member(
        "Baccarat.bankerDraws(banker, third) -> Bool",
        "Banker third-card rule, given the player's third card.",
      ),
      winner: member("Baccarat.winner(player, banker) -> String", "Player, Banker or Tie."),
      payout: member("Baccarat.payout(result, bet) -> Money", "Rule-table payout."),
      isNatural: member("Baccarat.isNatural(hand) -> Bool", "Natural eight or nine."),
    },
  },

  Poker: {
    summary: "hand ranking",
    description: "Ranks a five-card hand and returns the category with its comparison key.",
    members: {
      rank: member("Poker.rank(hand) -> Record", "Rank a five-card hand."),
    },
  },

  Dice: {
    summary: "dice",
    description: "Rolling carries the `rand` effect; totalling a roll does not.",
    members: {
      roll: member("Dice.roll(sides) -> Int", "Roll one die."),
      rollMany: member("Dice.rollMany(count, sides) -> List", "Roll `count` dice of `sides` faces."),
      total: member("Dice.total(rolls) -> Int", "Pure sum of a roll."),
    },
  },

  Money: {
    summary: "exact decimal money",
    description:
      "Money is a fixed-point value, never a float. Multiplying money by a float is a type error (E0731) because a fraction of a cent is not a quantity a ledger can hold.",
    members: {
      of: member("Money.of(major, minor?) -> Money", "Construct an exact amount."),
      zero: member("Money.zero() -> Money", "The zero amount."),
      isZero: member("Money.isZero(value) -> Bool", "Zero predicate."),
      add: member("Money.add(a, b) -> Money", "Exact addition."),
      sub: member("Money.sub(a, b) -> Money", "Exact subtraction."),
      scale: member("Money.scale(value, integer) -> Money", "Scale by an integer count."),
      divide: member("Money.divide(value, count) -> Record", "Quotient and exact remainder."),
      toFloat: member("Money.toFloat(value) -> Float", "Explicit, lossy conversion."),
      format: member("Money.format(value) -> String", "Currency display string."),
    },
  },

  Fair: {
    summary: "provable fairness",
    description:
      "The commit-reveal ceremony in the standard library. A server seed is committed as a hash before play, the client seed is bound, each round is derived by HMAC, and the reveal lets anyone recompute the outcome.",
    members: {
      begin: member("Fair.begin(clientSeed) -> Ceremony", "Create a commitment ceremony."),
      use: member("Fair.use(ceremony, nonce) -> Unit", "Bind a round nonce."),
      commitment: member("Fair.commitment(ceremony) -> String", "The published hash."),
      reveal: member("Fair.reveal(ceremony) -> String", "Publish the server seed."),
      verify: member("Fair.verify(seed, commitment) -> Bool", "Check a published commitment."),
      draw: member("Fair.draw(ceremony, index) -> Int", "Recompute a specific draw."),
      hash: member("Fair.hash(value) -> String", "SHA-256 of a value."),
    },
  },

  Rtp: {
    summary: "return-to-player verification",
    description:
      "Simulation and statistics for a declared RTP. `Rtp.check` is what `sunra rtp` reports, and a failing check is a build-blocking obligation, not a warning.",
    members: {
      estimate: member("Rtp.estimate(game, rounds) -> Record", "Simulate return and variance."),
      check: member("Rtp.check(report, target, tolerance) -> Bool", "Evaluate a declared target."),
      volatility: member("Rtp.volatility(values) -> Float", "Standard deviation per unit bet."),
    },
  },

  Math: {
    summary: "pure numerics",
    description: "Deterministic mathematics. Nothing here reads the random source.",
    members: {
      pi: member("Math.pi -> Float", "The circle constant."),
      e: member("Math.e -> Float", "Euler's number."),
      tau: member("Math.tau -> Float", "Two pi."),
      floor: member("Math.floor(x) -> Int", "Round toward negative infinity."),
      ceil: member("Math.ceil(x) -> Int", "Round toward positive infinity."),
      round: member("Math.round(x) -> Int", "Round to nearest."),
      trunc: member("Math.trunc(x) -> Int", "Truncate toward zero."),
      abs: member("Math.abs(x) -> Float", "Absolute value."),
      sign: member("Math.sign(x) -> Int", "Sign as -1, 0 or 1."),
      sqrt: member("Math.sqrt(x) -> Float", "Square root."),
      cbrt: member("Math.cbrt(x) -> Float", "Cube root."),
      pow: member("Math.pow(base, exp) -> Float", "Exponentiation."),
      exp: member("Math.exp(x) -> Float", "e to the x."),
      log: member("Math.log(x) -> Float", "Natural logarithm."),
      log2: member("Math.log2(x) -> Float", "Base-2 logarithm."),
      log10: member("Math.log10(x) -> Float", "Base-10 logarithm."),
      sin: member("Math.sin(x) -> Float", "Sine."),
      cos: member("Math.cos(x) -> Float", "Cosine."),
      tan: member("Math.tan(x) -> Float", "Tangent."),
      atan2: member("Math.atan2(y, x) -> Float", "Two-argument arctangent."),
      hypot: member("Math.hypot(a, b) -> Float", "Euclidean length."),
      min: member("Math.min(a, b) -> Float", "Smaller of two values."),
      max: member("Math.max(a, b) -> Float", "Larger of two values."),
      clamp: member("Math.clamp(x, lo, hi) -> Float", "Constrain to a range."),
      lerp: member("Math.lerp(a, b, t) -> Float", "Linear interpolation."),
      gcd: member("Math.gcd(a, b) -> Int", "Greatest common divisor."),
      lcm: member("Math.lcm(a, b) -> Int", "Least common multiple."),
      factorial: member("Math.factorial(n) -> Int", "n!"),
      combinations: member("Math.combinations(n, k) -> Int", "Binomial coefficient."),
      permutations: member("Math.permutations(n, k) -> Int", "Ordered selections."),
      mean: member("Math.mean(values) -> Float", "Arithmetic mean."),
      median: member("Math.median(values) -> Float", "Median."),
      variance: member("Math.variance(values) -> Float", "Sample variance."),
      stdev: member("Math.stdev(values) -> Float", "Sample standard deviation."),
      isNaN: member("Math.isNaN(x) -> Bool", "Not-a-number predicate."),
      isFinite: member("Math.isFinite(x) -> Bool", "Finiteness predicate."),
    },
  },

  String: {
    summary: "string operations",
    description: "Pure text manipulation. Sunra strings are UTF-8 and immutable.",
    members: Object.fromEntries(
      [
        ["len", "String.len(s) -> Int", "Length in characters."],
        ["upper", "String.upper(s) -> String", "Upper case."],
        ["lower", "String.lower(s) -> String", "Lower case."],
        ["trim", "String.trim(s) -> String", "Strip surrounding whitespace."],
        ["trimStart", "String.trimStart(s) -> String", "Strip leading whitespace."],
        ["trimEnd", "String.trimEnd(s) -> String", "Strip trailing whitespace."],
        ["contains", "String.contains(s, part) -> Bool", "Substring predicate."],
        ["startsWith", "String.startsWith(s, part) -> Bool", "Prefix predicate."],
        ["endsWith", "String.endsWith(s, part) -> Bool", "Suffix predicate."],
        ["indexOf", "String.indexOf(s, part) -> Int", "First index or -1."],
        ["split", "String.split(s, sep) -> List", "Split on a separator."],
        ["join", "String.join(parts, sep) -> String", "Join with a separator."],
        ["chars", "String.chars(s) -> List", "Characters as a list."],
        ["reverse", "String.reverse(s) -> String", "Reversed string."],
        ["repeat", "String.repeat(s, n) -> String", "Repeat n times."],
        ["replace", "String.replace(s, from, to) -> String", "Replace all occurrences."],
        ["slice", "String.slice(s, start, end?) -> String", "Substring."],
        ["padStart", "String.padStart(s, width, pad) -> String", "Left pad."],
        ["padEnd", "String.padEnd(s, width, pad) -> String", "Right pad."],
        ["lines", "String.lines(s) -> List", "Split into lines."],
        ["words", "String.words(s) -> List", "Split into words."],
        ["isEmpty", "String.isEmpty(s) -> Bool", "Emptiness predicate."],
        ["capitalize", "String.capitalize(s) -> String", "Capitalise the first character."],
        ["toInt", "String.toInt(s) -> Int", "Parse an integer."],
        ["toFloat", "String.toFloat(s) -> Float", "Parse a float."],
        ["format", "String.format(template, values) -> String", "Substitute placeholders."],
      ].map(([name, signature, description]) => [name, member(signature, description)]),
    ),
  },

  Array: {
    summary: "list operations",
    description: "Pure, non-mutating list operations. Every function returns a new list.",
    members: Object.fromEntries(
      [
        ["len", "Array.len(xs) -> Int", "Length."],
        ["isEmpty", "Array.isEmpty(xs) -> Bool", "Emptiness predicate."],
        ["first", "Array.first(xs) -> Value", "First element."],
        ["last", "Array.last(xs) -> Value", "Last element."],
        ["map", "Array.map(xs, f) -> List", "Transform each element."],
        ["filter", "Array.filter(xs, f) -> List", "Keep matching elements."],
        ["reduce", "Array.reduce(xs, f, initial) -> Value", "Fold to a single value."],
        ["forEach", "Array.forEach(xs, f) -> Unit", "Visit each element."],
        ["find", "Array.find(xs, f) -> Value", "First match."],
        ["any", "Array.any(xs, f) -> Bool", "Existential predicate."],
        ["all", "Array.all(xs, f) -> Bool", "Universal predicate."],
        ["count", "Array.count(xs, f) -> Int", "Count matches."],
        ["contains", "Array.contains(xs, value) -> Bool", "Membership."],
        ["indexOf", "Array.indexOf(xs, value) -> Int", "First index or -1."],
        ["push", "Array.push(xs, value) -> List", "Append, returning a new list."],
        ["pop", "Array.pop(xs) -> Record", "Last element and the rest."],
        ["concat", "Array.concat(a, b) -> List", "Concatenate."],
        ["reverse", "Array.reverse(xs) -> List", "Reversed copy."],
        ["slice", "Array.slice(xs, start, end?) -> List", "Sublist."],
        ["take", "Array.take(xs, n) -> List", "First n elements."],
        ["drop", "Array.drop(xs, n) -> List", "All but the first n."],
        ["sum", "Array.sum(xs) -> Float", "Numeric sum."],
        ["min", "Array.min(xs) -> Value", "Minimum."],
        ["max", "Array.max(xs) -> Value", "Maximum."],
        ["sort", "Array.sort(xs) -> List", "Sorted copy."],
        ["sortBy", "Array.sortBy(xs, f) -> List", "Sort by a key function."],
        ["unique", "Array.unique(xs) -> List", "Remove duplicates."],
        ["flatten", "Array.flatten(xs) -> List", "One level of flattening."],
        ["chunk", "Array.chunk(xs, size) -> List", "Fixed-size chunks."],
        ["zip", "Array.zip(a, b) -> List", "Pairwise combination."],
        ["groupBy", "Array.groupBy(xs, f) -> Record", "Group by a key function."],
        ["repeat", "Array.repeat(value, n) -> List", "n copies of a value."],
        ["range", "Array.range(from, to, step?) -> List", "Numeric range."],
      ].map(([name, signature, description]) => [name, member(signature, description)]),
    ),
  },

  Json: {
    summary: "JSON encoding",
    description: "Serialise and parse JSON. Encoding is deterministic, which matters for hashing.",
    members: {
      encode: member("Json.encode(value) -> String", "Serialise a value."),
      decode: member("Json.decode(text) -> Value", "Parse a JSON document."),
      isValid: member("Json.isValid(text) -> Bool", "Validity predicate."),
      pretty: member("Json.pretty(value) -> String", "Indented serialisation."),
    },
  },

  Crypto: {
    summary: "hashing and randomness",
    description:
      "The primitives fairness is built on. `hmacSha256` is the construction that derives every provably fair round.",
    members: {
      sha256: member("Crypto.sha256(text) -> String", "SHA-256 as lowercase hex."),
      hmacSha256: member("Crypto.hmacSha256(key, message) -> String", "HMAC-SHA256 as hex."),
      randomHex: member("Crypto.randomHex(bytes) -> String", "Secure random hex string."),
      randomSeed: member("Crypto.randomSeed() -> String", "A fresh server seed."),
      uuid: member("Crypto.uuid() -> String", "Random UUID."),
      toHex: member("Crypto.toHex(bytes) -> String", "Hex encoding."),
      base64Encode: member("Crypto.base64Encode(text) -> String", "Base64 encode."),
      base64Decode: member("Crypto.base64Decode(text) -> String", "Base64 decode."),
      constantTimeEquals: member(
        "Crypto.constantTimeEquals(a, b) -> Bool",
        "Timing-safe comparison for secrets.",
      ),
      hashChain: member("Crypto.hashChain(seed, length) -> List", "Iterated hash chain."),
    },
  },

  Timer: {
    summary: "clocks and scheduling",
    description: "Wall clock, monotonic clock, and scheduling. All of it carries the `io` effect.",
    members: {
      now: member("Timer.now() -> Int", "Milliseconds since the epoch."),
      monotonic: member("Timer.monotonic() -> Float", "Monotonic clock reading."),
      iso: member("Timer.iso() -> String", "Current time as ISO-8601."),
      sleep: member("Timer.sleep(ms) -> Unit", "Block for a duration."),
      measure: member("Timer.measure(f) -> Record", "Time a function call."),
      every: member("Timer.every(ms, f) -> Unit", "Repeat on an interval."),
      after: member("Timer.after(ms, f) -> Unit", "Run once after a delay."),
    },
  },

  Http: {
    summary: "HTTP requests",
    description: "Requests carry the `net` effect, so a paytable can never quietly call out.",
    members: {
      get: member("Http.get(url) -> Record", "GET request."),
      post: member("Http.post(url, body) -> Record", "POST request."),
      put: member("Http.put(url, body) -> Record", "PUT request."),
      patch: member("Http.patch(url, body) -> Record", "PATCH request."),
      delete: member("Http.delete(url) -> Record", "DELETE request."),
      request: member("Http.request(options) -> Record", "Full request control."),
      async: member("Http.async(options) -> Record", "Fire-and-forget request."),
      encodeQuery: member("Http.encodeQuery(record) -> String", "Encode a query string."),
    },
  },

  File: {
    summary: "file system access",
    description: "File access carries the `io` effect.",
    members: {
      read: member("File.read(path) -> String", "Read a whole file."),
      write: member("File.write(path, text) -> Unit", "Write a file."),
      append: member("File.append(path, text) -> Unit", "Append to a file."),
      exists: member("File.exists(path) -> Bool", "Existence predicate."),
      remove: member("File.remove(path) -> Unit", "Delete a file."),
      lines: member("File.lines(path) -> List", "Read a file as lines."),
      readJson: member("File.readJson(path) -> Value", "Read and parse JSON."),
      writeJson: member("File.writeJson(path, value) -> Unit", "Serialise and write JSON."),
      list: member("File.list(path) -> List", "Directory listing."),
      makeDir: member("File.makeDir(path) -> Unit", "Create a directory."),
      size: member("File.size(path) -> Int", "File size in bytes."),
    },
  },
  Random: {
    summary: "advanced deterministic distributions",
    description: "Distribution helpers consume Sunra's active RNG, so simulations remain reproducible and live games remain auditable.",
    members: {
      uniform: member("Random.uniform(lo, hi) -> Float", "Uniform real value in the interval."),
      int: member("Random.int(lo, hi) -> Int", "Inclusive integer draw."),
      bernoulli: member("Random.bernoulli(p) -> Bool", "Bernoulli trial."),
      normal: member("Random.normal(mean, sd) -> Float", "Normal/Gaussian draw."),
      exponential: member("Random.exponential(lambda) -> Float", "Exponential draw."),
      gamma: member("Random.gamma(shape, scale) -> Float", "Gamma draw."),
      beta: member("Random.beta(alpha, beta) -> Float", "Beta draw in [0, 1]."),
      lognormal: member("Random.lognormal(mean, sd) -> Float", "Log-normal draw."),
      poisson: member("Random.poisson(lambda) -> Int", "Poisson count."),
      binomial: member("Random.binomial(trials, p) -> Int", "Binomial count."),
      triangular: member("Random.triangular(lo, mode, hi) -> Float", "Triangular draw."),
      weightedIndex: member("Random.weightedIndex(weights) -> Int", "Pick an index by non-negative weights."),
      choice: member("Random.choice(values) -> Value", "Choose one value."),
      shuffle: member("Random.shuffle(values) -> List", "Return a shuffled copy."),
      sample: member("Random.sample(values, count) -> List", "Sample without replacement."),
      seed: member("Random.seed(seed) -> Unit", "Install a deterministic simulation source."),
      draws: member("Random.draws() -> Int", "Number of consumed draws."),
    },
  },
  Net: {
    summary: "TCP and WebSocket handles",
    description: "Event-driven network handles with polling queues. Network operations carry `net`.",
    members: {
      tcpConnect: member("Net.tcpConnect(host, port) -> TcpSocket", "Open a TCP connection."),
      tcpSend: member("Net.tcpSend(socket, payload) -> Int", "Send UTF-8 text."),
      tcpReceive: member("Net.tcpReceive(socket, limit?) -> String", "Read queued TCP data."),
      tcpListen: member("Net.tcpListen(host, port) -> TcpListener", "Start a TCP listener."),
      tcpAccept: member("Net.tcpAccept(listener) -> TcpSocket", "Poll for a pending client."),
      websocketConnect: member("Net.websocketConnect(url) -> WebSocket", "Connect to a WebSocket URL."),
      websocketSend: member("Net.websocketSend(socket, payload) -> Int", "Send a WebSocket message."),
      websocketReceive: member("Net.websocketReceive(socket) -> String", "Poll one WebSocket message."),
      connected: member("Net.connected(handle) -> Bool", "Connection state."),
      error: member("Net.error(handle) -> String", "Latest transport error."),
      close: member("Net.close(handle) -> Unit", "Close a socket or listener."),
    },
  },
  Db: {
    summary: "durable key-value storage",
    description: "Synchronous key-value storage with an in-memory mode and a JSON-backed Node mode. Database operations carry `db`.",
    members: {
      open: member("Db.open(path) -> KeyValueStore", "Open `:memory:` or a durable JSON store."),
      get: member("Db.get(store, key) -> Value", "Read a value; missing keys return Unit."),
      set: member("Db.set(store, key, value) -> Unit", "Write a value."),
      has: member("Db.has(store, key) -> Bool", "Test key existence."),
      delete: member("Db.delete(store, key) -> Bool", "Delete a key."),
      keys: member("Db.keys(store) -> List", "Sorted keys."),
      count: member("Db.count(store) -> Int", "Number of keys."),
      flush: member("Db.flush(store) -> Unit", "Persist pending writes."),
      close: member("Db.close(store) -> Unit", "Flush and close."),
    },
  },
  Graphics: {
    summary: "Canvas and WebGL command buffers",
    description: "Portable deterministic drawing commands. Serialize to SVG/JSON or hand the WebGL command stream to a browser host.",
    members: {
      canvas: member("Graphics.canvas(width, height) -> Canvas", "Create a drawing surface."),
      clear: member("Graphics.clear(canvas, color) -> Unit", "Clear the canvas."),
      fillRect: member("Graphics.fillRect(canvas, x, y, w, h, color) -> Unit", "Draw a filled rectangle."),
      strokeRect: member("Graphics.strokeRect(canvas, x, y, w, h, color) -> Unit", "Draw a rectangle outline."),
      line: member("Graphics.line(canvas, x1, y1, x2, y2, color) -> Unit", "Draw a line."),
      circle: member("Graphics.circle(canvas, cx, cy, radius, color, fill) -> Unit", "Draw a circle."),
      text: member("Graphics.text(canvas, text, x, y, color) -> Unit", "Draw text."),
      toJson: member("Graphics.toJson(canvas) -> String", "Serialize the command buffer."),
      toSvg: member("Graphics.toSvg(canvas) -> String", "Render the buffer as SVG."),
      commands: member("Graphics.commands(canvas) -> List", "Inspect drawing commands."),
      width: member("Graphics.width(canvas) -> Int", "Canvas width."),
      height: member("Graphics.height(canvas) -> Int", "Canvas height."),
      webgl: member("Graphics.webgl(canvas) -> WebGLContext", "Create a WebGL command context."),
      webglClear: member("Graphics.webglClear(gl, r, g, b, a) -> Unit", "Queue a WebGL clear."),
      webglViewport: member("Graphics.webglViewport(gl, x, y, width, height) -> Unit", "Queue a viewport."),
      webglDraw: member("Graphics.webglDraw(gl, mode, count) -> Unit", "Queue a draw call."),
      webglCommands: member("Graphics.webglCommands(gl) -> String", "Serialize WebGL commands."),
    },
  },
  Audio: {
    summary: "portable tones and WAV synthesis",
    description: "Build tone buffers, compose sequences, export base64 WAV, or let a browser host play the buffer. Playback carries `io`.",
    members: {
      tone: member("Audio.tone(frequency, duration, volume) -> AudioBuffer", "Create a sine tone."),
      note: member("Audio.note(name, duration, volume) -> AudioBuffer", "Create a musical note such as A4."),
      sequence: member("Audio.sequence(buffers) -> AudioBuffer", "Play buffers one after another."),
      mix: member("Audio.mix(buffers) -> AudioBuffer", "Mix buffers at the same start time."),
      toJson: member("Audio.toJson(buffer) -> String", "Serialize tone descriptions."),
      wavBase64: member("Audio.wavBase64(buffer, sampleRate?) -> String", "Export a mono PCM WAV as base64."),
      play: member("Audio.play(buffer) -> Unit", "Ask the host to play a buffer."),
    },
  },
};

export const BUILTIN_DOCS: Record<string, MemberDoc> = {
  print: member("print(value...) -> Unit", "Write a line to standard output. Carries `io`."),
  println: member("println(value...) -> Unit", "Write a line to standard output. Carries `io`."),
  len: member("len(value) -> Int", "Length of a string or list."),
  str: member("str(value) -> String", "Convert to a string."),
  int: member("int(value) -> Int", "Convert to an integer."),
  float: member("float(value) -> Float", "Convert to a float."),
  abs: member("abs(x) -> Float", "Absolute value."),
  floor: member("floor(x) -> Int", "Round toward negative infinity."),
  ceil: member("ceil(x) -> Int", "Round toward positive infinity."),
  round: member("round(x) -> Int", "Round to nearest."),
  sqrt: member("sqrt(x) -> Float", "Square root."),
  min: member("min(a, b) -> Float", "Smaller of two values."),
  max: member("max(a, b) -> Float", "Larger of two values."),
  sum: member("sum(values) -> Float", "Sum of a numeric list."),
  range: member("range(from, to) -> List", "Integer range."),
  push: member("push(list, value) -> Unit", "Append to a list."),
  sort: member("sort(values) -> List", "Sorted copy."),
  assert: member("assert(condition, message?) -> Unit", "Fail loudly when a condition is false."),
  audit: member("audit(label, value) -> Unit", "Record an auditable event. Carries `audit`."),

};

export const KEYWORD_DOCS: Record<string, string> = {
  fn: "Declares a function. Effects are part of the signature: `fn spin() -> Float uses rand`.",
  let: "Binds an immutable value. Use `var` when a binding must change.",
  var: "Binds a mutable value. Reassigning a `let` is error E0640.",
  game: "Declares a game: fields such as `rtp`, reel strips, and methods. A declared RTP is an obligation the toolchain measures.",
  reel: "Declares a reel strip inside a `game` block, optionally with weights.",
  uses: "Declares the effects a function performs. A caller must declare everything its callees use.",
  test: "Declares a test block. `sunra test` runs every block in the file.",
  type: "Declares a named record or variant type.",
  match: "Pattern matches on a value. `_` is the wildcard arm.",
  if: "Conditional. Usable as a statement or an expression.",
  else: "The alternative branch of an `if`.",
  while: "Loops while a condition holds.",
  for: "Iterates over a list or range.",
  return: "Returns from a function. A trailing expression also returns its value.",
  break: "Exits the innermost loop.",
  continue: "Skips to the next iteration of the innermost loop.",
  import: "Imports a module.",
  module: "Declares the module path of the current file.",
  pub: "Marks a declaration as visible outside its module.",
  true: "The boolean true.",
  false: "The boolean false.",
  and: "Short-circuiting conjunction.",
  or: "Short-circuiting disjunction.",
  not: "Boolean negation.",
  assert: "Fails loudly when a condition is false; the idiom inside `test` blocks.",
  intent: "Documents what a function is for, in natural language, for both readers and AI tooling.",
};

export const EFFECT_DOCS: Record<string, string> = {
  rand: "Reads the random source. A payout function without this effect provably cannot consult randomness, which is what makes a paytable auditable.",
  io: "Prints, reads input, or touches the file system.",
  net: "Performs network requests.",
  db: "Reads or writes a database.",
  money: "Moves real balances. Separating this from `io` lets a review focus on the code that can actually pay a player.",
  ai: "Calls a model.",
  chain: "Writes to a blockchain or an append-only ledger.",
  audit: "Emits audit records.",
  unsafe: "Escapes the effect system deliberately. Every use is a place a reviewer should look.",
};
