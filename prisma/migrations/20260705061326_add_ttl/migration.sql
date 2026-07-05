-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Feed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" TEXT,
    "resolvedUrl" TEXT,
    "ttl" INTEGER NOT NULL DEFAULT 15,
    "lastFetched" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Feed" ("config", "createdAt", "id", "lastFetched", "name", "resolvedUrl", "type", "updatedAt", "url") SELECT "config", "createdAt", "id", "lastFetched", "name", "resolvedUrl", "type", "updatedAt", "url" FROM "Feed";
DROP TABLE "Feed";
ALTER TABLE "new_Feed" RENAME TO "Feed";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
