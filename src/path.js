// Minimal SVG-path helpers for editing LCEDA records.
//
// LCEDA stores component graphics as absolute sheet coordinates, so moving or
// rotating a symbol means rewriting every coordinate — including the numbers
// inside `PT`/`A`/pin path strings. Paths in practice use M/L/H/V (lines) and
// occasionally A (arcs); this module handles M L H V C S Q T A Z, absolute and
// relative, and emits absolute commands after a transform.

const PARAM_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

export function fmt(n) {
  const v = Math.round(n * 1e4) / 1e4;
  return String(v);
}

export function parsePath(d) {
  const toks = [];
  const re = /([a-zA-Z])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(String(d)))) {
    if (m[1]) toks.push({ cmd: m[1] });
    else toks.push({ n: Number(m[2]) });
  }
  const cmds = [];
  for (const t of toks) {
    if (t.cmd) { cmds.push({ cmd: t.cmd, params: [] }); continue; }
    if (!cmds.length) continue;
    const last = cmds[cmds.length - 1];
    const need = PARAM_COUNT[last.cmd.toUpperCase()] ?? 0;
    if (need && last.params.length >= need) cmds.push({ cmd: last.cmd, params: [] });
    cmds[cmds.length - 1].params.push(t.n);
  }
  return cmds;
}

export function serializePath(cmds) {
  return cmds.map((c) => `${c.cmd}${c.params.length ? ' ' + c.params.map(fmt).join(' ') : ''}`).join(' ');
}

// Translate a path by (dx, dy). Absolute commands move; relative ones do not.
export function translatePath(d, dx, dy) {
  const cmds = parsePath(d);
  for (const c of cmds) {
    const up = c.cmd.toUpperCase();
    if (c.cmd !== up) continue; // relative: unchanged by a translation
    const p = c.params;
    if (up === 'M' || up === 'L' || up === 'T') { p[0] += dx; p[1] += dy; }
    else if (up === 'H') p[0] += dx;
    else if (up === 'V') p[0] += dy;
    else if (up === 'C') for (let k = 0; k + 5 < p.length; k += 2) { p[k] += dx; p[k + 1] += dy; }
    else if (up === 'S' || up === 'Q') for (let k = 0; k + 3 < p.length; k += 2) { p[k] += dx; p[k + 1] += dy; }
    else if (up === 'A') { p[5] += dx; p[6] += dy; }
  }
  return serializePath(cmds);
}

// Convert every command to absolute coordinates (h/v/l/... become explicit).
export function toAbsolute(cmds) {
  const out = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (const c of cmds) {
    const up = c.cmd.toUpperCase();
    const rel = c.cmd !== up;
    const p = c.params.slice();
    if (up === 'Z') { out.push({ cmd: 'Z', params: [] }); cx = sx; cy = sy; continue; }
    if (rel) {
      switch (up) {
        case 'M': p[0] += cx; p[1] += cy; break;
        case 'L': p[0] += cx; p[1] += cy; break;
        case 'H': { const x = cx + p[0]; p[0] = x; p[1] = cy; break; }
        case 'V': { const y = cy + p[0]; p[0] = cx; p[1] = y; break; }
        case 'C': for (let k = 0; k + 1 < p.length; k += 2) { p[k] += cx; p[k + 1] += cy; } break;
        case 'S': case 'Q': case 'T': for (let k = 0; k + 1 < p.length; k += 2) { p[k] += cx; p[k + 1] += cy; } break;
        case 'A': p[5] += cx; p[6] += cy; break;
        default: break;
      }
    }
    const cmd = up === 'H' || up === 'V' ? 'L' : up;
    out.push({ cmd, params: p });
    if (up === 'A') { cx = p[5]; cy = p[6]; }
    else if (up === 'C') { cx = p[4]; cy = p[5]; }
    else if (up === 'S' || up === 'Q') { cx = p[2]; cy = p[3]; }
    else if (up === 'M') { cx = p[0]; cy = p[1]; sx = cx; sy = cy; }
    else { cx = p[0]; cy = p[1]; }
  }
  return out;
}

// Rotate a path by `angle` degrees around (ox, oy). In LCEDA's y-down sheet space
// a positive angle turns clockwise on screen.
export function rotatePath(d, ox, oy, angle) {
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const rp = (x, y) => [ox + (x - ox) * cos - (y - oy) * sin, oy + (x - ox) * sin + (y - oy) * cos];
  const quarterTurn = Math.round(angle / 90) % 2 !== 0;
  const cmds = toAbsolute(parsePath(d));
  for (const c of cmds) {
    const p = c.params;
    switch (c.cmd) {
      case 'M': case 'L': case 'T': { const [x, y] = rp(p[0], p[1]); p[0] = x; p[1] = y; break; }
      case 'C': for (let k = 0; k + 5 < p.length; k += 2) { const [x, y] = rp(p[k], p[k + 1]); p[k] = x; p[k + 1] = y; } break;
      case 'S': case 'Q': for (let k = 0; k + 3 < p.length; k += 2) { const [x, y] = rp(p[k], p[k + 1]); p[k] = x; p[k + 1] = y; } break;
      case 'A': {
        const [x, y] = rp(p[5], p[6]);
        p[5] = x; p[6] = y;
        if (quarterTurn) { const rx = p[0]; p[0] = p[1]; p[1] = rx; }
        p[2] = ((p[2] + angle) % 180 + 180) % 180;
        break;
      }
      default: break;
    }
  }
  return serializePath(cmds);
}

/** Rotate a flat "x y x y ..." point list. */
export function rotatePoints(str, ox, oy, angle) {
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const nums = String(str).trim().split(/\s+/).map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const dx = nums[i] - ox, dy = nums[i + 1] - oy;
    out.push(ox + dx * cos - dy * sin, oy + dx * sin + dy * cos);
  }
  return out.map(fmt).join(' ');
}

/** Translate a flat "x y x y ..." point list. */
export function translatePoints(str, dx, dy) {
  const nums = String(str).trim().split(/\s+/).map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push(nums[i] + dx, nums[i + 1] + dy);
  return out.map(fmt).join(' ');
}
