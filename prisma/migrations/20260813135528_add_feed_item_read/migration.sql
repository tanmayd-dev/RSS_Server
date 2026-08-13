-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedItem_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "FeedSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FeedItem" ("createdAt", "description", "extraMetadata", "feedId", "guid", "id", "link", "pubDate", "sourceId", "title") SELECT "createdAt", "description", "extraMetadata", "feedId", "guid", "id", "link", "pubDate", "sourceId", "title" FROM "FeedItem";
DROP TABLE "FeedItem";
ALTER TABLE "new_FeedItem" RENAME TO "FeedItem";
CREATE UNIQUE INDEX "FeedItem_feedId_link_key" ON "FeedItem"("feedId", "link");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
