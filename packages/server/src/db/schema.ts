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
];
