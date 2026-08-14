# RSS Aggregator — Frontend

The web UI for the RSS Aggregator server: manage feeds and their sources, test
sources live, force refreshes, and read items with read/unread state.

Built with **React 18 + Vite + Tailwind CSS**. It talks to the server's JSON API
on `http://localhost:3000` (see the [root README](../README.md#api) for the
endpoint reference).

## Commands

```bash
npm install     # install dependencies
npm run dev     # Vite dev server at http://localhost:5173 (hot reload)
npm run build   # typecheck + production build → dist/
npm run preview # serve the production build locally
npm run lint    # eslint
```

The production build (`dist/`) is served by the backend at
`http://localhost:3000` — start the server from the repo root, build here, done.

## Structure

| Path | What it is |
|---|---|
| `src/main.tsx` | React entry point |
| `src/App.tsx` | The whole UI in one component: feed list, add/edit modal, source testing, Zen panel, item reader modal |
| `src/types.ts` | Shared `Feed` / `FeedSource` / `FeedItem` types matching the server's API |
| `index.html`, `tailwind.config.js`, `vite.config.ts` | Build tooling |

## Notes

- The backend must be running for anything to work — the UI shows a connection
  error with a **Retry Connection** button when it can't reach the server.
- The Zen panel shows how to keep the RSS server running (autostart) and links
  to [`../zen/README.md`](../zen/README.md) for the full integration docs.
