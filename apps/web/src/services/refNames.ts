/**
 * refNames — humanizes the raw ids inside event conditions/effects: map-object refs →
 * object names, players → player names, vars → variable names, spells/items → catalog
 * names, templates → template names, events → event names. One composable shared by the
 * event graph, the variables usage view, and any summary line. The raw id stays available
 * (shown as a tooltip / secondary text) — we present a friendly layer, we don't hide data.
 */
import type { EventFieldSpec, EventTypeSpec, MapEvent } from "@d2/map-schema";
import { useEditStore } from "../stores/editStore";
import { useItemStore } from "../stores/itemStore";
import { useSpellStore } from "../stores/spellStore";
import { useUnitStore } from "../stores/unitStore";
import { useDecorStore } from "../stores/decorStore";

/** Entity category of a resolved ref (drives graph icon + click behavior). */
export type RefKind = "object" | "player" | "event" | "var" | "spell" | "item" | "template";

export interface ResolvedRef {
  fieldKey: string;
  fieldLabel: string;
  kind: RefKind;
  /** Raw stored value (compound id string, or the variable's numeric id). */
  value: string | number;
  /** Humanized display name. */
  text: string;
  /** Map-object type for kind==="object" (location/stack/village/…). */
  objType?: string;
}

/** Icon per entity kind (satellite badges in the graph + chips elsewhere). */
export const REF_ICONS: Record<RefKind, string> = {
  object: "📍", player: "🚩", event: "⚑", var: "𝑥", spell: "✨", item: "🎒", template: "📋",
};
/** Finer object-type icons (fall back to REF_ICONS.object). */
export const OBJ_ICONS: Record<string, string> = {
  location: "⭕", stack: "⚔️", village: "🏰", capital: "👑", ruin: "🏚️",
  merchant: "🏪", mage: "🔮", trainer: "🎓", mercenary: "🛡️", landmark: "🌳",
};

export function useRefNames() {
  const edit = useEditStore();
  const items = useItemStore();
  const spells = useSpellStore();
  const units = useUnitStore();
  const decor = useDecorStore();
  // catalogs are tiny JSONs; kick their lazy load so names resolve on first paint
  void items.load();
  void spells.load();
  void units.load();
  void decor.load();

  function objOf(id: string) {
    return edit.liveDoc?.objects.find((o) => o.id === id);
  }
  /** A STACK's human label = its leader's unit name (stacks rarely carry names). */
  function stackLabel(o: {
    garrison?: ({ unit: string } | null)[];
    leaderCell?: number;
    pos: { x: number; y: number };
  }): string {
    const leader =
      (o.leaderCell !== undefined ? o.garrison?.[o.leaderCell] : undefined) ??
      o.garrison?.find(Boolean);
    const lname = leader ? units.get(leader.unit)?.name : undefined;
    return lname ? `Отряд: ${lname}` : `Отряд (${o.pos.x},${o.pos.y})`;
  }
  function objName(id: string): string {
    const o = objOf(id);
    if (!o) {
      // stack fields legitimately hold TEMPLATE ids (SRCTMPL_ID matching) — resolve the
      // template's name instead of surfacing a raw S143TM#### id
      const t = edit.liveDoc?.templates?.find((x) => x.id === id);
      return t ? `Шаблон: ${t.name || id}` : id;
    }
    const named = (o as { name?: string }).name;
    if (named) return named;
    if (o.type === "stack") return stackLabel(o as Parameters<typeof stackLabel>[0]);
    if (o.type === "landmark") {
      // decorations are never named on maps — the catalog knows what they look like
      const bt = ((o as { baseType?: string }).baseType ?? "").toUpperCase();
      const d = bt ? decor.get(bt) : undefined;
      if (d?.name_ru) return d.name_ru;
    }
    return o.type;
  }
  function playerName(id: string): string {
    const p = edit.liveDoc?.players.find((x) => x.id === id);
    return p?.name || id;
  }
  function eventName(id: string): string {
    const e = edit.liveDoc?.events?.find((x) => x.id === id);
    return e?.name || id;
  }
  function varName(id: number): string {
    const v = edit.liveDoc?.variables?.find((x) => x.id === id);
    return v ? v.name || `var #${id}` : `var #${id}`;
  }
  function templateName(id: string): string {
    const t = edit.liveDoc?.templates?.find((x) => x.id === id);
    return t?.name || id;
  }

  /** Resolve ONE field's value to a humanized ref, or null when it's not an entity ref
   *  (ints/bools/texts) or it's empty. */
  function resolveField(f: EventFieldSpec, v: unknown): ResolvedRef | null {
    const base = { fieldKey: f.key, fieldLabel: f.label };
    if (f.type.startsWith("ref-")) {
      const id = (v as string) || "";
      if (!id) return null;
      if (f.type === "ref-player") return { ...base, kind: "player", value: id, text: playerName(id) };
      if (f.type === "ref-event") return { ...base, kind: "event", value: id, text: eventName(id) };
      const o = objOf(id);
      return { ...base, kind: "object", value: id, text: objName(id), objType: o?.type };
    }
    if (f.type === "var") {
      const id = Number(v ?? 0);
      return { ...base, kind: "var", value: id, text: varName(id) };
    }
    if (f.type === "spell") {
      const id = (v as string) || "";
      return id ? { ...base, kind: "spell", value: id, text: spells.nameOf(id) || id } : null;
    }
    if (f.type === "item") {
      const id = (v as string) || "";
      return id ? { ...base, kind: "item", value: id, text: items.nameOf(id) || id } : null;
    }
    if (f.type === "template") {
      const id = (v as string) || "";
      return id ? { ...base, kind: "template", value: id, text: templateName(id) } : null;
    }
    return null;
  }

  /** All entity refs of one condition/effect (its spec's fields, resolved + non-empty). */
  function refsOf(part: Record<string, unknown>, spec: EventTypeSpec | undefined): ResolvedRef[] {
    if (!spec) return [];
    const out: ResolvedRef[] = [];
    for (const f of spec.fields) {
      const r = resolveField(f, part[f.key]);
      if (r) out.push(r);
    }
    return out;
  }

  /** Events whose effects enable/disable `id` (the incoming half of the enable-chain). */
  function enablersOf(id: string): MapEvent[] {
    return (edit.liveDoc?.events ?? []).filter((e) =>
      e.effects.some((f) => f.kind === "enableEvent" && (f as { eventId?: string }).eventId === id));
  }

  const icon = (r: ResolvedRef): string =>
    r.kind === "object" ? OBJ_ICONS[r.objType ?? ""] ?? REF_ICONS.object : REF_ICONS[r.kind];

  return { objName, playerName, eventName, varName, templateName, stackLabel, resolveField, refsOf, enablersOf, icon };
}
