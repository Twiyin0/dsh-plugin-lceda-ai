// Geometric netlist extraction for LCEDA standard schematics.
//
// Connectivity rules (matching the editor):
//  - A wire polyline is one conductor: any pin point, another wire's endpoint,
//    a junction, or a label anchor lying ON the wire connects to it.
//  - Two wire ENDPOINTS coinciding connect.
//  - A wire endpoint lying on another wire's interior connects (T-junction).
//  - Two wire interiors CROSSING connect only if a junction marker sits there.
//  - Net labels (N) / net flags (F) rename the net they touch.
import { num } from './format.js';

const EPS = 0.75;      // coincidence tolerance (grid is 5 units)
const key = (p) => `${Math.round(p[0] * 20) / 20},${Math.round(p[1] * 20) / 20}`;

function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

function pointSegDist2(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = px - a[0], wy = py - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-9) return dist2(px, py, a[0], a[1]);
  let t = (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist2(px, py, a[0] + t * vx, a[1] + t * vy);
}

class DSU {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

export function extractNetlist(doc) {
  const wires = doc.shapes.filter((s) => s.type === 'wire' && s.points.length >= 2);
  const junctions = doc.shapes.filter((s) => s.type === 'junction');
  const netlabels = doc.shapes.filter((s) => s.type === 'netlabel');
  const netflags = doc.shapes.filter((s) => s.type === 'netflag');
  const comps = doc.components.filter((c) => !c.isFrame);

  // every connection-relevant point
  const points = new Map(); // key -> {x,y,kind,refs:[]}
  const addPoint = (p, kind, ref) => {
    const k = key(p);
    if (!points.has(k)) points.set(k, { x: p[0], y: p[1], kinds: new Set(), refs: [] });
    const o = points.get(k);
    o.kinds.add(kind);
    if (ref) o.refs.push(ref);
    return k;
  };

  const pinList = []; // {ref, number, name, elec, x, y}
  for (const c of comps) {
    for (const pin of c.pins) {
      const entry = { ref: c.designator || c.id, compId: c.id, number: pin.number, name: pin.name, elec: pin.elecName, x: pin.x, y: pin.y, comp: c };
      pinList.push(entry);
      addPoint([pin.x, pin.y], 'pin', entry);
    }
  }
  for (const w of wires) {
    addPoint(w.points[0], 'wireEnd', { wire: w, end: 0 });
    addPoint(w.points[w.points.length - 1], 'wireEnd', { wire: w, end: -1 });
    for (const p of w.points) addPoint(p, 'wireVert', null);
  }
  for (const j of junctions) addPoint([j.x, j.y], 'junction', j);
  for (const l of netlabels) addPoint([l.x, l.y], 'label', l);
  for (const fl of netflags) addPoint(fl.anchor, 'flag', fl);

  // union-find: wire identity nodes + point nodes
  const dsu = new DSU();
  const wireNode = (w) => 'W:' + w.id;
  for (const w of wires) dsu.find(wireNode(w));

  const onWire = (p, w, ignoreEnds = false) => {
    const pts = w.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d2 = pointSegDist2(p[0], p[1], pts[i], pts[i + 1]);
      if (d2 <= EPS * EPS) {
        if (ignoreEnds) {
          // skip if exactly at a segment endpoint that is a wire end handled separately
        }
        return true;
      }
    }
    return false;
  };

  // 1) pins/junctions/labels lying on a wire -> union with wire
  for (const w of wires) {
    for (const [k, o] of points) {
      if (o.kinds.has('pin') || o.kinds.has('junction') || o.kinds.has('label') || o.kinds.has('flag')) {
        if (onWire([o.x, o.y], w)) dsu.union(k, wireNode(w));
      }
    }
  }
  // 2) wire endpoints touching other wires (endpoint coincidence or T-touch)
  for (const w of wires) {
    for (const endP of [w.points[0], w.points[w.points.length - 1]]) {
      const k = key(endP);
      for (const w2 of wires) {
        if (w2 === w) continue;
        if (onWire(endP, w2)) dsu.union(k, wireNode(w2));
      }
    }
  }
  // 3) junctions connect crossing wires (interior-interior)
  for (const j of junctions) {
    const k = key([j.x, j.y]);
    for (const w of wires) if (onWire([j.x, j.y], w)) dsu.union(k, wireNode(w));
  }
  // 4) direct pin-pin contact (coincident points, no wire)
  for (const [k, o] of points) {
    if (o.kinds.has('pin')) dsu.find(k);
  }

  // group members
  const groups = new Map(); // root -> {wires:[], pins:[], labels:[], flags:[]}
  const groupOf = (root) => {
    if (!groups.has(root)) groups.set(root, { wires: [], pins: [], labels: [], flags: [] });
    return groups.get(root);
  };
  for (const w of wires) groupOf(dsu.find(wireNode(w))).wires.push(w);
  for (const [k, o] of points) {
    if (o.kinds.has('pin')) groupOf(dsu.find(k)).pins.push(o.refs[0]);
  }
  for (const l of netlabels) groupOf(dsu.find(key([l.x, l.y]))).labels.push(l);
  for (const fl of netflags) groupOf(dsu.find(key(fl.anchor))).flags.push(fl);

  // ---- naming ----
  // Every group collects the names of the net labels / net flags attached to it.
  // A group with several DIFFERENT names is a labelling conflict (EasyEDA ERC
  // would complain too): we keep the first as the net name, list the rest as
  // aliases, and never let an alias drag an unrelated net into this group.
  const namesOf = new Map(); // root -> [names]
  const flagNamesOf = new Map(); // root -> [power/ground flag names]
  for (const [root, g] of groups) {
    const list = [];
    const flagList = [];
    for (const fl of g.flags) {
      const t = String(fl.text ?? '').trim();
      if (t && !flagList.includes(t)) flagList.push(t);
      if (t && !list.includes(t)) list.push(t);
    }
    for (const l of g.labels) {
      const t = String(l.text ?? '').trim();
      if (t && !list.includes(t)) list.push(t);
    }
    namesOf.set(root, list);
    flagNamesOf.set(root, flagList);
  }
  // global merge: groups sharing the same PRIMARY name are the same net (GND, VBUS, ...)
  const byName = new Map();
  for (const [root, list] of namesOf) {
    if (!list.length) continue;
    const n = list[0];
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(root);
  }
  const alias = new Map(); // root -> canonical root
  const canonical = (r) => {
    let c = r;
    while (alias.has(c)) c = alias.get(c);
    return c;
  };
  for (const [, roots] of byName) {
    for (let i = 1; i < roots.length; i++) {
      const a = canonical(roots[i]), b = canonical(roots[0]);
      if (a !== b) alias.set(a, b);
    }
  }
  const merged = new Map();
  for (const [root, g] of groups) {
    const c = canonical(root);
    if (!merged.has(c)) merged.set(c, { wires: [], pins: [], labels: [], flags: [], names: [], flagNames: [] });
    const mg = merged.get(c);
    mg.wires.push(...g.wires); mg.pins.push(...g.pins);
    mg.labels.push(...g.labels); mg.flags.push(...g.flags);
    for (const n of namesOf.get(root) ?? []) if (!mg.names.includes(n)) mg.names.push(n);
    for (const n of flagNamesOf.get(root) ?? []) if (!mg.flagNames.includes(n)) mg.flagNames.push(n);
  }

  // final nets
  const nets = [];
  let auto = 0;
  for (const [, g] of merged) {
    const seen = new Set();
    const pins = [];
    for (const p of g.pins) {
      const kk = `${p.ref}#${p.number}`;
      if (seen.has(kk)) continue;
      seen.add(kk);
      pins.push({ ref: p.ref, pin: p.number, pinName: p.name, elec: p.elec });
    }
    pins.sort((a, b) => (a.ref === b.ref ? String(a.pin).localeCompare(String(b.pin), undefined, { numeric: true }) : a.ref.localeCompare(b.ref, undefined, { numeric: true })));
    const name = g.names[0] || `N$${++auto}`;
    // A real labelling conflict means two *power/ground flags* (or a flag and a
    // differently named label) share one net. Several plain net labels on the
    // same wire are just aliases (a common, intentional practice).
    const others = g.names.slice(1);
    const conflict = g.flagNames.length > 1
      || (g.flagNames.length === 1 && others.some((n) => n !== g.flagNames[0]));
    nets.push({
      name,
      named: g.names.length > 0,
      aliases: others,
      conflict,
      pins,
      wireCount: g.wires.length,
    });
  }
  // merge duplicate auto-nets that got named after grouping? (handled by alias)
  nets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  // pin -> net index (handy for AI queries and the report)
  const pinNets = new Map();
  for (const n of nets) for (const p of n.pins) pinNets.set(`${p.ref}.${p.pin}`, n.name);

  // per-component pin map
  const components = comps.map((c) => ({
    ref: c.designator || `?${c.id.slice(0, 8)}`,
    id: c.id,
    name: c.name,
    value: c.value,
    package: c.package,
    mfrPart: c.mfrPart,
    lcsc: c.lcscPart,
    manufacturer: c.manufacturer,
    supplier: c.supplier,
    pinCount: c.pins.length,
    pins: c.pins
      .map((p) => ({ number: p.number, name: p.name, elec: p.elecName, x: p.x, y: p.y }))
      .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true })),
  })).sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));

  return {
    components,
    nets,
    pinNets,
    statistics: {
      components: components.length,
      pins: pinList.length,
      wires: wires.length,
      junctions: junctions.length,
      netLabels: netlabels.length,
      netFlags: netflags.length,
      nets: nets.length,
      namedNets: nets.filter((n) => n.named).length,
      conflicts: nets.filter((n) => n.conflict).length,
    },
  };
}
