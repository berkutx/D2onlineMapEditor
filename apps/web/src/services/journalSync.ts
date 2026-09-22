import { activeOps, activeOpUids, type EditorProject } from "@d2/map-edit";
import type { EditOp } from "@d2/socket-contract";

export interface JournalEntry {
  op: EditOp;
  uid: string;
}

/** Keep each operation paired with its persisted identity while filtering a draft.
 * Call ensureJournalUids before taking this snapshot, including for legacy projects.
 * Minting a fallback here would make a retry look like a new operation to the server. */
export function pendingJournalEntries(project: EditorProject, knownUids: ReadonlySet<string>): JournalEntry[] {
  const uids = activeOpUids(project);
  const pending: JournalEntry[] = [];
  for (const [index, op] of activeOps(project).entries()) {
    const uid = uids[index];
    if (!uid) throw new Error(`Journal operation ${index} has no persisted UID; normalize the journal before synchronizing`);
    if (!knownUids.has(uid)) pending.push({ op, uid });
  }
  return pending;
}
