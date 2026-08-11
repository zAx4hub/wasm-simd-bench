/** wasm-simd-bench — trace engine by zAx4hub */
import { createHash } from "crypto";

export type Finding = {
  id: string;
  kind: string;
  score: number;
  detail: string;
  tag: string;
};

export type Report = {
  project: string;
  author: string;
  family: string;
  summary: string;
  score: number;
  findings: Finding[];
  metrics: Record<string, number | string>;
};

const FAMILY = "trace" as const;
const SEED = 955447115;

function hash01(s: string, salt = 0): number {
  const h = createHash("sha256").update(String(SEED + salt)).update(s).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_.-]+/).filter(Boolean);
}

/** Graph: adjacency + PageRank-ish centrality */
function graphScore(items: string[]): { scores: number[]; edges: number } {
  const nodes = items.map(tokens);
  const n = nodes.length;
  const scores = new Array(n).fill(1 / Math.max(1, n));
  let edges = 0;
  const sim = (a: string[], b: string[]) => {
    const A = new Set(a), B = new Set(b);
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / Math.max(1, A.size + B.size - inter);
  };
  for (let iter = 0; iter < 8; iter++) {
    const next = new Array(n).fill(0.15 / Math.max(1, n));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const w = sim(nodes[i], nodes[j]);
        if (w > 0.05) {
          if (iter === 0) edges++;
          next[j] += 0.85 * scores[i] * w;
        }
      }
    }
    const sum = next.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < n; i++) scores[i] = next[i] / sum;
  }
  return { scores, edges };
}

/** Bloom filter membership */
class Bloom {
  bits: Uint8Array;
  k: number;
  constructor(m = 2048, k = 4) {
    this.bits = new Uint8Array(m);
    this.k = k;
  }
  private idx(s: string, i: number): number {
    return Math.floor(hash01(s, i) * this.bits.length);
  }
  add(s: string) {
    for (let i = 0; i < this.k; i++) this.bits[this.idx(s, i)] = 1;
  }
  mightHave(s: string): boolean {
    for (let i = 0; i < this.k; i++) if (!this.bits[this.idx(s, i)]) return false;
    return true;
  }
  fill(): number {
    return this.bits.reduce((a, b) => a + b, 0) / this.bits.length;
  }
}

/** Interval scheduler / bin packing */
function schedule(tasks: Array<{ id: string; cost: number; priority: number }>, capacity: number) {
  const sorted = [...tasks].sort((a, b) => b.priority - a.priority || a.cost - b.cost);
  const bins: number[] = [];
  const placement: Array<{ id: string; bin: number }> = [];
  for (const t of sorted) {
    let placed = false;
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] + t.cost <= capacity) {
        bins[i] += t.cost;
        placement.push({ id: t.id, bin: i });
        placed = true;
        break;
      }
    }
    if (!placed) {
      bins.push(t.cost);
      placement.push({ id: t.id, bin: bins.length - 1 });
    }
  }
  return { bins, placement, waste: bins.reduce((a, b) => a + (capacity - b), 0) };
}

/** Recursive descent-ish tokenizer score */
function parseScore(text: string): { depth: number; ops: number; ok: boolean } {
  let depth = 0, max = 0, ops = 0, ok = true;
  for (const ch of text) {
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      max = Math.max(max, depth);
      ops++;
    } else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      ops++;
      if (depth < 0) ok = false;
    }
  }
  if (depth !== 0) ok = false;
  return { depth: max, ops, ok };
}

/** Merkle-ish root */
function merkle(parts: string[]): string {
  if (!parts.length) return createHash("sha256").update("empty").digest("hex").slice(0, 16);
  let layer = parts.map((p) => createHash("sha256").update(p).digest("hex"));
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = layer[i + 1] ?? a;
      next.push(createHash("sha256").update(a + b).digest("hex"));
    }
    layer = next;
  }
  return layer[0].slice(0, 16);
}

/** Rolling stream heavy-hitters */
function heavyHitters(items: string[], k = 5) {
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const t of tokens(it)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
}

/** BM25-ish ranking */
function bm25(query: string, docs: string[]): number[] {
  const q = tokens(query);
  const N = docs.length || 1;
  const df = new Map<string, number>();
  const tfs = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of tokens(d)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });
  const avgdl = docs.reduce((a, d) => a + tokens(d).length, 0) / N;
  const k1 = 1.2, b = 0.75;
  return tfs.map((tf, i) => {
    const dl = tokens(docs[i]).length || 1;
    let score = 0;
    for (const term of q) {
      const f = tf.get(term) || 0;
      const n = df.get(term) || 0.5;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl)));
    }
    return Math.round(score * 1000) / 1000;
  });
}

/** Policy allow/deny evaluator */
function policyEval(rules: Array<{ action: string; res: string; effect: "allow" | "deny" }>, req: { action: string; res: string }) {
  let decision: "allow" | "deny" = "deny";
  let matched = 0;
  for (const r of rules) {
    const aOk = r.action === "*" || r.action === req.action;
    const rOk = r.res === "*" || req.res.startsWith(r.res);
    if (aOk && rOk) {
      matched++;
      decision = r.effect;
    }
  }
  return { decision, matched };
}

/** Tiny LWW CRDT map */
function crdtMerge(a: Record<string, { v: string; t: number }>, b: Record<string, { v: string; t: number }>) {
  const out = { ...a };
  for (const [k, val] of Object.entries(b)) {
    if (!out[k] || val.t >= out[k].t) out[k] = val;
  }
  return out;
}

/** Welch-ish t stat between two samples */
function tStat(x: number[], y: number[]): number {
  const mean = (a: number[]) => a.reduce((p, c) => p + c, 0) / Math.max(1, a.length);
  const v = (a: number[], m: number) => a.reduce((p, c) => p + (c - m) ** 2, 0) / Math.max(1, a.length - 1);
  const mx = mean(x), my = mean(y);
  const vx = v(x, mx), vy = v(y, my);
  const denom = Math.sqrt(vx / Math.max(1, x.length) + vy / Math.max(1, y.length)) || 1;
  return Math.round(((mx - my) / denom) * 1000) / 1000;
}

/** Cellular automata step */
function caStep(row: number[]): number[] {
  const n = row.length;
  const next = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const l = row[(i - 1 + n) % n];
    const c = row[i];
    const r = row[(i + 1) % n];
    const code = (l << 2) | (c << 1) | r;
    // rule 30-ish
    next[i] = [0, 1, 1, 1, 1, 0, 0, 0][code] ?? 0;
  }
  return next;
}

/** Dijkstra on small graph */
function dijkstra(edges: Array<[string, string, number]>, src: string, dst: string): { dist: number; path: string[] } {
  const adj = new Map<string, Array<[string, number]>>();
  for (const [a, b, w] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push([b, w]);
  }
  const dist = new Map<string, number>([[src, 0]]);
  const prev = new Map<string, string>();
  const q = [src];
  while (q.length) {
    q.sort((a, b) => (dist.get(a) ?? 1e9) - (dist.get(b) ?? 1e9));
    const u = q.shift()!;
    for (const [v, w] of adj.get(u) || []) {
      const nd = (dist.get(u) ?? 1e9) + w;
      if (nd < (dist.get(v) ?? 1e9)) {
        dist.set(v, nd);
        prev.set(v, u);
        q.push(v);
      }
    }
  }
  const path: string[] = [];
  let cur: string | undefined = dst;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return { dist: dist.get(dst) ?? -1, path: path[0] === src ? path : [] };
}

/** Double-entry ledger */
function ledgerBalance(entries: Array<{ account: string; debit: number; credit: number }>) {
  const bal = new Map<string, number>();
  let deb = 0, cred = 0;
  for (const e of entries) {
    bal.set(e.account, (bal.get(e.account) || 0) + e.debit - e.credit);
    deb += e.debit;
    cred += e.credit;
  }
  return { balanced: Math.abs(deb - cred) < 1e-9, accounts: Object.fromEntries(bal), deb, cred };
}

/** Trace span critical path */
function criticalPath(spans: Array<{ id: string; parent?: string; dur: number }>) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const children = new Map<string, string[]>();
  for (const s of spans) {
    if (s.parent) {
      if (!children.has(s.parent)) children.set(s.parent, []);
      children.get(s.parent)!.push(s.id);
    }
  }
  function dfs(id: string): { cost: number; path: string[] } {
    const kids = children.get(id) || [];
    if (!kids.length) return { cost: byId.get(id)!.dur, path: [id] };
    let best = { cost: -1, path: [] as string[] };
    for (const k of kids) {
      const r = dfs(k);
      if (r.cost > best.cost) best = r;
    }
    return { cost: byId.get(id)!.dur + best.cost, path: [id, ...best.path] };
  }
  const roots = spans.filter((s) => !s.parent).map((s) => s.id);
  let best = { cost: 0, path: [] as string[] };
  for (const r of roots) {
    const x = dfs(r);
    if (x.cost > best.cost) best = x;
  }
  return best;
}

/** JSON-ish schema drift */
function schemaDrift(a: unknown, b: unknown, path = "$"): string[] {
  const drifts: string[] = [];
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb) {
    drifts.push(`${path}: ${ta}→${tb}`);
    return drifts;
  }
  if (ta === "object" && a && b) {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    for (const k of ak) if (!bk.includes(k)) drifts.push(`${path}.${k}: removed`);
    for (const k of bk) if (!ak.includes(k)) drifts.push(`${path}.${k}: added`);
    for (const k of ak.filter((x) => bk.includes(x))) {
      drifts.push(...schemaDrift((a as any)[k], (b as any)[k], `${path}.${k}`));
    }
  }
  return drifts;
}

/** Sandbox policy risk score */
function sandboxRisk(syscalls: string[], allow: Set<string>): { risk: number; denied: string[] } {
  const denied = syscalls.filter((s) => !allow.has(s));
  const risk = Math.min(1, denied.length / Math.max(1, syscalls.length));
  return { risk: Math.round(risk * 1000) / 1000, denied };
}

export function run(input: Record<string, any> = {}): Report {
  const texts: string[] = (input.items || [{ text: "WASM SIMD microbench harness" }]).map((x: any) =>
    typeof x === "string" ? x : x.text || JSON.stringify(x),
  );
  const findings: Finding[] = [];
  const metrics: Record<string, number | string> = { family: FAMILY, id: 955 };

  if (FAMILY === "graph") {
    const g = graphScore(texts);
    g.scores.forEach((s, i) =>
      findings.push({ id: `n${i}`, kind: "centrality", score: Math.round(s * 1000) / 1000, detail: texts[i].slice(0, 80), tag: s > 1 / texts.length ? "hub" : "leaf" }),
    );
    metrics.edges = g.edges;
  } else if (FAMILY === "bloom") {
    const bloom = new Bloom();
    for (const t of texts) bloom.add(t);
    const probes = [...texts, "zAx4hub-canary-miss"];
    probes.forEach((t, i) => {
      const hit = bloom.mightHave(t);
      findings.push({ id: `p${i}`, kind: "membership", score: hit ? 1 : 0, detail: t.slice(0, 80), tag: hit ? "maybe" : "no" });
    });
    metrics.fill = Math.round(bloom.fill() * 1000) / 1000;
  } else if (FAMILY === "scheduler") {
    const tasks = texts.map((t, i) => ({ id: `t${i}`, cost: 1 + Math.floor(hash01(t) * 5), priority: hash01(t, 1) }));
    const sch = schedule(tasks, Number(input.capacity ?? 5));
    sch.placement.forEach((p) =>
      findings.push({ id: p.id, kind: "placement", score: 1 / (1 + p.bin), detail: `bin=${p.bin}`, tag: "scheduled" }),
    );
    metrics.bins = sch.bins.length;
    metrics.waste = sch.waste;
  } else if (FAMILY === "parser") {
    texts.forEach((t, i) => {
      const r = parseScore(t);
      findings.push({ id: `s${i}`, kind: "parse", score: r.ok ? 1 : 0.2, detail: `depth=${r.depth} ops=${r.ops}`, tag: r.ok ? "balanced" : "broken" });
    });
  } else if (FAMILY === "crypto") {
    const root = merkle(texts);
    findings.push({ id: "merkle", kind: "root", score: 1, detail: root, tag: "ok" });
    texts.forEach((t, i) =>
      findings.push({ id: `h${i}`, kind: "leaf", score: hash01(t), detail: createHash("sha256").update(t).digest("hex").slice(0, 12), tag: "hashed" }),
    );
    metrics.root = root;
  } else if (FAMILY === "stream") {
    heavyHitters(texts).forEach(([term, c], i) =>
      findings.push({ id: `hh${i}`, kind: "heavy-hitter", score: c, detail: term, tag: "hot" }),
    );
  } else if (FAMILY === "search") {
    const q = String(input.query ?? tokens(texts[0] || "zAx4hub").slice(0, 3).join(" "));
    bm25(q, texts).forEach((s, i) =>
      findings.push({ id: `d${i}`, kind: "bm25", score: s, detail: texts[i].slice(0, 80), tag: s > 0 ? "hit" : "miss" }),
    );
    metrics.query = q;
  } else if (FAMILY === "policy") {
    const rules = input.rules || [
      { action: "read", res: "doc/", effect: "allow" },
      { action: "*", res: "secret/", effect: "deny" },
      { action: "write", res: "doc/", effect: "allow" },
    ];
    const reqs = input.requests || [
      { action: "read", res: "doc/a" },
      { action: "read", res: "secret/x" },
      { action: "write", res: "doc/b" },
    ];
    reqs.forEach((req: any, i: number) => {
      const r = policyEval(rules, req);
      findings.push({ id: `r${i}`, kind: "policy", score: r.decision === "allow" ? 1 : 0, detail: `${req.action} ${req.res}`, tag: r.decision });
    });
  } else if (FAMILY === "crdt") {
    const a = Object.fromEntries(texts.map((t, i) => [`k${i}`, { v: t.slice(0, 24), t: i }]));
    const b = Object.fromEntries(texts.map((t, i) => [`k${i}`, { v: t.slice(0, 12) + "-b", t: i + (i % 2) }]));
    const m = crdtMerge(a, b);
    Object.entries(m).forEach(([k, val], i) =>
      findings.push({ id: k, kind: "lww", score: val.t, detail: val.v, tag: "merged" }),
    );
    metrics.keys = Object.keys(m).length;
  } else if (FAMILY === "stats") {
    const x = texts.map((t) => hash01(t));
    const y = texts.map((t) => hash01(t, 9));
    const ts = tStat(x, y);
    findings.push({ id: "t", kind: "t-stat", score: Math.abs(ts), detail: String(ts), tag: Math.abs(ts) > 1 ? "shift" : "stable" });
    metrics.t = ts;
  } else if (FAMILY === "automata") {
    let row = texts.join("").split("").slice(0, 32).map((c) => (c.charCodeAt(0) % 2));
    if (!row.length) row = [1, 0, 1, 0, 1, 0, 1, 0];
    for (let i = 0; i < 5; i++) row = caStep(row);
    const density = row.reduce((a, b) => a + b, 0) / row.length;
    findings.push({ id: "ca", kind: "rule30", score: Math.round(density * 1000) / 1000, detail: row.join(""), tag: "evolved" });
  } else if (FAMILY === "routing") {
    const nodes = ["a", "b", "c", "d", "e"];
    const edges: Array<[string, string, number]> = [];
    for (let i = 0; i < nodes.length - 1; i++) edges.push([nodes[i], nodes[i + 1], 1 + (i % 3)]);
    edges.push(["a", "c", 2], ["b", "e", 4], ["c", "e", 1]);
    const r = dijkstra(edges, "a", "e");
    findings.push({ id: "path", kind: "dijkstra", score: r.dist, detail: r.path.join("→"), tag: r.path.length ? "routed" : "unreachable" });
  } else if (FAMILY === "ledger") {
    const entries = texts.map((t, i) => ({
      account: i % 2 ? "cash" : "revenue",
      debit: i % 2 ? Math.round(hash01(t) * 100) : 0,
      credit: i % 2 ? 0 : Math.round(hash01(t) * 100),
    }));
    // balance pad
    const sumD = entries.reduce((a, e) => a + e.debit, 0);
    const sumC = entries.reduce((a, e) => a + e.credit, 0);
    if (sumD !== sumC) entries.push({ account: "equity", debit: sumC > sumD ? sumC - sumD : 0, credit: sumD > sumC ? sumD - sumC : 0 });
    const L = ledgerBalance(entries);
    findings.push({ id: "books", kind: "ledger", score: L.balanced ? 1 : 0, detail: `deb=${L.deb} cred=${L.cred}`, tag: L.balanced ? "balanced" : "broken" });
  } else if (FAMILY === "trace") {
    const spans = texts.map((t, i) => ({ id: `s${i}`, parent: i ? `s${Math.floor((i - 1) / 2)}` : undefined, dur: 1 + Math.floor(hash01(t) * 20) }));
    const cp = criticalPath(spans);
    findings.push({ id: "cp", kind: "critical-path", score: cp.cost, detail: cp.path.join("→"), tag: "hot" });
  } else if (FAMILY === "schema") {
    const a = input.before || { user: { id: 1, name: "a" }, meta: { v: 1 } };
    const b = input.after || { user: { id: "1", name: "a", email: "x" }, meta: { v: 2 } };
    const drifts = schemaDrift(a, b);
    drifts.forEach((d, i) => findings.push({ id: `d${i}`, kind: "drift", score: 1, detail: d, tag: "changed" }));
    if (!drifts.length) findings.push({ id: "ok", kind: "drift", score: 0, detail: "no drift", tag: "stable" });
    metrics.drifts = drifts.length;
  } else {
    const allow = new Set(["read", "stat", "open", ...(input.allow || [])]);
    const calls = input.syscalls || tokens(texts.join(" ")).concat(["read", "write", "exec", "connect"]);
    const r = sandboxRisk(calls, allow);
    r.denied.forEach((d, i) => findings.push({ id: `sys${i}`, kind: "syscall", score: 1, detail: d, tag: "denied" }));
    if (!r.denied.length) findings.push({ id: "ok", kind: "syscall", score: 0, detail: "clean", tag: "allow" });
    metrics.risk = r.risk;
  }

  const score =
    findings.reduce((a, f) => a + (typeof f.score === "number" ? Number(f.score) : 0), 0) /
    Math.max(1, findings.length);

  return {
    project: "wasm-simd-bench",
    author: "zAx4hub",
    family: FAMILY,
    summary: `${FAMILY} engine processed ${texts.length} inputs → ${findings.length} findings`,
    score: Math.round(score * 1000) / 1000,
    findings,
    metrics,
  };
}

export function demo(): Report {
  return run({
    items: [
      { text: "WASM SIMD microbench harness" },
      { text: "zAx4hub quality gate regression fixture" },
      { text: "deterministic trace path with nested (tokens) {ok}" },
      { text: "secret/token should trip policy and sandbox paths" },
    ],
    query: "zAx4hub engine",
    capacity: 6,
  });
}

export function inspect() {
  return {
    name: "wasm-simd-bench",
    author: "zAx4hub",
    oneLiner: "WASM SIMD microbench harness",
    family: FAMILY,
    tier: "standard",
    version: "0.1.0",
    commands: ["demo", "run", "inspect"],
  };
}
