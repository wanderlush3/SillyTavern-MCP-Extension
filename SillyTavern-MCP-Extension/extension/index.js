/**
 * MCP Extension for SillyTavern
 * Browser-compatible client-side extension supporting both WebSocket and HTTP/SSE MCP transports.
 */

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'mcp';
const EXTENSION_NAME = 'third-party/SillyTavern-MCP-Extension';

/**
 * Default settings
 */
const DEFAULT_SETTINGS = {
    serverUrl: 'ws://localhost:5005',
    logging: {
        level: 'info',
    },
    enabled: false,
};

/**
 * Extension state
 */
let transport = null; // current active transport instance
const tools = new Map();
const activeExecutions = new Map();
let reconnectTimeout = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let csrfToken = null;

async function getCsrfToken() {
    if (!csrfToken) {
        try {
            const response = await fetch('/csrf-token');
            const data = await response.json();
            csrfToken = data.token;
        } catch (err) {
            log('warn', 'Could not fetch CSRF token:', err);
        }
    }
    return csrfToken;
}
let jsonRpcId = 1;
const pendingRequests = new Map(); // id -> { resolve, reject, method }

// ─── Logger ─────────────────────────────────────────────────────────────────

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function getLogLevel() {
    return extension_settings[MODULE_NAME]?.logging?.level || 'info';
}

function log(level, ...args) {
    if (LOG_LEVELS[level] >= LOG_LEVELS[getLogLevel()]) {
        const prefix = `[MCP][${level.toUpperCase()}]`;
        switch (level) {
            case 'error': console.error(prefix, ...args); break;
            case 'warn': console.warn(prefix, ...args); break;
            case 'info': console.info(prefix, ...args); break;
            case 'debug': console.debug(prefix, ...args); break;
            default: console.log(prefix, ...args);
        }
    }
}

// ─── Settings ───────────────────────────────────────────────────────────────

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    extension_settings[MODULE_NAME] = {
        ...DEFAULT_SETTINGS,
        ...extension_settings[MODULE_NAME],
        logging: {
            ...DEFAULT_SETTINGS.logging,
            ...(extension_settings[MODULE_NAME].logging || {}),
        },
    };

    // Migrate old websocket.url setting to serverUrl
    if (extension_settings[MODULE_NAME].websocket?.url && !extension_settings[MODULE_NAME].serverUrl) {
        extension_settings[MODULE_NAME].serverUrl = extension_settings[MODULE_NAME].websocket.url;
    }
}

function getSettings() {
    return extension_settings[MODULE_NAME];
}

// ─── Transport Detection ────────────────────────────────────────────────────

function detectTransportType(url) {
    if (!url || typeof url !== 'string') return null;
    url = url.trim();
    if (url.startsWith('ws://') || url.startsWith('wss://')) return 'websocket';
    if (url.startsWith('http://') || url.startsWith('https://')) return 'http';
    return null;
}

function validateUrl(url) {
    if (!url || typeof url !== 'string' || !url.trim()) {
        return 'MCP server URL is empty. Please enter a URL.';
    }
    const type = detectTransportType(url.trim());
    if (!type) {
        return `Invalid URL: "${url}". Must start with ws://, wss://, http://, or https://`;
    }
    try {
        new URL(url.trim());
    } catch {
        return `Invalid URL format: "${url}". Please check the URL.`;
    }
    return null;
}

// ─── WebSocket Transport ────────────────────────────────────────────────────

class WebSocketTransport {
    constructor(url) {
        this.url = url;
        this.socket = null;
        this.type = 'WebSocket';
    }

    connect(onMessage, onOpen, onClose, onError) {
        this.socket = new WebSocket(this.url);

        this.socket.onopen = () => {
            log('info', `WebSocket connected to ${this.url}`);
            onOpen();
        };

        this.socket.onclose = (event) => {
            const reason = getCloseReason(event.code);
            log('info', `WebSocket closed: ${event.code} (${reason})`);
            onClose(event.code, reason);
        };

        this.socket.onerror = () => {
            log('error', `WebSocket error connecting to ${this.url}`);
            onError(`WebSocket connection failed to ${this.url}`);
        };

        this.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                onMessage(data);
            } catch (err) {
                log('error', 'Failed to parse WebSocket message:', err);
            }
        };
    }

    send(message) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(message));
        }
    }

    close() {
        if (this.socket) {
            this.socket.onopen = null;
            this.socket.onclose = null;
            this.socket.onerror = null;
            this.socket.onmessage = null;
            try { this.socket.close(); } catch { /* ignore */ }
            this.socket = null;
        }
    }

    get connected() {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    }
}

// ─── HTTP/SSE Transport (via server-side proxy to bypass CORS) ──────────────

class HttpSseTransport {
    constructor(url) {
        this.url = url;
        this.type = 'HTTP/SSE';
        this.sessionId = null;
        this._connected = false;
        this._onMessage = null;
        this._onClose = null;
        this._onError = null;
    }

    async connect(onMessage, onOpen, onClose, onError) {
        this._onMessage = onMessage;
        this._onClose = onClose;
        this._onError = onError;

        try {
            log('info', `Connecting to MCP server via proxy: ${this.url}`);
            const initRequest = {
                jsonrpc: '2.0',
                id: jsonRpcId++,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: { name: 'SillyTavern-MCP', version: '1.0.0' },
                },
            };

            const response = await this._proxyFetch(this.url, {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
            }, initRequest);

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(`Server returned HTTP ${response.status}: ${errText || response.statusText}`);
            }

            // Check for session ID
            const sessionHeader = response.headers.get('Mcp-Session-Id');
            if (sessionHeader) {
                this.sessionId = sessionHeader;
            }

            // Parse the response body (which comes through the proxy)
            const responseText = await response.text();
            const messages = this._parseSseOrJson(responseText);

            this._connected = true;
            log('info', `Connected to MCP server via HTTP/SSE proxy`);

            // Deliver any messages from the initialize response
            for (const msg of messages) {
                onMessage(msg);
            }

            onOpen();
        } catch (err) {
            onError(`Failed to connect to ${this.url}: ${err.message}`);
            throw err;
        }
    }

    async _proxyFetch(url, headers, body) {
        const token = await getCsrfToken();
        const fetchHeaders = { 'Content-Type': 'application/json' };
        if (token) {
            fetchHeaders['X-CSRF-Token'] = token;
        }
        return fetch('/api/mcp/proxy', {
            method: 'POST',
            headers: fetchHeaders,
            body: JSON.stringify({
                url: url,
                method: 'POST',
                headers: headers,
                body: body,
            }),
        });
    }

    _parseSseOrJson(text) {
        const messages = [];
        text = text.trim();

        // Try parsing as plain JSON first
        if (text.startsWith('{') || text.startsWith('[')) {
            try {
                messages.push(JSON.parse(text));
                return messages;
            } catch { /* not plain JSON, try SSE */ }
        }

        // Parse as SSE format: look for "data: {...}" lines
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
                const data = trimmed.slice(6).trim();
                if (data) {
                    try {
                        messages.push(JSON.parse(data));
                    } catch {
                        log('debug', 'Non-JSON SSE data line:', data);
                    }
                }
            }
        }

        return messages;
    }

    async send(message) {
        if (!this._connected) {
            log('error', 'Cannot send: not connected');
            return;
        }

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        };
        if (this.sessionId) {
            headers['Mcp-Session-Id'] = this.sessionId;
        }

        try {
            const response = await this._proxyFetch(this.url, headers, message);

            if (!response.ok) {
                log('error', `POST failed: ${response.status}`);
                return;
            }

            const responseText = await response.text();
            const messages = this._parseSseOrJson(responseText);

            for (const msg of messages) {
                if (this._onMessage) this._onMessage(msg);
            }
        } catch (err) {
            log('error', 'Failed to send message:', err);
        }
    }

    close() {
        this._connected = false;
    }

    get connected() {
        return this._connected;
    }
}

// ─── Connection Management ──────────────────────────────────────────────────

const CONNECTION_TIMEOUT_MS = 15000;
let connectionTimeoutId = null;

async function connectToServer() {
    const settings = getSettings();
    const serverUrl = (settings.serverUrl || '').trim();

    const validationError = validateUrl(serverUrl);
    if (validationError) {
        log('error', validationError);
        toastr.error(validationError, 'MCP Connection Error', { timeOut: 8000 });
        updateConnectionStatus(false, validationError);
        settings.enabled = false;
        saveSettingsDebounced();
        return;
    }

    cleanupConnection();

    const transportType = detectTransportType(serverUrl);
    log('info', `Connecting to MCP server at ${serverUrl} (transport: ${transportType})...`);
    toastr.info(`Connecting to ${serverUrl}...`, 'MCP', { timeOut: 3000 });
    updateConnectionStatus(false, 'Connecting...');

    try {
        if (transportType === 'websocket') {
            transport = new WebSocketTransport(serverUrl);
        } else {
            transport = new HttpSseTransport(serverUrl);
        }

        // Set connection timeout
        connectionTimeoutId = setTimeout(() => {
            if (transport && !transport.connected) {
                const msg = `Connection timed out after ${CONNECTION_TIMEOUT_MS / 1000}s. Is the MCP server running at ${serverUrl}?`;
                log('error', msg);
                toastr.error(msg, 'MCP Timeout', { timeOut: 10000 });
                updateConnectionStatus(false, 'Timed out');
                transport.close();
                transport = null;
                scheduleReconnect(settings);
            }
        }, CONNECTION_TIMEOUT_MS);

        await transport.connect(
            // onMessage
            (message) => handleMcpMessage(message),
            // onOpen
            () => {
                clearTimeout(connectionTimeoutId);
                connectionTimeoutId = null;
                reconnectAttempts = 0;
                log('info', `Connected to MCP server via ${transport.type}`);
                toastr.success(`Connected to MCP server via ${transport.type}`, 'MCP', { timeOut: 5000 });
                updateConnectionStatus(true, `Connected via ${transport.type}`);
            },
            // onClose
            (code, reason) => {
                clearTimeout(connectionTimeoutId);
                connectionTimeoutId = null;
                log('info', `Disconnected: ${reason}`);
                if (code !== 1000 && code !== 1001) {
                    toastr.warning(`Disconnected: ${reason}`, 'MCP', { timeOut: 6000 });
                }
                updateConnectionStatus(false, `Disconnected (${reason})`);
                transport = null;
                scheduleReconnect(settings);
            },
            // onError
            (errorMsg) => {
                clearTimeout(connectionTimeoutId);
                connectionTimeoutId = null;
                log('error', errorMsg);
                toastr.error(errorMsg, 'MCP Connection Error', { timeOut: 10000 });
                updateConnectionStatus(false, 'Connection failed');
            },
        );
    } catch (error) {
        clearTimeout(connectionTimeoutId);
        connectionTimeoutId = null;
        log('error', 'Connection failed:', error);
        toastr.error(`Connection failed: ${error.message}`, 'MCP Error', { timeOut: 10000 });
        updateConnectionStatus(false, `Error: ${error.message}`);
        scheduleReconnect(settings);
    }
}

function scheduleReconnect(settings) {
    if (!settings.enabled) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log('warn', `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
        toastr.warning(
            `Stopped reconnecting after ${MAX_RECONNECT_ATTEMPTS} failed attempts. Click Connect to try again.`,
            'MCP',
            { timeOut: 10000 },
        );
        settings.enabled = false;
        saveSettingsDebounced();
        updateConnectionStatus(false, `Failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
        return;
    }

    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, 30000);
    log('info', `Reconnecting in ${delay / 1000}s (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    updateConnectionStatus(false, `Reconnecting in ${delay / 1000}s (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    reconnectTimeout = setTimeout(connectToServer, delay);
}

function cleanupConnection() {
    if (connectionTimeoutId) {
        clearTimeout(connectionTimeoutId);
        connectionTimeoutId = null;
    }
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    if (transport) {
        transport.close();
        transport = null;
    }
}

function disconnectFromServer() {
    reconnectAttempts = 0;
    cleanupConnection();
    log('info', 'Disconnected from MCP server');
    toastr.info('Disconnected from MCP server', 'MCP', { timeOut: 3000 });
    updateConnectionStatus(false, 'Disconnected');
}

function getCloseReason(code) {
    const reasons = {
        1000: 'Normal closure',
        1001: 'Going away',
        1002: 'Protocol error',
        1003: 'Unsupported data',
        1005: 'No status received',
        1006: 'Server may be down',
        1007: 'Invalid payload',
        1008: 'Policy violation',
        1009: 'Message too big',
        1011: 'Internal server error',
        1015: 'TLS handshake failure',
    };
    return reasons[code] || `Unknown (code ${code})`;
}

// ─── MCP Request Helper ─────────────────────────────────────────────────────

async function sendMcpRequest(method, params = {}) {
    if (!transport || !transport.connected) {
        toastr.warning('Not connected to MCP server', 'MCP', { timeOut: 4000 });
        return null;
    }

    const id = jsonRpcId++;
    const request = {
        jsonrpc: '2.0',
        id,
        method,
        params,
    };

    return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject, method });

        // Timeout after 15 seconds
        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error(`Request ${method} timed out`));
            }
        }, 15000);

        transport.send(request);
    });
}

// ─── MCP Message Handling ───────────────────────────────────────────────────

function handleMcpMessage(message) {
    log('debug', 'Received:', message);

    // JSON-RPC response (has id and result/error)
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const pending = pendingRequests.get(message.id);
        if (pending) {
            pendingRequests.delete(message.id);
            if (message.error) {
                log('error', `MCP ${pending.method} error:`, message.error);
                pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
            } else {
                log('info', `MCP ${pending.method} response received`);
                pending.resolve(message.result);
            }
        } else {
            log('info', 'MCP response (no pending handler):', message);
        }
        return;
    }

    // JSON-RPC request or notification from server
    if (message.method) {
        log('info', `MCP server method: ${message.method}`);
        return;
    }

    // Legacy extension messages (tool_registered, etc.)
    if (message.type) {
        handleLegacyMessage(message);
    }
}

function handleLegacyMessage(message) {
    switch (message.type) {
        case 'tool_registered':
            tools.set(message.data.name, message.data.schema);
            updateToolsList();
            break;

        case 'tool_execution_started': {
            const { executionId, name, args } = message.data;
            const element = createToolExecutionElement(name, args);
            const executionsList = document.getElementById('mcp_executions_list');
            if (element && executionsList) {
                const placeholder = executionsList.querySelector('.mcp-no-executions');
                if (placeholder) placeholder.remove();
                executionsList.appendChild(element);
                activeExecutions.set(executionId, { name, args, element });
                updateToolExecutionStatus(executionId, 'running');
            }
            break;
        }

        case 'tool_execution_completed': {
            const { executionId, result } = message.data;
            updateToolExecutionStatus(executionId, 'success', result);
            break;
        }

        case 'tool_execution_failed': {
            const { executionId, error } = message.data;
            updateToolExecutionStatus(executionId, 'error', error);
            break;
        }

        default:
            log('warn', 'Unknown message type:', message.type);
    }
}

// ─── UI Functions ───────────────────────────────────────────────────────────

function updateConnectionStatus(connected, detail) {
    const statusElement = document.getElementById('mcp_ws_status');
    if (statusElement) {
        statusElement.textContent = connected ? 'Connected' : 'Disconnected';
        statusElement.classList.toggle('connected', connected);
    }
    const detailElement = document.getElementById('mcp_ws_detail');
    if (detailElement) {
        detailElement.textContent = detail || '';
        detailElement.style.display = detail ? 'block' : 'none';
    }
}

function updateToolsList() {
    const toolsList = document.getElementById('mcp_tools_list');
    if (!toolsList) return;

    const countEl = document.getElementById('mcp_tools_count');
    if (countEl) {
        countEl.textContent = tools.size > 0 ? `(${tools.size})` : '';
    }

    if (tools.size === 0) {
        toolsList.innerHTML = '<div class="mcp-no-tools">No tools registered</div>';
        return;
    }

    toolsList.innerHTML = '';
    for (const [name, tool] of tools.entries()) {
        const toolEl = document.createElement('div');
        toolEl.className = 'mcp-tool';
        const desc = tool.description || '';
        const inputSchema = tool.inputSchema;
        const paramsHtml = inputSchema && inputSchema.properties
            ? Object.entries(inputSchema.properties).map(([k, v]) => {
                const required = inputSchema.required?.includes(k) ? ' <span class="mcp-required">*</span>' : '';
                return `<div class="mcp-param"><code>${k}</code>${required} — <span class="mcp-param-desc">${v.description || v.type || ''}</span></div>`;
            }).join('')
            : '<div class="mcp-param mcp-param-desc">No parameters</div>';
        toolEl.innerHTML = `
            <div class="mcp-tool-name">${name}</div>
            ${desc ? `<div class="mcp-tool-desc">${desc}</div>` : ''}
            <details class="mcp-tool-params">
                <summary>Parameters</summary>
                ${paramsHtml}
            </details>
        `;
        toolsList.appendChild(toolEl);
    }
}

function createToolExecutionElement(toolName, args) {
    const container = document.createElement('div');
    container.className = 'mcp-tool-execution';
    container.innerHTML = `
            < div class="mcp-tool-header" >
            <h4 class="mcp-tool-name">${toolName}</h4>
            <div class="mcp-tool-status">
                <span class="status-indicator"></span>
                <span class="status-text"></span>
            </div>
        </div >
            <div class="mcp-tool-content">
                <div class="mcp-tool-args">
                    <h5>Arguments</h5>
                    <pre class="args-display">${JSON.stringify(args, null, 2)}</pre>
                </div>
                <div class="mcp-tool-result">
                    <h5>Result</h5>
                    <pre class="result-display"></pre>
                </div>
                <div class="mcp-tool-error hidden">
                    <h5>Error</h5>
                    <pre class="error-display"></pre>
                </div>
            </div>
        `;
    return container;
}

function updateToolExecutionStatus(executionId, status, data) {
    const execution = activeExecutions.get(executionId);
    if (!execution || !execution.element) return;

    const { element } = execution;
    const indicator = element.querySelector('.status-indicator');
    const statusText = element.querySelector('.status-text');
    const resultDisplay = element.querySelector('.result-display');
    const errorDisplay = element.querySelector('.error-display');
    const errorContainer = element.querySelector('.mcp-tool-error');

    if (indicator && statusText) {
        indicator.className = 'status-indicator ' + status;
        statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    }

    if (status === 'success' && resultDisplay && errorContainer) {
        resultDisplay.textContent = JSON.stringify(data, null, 2);
        errorContainer.classList.add('hidden');
    } else if (status === 'error' && errorDisplay && errorContainer) {
        errorDisplay.textContent = JSON.stringify(data, null, 2);
        errorContainer.classList.remove('hidden');
    }

    if (status !== 'running') {
        activeExecutions.delete(executionId);
    }
}

// ─── Event Handlers ─────────────────────────────────────────────────────────

function onServerUrlInput() {
    const settings = getSettings();
    settings.serverUrl = String($('#mcp_server_url').val()).trim();
    saveSettingsDebounced();
}

function onLogLevelChange() {
    const settings = getSettings();
    settings.logging.level = String($('#mcp_log_level').val());
    saveSettingsDebounced();
}

function onConnectClick() {
    const settings = getSettings();
    settings.enabled = true;
    reconnectAttempts = 0;
    saveSettingsDebounced();
    connectToServer();
}

async function onListToolsClick() {
    try {
        toastr.info('Fetching tools list...', 'MCP', { timeOut: 2000 });
        const result = await sendMcpRequest('tools/list');
        if (result && result.tools) {
            tools.clear();
            for (const tool of result.tools) {
                tools.set(tool.name, tool);
            }
            updateToolsList();
            toastr.success(`Found ${result.tools.length} tool(s)`, 'MCP', { timeOut: 4000 });
            log('info', `tools / list returned ${result.tools.length} tools: `, result.tools.map(t => t.name));
        } else {
            toastr.info('Server returned no tools', 'MCP', { timeOut: 4000 });
        }
    } catch (err) {
        log('error', 'tools/list failed:', err);
        toastr.error(`Failed to list tools: ${err.message} `, 'MCP', { timeOut: 6000 });
    }
}

function onDisconnectClick() {
    const settings = getSettings();
    settings.enabled = false;
    saveSettingsDebounced();
    disconnectFromServer();
}

// ─── Initialization ─────────────────────────────────────────────────────────

jQuery(async function () {
    loadSettings();
    const settings = getSettings();

    // Render settings HTML
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    $('#extensions_settings2').append(html);

    // Populate UI from settings
    $('#mcp_server_url').val(settings.serverUrl);
    $('#mcp_log_level').val(settings.logging.level);

    // Bind event handlers
    $('#mcp_server_url').on('input', onServerUrlInput);
    $('#mcp_log_level').on('change', onLogLevelChange);
    $('#mcp_connect').on('click', onConnectClick);
    $('#mcp_disconnect').on('click', onDisconnectClick);
    $('#mcp_list_tools').on('click', onListToolsClick);

    // Update initial UI state
    updateConnectionStatus(false);
    updateToolsList();

    // Auto-connect if previously enabled
    if (settings.enabled) {
        connectToServer();
    }

    log('info', 'MCP Extension initialized');
});