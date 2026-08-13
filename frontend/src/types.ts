export type FeedType = 'rss' | 'html' | 'reddit' | 'youtube' | 'fourchan';

export interface FeedSource {
  id?: string;
  feedId?: string;
  url: string;
  type: FeedType;
  config: string | null;
  resolvedUrl: string | null;
  lastFetched: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Feed {
  id: string;
  name: string;
  ttl: number;
  lastFetched: string | null;
  createdAt: string;
  updatedAt: string;
  sources: FeedSource[];
  items?: FeedItem[];
  unreadCount?: number;
}

export interface FeedItem {
  id: string;
  feedId: string;
  title: string;
  link: string;
  description: string | null;
  pubDate: string | null;
  guid: string | null;
  extraMetadata: string | null;
  read: boolean;
  createdAt: string;
  feed?: { id: string; name: string };
  source?: { id: string; type: string };
}

export interface HtmlConfig {
  itemSelector: string;
  titleSelector: string;
  linkSelector: string;
  descriptionSelector?: string;
  pubDateSelector?: string;
}

export interface YoutubeConfig {
  includeShorts?: boolean;
}

export interface FourChanConfig {
  board: string;
  query: string;
  topN?: number;
}

export interface ScrapedFeedItem {
  title: string;
  link: string;
  description?: string | null;
  pubDate?: string | null;
  guid?: string | null;
  extraMetadata?: {
    videoId?: string;
    isShort?: boolean;
    thumbnail?: string;
    replies?: number;
    images?: number;
    tim?: number;
    ext?: string;
  } | null;
}
