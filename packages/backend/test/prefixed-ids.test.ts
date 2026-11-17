import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { prefixLegacyNames } from '../src/legacy-names.js';
import { Database } from '../src/db/database.js';
import { migrations } from '../src/db/schema.js';
import { createTestApp, seedConversation } from './helpers.js';

const withoutPrefix = (id: string) => id.slice(id.indexOf('_') + 1);

describe('prefixed ids', () => {
  it('gives new chats, forks and notes ids that name their kind', () => {
    const { store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);
    const group = store.createNoteGroup(explorationId, {});
    const note = store.createNote(explorationId, { groupId: group.id, topic: 'One' });
    expect(explorationId).toMatch(/^chat_[0-9a-z]{10}$/);
    expect(mainForkId).toMatch(/^fork_[0-9a-z]{10}$/);
    expect(note.id).toMatch(/^note_[0-9a-z]{10}$/);
    expect(group.id).toMatch(/^[0-9a-z]{10}$/);
  });

  it('takes an old id without its prefix, in the path and in the body', async () => {
    const { request, store } = createTestApp();
    const { explorationId, mainForkId } = seedConversation(store);

    const snapshot = await request(`/api/explorations/${withoutPrefix(explorationId)}`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).exploration.id).toBe(explorationId);

    const submitted = await request(`/api/explorations/${withoutPrefix(explorationId)}/submit`, {
      method: 'POST',
      json: {
        forkId: withoutPrefix(mainForkId),
        globalMessage: 'Tell me more',
        newFork: false,
        fileIds: [],
      },
    });
    expect(submitted.status).toBe(201);
    expect(await submitted.json()).toMatchObject({ forkId: mainForkId });
  });

  it('migrates the ids in the database, with every column that points to them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'chat-explorer-migration-')), 'test.db');
    const old = new DatabaseSync(path);
    const before = migrations.findIndex((migration) =>
      migration.includes("UPDATE explorations SET id = 'chat_' || id"),
    );
    for (const migration of migrations.slice(0, before)) old.exec(migration);
    old.exec(`PRAGMA user_version = ${before};
      INSERT INTO explorations (id, created_at, updated_at) VALUES ('chat000001', 1, 1);
      INSERT INTO forks (id, exploration_id, created_at, updated_at)
        VALUES ('frk0000001', 'chat000001', 1, 1);
      INSERT INTO forks (id, exploration_id, parent_fork_id, created_at, updated_at)
        VALUES ('frk0000002', 'chat000001', 'frk0000001', 1, 1);
      INSERT INTO messages (id, exploration_id, fork_id, role, content, source, created_at)
        VALUES ('msg0000001', 'chat000001', 'frk0000001', 'user', 'Hi', 'live', 1);
      INSERT INTO note_groups (id, exploration_id, name, position, created_at, updated_at)
        VALUES ('grp0000001', 'chat000001', 'General', 0, 1, 1);
      INSERT INTO notes (id, exploration_id, group_id, topic, description, position,
          source_fork_id, created_by, created_at, updated_at)
        VALUES ('nte0000001', 'chat000001', 'grp0000001', 'One', '', 0, 'frk0000002', 'user', 1, 1);
      INSERT INTO fork_runs (fork_id, exploration_id, updated_at)
        VALUES ('frk0000002', 'chat000001', 1);`);
    old.close();

    const database = new Database(path);
    expect(
      database.all('SELECT id, parent_fork_id, exploration_id FROM forks ORDER BY id'),
    ).toEqual([
      { id: 'fork_frk0000001', parent_fork_id: null, exploration_id: 'chat_chat000001' },
      {
        id: 'fork_frk0000002',
        parent_fork_id: 'fork_frk0000001',
        exploration_id: 'chat_chat000001',
      },
    ]);
    expect(database.get('SELECT id, exploration_id, fork_id FROM messages')).toEqual({
      id: 'msg0000001',
      exploration_id: 'chat_chat000001',
      fork_id: 'fork_frk0000001',
    });
    expect(database.get('SELECT id, group_id, source_fork_id FROM notes')).toEqual({
      id: 'note_nte0000001',
      group_id: 'grp0000001',
      source_fork_id: 'fork_frk0000002',
    });
    expect(database.get('SELECT fork_id FROM fork_runs')).toEqual({ fork_id: 'fork_frk0000002' });
    expect(database.all('PRAGMA foreign_key_check')).toEqual([]);
    database.close();
  });

  it('renames folders and files named after an old id', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat-explorer-names-'));
    mkdirSync(join(directory, 'frk0000001'));
    mkdirSync(join(directory, 'fork_frk0000002'));
    writeFileSync(join(directory, 'chat000001.log'), '');
    prefixLegacyNames(directory, 'fork');
    prefixLegacyNames(directory, 'chat', '.log');
    expect(existsSync(join(directory, 'fork_frk0000001'))).toBe(true);
    expect(existsSync(join(directory, 'fork_frk0000002'))).toBe(true);
    expect(existsSync(join(directory, 'chat_chat000001.log'))).toBe(true);
    expect(existsSync(join(directory, 'frk0000001'))).toBe(false);
  });
});
