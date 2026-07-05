import { Feed as PrismaFeed, FeedItem, FeedSource } from '@prisma/client';
import { Feed } from 'feed';
import { YoutubeConfig } from '../types.js';

/**
 * Generates an RSS 2.0 XML string for a given feed and its items
 */
export function generateRssXml(feed: PrismaFeed & { sources: FeedSource[]; items: (FeedItem & { source?: FeedSource | null })[] }): string {
  let filteredItems = [...feed.items];

  // Apply YouTube Shorts filtering if needed
  filteredItems = filteredItems.filter((item) => {
    if (!item.source || item.source.type !== 'youtube') return true;
    const ytConfig: YoutubeConfig = item.source.config ? JSON.parse(item.source.config) : {};
    if (ytConfig.includeShorts === false) {
      if (!item.extraMetadata) return true;
      try {
        const meta = JSON.parse(item.extraMetadata);
        return meta.isShort !== true;
      } catch {
        return true;
      }
    }
    return true;
  });

  // Sort items in reverse chronological order
  filteredItems.sort((a, b) => {
    const dateA = a.pubDate ? new Date(a.pubDate) : new Date(a.createdAt);
    const dateB = b.pubDate ? new Date(b.pubDate) : new Date(b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });

  // Limit to latest 50 items to keep feed size reasonable
  const feedItemsToInclude = filteredItems.slice(0, 50);

  const sourceUrls = feed.sources.map(s => s.url).join(', ');
  const firstSourceUrl = feed.sources[0]?.url || '';

  const feedInstance = new Feed({
    title: feed.name,
    description: `RSS Feed aggregated from: ${sourceUrls}`,
    id: feed.id,
    link: firstSourceUrl,
    language: 'en',
    generator: 'RSS Aggregator Server',
    updated: feed.lastFetched || new Date(),
    copyright: 'All rights reserved',
    feedLinks: {
      rss2: `/feeds/${feed.id}`,
    },
  });

  feedItemsToInclude.forEach((item) => {
    feedInstance.addItem({
      title: item.title,
      id: item.guid || item.link,
      link: item.link,
      description: item.description || '',
      date: item.pubDate ? new Date(item.pubDate) : new Date(item.createdAt),
    });
  });

  return feedInstance.rss2();
}
