import express from 'express';

export const router = express.Router();

/**
 * MCP Proxy endpoint - forwards HTTP requests to an MCP server,
 * bypassing browser CORS restrictions.
 */
router.post('/proxy', async (request, response) => {
    const { url, method, headers: reqHeaders, body } = request.body;

    if (!url) {
        return response.status(400).json({ error: 'URL is required' });
    }

    try {
        const targetUrl = new URL(url);

        // Only allow http(s) protocols
        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return response.status(400).json({ error: `Invalid protocol: ${targetUrl.protocol}` });
        }

        const fetchHeaders = { ...reqHeaders };
        // Don't forward host/origin headers
        delete fetchHeaders['host'];
        delete fetchHeaders['origin'];
        delete fetchHeaders['referer'];

        const fetchOptions = {
            method: method || 'POST',
            headers: fetchHeaders,
        };

        if (body && method !== 'GET') {
            fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        console.info(`[MCP Proxy] ${fetchOptions.method} ${url}`);
        const proxyResponse = await fetch(url, fetchOptions);

        // Forward status
        response.status(proxyResponse.status);

        // Forward relevant response headers
        const contentType = proxyResponse.headers.get('content-type');
        if (contentType) {
            response.setHeader('Content-Type', contentType);
        }
        const sessionId = proxyResponse.headers.get('mcp-session-id');
        if (sessionId) {
            response.setHeader('Mcp-Session-Id', sessionId);
        }

        // Check if it's SSE - if so, stream the response
        if (contentType && contentType.includes('text/event-stream')) {
            response.setHeader('Cache-Control', 'no-cache');
            response.setHeader('Connection', 'keep-alive');

            const reader = proxyResponse.body.getReader();
            const decoder = new TextDecoder();

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    response.write(chunk);
                }
            } catch (streamErr) {
                console.error('[MCP Proxy] Stream error:', streamErr.message);
            } finally {
                response.end();
            }
        } else {
            // Regular JSON or text response
            const text = await proxyResponse.text();
            response.send(text);
        }
    } catch (error) {
        console.error('[MCP Proxy] Error:', error.message);
        response.status(502).json({
            error: 'Proxy request failed',
            message: error.message,
        });
    }
});
