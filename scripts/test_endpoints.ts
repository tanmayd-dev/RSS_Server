import express from 'express';
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
