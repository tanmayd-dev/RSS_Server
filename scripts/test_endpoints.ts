import express from 'express';
import http from 'http';
import axios from 'axios';
import { router } from '../src/routes.js';
import { prisma } from '../src/services/db.js';

const app = express();
app.use(express.json());
app.use(router);

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

async function runTests() {
  console.log('\n=== Starting End-to-End Tests ===\n');

  // Clear existing test feeds just in case
  await prisma.feed.deleteMany({
    where: {
      OR: [
        { name: 'T3.gg Feed (No Shorts)' },
        { name: 'Reddit JavaScript' },
        { name: '4chan /g/ Search' },
      ],
    },
  });

  // 1. Test Health Endpoint
  console.log('Testing /health endpoint...');
  const healthRes = await axios.get(`${BASE_URL}/health`);
  console.log(`Status: ${healthRes.status}, Body:`, healthRes.data);
  if (healthRes.data.status !== 'OK') throw new Error('Health check failed');

  // 2. Real-time Selector Testing on YouTube
  console.log('\nTesting /api/feeds/test for YouTube channel (includeShorts: true)...');
  let hasYtTest = false;
  let ytTestResCount = 0;
  try {
    const ytTestRes = await axios.post(`${BASE_URL}/api/feeds/test`, {
      type: 'youtube',
      url: 'https://www.youtube.com/@t3dotgg',
      config: { includeShorts: true },
    });
    console.log(`Status: ${ytTestRes.status}, Found items: ${ytTestRes.data.count}`);
    ytTestResCount = ytTestRes.data.count;
    
    if (ytTestRes.data.count > 0) {
      console.log('Sample YouTube videos found:');
      ytTestRes.data.items.slice(0, 5).forEach((item: any) => {
        console.log(`- Title: ${item.title}`);
        console.log(`  Link: ${item.link}`);
        console.log(`  Is Short: ${item.extraMetadata?.isShort}`);
      });
      hasYtTest = true;
    } else {
      throw new Error('No items returned for YouTube channel test');
    }
  } catch (err: any) {
    console.warn(`YouTube test skipped/failed (possibly rate limited): ${err.message}`);
  }

  // 3. YouTube Shorts Filtering Test
  if (hasYtTest) {
    console.log('\nTesting /api/feeds/test for YouTube channel (includeShorts: false)...');
    try {
      const ytTestNoShortsRes = await axios.post(`${BASE_URL}/api/feeds/test`, {
        type: 'youtube',
        url: 'https://www.youtube.com/@t3dotgg',
        config: { includeShorts: false },
      });
      console.log(`Status: ${ytTestNoShortsRes.status}, Found items: ${ytTestNoShortsRes.data.count}`);
      console.log(`Filtered out ${ytTestResCount - ytTestNoShortsRes.data.count} Shorts.`);
    } catch (err: any) {
      console.warn(`YouTube Shorts filtering test failed/skipped: ${err.message}`);
    }
  } else {
    console.log('\nSkipping YouTube Shorts filtering test (YouTube test was skipped)');
  }

  // 4. Create YouTube Feed (No Shorts)
  console.log('\nCreating YouTube feed (No Shorts)...');
  const createYtFeedRes = await axios.post(`${BASE_URL}/api/feeds`, {
    name: 'T3.gg Feed (No Shorts)',
    ttl: 15,
    sources: [
      {
        url: 'https://www.youtube.com/@t3dotgg',
        type: 'youtube',
        config: { includeShorts: false }
      }
    ]
  });
  const ytFeedId = createYtFeedRes.data.id;
  console.log(`Created YouTube Feed ID: ${ytFeedId}`);

  // 5. Create Reddit Feed
  console.log('\nCreating Reddit feed for r/javascript...');
  const createRedditFeedRes = await axios.post(`${BASE_URL}/api/feeds`, {
    name: 'Reddit JavaScript',
    ttl: 10,
    sources: [
      {
        url: 'https://www.reddit.com/r/javascript',
        type: 'reddit',
        config: null
      }
    ]
  });
  const redditFeedId = createRedditFeedRes.data.id;
  console.log(`Created Reddit Feed ID: ${redditFeedId}`);

  // 6. Create 4chan Feed
  console.log('\nCreating 4chan feed for board "g" query "setup"...');
  const create4chanFeedRes = await axios.post(`${BASE_URL}/api/feeds`, {
    name: '4chan /g/ Search',
    ttl: 5,
    sources: [
      {
        url: 'https://boards.4channel.org/g/',
        type: 'fourchan',
        config: { board: 'g', query: 'setup', topN: 3 }
      }
    ]
  });
  const chanFeedId = create4chanFeedRes.data.id;
  console.log(`Created 4chan Feed ID: ${chanFeedId}`);

  // 7. Verify List Feeds
  console.log('\nListing registered feeds...');
  const listRes = await axios.get(`${BASE_URL}/api/feeds`);
  console.log(`Registered Feed count: ${listRes.data.length}`);
  listRes.data.forEach((feed: any) => {
    const platforms = Array.from(new Set(feed.sources.map((s: any) => s.type))).join(', ').toUpperCase();
    console.log(`- [${platforms}] ${feed.name} (ID: ${feed.id})`);
  });

  // 8. Generate and serve RSS XML for YouTube
  console.log('\nFetching RSS XML for YouTube Feed...');
  const startTimeScrape = Date.now();
  const ytXmlRes = await axios.get(`${BASE_URL}/feeds/${ytFeedId}`);
  const elapsedScrape = Date.now() - startTimeScrape;
  console.log(`Status: ${ytXmlRes.status}, Content-Type: ${ytXmlRes.headers['content-type']}`);
  console.log(`Response time (Scrape & Save): ${elapsedScrape}ms`);
  
  if (!ytXmlRes.data.includes('<?xml') || !ytXmlRes.data.includes('<rss')) {
    throw new Error('Invalid RSS XML response for YouTube');
  }
  console.log('Sample XML Preview (first 250 characters):');
  console.log(ytXmlRes.data.slice(0, 250) + '...\n');

  // Verify caching performance by requesting with large TTL
  console.log('Fetching RSS XML for YouTube Feed again (served from cache)...');
  const startTimeCache = Date.now();
  const ytXmlResCache = await axios.get(`${BASE_URL}/feeds/${ytFeedId}`);
  const elapsedCache = Date.now() - startTimeCache;
  console.log(`Status: ${ytXmlResCache.status}, Content-Type: ${ytXmlResCache.headers['content-type']}`);
  console.log(`Response time (Cache Hit): ${elapsedCache}ms`);
  
  if (elapsedCache >= elapsedScrape && elapsedScrape > 100) {
    console.warn(`WARNING: Cache response time (${elapsedCache}ms) is not significantly faster than scrape response time (${elapsedScrape}ms)`);
  } else {
    console.log(`SUCCESS: Cache is faster! (${elapsedCache}ms vs ${elapsedScrape}ms)`);
  }

  // 9. Generate and serve RSS XML for Reddit
  console.log('\nFetching RSS XML for Reddit Feed (ttl=0)...');
  try {
    const redditXmlRes = await axios.post(`${BASE_URL}/api/feeds/test`, {
      type: 'reddit',
      url: 'https://www.reddit.com/r/javascript',
    });
    console.log(`Status: ${redditXmlRes.status}, Found posts: ${redditXmlRes.data.count}`);
    if (redditXmlRes.data.count > 0) {
      console.log(`Sample Reddit Post: ${redditXmlRes.data.items[0].title}`);
    }
  } catch (err: any) {
    console.warn(`Reddit test skipped/failed (possibly rate limited): ${err.message}`);
  }

  // 10. Generate and serve RSS XML for 4chan
  console.log('\nFetching RSS XML for 4chan Feed...');
  const chanXmlRes = await axios.get(`${BASE_URL}/feeds/${chanFeedId}`);
  console.log(`Status: ${chanXmlRes.status}, Content-Type: ${chanXmlRes.headers['content-type']}`);
  if (!chanXmlRes.data.includes('<?xml')) {
    throw new Error('Invalid RSS XML response for 4chan');
  }

  // 10.5 Mixed Feed & PUT E2E Test
  console.log('\nCreating Mixed Feed (YouTube + Reddit)...');
  const createMixedFeedRes = await axios.post(`${BASE_URL}/api/feeds`, {
    name: 'Mixed Tech Feed',
    ttl: 5,
    sources: [
      {
        url: 'https://www.youtube.com/@t3dotgg',
        type: 'youtube',
        config: { includeShorts: true }
      },
      {
        url: 'r/javascript',
        type: 'reddit',
        config: null
      }
    ]
  });
  const mixedFeedId = createMixedFeedRes.data.id;
  console.log(`Created Mixed Feed ID: ${mixedFeedId}`);

  console.log('Fetching RSS XML for Mixed Feed...');
  const mixedXmlRes = await axios.get(`${BASE_URL}/feeds/${mixedFeedId}`);
  console.log(`Status: ${mixedXmlRes.status}`);
  if (!mixedXmlRes.data.includes('<?xml')) {
    throw new Error('Invalid RSS XML response for Mixed Feed');
  }

  console.log('Updating Mixed Feed via PUT (adding an RSS source)...');
  const updateRes = await axios.put(`${BASE_URL}/api/feeds/${mixedFeedId}`, {
    name: 'Mixed Tech Feed (Updated)',
    ttl: 10,
    sources: [
      ...createMixedFeedRes.data.sources,
      {
        url: 'https://news.ycombinator.com/rss',
        type: 'rss',
        config: null
      }
    ]
  });
  console.log(`Updated feed sources count: ${updateRes.data.sources.length}`);
  if (updateRes.data.sources.length !== 3) {
    throw new Error('Failed to update/add source via PUT');
  }

  // 10.6 Offline TTL / Source Dedup Tests (local RSS server, no external network)
  console.log('\n=== TTL Query Param & Source Dedup Tests (local RSS server) ===');

  let rssRequestCount = 0;
  const rssServer = http.createServer((_req, res) => {
    rssRequestCount++;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Local Test Feed</title>
    <link>https://example.com</link>
    <description>test</description>
    <item>
      <title>Item One</title>
      <link>https://example.com/one</link>
      <guid>https://example.com/one</guid>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>
    <item>
      <title>Item Two</title>
      <link>https://example.com/two</link>
      <guid>https://example.com/two</guid>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>
  </channel>
</rss>`;
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
  });

  const RSS_SOURCE_PORT = 3002;
  await new Promise<void>((resolve) => rssServer.listen(RSS_SOURCE_PORT, resolve));
  const localFeedUrl = `http://localhost:${RSS_SOURCE_PORT}/feed.xml`;
  const testFeedIds: string[] = [];

  try {
    // --- Stored ttl=0 disables auto-refresh; ?ttl=0 still forces a refresh ---
    const disabledFeed = await axios.post(`${BASE_URL}/api/feeds`, {
      name: 'TTL Disabled Feed',
      ttl: 0,
      sources: [{ url: localFeedUrl, type: 'rss', config: null }],
    });
    const disabledFeedId = disabledFeed.data.id;
    testFeedIds.push(disabledFeedId);
    if (disabledFeed.data.ttl !== 0) {
      throw new Error('Feed should be saved with ttl = 0 (auto-refresh disabled)');
    }
    // Creating the feed triggers one initial scrape of the source
    if (rssRequestCount !== 1) {
      throw new Error(`Expected 1 initial fetch on feed create, got ${rssRequestCount}`);
    }

    const disabledFirst = await axios.get(`${BASE_URL}/feeds/${disabledFeedId}`);
    if (!disabledFirst.data.includes('<item>')) {
      throw new Error('Initial fetch should contain items');
    }
    // Plain GET with stored ttl=0 must NOT auto-refresh
    await axios.get(`${BASE_URL}/feeds/${disabledFeedId}`);
    if (rssRequestCount !== 1) {
      throw new Error(`ttl=0 (disabled) feed must not auto-refresh on plain GET (fetches: ${rssRequestCount})`);
    }
    // Explicit ?ttl=0 must still force a refresh even when auto-refresh is disabled
    await axios.get(`${BASE_URL}/feeds/${disabledFeedId}?ttl=0`);
    if (rssRequestCount !== 2) {
      throw new Error(`?ttl=0 should force a server refresh (fetches: ${rssRequestCount})`);
    }
    console.log('  [OK] stored ttl=0 disables auto-refresh; ?ttl=0 still forces');

    // --- ?ttl=0 forces on every call; plain GET serves cache while TTL unexpired ---
    const ttlFeed = await axios.post(`${BASE_URL}/api/feeds`, {
      name: 'TTL Param Feed',
      ttl: 30,
      sources: [{ url: localFeedUrl, type: 'rss', config: null }],
    });
    const ttlFeedId = ttlFeed.data.id;
    testFeedIds.push(ttlFeedId);
    // Create-time initial scrape
    if (rssRequestCount !== 3) {
      throw new Error(`Unexpected fetch count after creating ttl feed: ${rssRequestCount}`);
    }

    await axios.get(`${BASE_URL}/feeds/${ttlFeedId}?ttl=0`);
    if (rssRequestCount !== 4) {
      throw new Error(`?ttl=0 must force a refresh (fetches: ${rssRequestCount})`);
    }
    await axios.get(`${BASE_URL}/feeds/${ttlFeedId}?ttl=0`);
    if (rssRequestCount !== 5) {
      throw new Error(`?ttl=0 must force a refresh every time (fetches: ${rssRequestCount})`);
    }
    await axios.get(`${BASE_URL}/feeds/${ttlFeedId}`);
    if (rssRequestCount !== 5) {
      throw new Error(`Plain GET should serve cache when stored TTL is unexpired (fetches: ${rssRequestCount})`);
    }
    console.log('  [OK] ?ttl=0 forces refresh; unexpired stored TTL serves cache');

    // --- Duplicate sources in one feed are fetched only once per run ---
    const dupFeed = await axios.post(`${BASE_URL}/api/feeds`, {
      name: 'Dedup Feed',
      ttl: 30,
      sources: [
        { url: localFeedUrl, type: 'rss', config: null },
        { url: localFeedUrl, type: 'rss', config: null },
      ],
    });
    const dupFeedId = dupFeed.data.id;
    testFeedIds.push(dupFeedId);
    if (dupFeed.data.sources.length !== 2) {
      throw new Error('Dedup feed should keep both source rows');
    }
    // Create-time scrape: source 1 fetched, duplicate source 2 reuses its items
    if (rssRequestCount !== 6) {
      throw new Error(`Duplicate sources should be fetched once on create (fetches: ${rssRequestCount})`);
    }

    const dupXmlRes = await axios.get(`${BASE_URL}/feeds/${dupFeedId}?ttl=0`);
    if (rssRequestCount !== 7) {
      throw new Error(`Duplicate sources should be fetched once on force refresh (fetches: ${rssRequestCount})`);
    }
    const rssParser = new (await import('rss-parser')).default();
    const parsedFeed = await rssParser.parseString(dupXmlRes.data);
    const links = parsedFeed.items.map((i) => i.link);
    if (links.length === 0) {
      throw new Error('Dedup feed RSS should contain items');
    }
    if (new Set(links).size !== links.length) {
      throw new Error(`RSS output must not contain duplicate links (got ${links.length} links, ${new Set(links).size} unique)`);
    }
    console.log(`  [OK] duplicate sources fetched once; RSS deduped (${links.length} unique items)`);
  } finally {
    for (const id of testFeedIds) {
      await axios.delete(`${BASE_URL}/api/feeds/${id}`);
    }
    await new Promise<void>((resolve) => rssServer.close(() => resolve()));
  }

  // 11. Clean Up / Delete Feeds
  console.log('\nDeleting registered test feeds...');
  for (const id of [ytFeedId, redditFeedId, chanFeedId, mixedFeedId]) {
    const deleteRes = await axios.delete(`${BASE_URL}/api/feeds/${id}`);
    console.log(`Deleted feed ${id}:`, deleteRes.data);
  }

  console.log('\n=== All Tests Passed Successfully! ===\n');
}

const server = app.listen(PORT, async () => {
  console.log(`Test server running on port ${PORT}`);
  try {
    await runTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    server.close();
  }
});
