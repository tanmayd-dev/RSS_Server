/*
  Warnings:

  - You are about to drop the column `config` on the `Feed` table. All the data in the column will be lost.
  - You are about to drop the column `resolvedUrl` on the `Feed` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `Feed` table. All the data in the column will be lost.
  - You are about to drop the column `url` on the `Feed` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "FeedSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feedId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "resolvedUrl" TEXT,
    "config" TEXT,
    "lastFetched" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FeedSource_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Copy existing feed configurations into FeedSource
-- We use the feed ID as the source ID because it is unique and already exists.
INSERT INTO "FeedSource" ("id", "feedId", "url", "type", "resolvedUrl", "config", "lastFetched", "createdAt", "updatedAt")
SELECT "id", "id", "url", "type", "resolvedUrl", "config", "lastFetched", "createdAt", "updatedAt" FROM "Feed";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Feed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "ttl" INTEGER NOT NULL DEFAULT 15,
    "lastFetched" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Feed" ("createdAt", "id", "lastFetched", "name", "ttl", "updatedAt") SELECT "createdAt", "id", "lastFetched", "name", "ttl", "updatedAt" FROM "Feed";
DROP TABLE "Feed";
ALTER TABLE "new_Feed" RENAME TO "Feed";
CREATE TABLE "new_FeedItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feedId" TEXT NOT NULL,
    "sourceId" TEXT,
    "title" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "description" TEXT,
    "pubDate" DATETIME,
    "guid" TEXT,
    "extraMetadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedItem_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "FeedSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- We select "feedId" as "sourceId" since we mapped Feed.id to FeedSource.id
INSERT INTO "new_FeedItem" ("createdAt", "description", "extraMetadata", "feedId", "sourceId", "guid", "id", "link", "pubDate", "title") 
SELECT "createdAt", "description", "extraMetadata", "feedId", "feedId", "guid", "id", "link", "pubDate", "title" FROM "FeedItem";
DROP TABLE "FeedItem";
ALTER TABLE "new_FeedItem" RENAME TO "FeedItem";
CREATE UNIQUE INDEX "FeedItem_feedId_link_key" ON "FeedItem"("feedId", "link");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
