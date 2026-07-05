import express from 'express';
import path from 'path';
import { chromium } from 'playwright';
import { router } from '../src/routes.js';
import { prisma } from '../src/services/db.js';

// Setup Express test server
const app = express();
app.use(express.json());
app.use(router);

const frontendDistPath = path.join(process.cwd(), 'frontend/dist');
app.use(express.static(frontendDistPath));

app.get('/*splat', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/feeds')) {
    return next();
  }
  res.sendFile(path.join(frontendDistPath, 'index.html'));
});

const PORT = 3002;
const BASE_URL = `http://localhost:${PORT}`;

async function main() {
  console.log('\n=== Starting Headless Browser Integration Test ===\n');

  // Start the server
  const server = app.listen(PORT, () => {
    console.log(`[Test Server] Running at ${BASE_URL}`);
  });

  // Ensure DB clean state
  await prisma.feed.deleteMany({
    where: {
      name: { in: ['Browser Test Channel', 'Test HTML Feed'] }
    }
  });

  // Launch browser
  console.log('Launching headless Chromium browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. Load dashboard
    console.log(`Navigating to ${BASE_URL}...`);
    await page.goto(BASE_URL);
    
    // Verify title
    const title = await page.title();
    console.log(`Page title: "${title}"`);
    if (!title.includes('RSS Aggregator')) {
      throw new Error('Title does not match expected');
    }

    // 2. Toggle Theme (Dark Mode)
    console.log('Testing Dark Mode Toggle...');
    const bodyClassBefore = await page.evaluate(() => document.documentElement.className);
    console.log(`Class list before toggle: "${bodyClassBefore}"`);
    
    // Click theme toggle button
    const themeBtn = page.locator('button[title="Toggle Theme"]');
    await themeBtn.click();
    
    const bodyClassAfter = await page.evaluate(() => document.documentElement.className);
    console.log(`Class list after toggle: "${bodyClassAfter}"`);
    if (bodyClassBefore.includes('dark') === bodyClassAfter.includes('dark')) {
      throw new Error('Theme toggle failed to change dark class');
    }

    // Toggle it back
    await themeBtn.click();

    // 3. Register Feed Flow (YouTube)
    console.log('\nTesting "Add Feed" modal flow...');
    const addFeedBtn = page.locator('button:has-text("Add Feed")');
    await addFeedBtn.click();

    // Verify modal visible
    const modalHeader = page.locator('h3:has-text("Register New Feed")');
    await modalHeader.waitFor({ state: 'visible' });
    console.log('Modal registered: Visible!');

    // Select YouTube type
    console.log('Selecting YouTube feed type...');
    const ytTypeBtn = page.locator('button:has-text("youtube")');
    await ytTypeBtn.click();

    // Fill form
    console.log('Filling form inputs...');
    await page.fill('input[placeholder="e.g. T3.gg Updates"]', 'Browser Test Channel');
    await page.fill('input[placeholder="https://www.youtube.com/@t3dotgg"]', 'https://www.youtube.com/@t3dotgg');

    // 4. Test Connection Flow
    console.log('Clicking "Test Connection" button...');
    const testConnectionBtn = page.locator('button:has-text("Test Connection")');
    await testConnectionBtn.click();

    console.log('Waiting for scraper response...');
    const successIndicator = page.locator('text=Success! Found').first();
    await successIndicator.waitFor({ state: 'visible', timeout: 15000 });
    console.log('Connection test completed successfully!');

    // Print first item from preview list
    const previewItem = page.locator('ul > li').first();
    const itemTitle = await previewItem.locator('div').first().innerText();
    console.log(`First scraped preview item title: "${itemTitle}"`);

    // 5. Submit Form
    console.log('Clicking "Save Feed" to register...');
    const saveBtn = page.locator('button:has-text("Save Feed")');
    await saveBtn.click();

    // Wait for modal to close and row to appear in table
    console.log('Waiting for table update...');
    const tableRow = page.locator('tr:has-text("Browser Test Channel")');
    await tableRow.waitFor({ state: 'visible' });
    console.log('Feed successfully added to dashboard table!');

    // 5.5 Verify RSS XML Feed Content
    console.log('\n=== Verifying Generated RSS XML Feed Data ===');
    const registeredFeed = await prisma.feed.findFirst({
      where: { name: 'Browser Test Channel' }
    });
    if (!registeredFeed) {
      throw new Error('Failed to find registered feed in database');
    }
    const feedId = registeredFeed.id;
    const rssFeedUrl = `${BASE_URL}/feeds/${feedId}?ttl=0`;
    console.log(`Requesting generated RSS XML: ${rssFeedUrl}`);
    
    const xmlResponse = await page.request.get(rssFeedUrl);
    if (xmlResponse.status() !== 200) {
      throw new Error(`Failed to fetch RSS feed, status: ${xmlResponse.status()}`);
    }
    
    const contentType = xmlResponse.headers()['content-type'] || '';
    console.log(`Feed Content-Type: "${contentType}"`);
    if (!contentType.includes('xml')) {
      throw new Error(`Expected XML content type, got: ${contentType}`);
    }

    const xmlText = await xmlResponse.text();
    if (!xmlText.includes('<?xml version="1.0" encoding="utf-8"?>')) {
      throw new Error('RSS Feed is missing XML declaration header');
    }
    if (!xmlText.includes('<rss version="2.0">')) {
      throw new Error('RSS Feed is missing <rss version="2.0"> element');
    }
    if (!xmlText.includes('<title>Browser Test Channel</title>')) {
      throw new Error('RSS Feed title does not match registered name');
    }
    
    // Verify that the title of the video we saw in the preview is inside the XML feed!
    const matchesTitle = xmlText.includes(itemTitle);
    console.log(`Does XML feed contain scraped title "${itemTitle}"? ${matchesTitle}`);
    if (!matchesTitle) {
      throw new Error(`RSS Feed XML did not contain the scraped item title: "${itemTitle}"`);
    }
    console.log('RSS Feed XML structure and content verified successfully!');

    // 6. Dynamic TTL dropdown test
    console.log('\nTesting TTL dropdown and link copy generation...');
    const selectDropdown = tableRow.locator('select');
    await selectDropdown.selectOption({ value: '30' }); // Select 30 minutes
    console.log('Dropdown changed to 30 minutes.');

    const copiedLinkSpan = tableRow.locator('span.truncate');
    const linkValue = await copiedLinkSpan.innerText();
    console.log(`Generated copy link text: "${linkValue}"`);
    if (!linkValue.includes('?ttl=30')) {
      throw new Error('Link copy URL did not dynamically append "?ttl=30"');
    }
    console.log('TTL query parameter dynamic generation verified!');

    // 7. Delete Feed
    console.log('\nTesting delete feed flow...');
    // Handle the browser confirm popup automatically
    page.once('dialog', async dialog => {
      console.log(`Alert dialog popped up: "${dialog.message()}"`);
      await dialog.accept(); // click OK
    });

    const deleteBtn = tableRow.locator('button[title="Delete Feed"]');
    await deleteBtn.click();

    // Verify row is gone
    await tableRow.waitFor({ state: 'detached' });
    console.log('Feed successfully deleted and table is empty!');

    console.log('\n=== All Headless Browser Tests Passed! ===\n');

  } catch (error) {
    console.error('Test failed with error:', error);
    process.exitCode = 1;
  } finally {
    console.log('Closing browser...');
    await browser.close();
    console.log('Stopping server...');
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log('Cleanup finished.');
  }
}

main();
