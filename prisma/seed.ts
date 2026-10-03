import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PrismaClient } from '../src/generated/prisma/client';
import { hashPassword } from '../src/server/credentials';

export const demoSubjects = [
  { id: 'math', name: '考研数学' },
  { id: 'english', name: '考研英语' },
  { id: 'politics', name: '考研政治' },
  { id: 'cs', name: '计算机专业基础' },
];
/** Isolated tests only; normal setup never creates these identities or passwords. */
export const demoUsers = [
  { id: 'asker-a', name: '学生A', role: 'ASKER' },
  { id: 'asker-b', name: '学生B', role: 'ASKER' },
  { id: 'answerer-a', name: '教师A', role: 'ANSWERER' },
  { id: 'answerer-b', name: '教师B', role: 'ANSWERER' },
  { id: 'answerer-c', name: '教师C', role: 'ANSWERER' },
  { id: 'admin', name: '管理员', role: 'ADMIN' },
];
export const fixturePassword = 'YanbanTest!2026';
const profiles = [
  { userId: 'answerer-a', bio: '极限、微积分与线性代数（隔离测试资料，自述资格，未经学籍核验）', subjectIds: ['math', 'cs'] },
  { userId: 'answerer-b', bio: '长难句与阅读理解（隔离测试资料，自述资格，未经学籍核验）', subjectIds: ['english', 'politics'] },
  { userId: 'answerer-c', bio: '数据结构与算法（隔离测试资料，自述资格，未经学籍核验）', subjectIds: ['cs', 'math'] },
];

/** Add subjects safely. Credentials are inserted only when an isolated test explicitly opts in.
 * Existing business data, credentials, login sessions and administrator settings are never reset. */
export async function seedDatabase(prisma: PrismaClient, options: { fixtures?: boolean | 'admin' } = {}) {
  const fixtureUsers = options.fixtures === 'admin' ? demoUsers.filter(u => u.role === 'ADMIN') : options.fixtures ? demoUsers : [];
  const hashes = await Promise.all(fixtureUsers.map(() => hashPassword(fixturePassword)));
  await prisma.$transaction(async (tx) => {
    await tx.writeFence.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    for (const subject of demoSubjects) {
      await tx.subject.upsert({ where: { id: subject.id }, create: subject, update: {} });
    }
    if (!options.fixtures) return;
    for (const [index, user] of fixtureUsers.entries()) {
      await tx.user.upsert({ where: { id: user.id }, create: user, update: {} });
      const credentials = { userId: user.id, username: user.id, passwordHash: hashes[index] };
      const consent = { adultConfirmedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: '2026-10-03' };
      if (user.role === 'ASKER') {
        await tx.studentAccount.upsert({ where: { userId: user.id }, update: {},
          create: { ...credentials, ...consent, displayName: user.name, university: '隔离测试大学', major: '测试专业' } });
      } else if (user.role === 'ANSWERER') {
        await tx.teacherAccount.upsert({ where: { userId: user.id }, update: {},
          create: { ...credentials, ...consent, displayName: user.name, university: '隔离测试大学', major: '测试专业', degree: 'MASTER', qualificationConfirmedAt: new Date() } });
      } else {
        await tx.adminAccount.upsert({ where: { userId: user.id }, update: {}, create: credentials });
      }
    }
    if (options.fixtures !== true) return;
    for (const { subjectIds, ...profile } of profiles) {
      await tx.answererProfile.upsert({
        where: { userId: profile.userId }, update: {},
        create: { ...profile, profileSource: 'SELF_DECLARED', enabled: true,
          isAdult: true, isFullTimeStudent: true, isEmployed: false, online: false, heartbeatAt: null,
          subjects: { create: subjectIds.map((subjectId) => ({ subjectId })) },
        },
      });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { db } = await import('../src/server/db');
  try {
    await seedDatabase(db);
    console.log('科目初始化完成；已有账号和业务记录已保留。');
  } finally { await db.$disconnect(); }
}
