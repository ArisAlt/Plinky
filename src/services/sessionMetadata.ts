/**
 * Session metadata and folder management persistence service.
 * In accordance with Plinky System Design D4:
 * PuTTY store stores base connection parameters, while Plinky-specific
 * metadata (folder hierarchy, tags, custom color markers) is persisted
 * both into session.extra (PlinkyFolder, PlinkyTags) and in sidecar storage.
 */

import { isSameOrDescendant, normalizeFolderPath, rebasePath } from './folderTree';

const STORAGE_METADATA_KEY = 'plinky_session_metadata_v1';
const STORAGE_FOLDERS_KEY = 'plinky_user_folders_v1';
const STORAGE_COLLAPSED_KEY = 'plinky_collapsed_folders_v1';

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
  const clean = normalizeFolderPath(folder);
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

export function setUserFolders(folders: string[]): void {
  try {
    const clean = Array.from(new Set(folders.map(normalizeFolderPath).filter(Boolean))).sort();
    localStorage.setItem(STORAGE_FOLDERS_KEY, JSON.stringify(clean));
  } catch (e) {
    console.warn('Failed to save user folders:', e);
  }
}

/** Removes the folder and every subfolder below it. */
export function deleteUserFolder(folder: string): void {
  try {
    const current = getUserFolders();
    const updated = current.filter(f => !isSameOrDescendant(f, folder));
    localStorage.setItem(STORAGE_FOLDERS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('Failed to delete user folder:', e);
  }
}

/**
 * Renames a folder path in the sidecar, subfolders included: renaming
 * "Corp/Site 1" moves "Corp/Site 1/Prod" too, and leaves "Corp/Site 10".
 * This is only the local mirror -- PuTTY's own PlinkyFolder values are
 * rewritten by setSessionFolders.
 */
export function renameUserFolder(oldName: string, newName: string): void {
  const from = normalizeFolderPath(oldName);
  const to = normalizeFolderPath(newName);
  if (!from || !to || from === to) return;
  try {
    const current = getUserFolders();
    setUserFolders(current.map(f => rebasePath(f, from, to) ?? f));

    const all = getAllSessionMetadata();
    let modified = false;
    for (const meta of Object.values(all)) {
      const moved = meta.folder ? rebasePath(meta.folder, from, to) : null;
      if (moved !== null) {
        meta.folder = moved;
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

/** Collapsed folders, keyed by full path. */
export function getCollapsedFolders(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCollapsedFolders(collapsed: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_COLLAPSED_KEY, JSON.stringify(collapsed));
  } catch (e) {
    console.warn('Failed to save collapsed folders:', e);
  }
}
