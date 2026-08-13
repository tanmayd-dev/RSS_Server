import { Router, Request, Response } from 'express';
import { prisma } from './services/db.js';
import * as feedManager from './services/feedManager.js';
import * as feedGenerator from './services/feedGenerator.js';
import * as scraper from './services/scraper.js';
import { findZenProgramDir, status as zenInstallStatus } from './zen/installer.js';

export const router = Router();

/**
 * Health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

/**
 * Register a new feed with multiple sources
 */
router.post('/api/feeds', async (req: Request, res: Response) => {
  const { name, sources, ttl } = req.body;

  if (!name || !sources || !Array.isArray(sources) || sources.length === 0) {
    res.status(400).json({ error: 'Missing required fields: name, sources (array)' });
    return;
  }

  const validTypes = ['rss', 'html', 'reddit', 'youtube', 'fourchan'];
  for (const source of sources) {
    if (!source.url || !source.type) {
      res.status(400).json({ error: 'Each source must have a url and a type' });
      return;
    }
    if (!validTypes.includes(source.type)) {
      res.status(400).json({ error: `Invalid source type: ${source.type}. Must be one of: ${validTypes.join(', ')}` });
      return;
    }
  }

  // Parse TTL. 0 means auto-refresh disabled (the feed is only refreshed on demand, e.g. by Zen).
  let ttlMinutes = 15;
  if (ttl !== undefined && ttl !== null && ttl !== '') {
    ttlMinutes = parseInt(ttl as string, 10);
    if (Number.isNaN(ttlMinutes) || ttlMinutes < 0) {
      res.status(400).json({ error: 'Invalid ttl: must be a non-negative number of minutes' });
      return;
    }
  }

  try {
    const feed = await prisma.feed.create({
      data: {
        name,
        ttl: ttlMinutes,
        sources: {
          create: sources.map((source) => ({
            url: source.url,
            type: source.type,
            config: source.config ? JSON.stringify(source.config) : null,
          })),
        },
      },
      include: {
        sources: true,
      },
    });

    try {
      await feedManager.updateFeedIfNeeded(feed.id, 0);
    } catch (scrapeErr) {
      console.error(`Initial scrape failed for feed ${feed.id}:`, scrapeErr);
    }

    res.status(201).json(feed);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * List all feeds (includes their sources)
 */
router.get('/api/feeds', async (req: Request, res: Response) => {
  try {
    const feeds = await prisma.feed.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        sources: true,
        _count: { select: { items: { where: { read: false } } } },
      },
    });
    res.json(
      feeds.map(({ _count, ...feed }) => ({ ...feed, unreadCount: _count.items }))
    );
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get details of a single feed (includes sources and items)
 */
router.get('/api/feeds/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const feed = await prisma.feed.findUnique({
      where: { id },
      include: {
        sources: true,
        items: { include: { source: true } },
        _count: { select: { items: { where: { read: false } } } },
      },
    });
    if (!feed) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    const { _count, ...feedBody } = feed;
    res.json({ ...feedBody, unreadCount: _count.items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update a feed's metadata and sync its sources
 */
router.put('/api/feeds/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { name, ttl, sources } = req.body;

  if (!name || !sources || !Array.isArray(sources) || sources.length === 0) {
    res.status(400).json({ error: 'Missing required fields: name, sources' });
    return;
  }

  const validTypes = ['rss', 'html', 'reddit', 'youtube', 'fourchan'];
  for (const source of sources) {
    if (!source.url || !source.type) {
      res.status(400).json({ error: 'Each source must have a url and a type' });
      return;
    }
    if (!validTypes.includes(source.type)) {
      res.status(400).json({ error: `Invalid source type: ${source.type}` });
      return;
    }
  }

  // Parse TTL. 0 means auto-refresh disabled (the feed is only refreshed on demand, e.g. by Zen).
  let ttlMinutes = 15;
  if (ttl !== undefined && ttl !== null && ttl !== '') {
    ttlMinutes = parseInt(ttl as string, 10);
    if (Number.isNaN(ttlMinutes) || ttlMinutes < 0) {
      res.status(400).json({ error: 'Invalid ttl: must be a non-negative number of minutes' });
      return;
    }
  }

  try {
    // Get current sources to identify ones to delete
    const currentFeed = await prisma.feed.findUnique({
      where: { id },
      include: { sources: true },
    });

    if (!currentFeed) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }

    const incomingIds = sources.map((s: any) => s.id).filter(Boolean);
    const sourcesToDelete = currentFeed.sources.filter((s) => !incomingIds.includes(s.id));

    // Transaction to update metadata and sync sources
    const result = await prisma.$transaction(async (tx) => {
      // Delete removed sources (cascades to delete their feed items)
      if (sourcesToDelete.length > 0) {
        await tx.feedSource.deleteMany({
          where: {
            id: { in: sourcesToDelete.map((s) => s.id) },
          },
        });
      }

      // Update feed-level fields
      await tx.feed.update({
        where: { id },
        data: {
          name,
          ttl: ttlMinutes,
        },
      });

      // Create/Update sources
      for (const source of sources) {
        const configString = source.config ? JSON.stringify(source.config) : null;
        if (source.id) {
          // Update existing source
          const existingSource = currentFeed.sources.find((s) => s.id === source.id);
          await tx.feedSource.update({
            where: { id: source.id },
            data: {
              url: source.url,
              type: source.type,
              config: configString,
              // If the URL changed, reset resolvedUrl so it re-resolves
              resolvedUrl: source.url !== existingSource?.url ? null : undefined,
            },
          });
        } else {
          // Create new source
          await tx.feedSource.create({
            data: {
              feedId: id,
              url: source.url,
              type: source.type,
              config: configString,
            },
          });
        }
      }

      return tx.feed.findUnique({
        where: { id },
        include: { sources: true },
      });
    });

    if (result) {
      try {
        await feedManager.updateFeedIfNeeded(result.id, 0);
      } catch (scrapeErr) {
        console.error(`Scrape on update failed for feed ${result.id}:`, scrapeErr);
      }
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a feed (automatically cascades to delete feed items and sources)
 */
router.delete('/api/feeds/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    await prisma.feed.delete({
      where: { id },
    });
    res.json({ message: 'Feed deleted successfully' });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * Read-only status of the Zen integration (same core as zen-install.exe status).
 * Never writes — safe to expose on the loopback-only server.
 */
router.get('/api/zen/status', (_req: Request, res: Response) => {
  try {
    const report = zenInstallStatus();
    const target = report.target;
    res.json({
      zenFound: report.zenFound,
      appInstalled: !!findZenProgramDir(),
      appRoot: report.appRoot,
      profileCount: report.profiles.length,
      installed: !!target && (report.loader.present || report.engine.present),
      running: !!target?.running,
      targetName: target?.name ?? null,
      error: report.zenFound
        ? null
        : report.appRoot
          ? `No Zen profiles found at ${report.appRoot}`
          : 'Zen is not supported on this platform',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * List aggregated items (the reader).
 * Query params: feedId, unreadOnly=true, limit (default 50, max 200), offset, since (ISO date)
 */
router.get('/api/items', async (req: Request, res: Response) => {
  try {
    const feedId = req.query.feedId as string | undefined;
    const unreadOnly = req.query.unreadOnly === 'true';
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const since = req.query.since as string | undefined;

    const where: any = {};
    if (feedId) where.feedId = feedId;
    if (unreadOnly) where.read = false;
    if (since) {
      const sinceDate = new Date(since);
      if (!Number.isNaN(sinceDate.getTime())) {
        where.createdAt = { gte: sinceDate };
      }
    }

    const [items, total, unreadTotal] = await Promise.all([
      prisma.feedItem.findMany({
        where,
        orderBy: [{ pubDate: 'desc' }, { createdAt: 'desc' }],
        skip: offset,
        take: limit,
        include: {
          feed: { select: { id: true, name: true } },
          source: { select: { id: true, type: true } },
        },
      }),
      prisma.feedItem.count({ where }),
      prisma.feedItem.count({ where: { ...where, read: false } }),
    ]);

    res.json({ items, total, unreadTotal, limit, offset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Mark a single item read/unread.
 */
router.patch('/api/items/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { read } = req.body;
  if (typeof read !== 'boolean') {
    res.status(400).json({ error: 'Missing required field: read (boolean)' });
    return;
  }
  try {
    const item = await prisma.feedItem.update({ where: { id }, data: { read } });
    res.json(item);
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * Mark items read in bulk: { ids?: string[], feedId?: string }.
 * ids → those items; feedId → every item in that feed; neither → every item.
 */
router.post('/api/items/read', async (req: Request, res: Response) => {
  try {
    const { ids, feedId } = req.body ?? {};
    const where: any = { read: false };
    if (Array.isArray(ids) && ids.length > 0) {
      where.id = { in: ids };
    } else if (feedId) {
      where.feedId = feedId;
    }
    const result = await prisma.feedItem.updateMany({ where, data: { read: true } });
    res.json({ count: result.count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Test feed selectors or queries in real-time
 */
router.post('/api/feeds/test', async (req: Request, res: Response) => {
  const { type, url, config } = req.body;

  if (!type) {
    res.status(400).json({ error: 'Missing type parameter' });
    return;
  }

  try {
    let items: any[] = [];

    switch (type) {
      case 'html':
        if (!url || !config) {
          res.status(400).json({ error: 'Missing url or config (selectors) for HTML scraper' });
          return;
        }
        items = await scraper.scrapeHtml(url, config);
        break;

      case 'reddit':
        if (!url) {
          res.status(400).json({ error: 'Missing subreddit url or handle' });
          return;
        }
        items = await scraper.fetchRedditRss(url);
        break;

      case 'youtube':
        if (!url) {
          res.status(400).json({ error: 'Missing YouTube channel URL' });
          return;
        }
        const { resolvedUrl } = await scraper.resolveYoutubeChannel(url);
        const rawYtItems = await scraper.fetchYoutubeRss(resolvedUrl);
        const includeShorts = config?.includeShorts !== false;

        // Perform parallel Shorts check for testing
        const checkedItems = await Promise.all(
          rawYtItems.map(async (item) => {
            const videoId = item.extraMetadata?.videoId;
            let isShort = false;
            if (videoId) {
              // Try check in DB first to save overhead, if not test it
              const cachedItem = await prisma.feedItem.findFirst({
                where: { link: item.link },
              });
              if (cachedItem && cachedItem.extraMetadata) {
                try {
                  const meta = JSON.parse(cachedItem.extraMetadata);
                  if (meta.isShort !== undefined) {
                    isShort = meta.isShort;
                  } else {
                    isShort = await scraper.checkIsYoutubeShort(videoId);
                  }
                } catch {
                  isShort = await scraper.checkIsYoutubeShort(videoId);
                }
              } else {
                isShort = await scraper.checkIsYoutubeShort(videoId);
              }
            }
            return {
              ...item,
              extraMetadata: { ...item.extraMetadata, isShort },
            };
          })
        );

        if (!includeShorts) {
          items = checkedItems.filter((item) => item.extraMetadata.isShort !== true);
        } else {
          items = checkedItems;
        }
        break;

      case 'fourchan':
        if (!config || !config.board || !config.query) {
          res.status(400).json({ error: 'Missing board or query parameter inside config' });
          return;
        }
        items = await scraper.fetchFourChanFeed(config.board, config.query, config.topN || 10);
        break;

      default:
        res.status(400).json({ error: `Unsupported test feed type: ${type}` });
        return;
    }

    res.json({ count: items.length, items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Force refresh a feed cache immediately and return the updated feed
 */
router.post('/api/feeds/:id/refresh', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const feed = await prisma.feed.findUnique({ where: { id } });
    if (!feed) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    const updatedFeed = await feedManager.updateFeedIfNeeded(id, 0, { force: true });
    res.json(updatedFeed);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Fetch and return the generated RSS XML feed.
 * TTL is determined dynamically:
 * 1. From the link query parameter (?ttl=30)
 * 2. Stored feed TTL
 * 3. Default to 15 minutes
 */
router.get('/feeds/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    const feed = await prisma.feed.findUnique({ where: { id } });
    if (!feed) {
      res.status(404).send('Feed not found');
      return;
    }

    // TTL is determined dynamically:
    // 1. From the link query parameter (?ttl=30) — ?ttl=0 forces a refresh.
    // 2. From the stored feed TTL. A stored TTL of 0 means auto-refresh is disabled
    //    (Zen-only feeds): the feed is only fetched if never fetched, or when an
    //    explicit refresh is requested (?ttl=0 or POST /api/feeds/:id/refresh).
    // 3. Default to 15 minutes.
    let ttl = feed.ttl ?? 15;
    let force = false;
    let disabled = false;

    const queryTtlRaw = req.query.ttl;
    if (queryTtlRaw !== undefined) {
      const parsedTtl = parseInt(queryTtlRaw as string, 10);
      if (Number.isNaN(parsedTtl) || parsedTtl < 0) {
        res.status(400).send('Invalid ttl parameter');
        return;
      }
      ttl = parsedTtl;
      force = parsedTtl === 0;
    } else if (ttl === 0) {
      disabled = true;
    }

    // Refresh feed items cache if expired
    const updatedFeed = await feedManager.updateFeedIfNeeded(id, ttl, { force, disabled });

    // Generate XML feed
    const xml = feedGenerator.generateRssXml(updatedFeed);

    // Serve RSS XML
    res.header('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (error: any) {
    console.error('Error generating RSS feed XML:', error);
    res.status(500).send(`Internal Server Error: ${error.message}`);
  }
});
