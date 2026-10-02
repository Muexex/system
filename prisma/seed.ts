import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PrismaClient } from '../src/generated/prisma/client';

export const demoSubjects = [
  { id: 'math', name: '考研数学' },
  { id: 'english', name: '考研英语' },
  { id: 'politics', name: '考研政治' },
  { id: 'cs', name: '计算机专业基础' },
];
export const demoUsers = [
  { id: 'asker-a', name: '提问者A', role: 'ASKER' },
  { id: 'asker-b', name: '提问者B', role: 'ASKER' },
  { id: 'answerer-a', name: '答疑者A', role: 'ANSWERER' },
  { id: 'answerer-b', name: '答疑者B', role: 'ANSWERER' },
  { id: 'answerer-c', name: '答疑者C', role: 'ANSWERER' },
  { id: 'admin', name: '管理员', role: 'ADMIN' },
];
const profiles = [
  { userId: 'answerer-a', bio: '极限、微积分与线性代数 · 成年全日制在校研究生，非在职（虚构测试资料）', subjectIds: ['math', 'cs'] },
  { userId: 'answerer-b', bio: '长难句与阅读理解 · 成年全日制在校大学生，非在职（虚构测试资料）', subjectIds: ['english', 'politics'] },
  { userId: 'answerer-c', bio: '数据结构与算法 · 成年全日制在校研究生，非在职（虚构测试资料）', subjectIds: ['cs', 'math'] },
];

/** Add missing demo fixtures; preserve existing users' records and admin profile settings. */
export async function seedDatabase(prisma: PrismaClient) {
  await prisma.$transaction(async (tx) => {
    await tx.writeFence.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    for (const subject of demoSubjects) {
      await tx.subject.upsert({ where: { id: subject.id }, create: subject, update: {} });
    }
    for (const user of demoUsers) {
      await tx.user.upsert({ where: { id: user.id }, create: user, update: {} });
    }
    for (const { subjectIds, ...profile } of profiles) {
      await tx.answererProfile.upsert({
        where: { userId: profile.userId }, update: {},
        create: { ...profile, online: false, heartbeatAt: null,
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
    console.log('测试账号与科目初始化完成；已存在的记录与管理员设置已保留。');
  } finally { await db.$disconnect(); }
}
