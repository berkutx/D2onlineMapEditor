/**
 * A few solid-silhouette SVG icons for the editor's domain-specific tools that
 * Element Plus' icon set lacks a good match for (water / forest / road / erase).
 * They're authored in the same 0 0 1024 1024 / fill=currentColor style as the EP
 * icons so the tool dock reads as one consistent family.
 */
import { defineComponent, h } from "vue";

function icon(name: string, paths: { d: string; rule?: "evenodd" }[]) {
  return defineComponent({
    name,
    render() {
      return h(
        "svg",
        { viewBox: "0 0 1024 1024", xmlns: "http://www.w3.org/2000/svg" },
        paths.map((p) =>
          h("path", { fill: "currentColor", "fill-rule": p.rule, d: p.d }),
        ),
      );
    },
  });
}

/** Water — a teardrop. */
export const WaterIcon = icon("WaterIcon", [
  { d: "M512 96C512 96 224 432 224 640a288 288 0 1 0 576 0C800 432 512 96 512 96Z" },
]);

/** Forest — a three-tier pine with a short trunk. */
export const ForestIcon = icon("ForestIcon", [
  {
    d: "M512 110 L648 330 L576 330 L720 540 L632 540 L792 760 L552 760 L552 900 L472 900 L472 760 L232 760 L392 540 L304 540 L448 330 L376 330 Z",
  },
]);

/** Road — a perspective ribbon with a dashed centre line (cut out, even-odd). */
export const RoadIcon = icon("RoadIcon", [
  {
    rule: "evenodd",
    d: "M430 128 L594 128 L720 896 L304 896 Z M496 200 h32 v90 h-32 Z M491 372 h42 v100 h-42 Z M485 556 h54 v110 h-54 Z M478 750 h68 v120 h-68 Z",
  },
]);

/** Erase — a slanted eraser block. */
export const EraseIcon = icon("EraseIcon", [
  { d: "M250 632 L566 316 L828 578 L512 894 Z M150 904 h360 v64 h-360 Z" },
]);

/** Locations — a target: outer ring (even-odd cutout) + centre dot. */
export const LocationsIcon = icon("LocationsIcon", [
  {
    rule: "evenodd",
    d: "M512 112a400 400 0 1 0 0.1 0Z M512 212a300 300 0 1 0 0.1 0Z",
  },
  { d: "M512 372a140 140 0 1 0 0.1 0Z" },
]);
