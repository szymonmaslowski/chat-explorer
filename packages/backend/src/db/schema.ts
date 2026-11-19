// The tables a chat's data lives in, each with the kind of thing a change log row names and the
// column that identifies one.
const loggedTables = [
  { table: 'explorations', kind: 'exploration', key: 'id', chat: 'id' },
  { table: 'forks', kind: 'fork', key: 'id', chat: 'exploration_id' },
  { table: 'messages', kind: 'message', key: 'id', chat: 'exploration_id' },
  { table: 'comments', kind: 'comment', key: 'id', chat: 'exploration_id' },
  { table: 'submissions', kind: 'submission', key: 'id', chat: 'exploration_id' },
  { table: 'files', kind: 'file', key: 'id', chat: 'exploration_id' },
  { table: 'reply_drafts', kind: 'reply_draft', key: 'fork_id', chat: 'exploration_id' },
  { table: 'note_groups', kind: 'note_group', key: 'id', chat: 'exploration_id' },
  { table: 'notes', kind: 'note', key: 'id', chat: 'exploration_id' },
  { table: 'bookmarks', kind: 'bookmark', key: 'id', chat: 'exploration_id' },
  { table: 'fork_runs', kind: 'fork_run', key: 'fork_id', chat: 'exploration_id' },
  { table: 'activities', kind: 'activity', key: 'id', chat: 'exploration_id' },
] as const;

const nowMs = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

// Every write to a chat's data records a row in the same transaction, by trigger, so no write
// path can miss one. A row only names what changed; the current state is read when asked. A
// file that leaves a chat, or joins one, counts as deleted there and created in the other.
function changeLog() {
  const log = (row: 'NEW' | 'OLD', kind: string, key: string, chat: string, action: string) =>
    `INSERT INTO changes (exploration_id, kind, entity_id, action, created_at)
       SELECT ${row}.${chat}, '${kind}', ${row}.${key}, '${action}', ${nowMs}
       WHERE ${row}.${chat} IS NOT NULL;`;
  const triggers = loggedTables.map(
    ({ table, kind, key, chat }) => `
  CREATE TRIGGER ${table}_logged_insert AFTER INSERT ON ${table} BEGIN
    ${log('NEW', kind, key, chat, 'created')}
  END;
  CREATE TRIGGER ${table}_logged_update AFTER UPDATE ON ${table} BEGIN
    ${log('OLD', kind, key, chat, 'deleted').replace('WHERE', `WHERE OLD.${chat} IS NOT NEW.${chat} AND`)}
    ${log('NEW', kind, key, chat, 'updated').replace('WHERE', `WHERE OLD.${chat} IS NEW.${chat} AND`)}
    ${log('NEW', kind, key, chat, 'created').replace('WHERE', `WHERE OLD.${chat} IS NOT NEW.${chat} AND`)}
  END;
  CREATE TRIGGER ${table}_logged_delete AFTER DELETE ON ${table} BEGIN
    ${log('OLD', kind, key, chat, 'deleted')}
  END;`,
  );
  return `
  CREATE TABLE changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    exploration_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX changes_by_exploration ON changes (exploration_id, seq);
  CREATE INDEX changes_by_time ON changes (created_at);
  -- Rows up to the floor were deleted: a device that knows less loads the chat fresh.
  CREATE TABLE change_log (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    floor INTEGER NOT NULL
  );
  INSERT INTO change_log (id, floor) VALUES (1, 0);
  ${triggers.join('\n')}
  `;
}

export const migrations = [
  `
  CREATE TABLE explorations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    attached_session_id TEXT,
    attached_shim_id TEXT,
    attached_seen_at INTEGER
  );

  CREATE TABLE forks (
    id TEXT PRIMARY KEY,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    parent_fork_id TEXT,
    base_message_id TEXT,
    origin_comment_id TEXT,
    tip_message_id TEXT,
    kind TEXT NOT NULL DEFAULT 'soft' CHECK (kind IN ('soft', 'hard')),
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX forks_by_exploration ON forks (exploration_id);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    fork_id TEXT NOT NULL,
    parent_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('import', 'live')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_by_exploration ON messages (exploration_id);
  CREATE INDEX messages_by_fork ON messages (fork_id);

  CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    fork_id TEXT NOT NULL,
    global_message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('queued', 'delivered')),
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX submissions_by_exploration ON submissions (exploration_id, status);

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    view_fork_id TEXT NOT NULL,
    quote TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    body TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('inline', 'fork')),
    status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'submitted')),
    submission_id TEXT,
    reply_message_id TEXT,
    created_fork_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX comments_by_exploration ON comments (exploration_id);
  CREATE INDEX comments_by_reply ON comments (reply_message_id);
  `,
  `
  ALTER TABLE explorations ADD COLUMN model TEXT NOT NULL DEFAULT 'sonnet';
  ALTER TABLE explorations ADD COLUMN background_session_id TEXT;
  `,
  `
  ALTER TABLE explorations ADD COLUMN archived_at INTEGER;
  ALTER TABLE explorations ADD COLUMN deleted_at INTEGER;
  `,
  `
  ALTER TABLE submissions ADD COLUMN new_fork INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    exploration_id TEXT REFERENCES explorations (id) ON DELETE CASCADE,
    submission_id TEXT,
    message_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text')),
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX files_by_exploration ON files (exploration_id);
  CREATE INDEX files_by_submission ON files (submission_id);
  `,
  `
  ALTER TABLE comments ADD COLUMN edit_body TEXT;
  ALTER TABLE files ADD COLUMN draft_fork_id TEXT;
  CREATE TABLE reply_drafts (
    fork_id TEXT PRIMARY KEY,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    new_fork INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE forks ADD COLUMN archived_at INTEGER;
  `,
  `
  CREATE TABLE note_groups (
    id TEXT PRIMARY KEY,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    checklist INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX note_groups_by_exploration ON note_groups (exploration_id, position);

  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES note_groups (id) ON DELETE CASCADE,
    topic TEXT,
    description TEXT NOT NULL DEFAULT '',
    checked INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL,
    source_fork_id TEXT,
    source_message_id TEXT,
    source_quote TEXT,
    source_start_offset INTEGER,
    source_end_offset INTEGER,
    source_comment_id TEXT,
    created_by TEXT NOT NULL CHECK (created_by IN ('user', 'claude')),
    deletion_requested_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX notes_by_exploration ON notes (exploration_id);
  CREATE INDEX notes_by_group ON notes (group_id, position);

  -- The first CHECK on type had no name, so it could not be dropped. Swapping the column once
  -- gives it a named one, which later types change with DROP and ADD CONSTRAINT.
  ALTER TABLE comments ADD COLUMN new_type TEXT NOT NULL DEFAULT 'inline'
    CONSTRAINT comment_type CHECK (new_type IN ('inline', 'fork', 'note'));
  UPDATE comments SET new_type = type;
  ALTER TABLE comments DROP COLUMN type;
  ALTER TABLE comments RENAME COLUMN new_type TO type;
  ALTER TABLE comments ADD COLUMN note_group_id TEXT
    REFERENCES note_groups (id) ON DELETE SET NULL;
  ALTER TABLE comments ADD COLUMN created_note_id TEXT REFERENCES notes (id) ON DELETE SET NULL;
  `,
  `
  -- Uploads shown in answers before answers kept them.
  UPDATE files SET
    message_id = (
      SELECT id FROM messages
      WHERE role = 'assistant' AND instr(content, '/api/files/' || files.id) > 0
    ),
    exploration_id = (
      SELECT exploration_id FROM messages
      WHERE role = 'assistant' AND instr(content, '/api/files/' || files.id) > 0
    )
  WHERE exploration_id IS NULL AND EXISTS (
    SELECT 1 FROM messages
    WHERE role = 'assistant' AND instr(content, '/api/files/' || files.id) > 0
  );
  `,
  `
  ALTER TABLE comments ADD COLUMN fork_group_id TEXT;
  `,
  `
  -- Claude's answers are unread until the reader has seen them; earlier ones count as seen.
  ALTER TABLE messages ADD COLUMN read_at INTEGER;
  UPDATE messages SET read_at = created_at;
  `,
  `
  CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    fork_id TEXT NOT NULL REFERENCES forks (id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    quote TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (fork_id, message_id, start_offset, end_offset)
  );
  CREATE INDEX bookmarks_by_exploration ON bookmarks (exploration_id);
  `,
  `
  -- The agent loop: per fork, the engine session, which user messages it has answered, the lease
  -- of the runner working on it, its status and its usage.
  CREATE TABLE fork_runs (
    fork_id TEXT PRIMARY KEY REFERENCES forks (id) ON DELETE CASCADE,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    engine TEXT NOT NULL DEFAULT 'claude-code',
    session_id TEXT,
    input_cursor TEXT,
    lease_id TEXT,
    runner_id TEXT,
    lease_expires_at INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('idle', 'answering', 'waiting_limit', 'failed')),
    status_detail TEXT,
    model TEXT,
    context_tokens INTEGER,
    context_window INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX fork_runs_by_exploration ON fork_runs (exploration_id);

  -- What Claude was doing during a turn, shown collapsed and never part of the fork's context.
  CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    exploration_id TEXT NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
    fork_id TEXT NOT NULL REFERENCES forks (id) ON DELETE CASCADE,
    after_message_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('tool', 'text', 'progress')),
    text TEXT NOT NULL,
    interrupted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX activities_by_fork ON activities (fork_id, created_at);
  `,
  `
  -- The secret the engine sends to the job tools, valid while the lease it came with lasts.
  ALTER TABLE fork_runs ADD COLUMN tools_token TEXT;
  CREATE UNIQUE INDEX fork_runs_by_tools_token ON fork_runs (tools_token);
  `,
  `
  -- Whether a fork's engine hears about the chat's other forks, and how far it has heard.
  ALTER TABLE forks ADD COLUMN awareness TEXT NOT NULL DEFAULT 'aware'
    CHECK (awareness IN ('aware', 'separate'));
  ALTER TABLE fork_runs ADD COLUMN others_seen_rowid INTEGER;
  `,
  `
  -- The reader asked the runner to stop the fork's turn.
  ALTER TABLE fork_runs ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- A released lease used to leave the fork marked as answering.
  UPDATE fork_runs SET status = 'idle' WHERE status = 'answering' AND lease_id IS NULL;
  `,
  `
  ALTER TABLE forks ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- A fork split off another is named after its first message until Claude names it.
  ALTER TABLE forks ADD COLUMN needs_summary INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The page a chat opens on: its map (or its one fork's conversation), or its notes.
  ALTER TABLE explorations ADD COLUMN default_page TEXT NOT NULL DEFAULT 'map'
    CHECK (default_page IN ('map', 'notes'));
  `,
  `
  -- The ids people see and copy name their kind: chat_…, fork_…, note_…. Every column pointing to
  -- one changes with it, so the foreign keys are checked once, at the end.
  PRAGMA defer_foreign_keys = ON;
  UPDATE explorations SET id = 'chat_' || id;
  UPDATE activities SET exploration_id = 'chat_' || exploration_id;
  UPDATE bookmarks SET exploration_id = 'chat_' || exploration_id;
  UPDATE comments SET exploration_id = 'chat_' || exploration_id;
  UPDATE files SET exploration_id = 'chat_' || exploration_id;
  UPDATE fork_runs SET exploration_id = 'chat_' || exploration_id;
  UPDATE forks SET exploration_id = 'chat_' || exploration_id;
  UPDATE messages SET exploration_id = 'chat_' || exploration_id;
  UPDATE note_groups SET exploration_id = 'chat_' || exploration_id;
  UPDATE notes SET exploration_id = 'chat_' || exploration_id;
  UPDATE reply_drafts SET exploration_id = 'chat_' || exploration_id;
  UPDATE submissions SET exploration_id = 'chat_' || exploration_id;

  UPDATE forks SET id = 'fork_' || id, parent_fork_id = 'fork_' || parent_fork_id;
  UPDATE activities SET fork_id = 'fork_' || fork_id;
  UPDATE bookmarks SET fork_id = 'fork_' || fork_id;
  UPDATE comments SET view_fork_id = 'fork_' || view_fork_id,
    created_fork_id = 'fork_' || created_fork_id;
  UPDATE files SET draft_fork_id = 'fork_' || draft_fork_id;
  UPDATE fork_runs SET fork_id = 'fork_' || fork_id;
  UPDATE messages SET fork_id = 'fork_' || fork_id;
  UPDATE notes SET source_fork_id = 'fork_' || source_fork_id;
  UPDATE reply_drafts SET fork_id = 'fork_' || fork_id;
  UPDATE submissions SET fork_id = 'fork_' || fork_id;

  UPDATE notes SET id = 'note_' || id;
  UPDATE comments SET created_note_id = 'note_' || created_note_id;
  `,
  `
  ALTER TABLE files ADD COLUMN comment_id TEXT;
  CREATE INDEX files_by_comment ON files (comment_id);
  `,
  `
  ALTER TABLE files ADD COLUMN width INTEGER;
  ALTER TABLE files ADD COLUMN height INTEGER;
  `,
  changeLog(),
  `
  -- When a read mark was last set on the device that set it, so the newest of two marks wins.
  ALTER TABLE messages ADD COLUMN read_marked_at INTEGER;
  -- Which device made a note's last edit, so an edit from another device made meanwhile is seen.
  ALTER TABLE notes ADD COLUMN updated_device TEXT;
  `,
  `
  ALTER TABLE forks ADD COLUMN coding INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- A JSON array of host:port entries.
  ALTER TABLE forks ADD COLUMN allowed_hosts TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE forks ADD COLUMN registries INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- A JSON array of registry names, one checkbox each, in place of one switch for all of them.
  ALTER TABLE forks ADD COLUMN new_registries TEXT NOT NULL DEFAULT '[]';
  UPDATE forks SET new_registries = '["npm","pypi","rust","go"]' WHERE registries = 1;
  ALTER TABLE forks DROP COLUMN registries;
  ALTER TABLE forks RENAME COLUMN new_registries TO registries;
  `,
  `
  -- A coding fork can wait for Docker's memory.
  ALTER TABLE fork_runs ADD COLUMN new_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (new_status IN ('idle', 'answering', 'waiting_limit', 'waiting_memory', 'failed'));
  UPDATE fork_runs SET new_status = status;
  ALTER TABLE fork_runs DROP COLUMN status;
  ALTER TABLE fork_runs RENAME COLUMN new_status TO status;
  `,
  `
  -- A JSON array of credential names from the runner's config.
  ALTER TABLE forks ADD COLUMN credentials TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- A draft another fork's Claude wrote here, for the user to edit and send.
  ALTER TABLE comments ADD COLUMN drafted_by_fork_id TEXT;
  `,
];
