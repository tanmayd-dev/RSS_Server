import 'dotenv/config';
import pkg from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import path from 'path';

const { PrismaClient } = pkg;

// Resolve SQLite database file to absolute path
let dbUrl = process.env.DATABASE_URL || 'file:prisma/dev.db';

if (dbUrl.startsWith('file:')) {
  let relativePath = dbUrl.substring(5);
  // If database was migrated with file:./dev.db relative to prisma folder, it is at prisma/dev.db
  if (relativePath === './dev.db') {
    relativePath = 'prisma/dev.db';
  }
  const absolutePath = path.resolve(process.cwd(), relativePath).replace(/\\/g, '/');
  dbUrl = `file:${absolutePath}`;
}

console.log('Initializing Prisma Client with absolute URL:', dbUrl);

const adapter = new PrismaLibSql({
  url: dbUrl,
});

export const prisma = new PrismaClient({ adapter });
export { PrismaClient };
