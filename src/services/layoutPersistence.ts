import { SplitLayoutMode } from '../types/session';

export interface SavedTab {
  id: string;
  title: string;
  sessionName: string;
  syncChannel: 'none' | 'A' | 'B' | 'C' | 'D';
  hostname: string;
  port: number;
  username?: string;
}

export interface LayoutState {
  schema_version: number;
  layoutMode: SplitLayoutMode;
  activeTabId: string | null;
  tabs: SavedTab[];
  timestamp: number;
}

const STORAGE_KEY = 'plinky_layout_state_v1';
const CURRENT_SCHEMA_VERSION = 1;

/**
 * Save layout state adhering to R1-R3 persistence invariants.
 */
export function saveLayout(
  layoutMode: SplitLayoutMode,
  activeTabId: string | null,
  tabs: SavedTab[]
): void {
  try {
    const state: LayoutState = {
      schema_version: CURRENT_SCHEMA_VERSION,
      layoutMode,
      activeTabId,
      tabs: tabs.map(t => ({
        id: t.id,
        title: t.title,
        sessionName: t.sessionName,
        syncChannel: t.syncChannel,
        hostname: t.hostname,
        port: t.port,
        username: t.username,
      })),
      timestamp: Date.now(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to persist layout state:", e);
  }
}

/**
 * Load layout state with schema validation and fail-closed quarantine (R2/R3).
 */
export function loadLayout(): LayoutState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      // R2: Quarantine corrupted state with timestamp
      const quarantineKey = `plinky_layout_corrupt_${Date.now()}`;
      localStorage.setItem(quarantineKey, raw);
      localStorage.removeItem(STORAGE_KEY);
      console.error(`Corrupt layout JSON quarantined under ${quarantineKey}:`, parseErr);
      return null;
    }

    // R3: Version validation
    if (!parsed || typeof parsed !== 'object' || parsed.schema_version !== CURRENT_SCHEMA_VERSION) {
      console.warn("Unsupported layout schema version:", parsed?.schema_version);
      return null;
    }

    if (!Array.isArray(parsed.tabs)) {
      return null;
    }

    return parsed as LayoutState;
  } catch (e) {
    console.error("Failed to load layout state:", e);
    return null;
  }
}

/**
 * Clear persisted layout state.
 */
export function clearLayout(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error("Failed to clear layout state:", e);
  }
}

