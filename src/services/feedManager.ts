import { Feed, FeedItem, FeedSource } from '@prisma/client';
import { prisma } from './db.js';
import * as scraper from './scraper.js';
import { HtmlConfig, FourChanConfig, YoutubeConfig, ScrapedFeedItem } from '../types.js';

export interface UpdateFeedOptions {
  /** Always re-fetch every source, ignoring TTL (explicit force refresh). */
  force?: boolean;
  /** TTL auto-refresh disabled: only fetch sources that have never been fetched. */
  disabled?: boolean;
}

/**
 * Stable dedup key for a source. Two sources are considered the same when they share
 * type, normalized URL and config, so duplicate rows in one feed are fetched only once.
 */
function buildSourceDedupKey(source: FeedSource): string {
  const url = (source.url || '').trim().replace(/\/+$/, '');
  let configStr = '';
  if (source.config) {
    try {
      const parsed = JSON.parse(source.config);
      const sorted: Record<string, any> = {};
      for (const key of Object.keys(parsed).sort()) {
        sorted[key] = parsed[key];
      }
      configStr = JSON.stringify(sorted);
    } catch {
      configStr = source.config;
    }
  }
  return `${source.type}|${url}|${configStr}`;
}

/**
 * Updates the feed cache by scraping/fetching each of its sources if the cache has expired based on dynamic TTL.
 */
export async function updateFeedIfNeeded(
  feedId: string,
  ttlMinutes: number,
  opts: UpdateFeedOptions = {}
): Promise<Feed & { sources: FeedSource[]; items: FeedItem[] }> {
  const feed = await prisma.feed.findUnique({
    where: { id: feedId },
    include: { sources: true, items: { include: { source: true } } },
  });

  if (!feed) {
    throw new Error(`Feed not found with ID: ${feedId}`);
  }

  const now = new Date();
  let updatedAnySource = false;

  // Cache fetched results per run so duplicate sources in the same feed are only fetched once.
  const fetchedThisRun = new Map<string, { items: ScrapedFeedItem[]; resolvedUrl: string | null }>();

  for (const source of feed.sources) {
    const lastFetched = source.lastFetched;
    let isExpired: boolean;
    if (opts.force) {
      isExpired = true;
    } else if (opts.disabled) {
      // Auto-refresh disabled (Zen-only feeds): only fetch sources never fetched before.
      isExpired = !lastFetched;
    } else {
      isExpired = !lastFetched || (now.getTime() - lastFetched.getTime()) / (1000 * 60) >= ttlMinutes;
    }

    if (!isExpired) {
      continue;
    }

    const dedupKey = buildSourceDedupKey(source);
    const cached = dedupKey ? fetchedThisRun.get(dedupKey) : undefined;

    let resolvedUrl = source.resolvedUrl;
    let itemsToSave: ScrapedFeedItem[] = [];

    try {
      if (cached) {
        // Same source already fetched this run — reuse the results instead of a second network hit.
        console.log(`Source ${source.id} (${source.type}) is a duplicate of an already-fetched source in this feed. Reusing items.`);
        resolvedUrl = cached.resolvedUrl ?? source.resolvedUrl;
        itemsToSave = cached.items;
      } else {
        console.log(`Source ${source.id} (${source.type}) expired. Fetching fresh items...`);
        switch (source.type) {
        case 'rss':
          resolvedUrl = source.url;
          const rssParser = new (await import('rss-parser')).default();
          const rssFeed = await rssParser.parseURL(source.url);
          itemsToSave = rssFeed.items.map((item) => ({
            title: item.title || 'Untitled Post',
            link: item.link || '',
            description: item.content || item.contentSnippet || '',
            pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
            guid: item.guid || item.link || '',
          }));
          break;

        case 'html':
          resolvedUrl = source.url;
          if (!source.config) throw new Error('HTML feed configuration missing');
          const htmlConfig: HtmlConfig = JSON.parse(source.config);
          itemsToSave = await scraper.scrapeHtml(source.url, htmlConfig);
          break;

        case 'reddit':
          if (!resolvedUrl) {
            let sub = source.url.trim();
            const rMatch = sub.match(/reddit\.com\/r\/([a-zA-Z0-9_]+)/i);
            if (rMatch) {
              sub = `r/${rMatch[1]}`;
            } else if (!sub.startsWith('r/')) {
              sub = `r/${sub}`;
            }
            resolvedUrl = `https://www.reddit.com/${sub}/.rss`;
          }
          itemsToSave = await scraper.fetchRedditRss(resolvedUrl);
          break;

        case 'youtube':
          if (!resolvedUrl) {
            const resolved = await scraper.resolveYoutubeChannel(source.url);
            resolvedUrl = resolved.resolvedUrl;
          }
          
          const rawYtItems = await scraper.fetchYoutubeRss(resolvedUrl);
          // Resolve all Shorts checks in parallel using global lookup
          const checkedYtItems = await Promise.all(
            rawYtItems.map(async (rawItem) => {
              const videoId = rawItem.extraMetadata?.videoId;
              if (!videoId) {
                return rawItem;
              }

              // Check if we already cached this video's Short status anywhere in DB
              const existingItem = await prisma.feedItem.findFirst({
                where: { link: rawItem.link },
              });

              let isShort = false;
              if (existingItem && existingItem.extraMetadata) {
                try {
                  const meta = JSON.parse(existingItem.extraMetadata);
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

              return {
                ...rawItem,
                extraMetadata: {
                  ...rawItem.extraMetadata,
                  isShort,
                },
              };
            })
          );
          itemsToSave = checkedYtItems;
          break;

        case 'fourchan':
          if (!source.config) throw new Error('4chan feed configuration missing');
          const chanConfig: FourChanConfig = JSON.parse(source.config);
          const board = chanConfig.board;
          const query = chanConfig.query;
          const topN = chanConfig.topN || 10;
          resolvedUrl = `https://a.4cdn.org/${board}/catalog.json`;
          itemsToSave = await scraper.fetchFourChanFeed(board, query, topN);
          break;

        default:
          console.error(`Unsupported source type: ${source.type}`);
          continue;
        }

        if (dedupKey) {
          fetchedThisRun.set(dedupKey, { items: itemsToSave, resolvedUrl });
        }
      }

      // Save/Upsert new items to the database
      for (const item of itemsToSave) {
        await prisma.feedItem.upsert({
          where: {
            feedId_link: {
              feedId,
              link: item.link,
            },
          },
          create: {
            feedId,
            sourceId: source.id,
            title: item.title,
            link: item.link,
            description: item.description,
            pubDate: item.pubDate,
            guid: item.guid,
            extraMetadata: item.extraMetadata ? JSON.stringify(item.extraMetadata) : null,
          },
          update: {
            sourceId: source.id,
            title: item.title,
            description: item.description,
            pubDate: item.pubDate,
            guid: item.guid,
            extraMetadata: item.extraMetadata ? JSON.stringify(item.extraMetadata) : null,
          },
        });
      }

      // Update source lastFetched and resolvedUrl
      await prisma.feedSource.update({
        where: { id: source.id },
        data: {
          lastFetched: now,
          resolvedUrl,
        },
      });

      updatedAnySource = true;

    } catch (sourceError) {
      console.error(`Failed to update source ${source.id} (${source.url}):`, sourceError);
    }
  }

  // Update feed lastFetched if we updated any source or if it was never fetched
  if (updatedAnySource || !feed.lastFetched) {
    await prisma.feed.update({
      where: { id: feedId },
      data: {
        lastFetched: now,
      },
    });
  }

  // Return the fresh feed state
  const updatedFeed = await prisma.feed.findUnique({
    where: { id: feedId },
    include: { sources: true, items: { include: { source: true } } },
  });

  return updatedFeed!;
}
