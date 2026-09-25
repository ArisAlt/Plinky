/**
 * Session metadata and folder management persistence service.
 * In accordance with Plinky System Design D4:
 * PuTTY store stores base connection parameters, while Plinky-specific
 * metadata (folder hierarchy, tags, custom color markers) is persisted
 * both into session.extra (PlinkyFolder, PlinkyTags) and in sidecar storage.
 */

const STORAGE_METADATA_KEY = 'plinky_session_metadata_v1';
const STORAGE_FOLDERS_KEY = 'plinky_user_folders_v1';

export interface SessionMetadata {
  folder?: string;
  tags?: string[];
  color?: string;
}

export function getAllSessionMetadata(): Record<string, SessionMetadata> {
  try {
    const raw = localStorage.getItem(STORAGE_METADATA_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('Failed to parse session metadata from localStorage:', e);
    return {};
  }
}

export function getSessionMetadata(name: string): SessionMetadata | null {
  const all = getAllSessionMetadata();
  return all[name] || null;
}

export function saveSessionFolder(name: string, folder: string): void {
  try {
    const all = getAllSessionMetadata();
    all[name] = {
      ...all[name],
      folder,
    };
    localStorage.setItem(STORAGE_METADATA_KEY, JSON.stringify(all));
    // Also track in user folders list so folder stays visible even if empty
    addUserFolder(folder);
  } catch (e) {
    console.warn('Failed to save session folder:', e);
  }
}

export function saveSessionTags(name: string, tags: string[]): void {
  try {
    const all = getAllSessionMetadata();
    all[name] = {
      ...all[name],
      tags,
    };
    localStorage.setItem(STORAGE_METADATA_KEY, JSON.stringify(all));
  } catch (e) {
    console.warn('Failed to save session tags:', e);
  }
}

export function getUserFolders(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_FOLDERS_KEY);
    return raw ? JSON.parse(raw) : ['Saved Sessions'];
  } catch {
    return ['Saved Sessions'];
  }
}

export function addUserFolder(folder: string): void {
  const clean = folder.trim();
  if (!clean) return;
  try {
    const current = getUserFolders();
    if (!current.includes(clean)) {
      const updated = [...current, clean].sort();
      localStorage.setItem(STORAGE_FOLDERS_KEY, JSON.stringify(updated));
    }
  } catch (e) {
    console.warn('Failed to add user folder:', e);
  }
}

export function deleteUserFolder(folder: string): void {
  try {
    const current = getUserFolders();
    const updated = current.filter(f => f !== folder);
    localStorage.setItem(STORAGE_FOLDERS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('Failed to delete user folder:', e);
  }
}

export function renameUserFolder(oldName: string, newName: string): void {
  const clean = newName.trim();
  if (!clean || oldName === clean) return;
  try {
    const current = getUserFolders();
    const updated = current.map(f => (f === oldName ? clean : f)).sort();
    localStorage.setItem(STORAGE_FOLDERS_KEY, JSON.stringify(updated));

    // Update any sessions mapped to oldName
    const all = getAllSessionMetadata();
    let modified = false;
    for (const meta of Object.values(all)) {
      if (meta.folder === oldName) {
        meta.folder = clean;
        modified = true;
      }
    }
    if (modified) {
      localStorage.setItem(STORAGE_METADATA_KEY, JSON.stringify(all));
    }
  } catch (e) {
    console.warn('Failed to rename user folder:', e);
  }
}
