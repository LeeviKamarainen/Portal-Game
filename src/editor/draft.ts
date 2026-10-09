import type { MapData } from '../world/maps/MapFormat';

/** Where the map editor keeps the map being worked on between visits. */
export const EDITOR_DRAFT_KEY = 'portal-arena.editor-draft';

/** The saved (online) map the editor's map came from, so Save online updates it instead of making another. */
export const EDITOR_CLOUD_KEY = 'portal-arena.editor-cloud-id';

export function readEditorCloudId(): string | null {
  try {
    return localStorage.getItem(EDITOR_CLOUD_KEY);
  } catch {
    return null;
  }
}

export function writeEditorCloudId(id: string | null): void {
  try {
    if (id) localStorage.setItem(EDITOR_CLOUD_KEY, id);
    else localStorage.removeItem(EDITOR_CLOUD_KEY);
  } catch {
    // No storage: Save online makes a new map each time after a reload.
  }
}

/** The editor's current map (also offered to online rooms), or null if there is none. */
export function readEditorDraft(): MapData | null {
  try {
    const raw = localStorage.getItem(EDITOR_DRAFT_KEY);
    const data = raw ? (JSON.parse(raw) as MapData) : null;
    return data && Array.isArray(data.pieces) ? data : null;
  } catch {
    return null;
  }
}
