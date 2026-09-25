import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSessionMetadata,
  saveSessionFolder,
  saveSessionTags,
  getUserFolders,
  addUserFolder,
  deleteUserFolder,
  renameUserFolder,
} from '../services/sessionMetadata';

describe('Session Metadata and Folder Service', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves and retrieves session folder and tags', () => {
    expect(getSessionMetadata('srv1')).toBeNull();

    saveSessionFolder('srv1', 'Production');
    expect(getSessionMetadata('srv1')?.folder).toBe('Production');

    saveSessionTags('srv1', ['prod', 'web', 'nginx']);
    const meta = getSessionMetadata('srv1');
    expect(meta?.folder).toBe('Production');
    expect(meta?.tags).toEqual(['prod', 'web', 'nginx']);
  });

  it('manages user custom folders', () => {
    expect(getUserFolders()).toEqual(['Saved Sessions']);

    addUserFolder('Database Cluster');
    expect(getUserFolders()).toContain('Database Cluster');

    // Duplicate additions are idempotent
    addUserFolder('Database Cluster');
    expect(getUserFolders().filter(f => f === 'Database Cluster')).toHaveLength(1);

    // Rename folder updates user folders and session metadata
    saveSessionFolder('db-master', 'Database Cluster');
    renameUserFolder('Database Cluster', 'DB Production');
    expect(getUserFolders()).toContain('DB Production');
    expect(getUserFolders()).not.toContain('Database Cluster');
    expect(getSessionMetadata('db-master')?.folder).toBe('DB Production');

    // Deletion
    deleteUserFolder('DB Production');
    expect(getUserFolders()).not.toContain('DB Production');
  });
});
