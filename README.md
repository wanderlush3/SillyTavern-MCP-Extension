# SillyTavern MCP Extension

Connects SillyTavern to MCP (Model Context Protocol) servers via HTTP/SSE or WebSocket.

## Features

- **Dual transport** — supports `ws://`/`wss://` (WebSocket) and `http://`/`https://` (HTTP/SSE) URLs
- **Server-side proxy** — bypasses browser CORS restrictions for HTTP endpoints (e.g., Supabase Edge Functions)
- **CSRF-aware** — works with SillyTavern's security middleware
- **Tool listing** — fetches and displays available MCP tools with descriptions and parameters
- **Connection feedback** — toast notifications, status panel, auto-reconnect with exponential backoff

## Folder Structure

```
SillyTavern-MCP-Extension-Backup/
├── README.md                 ← You are here
├── extension/                ← Client-side extension (drop into SillyTavern)
│   ├── index.js              ← Main extension logic
│   ├── settings.html         ← Settings UI template
│   ├── style.css             ← Extension styles
│   └── manifest.json         ← Extension metadata
└── server-patch/             ← Server-side proxy (must be added to SillyTavern core)
    └── mcp.js                ← Proxy endpoint for CORS bypass
```

## Installation

### Step 1: Install the Extension

Copy the **entire `extension/` folder** to SillyTavern's third-party extensions directory:

```
<SillyTavern>/public/scripts/extensions/third-party/SillyTavern-MCP-Extension/
```

Make sure the folder is named `SillyTavern-MCP-Extension` and contains `index.js`, `settings.html`, `style.css`, and `manifest.json`.

### Step 2: Install the Server-Side Proxy

This is required for HTTP/SSE MCP servers (like Supabase) that don't send CORS headers.

1. Copy `server-patch/mcp.js` to:
   ```
   <SillyTavern>/src/endpoints/mcp.js
   ```

2. Edit `<SillyTavern>/src/server-startup.js`:

   **Add this import** near the other router imports (around line 52):
   ```javascript
   import { router as mcpRouter } from './endpoints/mcp.js';
   ```

   **Add this route** inside the `setupPrivateEndpoints()` function (around line 184):
   ```javascript
   app.use('/api/mcp', mcpRouter);
   ```

### Step 3: Restart SillyTavern

Fully stop and restart SillyTavern (not just a page refresh) so the server picks up the new endpoint.

## Usage

1. Open SillyTavern and go to **Extensions** in the settings panel
2. Find **MCP Extension** and expand it
3. Paste your MCP server URL (e.g., `https://your-project.supabase.co/functions/v1/your-mcp?key=...`)
4. Click **Connect**
5. Click **Refresh** under "Registered Tools" to verify the connection is pulling data

## Supported URL Formats

| Format | Transport | Example |
|--------|-----------|---------|
| `https://` | HTTP/SSE (proxied) | `https://example.supabase.co/functions/v1/mcp?key=abc` |
| `http://` | HTTP/SSE (proxied) | `http://localhost:3000/mcp` |
| `wss://` | WebSocket | `wss://example.com/mcp` |
| `ws://` | WebSocket | `ws://localhost:5005` |

## Notes

- The server-side proxy is necessary because browsers block cross-origin `fetch()` requests when the target server doesn't send CORS headers. The proxy runs on SillyTavern's Node.js server where CORS doesn't apply.
- WebSocket connections do NOT use the proxy — they connect directly.
- The extension stores settings in SillyTavern's extension settings and will auto-reconnect if enabled.
