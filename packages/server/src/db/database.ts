import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { migrations } from './schema.js';

export class Database {
  private readonly connection: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string) {
    this.connection = new DatabaseSync(path);
    this.connection.exec('PRAGMA journal_mode = WAL');
    this.connection.exec('PRAGMA foreign_keys = ON');
    this.connection.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  all<Row>(sql: string, ...parameters: SQLInputValue[]): Row[] {
    return this.statement(sql).all(...parameters) as Row[];
  }

  get<Row>(sql: string, ...parameters: SQLInputValue[]): Row | undefined {
    return this.statement(sql).get(...parameters) as Row | undefined;
  }

  run(sql: string, ...parameters: SQLInputValue[]) {
    return this.statement(sql).run(...parameters);
  }

  transaction<Result>(work: () => Result): Result {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.connection.close();
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.connection.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private migrate() {
    const { user_version: currentVersion } = this.get<{ user_version: number }>(
      'PRAGMA user_version',
    )!;
    migrations.slice(currentVersion).forEach((migration, index) => {
      this.transaction(() => {
        this.connection.exec(migration);
        this.connection.exec(`PRAGMA user_version = ${currentVersion + index + 1}`);
      });
    });
  }
}
