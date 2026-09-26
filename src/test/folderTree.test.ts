import { describe, it, expect } from 'vitest';
import {
  buildFolderTree,
  collectSessions,
  filterFolderTree,
  folderNameError,
  isSameOrDescendant,
  normalizeFolderPath,
  planFolderMove,
  pruneCollapsed,
  rebaseCollapsed,
  rebasePath,
  sessionFolder,
} from '../services/folderTree';
import { PuttySession } from '../types/session';

const s = (name: string, folder?: string): PuttySession => ({
  name,
  protocol: 'SSH',
  hostname: `${name}.example`,
  port: 22,
  folder,
});

describe('folder paths', () => {
  it('refuses a "/" inside a folder name instead of splitting it into two levels', () => {
    expect(folderNameError('Site 1/Prod')).toMatch(/cannot contain "\/"/);
    expect(folderNameError('   ')).toMatch(/empty/);
    expect(folderNameError('Site 1 (Prod)')).toBeNull();
  });

  it('normalizes stray separators and spaces, so "a//b/" is the folder "a/b"', () => {
    expect(normalizeFolderPath(' Corp 1 / /Site 1/ ')).toBe('Corp 1/Site 1');
    expect(normalizeFolderPath('')).toBe('');
  });

  it('keeps a legacy single-level folder exactly as it was', () => {
    // Folders saved before nesting are one segment: they must land where
    // they always were, and a session with no folder stays in Saved Sessions.
    const tree = buildFolderTree(['Production'], [s('web', 'Production'), s('bare')]);
    expect(tree.map(n => n.path)).toEqual(['Production', 'Saved Sessions']);
    expect(tree[0].children).toEqual([]);
    expect(tree[0].sessions.map(x => x.name)).toEqual(['web']);
    expect(sessionFolder(s('bare'))).toBe('Saved Sessions');
  });

  it('treats "Site 10" as a sibling of "Site 1", not a descendant', () => {
    expect(isSameOrDescendant('Corp/Site 10', 'Corp/Site 1')).toBe(false);
    expect(isSameOrDescendant('Corp/Site 1/Prod', 'Corp/Site 1')).toBe(true);
    expect(rebasePath('Corp/Site 10', 'Corp/Site 1', 'Corp/Site X')).toBeNull();
  });
});

describe('buildFolderTree', () => {
  it('nests by path and implies ancestors that hold no sessions themselves', () => {
    const tree = buildFolderTree([], [s('db', 'Corp 1/Site 1/Site 1 Production')]);
    expect(tree).toHaveLength(1);
    const corp = tree[0];
    expect(corp.path).toBe('Corp 1');
    expect(corp.children[0].path).toBe('Corp 1/Site 1');
    const prod = corp.children[0].children[0];
    expect(prod.name).toBe('Site 1 Production');
    expect(prod.sessions.map(x => x.name)).toEqual(['db']);
    expect(collectSessions(corp).map(x => x.name)).toEqual(['db']);
  });

  it('sorts folders by name with numbers in numeric order', () => {
    const tree = buildFolderTree(['Site 10', 'Site 2', 'Site 1'], []);
    expect(tree.map(n => n.name)).toEqual(['Site 1', 'Site 2', 'Site 10']);
  });

  it('search keeps a matching session with its ancestors, and a matching folder whole', () => {
    const tree = buildFolderTree([], [
      s('db-prod', 'Corp/Site 1'),
      s('web', 'Corp/Site 1'),
      s('mail', 'Corp/Site 2'),
    ]);
    const bySession = filterFolderTree(tree, 'db-', x => x.name.includes('db-'));
    expect(bySession[0].children.map(n => n.path)).toEqual(['Corp/Site 1']);
    expect(bySession[0].children[0].sessions.map(x => x.name)).toEqual(['db-prod']);

    const byFolder = filterFolderTree(tree, 'site 2', () => false);
    expect(byFolder[0].children[0].sessions.map(x => x.name)).toEqual(['mail']);
  });
});

describe('planFolderMove', () => {
  const sessions = [
    s('web1', 'Corp/Site 1'),
    s('db1', 'Corp/Site 1/Prod'),
    s('web10', 'Corp/Site 10'),
    s('home', 'Home'),
  ];

  it('rewrites every session below a renamed folder and nothing beside it', () => {
    const plan = planFolderMove('Corp/Site 1', 'Corp/Site A', sessions, ['Corp/Site 1/Empty']);
    expect(plan.sessionChanges).toEqual([
      ['web1', 'Corp/Site A'],
      ['db1', 'Corp/Site A/Prod'],
    ]);
    expect(plan.userFolders).toEqual(['Corp/Site A', 'Corp/Site A/Empty']);
  });

  it('moves a folder under a new parent, subfolders included', () => {
    const plan = planFolderMove('Corp/Site 1', 'Archive/Site 1', sessions, []);
    expect(plan.sessionChanges).toEqual([
      ['web1', 'Archive/Site 1'],
      ['db1', 'Archive/Site 1/Prod'],
    ]);
  });

  it('refuses to move a folder into itself or one of its own subfolders', () => {
    expect(() => planFolderMove('Corp', 'Corp/Site 1/Corp', sessions, [])).toThrow(/into itself/);
    expect(() => planFolderMove('Corp', 'Corp', sessions, [])).toThrow(/already there/);
  });

  it('refuses to rename the default folder that holds sessions with no folder', () => {
    expect(() => planFolderMove('Saved Sessions', 'Other', sessions, [])).toThrow(/cannot be renamed/);
  });
});

describe('collapsed state', () => {
  it('moves collapsed keys with a renamed folder and drops them for a deleted one', () => {
    const collapsed = { 'Corp/Site 1': true, 'Corp/Site 1/Prod': true, 'Corp/Site 10': true };
    expect(rebaseCollapsed(collapsed, 'Corp/Site 1', 'Corp/Site A')).toEqual({
      'Corp/Site A': true,
      'Corp/Site A/Prod': true,
      'Corp/Site 10': true,
    });
    expect(rebaseCollapsed(collapsed, 'Corp/Site 1', null)).toEqual({ 'Corp/Site 10': true });
  });

  it('prunes keys whose folder no longer exists', () => {
    expect(pruneCollapsed({ a: true, gone: true }, ['a', 'b'])).toEqual({ a: true });
  });
});
