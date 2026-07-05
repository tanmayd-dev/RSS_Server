import express from 'express';
import path from 'path';
import { router } from './routes.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Register API routes
app.use(router);

// Serve static assets from the frontend build directory
const frontendDistPath = path.join(process.cwd(), 'frontend/dist');
app.use(express.static(frontendDistPath));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Wildcard fallback for React Router SPA (serves index.html for client-side routing)
app.get('/*splat', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/feeds')) {
    return next();
  }
  res.sendFile(path.join(frontendDistPath, 'index.html'));
});

app.listen(port, () => {
  console.log(`[Server] RSS Aggregator Server listening at http://localhost:${port}`);
});
