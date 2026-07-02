/**
 * MidEvent block writer — the inverse of blocks/events.ts, driven by the same eventCodec
 * table so byte order/tags match. Emits a complete framed MidEvent (code 0x10, short "EV").
 * Ported 1:1 from toolsqt D2Event.h data(). Always writes the D2EESFISIG (elf-expansion)
 * fields — our target format.
 */

import { ByteWriter } from "./byteWriter.js";
import { encodeCp1251 } from "./cp1251.js";
import { emitBlock } from "./sgRebuild.js";
import type { MapEvent, EventCondition, EventEffect } from "@d2/map-schema";
import { CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";
import {
  COND_CODEC,
  EFF_CODEC,
  EMPTY_REF,
  POPUP_SHOW_TO_STR,
  type CodecField,
} from "../blocks/eventCodec.js";

function writeField(w: ByteWriter, fld: CodecField, src: Record<string, unknown>): void {
  const v = src[fld.key];
  switch (fld.io) {
    case "int": w.defaultInt(fld.tag, Number(v) || 0); break;
    case "bool": w.bool(fld.tag, v === true); break;
    case "ref": w.refField(fld.tag, (v as string) || EMPTY_REF); break;
    case "str": w.stringField(fld.tag, (v as string) ?? ""); break;
    case "existInt": w.defaultInt(fld.tag, v === true ? 0 : 1); break; // mustExist => MISC_INT 0
    case "popupShow": w.stringField(fld.tag, POPUP_SHOW_TO_STR[Number(v) || 0] ?? "TRI"); break;
  }
}

function writeCondition(w: ByteWriter, cond: EventCondition): void {
  const spec = CONDITION_BY_KIND[cond.kind];
  if (!spec) throw new Error(`eventFrame: unknown condition kind ${cond.kind}`);
  w.defaultInt("CATEGORY", spec.code);
  const src = cond as unknown as Record<string, unknown>;
  if (cond.kind === "customScript") {
    const code = String(src.code ?? "");
    const desc = String(src.desc ?? "");
    w.defaultInt("CODE_LEN", encodeCp1251(code).length);
    w.stringField("CODE", code);
    w.defaultInt("DESCR_LEN", encodeCp1251(desc).length);
    w.stringField("DESCR", desc);
  } else {
    for (const fld of COND_CODEC[cond.kind]!.fields) writeField(w, fld, src);
  }
}

function writeEffect(w: ByteWriter, eff: EventEffect, eventId: string): void {
  const spec = EFFECT_BY_KIND[eff.kind];
  if (!spec) throw new Error(`eventFrame: unknown effect kind ${eff.kind}`);
  w.defaultInt("CATEGORY", spec.code);
  const src = eff as unknown as Record<string, unknown>;
  w.defaultInt("NUM", Number(src.num) || 0);
  if (eff.kind === "changeFog") {
    const entries = (src.entries as { eventId: string; player: string }[]) ?? [];
    w.refField("ID_LOC", (src.locId as string) || EMPTY_REF);
    w.defaultInt(eventId, entries.length); // count tag == the event's own compound id
    for (const e of entries) {
      w.refField("EVENT_ID", e.eventId || EMPTY_REF);
      w.refField("PLAYER", e.player || EMPTY_REF);
    }
    w.bool("ENABLE", src.enable === true);
    w.defaultInt("NUMVALUE", Number(src.value) || 0);
  } else {
    for (const fld of EFF_CODEC[eff.kind]!.fields) writeField(w, fld, src);
  }
}

/** Serialize one MapEvent into a full MidEvent block frame. `ev.id` is the final 10-char id. */
export function eventFrame(version: string, ev: MapEvent): Uint8Array {
  const second = parseInt(ev.id.slice(6), 16) || 0;
  return emitBlock(version, "MidEvent", 0x10, "EV", second, (w, full) => {
    w.refField("ID", full);
    w.stringField("NAME_TXT", ev.name ?? "");
    const r = ev.appliesTo;
    w.bool("HUMAN", r.human).bool("DWARF", r.dwarf).bool("UNDEAD", r.undead)
      .bool("HERETIC", r.heretic).bool("NEUTRAL", r.neutral).bool("ELF", r.elf);
    const v = ev.canTrigger;
    w.bool("VERHUMAN", v.human).bool("VERDWARF", v.dwarf).bool("VERUNDEAD", v.undead)
      .bool("VERHERETIC", v.heretic).bool("VERNEUTRAL", v.neutral).bool("VERELF", v.elf);
    w.bool("ENABLED", ev.enabled).bool("OCCUR_ONCE", ev.occurOnce);
    w.defaultInt("CHANCE", ev.chance).defaultInt("ORDER", ev.order);
    w.defaultInt("COND_QTY", ev.conditions.length);
    for (const cond of ev.conditions) writeCondition(w, cond);
    w.defaultInt("EFFECT_QTY", ev.effects.length);
    for (const eff of ev.effects) writeEffect(w, eff, full);
  });
}
