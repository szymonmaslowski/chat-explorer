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
];
