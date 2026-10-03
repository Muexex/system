import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it('account migrations preserve legacy business rows and mark old login sessions unusable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yanban-account-upgrade-'));
  const database = new Database(join(directory, 'test.db'));
  try {
    database.exec(readFileSync('prisma/migrations/202610020001_init/migration.sql', 'utf8'));
    database.exec(`
      PRAGMA foreign_keys=ON;
      INSERT INTO User(id,name,role) VALUES ('legacy-asker','旧学生','ASKER'),('legacy-teacher','旧教师','ANSWERER');
      INSERT INTO Subject(id,name) VALUES ('math','考研数学');
      INSERT INTO AnswererProfile(userId,enabled,isAdult,isFullTimeStudent,isEmployed,profileSource,online) VALUES ('legacy-teacher',1,1,1,0,'DEMO',1);
      INSERT INTO AnswererSubject(answererId,subjectId) VALUES ('legacy-teacher','math');
      INSERT INTO LoginSession(id,tokenHash,userId,expiresAt) VALUES ('legacy-login','sentinel-hash','legacy-asker','2030-01-01');
      INSERT INTO QuestionRequest(id,askerId,subjectId,description,mode,status,idempotencyKey,deadlineAt) VALUES ('legacy-request','legacy-asker','math','保留旧请求资料','DIRECT','OFFERED','sentinel-key','2030-01-01');
      INSERT INTO RequesterLease(askerId,requestId) VALUES ('legacy-asker','legacy-request');
      INSERT INTO Invitation(id,requestId,answererId,status,deadlineAt) VALUES ('legacy-offer','legacy-request','legacy-teacher','PENDING','2030-01-01');
      INSERT INTO AnswererLease(answererId,requestId,offerId,expiresAt) VALUES ('legacy-teacher','legacy-request','legacy-offer','2030-01-01');
    `);
    const tables = ['User', 'Subject', 'AnswererProfile', 'AnswererSubject', 'QuestionRequest', 'RequesterLease', 'Invitation', 'AnswererLease'];
    const snapshot = (table: string) => database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    const before = tables.map(snapshot);
    database.exec(readFileSync('prisma/migrations/202610030001_accounts/migration.sql', 'utf8'));
    database.exec(readFileSync('prisma/migrations/202610030002_account_consent/migration.sql', 'utf8'));
    tables.forEach((table, index) => expect(snapshot(table)).toEqual(before[index]));
    expect(database.prepare('SELECT portal FROM LoginSession WHERE id=?').get('legacy-login')).toEqual({ portal: 'LEGACY' });
    expect(database.pragma('foreign_key_check')).toHaveLength(0);
    expect(database.prepare('SELECT count(*) AS count FROM StudentAccount').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM TeacherAccount').get()).toEqual({ count: 0 });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
