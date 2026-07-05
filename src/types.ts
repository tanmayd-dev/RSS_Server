export interface HtmlConfig {
  itemSelector: string;
  titleSelector: string;
  linkSelector: string;
  descriptionSelector?: string;
  pubDateSelector?: string;
}

export interface YoutubeConfig {
  includeShorts?: boolean; // Defaults to true
}

export interface FourChanConfig {
  board: string;
  query: string;
  topN?: number; // Defaults to 10
}

export type FeedType = 'rss' | 'html' | 'reddit' | 'youtube' | 'fourchan';

export interface ScrapedFeedItem {
  title: string;
  link: string;
  description?: string | null;
  pubDate?: Date | null;
  guid?: string | null;
  extraMetadata?: Record<string, any> | null;
}
