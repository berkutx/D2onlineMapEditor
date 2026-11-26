/**
 * A generator's sample plan (GenRecipePreview — the symbol grid the recipe really makes over
 * an empty zone) drawn as a small isometric picture: water, forest, peaks, walls, roads,
 * scattered decorations in plain colours. A schematic, on purpose: it shows the SHAPE a
 * generator gives — one lake or several, a ridge or a massif, a maze of fortress walls or of
 * a palisade — with no game art in it, so it is the same for every mod and costs nothing to load.
 */
import type { GenRecipePreview } from "@d2/socket-contract";

const GROUND = "#6b7a40";
const GROUND_EDGE = "#4d5a2c";

/** Cheap deterministic variation per cell, so trees and stones do not stand in ranks. */
const jitter = (x: number, y: number, k: number): number => {
  const v = Math.sin(x * 127.1 + y * 311.7 + k * 74.7) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Draw `plan` into `canvas`, sized to fit `width` CSS pixels (the height follows the plan's
 * 2:1 isometric shape). Returns the CSS height used.
 */
export function drawGenPlan(canvas: HTMLCanvasElement, plan: GenRecipePreview, width = 190): number {
  const W = plan.width * plan.scale; // the zone in map cells
  const H = plan.height * plan.scale;
  const hw = width / (W + H); // half a cell's width on screen
  const hh = hw / 2;
  const top = Math.max(10, hw * 3.2); // room above the back corner for peaks and walls
  const height = Math.ceil((W + H) * hh + top + 4);
  const dpr = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const g = canvas.getContext("2d");
  if (!g) return height;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);

  /** screen point of the map point (x, y) — a cell's back vertex for integer x, y */
  const sx = (x: number, y: number): number => (x - y + H) * hw;
  const sy = (x: number, y: number): number => (x + y) * hh + top;
  const diamond = (x: number, y: number, w: number, h: number, fill: string): void => {
    g.beginPath();
    g.moveTo(sx(x, y), sy(x, y));
    g.lineTo(sx(x + w, y), sy(x + w, y));
    g.lineTo(sx(x + w, y + h), sy(x + w, y + h));
    g.lineTo(sx(x, y + h), sy(x, y + h));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  /** a box standing on the cells [x..x+w) × [y..y+h), `up` pixels tall */
  const box = (x: number, y: number, w: number, h: number, up: number, topFill: string, leftFill: string, rightFill: string): void => {
    const ax = sx(x, y + h), ay = sy(x, y + h); // left corner
    const bx = sx(x + w, y + h), by = sy(x + w, y + h); // front corner
    const cx = sx(x + w, y), cy = sy(x + w, y); // right corner
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.lineTo(bx, by - up); g.lineTo(ax, ay - up); g.closePath();
    g.fillStyle = leftFill; g.fill();
    g.beginPath(); g.moveTo(bx, by); g.lineTo(cx, cy); g.lineTo(cx, cy - up); g.lineTo(bx, by - up); g.closePath();
    g.fillStyle = rightFill; g.fill();
    g.beginPath();
    g.moveTo(sx(x, y), sy(x, y) - up); g.lineTo(cx, cy - up); g.lineTo(bx, by - up); g.lineTo(ax, ay - up); g.closePath();
    g.fillStyle = topFill; g.fill();
  };
  const blob = (x: number, y: number, r: number, fill: string): void => {
    g.beginPath();
    g.ellipse(sx(x, y), sy(x, y), r, r * 0.6, 0, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
  };

  // the zone's ground, with a darker rim so the picture reads as a slab
  diamond(0, 0, W, H, GROUND);
  g.lineWidth = 1;
  g.strokeStyle = GROUND_EDGE;
  g.stroke();

  const s = plan.scale;
  const kindAt = (gx: number, gy: number): string | undefined => plan.legend[plan.rows[gy]?.[gx] ?? ""];

  // flat things first (they lie on the ground), standing things after, back to front
  for (let gy = 0; gy < plan.height; gy++) {
    for (let gx = 0; gx < plan.width; gx++) {
      const kind = kindAt(gx, gy);
      if (!kind) continue;
      const x = gx * s, y = gy * s;
      if (kind === "water") diamond(x, y, s, s, jitter(gx, gy, 1) > 0.5 ? "#2f7397" : "#2a6a8d");
      else if (kind === "road") diamond(x + 0.12, y + 0.12, s - 0.24, s - 0.24, "#c9b37d");
      else if (kind.startsWith("terrain:")) diamond(x, y, s, s, kind === "terrain:2" ? "#e8edf2" : "#86a14f");
      else if (kind === "forest") diamond(x, y, s, s, "#3c6630");
      else if (kind === "mountain") diamond(x, y, s, s, "#5e584f");
    }
  }
  for (let gy = 0; gy < plan.height; gy++) {
    for (let gx = 0; gx < plan.width; gx++) {
      const kind = kindAt(gx, gy);
      if (!kind) continue;
      const x = gx * s, y = gy * s;
      const j = jitter(gx, gy, 2);
      if (kind === "forest") {
        // a small fir: a triangle over the cell's centre
        const cx = sx(x + 0.5, y + 0.5), cy = sy(x + 0.5, y + 0.5);
        const hgt = hw * (1.5 + j * 0.9);
        g.beginPath(); g.moveTo(cx - hw * 0.62, cy); g.lineTo(cx + hw * 0.62, cy); g.lineTo(cx, cy - hgt); g.closePath();
        g.fillStyle = j > 0.5 ? "#2f5a27" : "#274d21";
        g.fill();
      } else if (kind === "mountain") {
        const cx = sx(x + 0.5, y + 0.5), cy = sy(x + 0.5, y + 0.5) + hh * 0.4;
        const hgt = hw * (2 + j * 1.5);
        g.beginPath(); g.moveTo(cx - hw, cy); g.lineTo(cx, cy - hgt); g.lineTo(cx, cy + hh * 0.5); g.closePath();
        g.fillStyle = "#8b857b"; g.fill(); // the lit slope
        g.beginPath(); g.moveTo(cx + hw, cy); g.lineTo(cx, cy - hgt); g.lineTo(cx, cy + hh * 0.5); g.closePath();
        g.fillStyle = "#4b463f"; g.fill(); // the shaded slope
        if (j > 0.55) { // a snow cap on the taller ones
          g.beginPath(); g.moveTo(cx - hw * 0.3, cy - hgt * 0.7); g.lineTo(cx, cy - hgt); g.lineTo(cx + hw * 0.3, cy - hgt * 0.7); g.closePath();
          g.fillStyle = "#eef2f5"; g.fill();
        }
      } else if (kind === "wall") {
        box(x, y, s, s, hw * (s > 1 ? 1.5 : 1.1), "#cdbf9f", "#9c8f73", "#7b7059");
      } else if (kind === "wall:fence") {
        box(x + 0.15, y + 0.15, s - 0.3, s - 0.3, hw * 0.9, "#7a5a36", "#5d4327", "#46321d");
      } else if (kind.startsWith("decor:")) {
        const shape = kind.slice(6);
        const px = x + 0.3 + j * 0.4, py = y + 0.3 + jitter(gx, gy, 3) * 0.4;
        if (shape === "rock") blob(px, py, hw * 0.75, "#9a958c");
        else if (shape === "vegetation") blob(px, py, hw * 0.85, "#b5dd7a");
        else if (shape === "grave") box(px - 0.2, py - 0.2, 0.4, 0.4, hw * 0.9, "#d8d5cc", "#aaa69c", "#8a867d");
        else box(px - 0.3, py - 0.3, 0.6, 0.6, hw * 0.8, "#b08a5c", "#8a6a44", "#6b5133"); // a ruin, a building
      }
    }
  }
  return height;
}
