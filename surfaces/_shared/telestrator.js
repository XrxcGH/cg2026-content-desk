/**
 * Telestrator stroke model + renderer. See docs/04-replay-and-telestrator.md.
 *
 * Shared deliberately: the draw pad and the render surface run the SAME
 * renderer, so what the analyst sees on the tablet is exactly what goes to
 * air. Two renderers would drift, and the drift would only show up live.
 *
 * Coordinates are normalised 0-1, so the tablet's aspect ratio doesn't have to
 * match the programme feed and a 60Hz stroke costs a few hundred bytes.
 */

export const TOOLS = ['pen', 'arrow', 'ellipse', 'spotlight', 'path', 'tag'];

export const INKS = {
  gold:  'var(--ink-default)',
  good:  'var(--ink-good)',
  note:  'var(--ink-note)',
  red:   'var(--ink-red)',
  blue:  'var(--ink-blue)',
};

const css = name => getComputedStyle(document.documentElement)
  .getPropertyValue(name).trim();

/** Resolve ink token -> concrete colour, once per frame rather than per stroke. */
function inkPalette() {
  return {
    gold: css('--cg-gold') || '#F0AF00',
    good: css('--cg-green-hi') || '#0D9B74',
    note: css('--cg-white') || '#FFFFFF',
    red:  css('--alliance-red') || '#ED1C24',
    blue: css('--alliance-blue') || '#0066B3',
  };
}

/**
 * Holds strokes and ages them out. Both surfaces keep their own copy; the
 * relay keeps them in sync.
 */
export class StrokeBook {
  strokes = [];
  #live = new Map();

  begin({ id, tool, ink, width }) {
    const s = {
      id, tool, ink,
      width: width ?? 7,
      pts: [],
      done: false,
      born: performance.now(),
      meta: null,
    };
    this.strokes.push(s);
    this.#live.set(id, s);
    return s;
  }

  append(id, pts) {
    const s = this.#live.get(id);
    if (!s) return;
    for (const p of pts) s.pts.push(p);
  }

  meta(id, meta) {
    const s = this.#live.get(id);
    if (s) s.meta = meta;
  }

  /**
   * A stroke's fade clock starts when it FINISHES, not when it starts —
   * otherwise a slow, careful circle begins fading before the analyst has
   * closed it.
   */
  end(id) {
    const s = this.#live.get(id);
    if (!s) return null;
    s.done = true;
    s.born = performance.now();
    this.#live.delete(id);
    return s;
  }

  undo() {
    // Undo the most recent FINISHED stroke; pulling one mid-draw out from
    // under the analyst's stylus is never what they meant.
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].done) { this.strokes.splice(i, 1); return; }
    }
  }

  clear() { this.strokes.length = 0; this.#live.clear(); }

  /**
   * Drop faded strokes. Anything still being drawn is immortal until finished,
   * so a half-drawn line can never be aged out from under the stylus.
   */
  prune(fadeMs) {
    const now = performance.now();
    this.strokes = this.strokes.filter(s => !s.done || now - s.born < fadeMs);
  }

  get empty() { return this.strokes.length === 0; }
  get drawing() { return this.#live.size > 0; }
}

/**
 * Render every stroke to a canvas.
 *
 * Spotlight is composited first as a single dim layer with holes punched out —
 * two spotlights should darken the frame once, not twice.
 */
export function render(ctx, book, opts = {}) {
  const { width: W, height: H } = ctx.canvas;
  const fadeMs = opts.fadeMs ?? 6000;
  const now = performance.now();
  const palette = inkPalette();

  ctx.clearRect(0, 0, W, H);

  const alive = book.strokes.filter(s => !s.done || now - s.born < fadeMs);
  const alpha = s => {
    if (!s.done) return 1;
    const age = now - s.born;
    return age > fadeMs - 800 ? Math.max(0, (fadeMs - age) / 800) : 1;
  };

  // ---- spotlights -----------------------------------------------------
  const spots = alive.filter(s => s.tool === 'spotlight' && s.pts.length > 2);
  if (spots.length) {
    const strongest = Math.max(...spots.map(alpha));
    ctx.save();
    ctx.globalAlpha = strongest;
    ctx.fillStyle = opts.dim ?? 'rgba(14,1,19,.66)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    for (const s of spots) {
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- everything else ------------------------------------------------
  for (const s of alive) {
    if (s.tool === 'spotlight' || !s.pts.length) continue;
    ctx.globalAlpha = alpha(s);

    if (s.tool === 'tag') { drawTag(ctx, s, W, H, palette); continue; }

    // Two passes: a black halo, then the ink. The field is red, blue and grey
    // carpet under mixed gym lighting — gold with a black outline is the only
    // ink that survives on all of it.
    const colour = palette[s.ink] ?? palette.gold;
    for (const pass of [{ c: '#000', w: s.width + 4 }, { c: colour, w: s.width }]) {
      ctx.strokeStyle = pass.c;
      ctx.fillStyle = pass.c;
      ctx.lineWidth = pass.w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash(s.tool === 'path' ? [26, 18] : []);
      ctx.lineDashOffset = s.tool === 'path' ? -(now / 22) % 44 : 0;
      drawShape(ctx, s, W, H);
    }
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

function drawShape(ctx, s, W, H) {
  const p = s.pts;
  const a = p[0];
  const b = p[p.length - 1];
  ctx.beginPath();

  switch (s.tool) {
    case 'pen':
    case 'path':
      p.forEach(([x, y], i) => i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H));
      ctx.stroke();
      break;

    case 'arrow': {
      const [x1, y1] = [a[0] * W, a[1] * H];
      const [x2, y2] = [b[0] * W, b[1] * H];
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(26, s.width * 5);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - 0.42), y2 - head * Math.sin(ang - 0.42));
      ctx.lineTo(x2 - head * Math.cos(ang + 0.42), y2 - head * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fill();
      break;
    }

    case 'ellipse': {
      const cx = (a[0] + b[0]) / 2 * W;
      const cy = (a[1] + b[1]) / 2 * H;
      const rx = Math.abs(b[0] - a[0]) / 2 * W;
      const ry = Math.abs(b[1] - a[1]) / 2 * H;
      if (rx > 1 && ry > 1) {
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
  }
}

/**
 * Team tag: a chamfered puck carrying the team number. The thing no
 * off-the-shelf telestrator can do, because no off-the-shelf telestrator
 * knows what an FRC team is.
 */
function drawTag(ctx, s, W, H, palette) {
  const [x, y] = s.pts[s.pts.length - 1];
  const label = String(s.meta?.team ?? '');
  if (!label) return;

  const px = x * W, py = y * H;
  const fontSize = Math.round(H * 0.042);
  ctx.font = `900 ${fontSize}px Chivo, Archivo, system-ui, sans-serif`;
  const w = ctx.measureText(label).width + fontSize * 1.1;
  const h = fontSize * 1.6;
  const ch = h * 0.3;

  ctx.beginPath();
  ctx.moveTo(px - w / 2 + ch, py - h / 2);
  ctx.lineTo(px + w / 2, py - h / 2);
  ctx.lineTo(px + w / 2, py + h / 2 - ch);
  ctx.lineTo(px + w / 2 - ch, py + h / 2);
  ctx.lineTo(px - w / 2, py + h / 2);
  ctx.lineTo(px - w / 2, py - h / 2 + ch);
  ctx.closePath();

  ctx.fillStyle = palette[s.ink] ?? palette.gold;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.stroke();

  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, px, py + fontSize * 0.06);
}
