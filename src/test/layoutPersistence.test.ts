import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveLayout,
  loadLayout,
  clearLayout,
  SavedTab,
} from '../services/layoutPersistence';

describe('Layout Persistence Service (R1-R3 Compliance)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const mockTabs: SavedTab[] = [
    {
      id: 'tab-1',
      title: 'Local Shell',
      sessionName: 'Default Settings',
      syncChannel: 'none',
      hostname: 'localhost',
      port: 22,
    },
    {
      id: 'tab-2',
      title: 'Prod Server',
      sessionName: 'Production-1',
      hostname: 'prod.example.com',
      port: 22,
      syncChannel: 'A',
      username: 'root',
    },
  ];

  it('saves and restores layout state accurately', () => {
    saveLayout('split-vertical', 'tab-2', mockTabs);

    const restored = loadLayout();
    expect(restored).not.toBeNull();
    expect(restored?.tabs.length).toBe(2);
    expect(restored?.activeTabId).toBe('tab-2');
    expect(restored?.layoutMode).toBe('split-vertical');
    expect(restored?.schema_version).toBe(1);

    // Check specific tab properties
    expect(restored?.tabs[1].hostname).toBe('prod.example.com');
    expect(restored?.tabs[1].syncChannel).toBe('A');
    expect(restored?.tabs[1].username).toBe('root');
  });

  it('returns null when no saved state exists', () => {
    const restored = loadLayout();
    expect(restored).toBeNull();
  });

  it('quarantines corrupted JSON without throwing and returns null', () => {
    localStorage.setItem('plinky_layout_state_v1', 'NOT_VALID_JSON{:::');

    const restored = loadLayout();
    expect(restored).toBeNull();

    // Verify original corrupted key was deleted
    expect(localStorage.getItem('plinky_layout_state_v1')).toBeNull();

    // Verify corrupted payload was preserved in quarantine
    const quarantineKeys = Object.keys(localStorage).filter((k) =>
      k.startsWith('plinky_layout_corrupt_')
    );
    expect(quarantineKeys.length).toBe(1);
    expect(localStorage.getItem(quarantineKeys[0])).toBe('NOT_VALID_JSON{:::');
  });

  it('clears layout state cleanly', () => {
    saveLayout('single', 'tab-1', mockTabs);
    expect(loadLayout()).not.toBeNull();

    clearLayout();
    expect(loadLayout()).toBeNull();
  });
});
