import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { HttpsProxyAgent } from "https-proxy-agent"; 
import dotenv from 'dotenv';

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const TARGET = 'https://chatgpt.com';
const MY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ----------------------------------------------------------------------
// 1. PROXY CONFIGURATION (THE FIX)
// ----------------------------------------------------------------------
const PROXY_SERVER_URL = process.env.PROXY_URL; 

// We MUST add 'rejectUnauthorized: false' or Node.js will drop the connection
const proxyAgent = PROXY_SERVER_URL ? new HttpsProxyAgent(PROXY_SERVER_URL, {
    rejectUnauthorized: false, 
    keepAlive: true,
    timeout: 10000 
}) : null;

if (proxyAgent) {
    console.log(`[System] Using Proxy Agent: ${PROXY_SERVER_URL.replace(/:[^:]*@/, ':****@')}`);
}

// ----------------------------------------------------------------------
// 2. COOKIE CONFIGURATION
// ----------------------------------------------------------------------
const MY_COOKIE_VALUE = process.env.COOKIES;
if (!MY_COOKIE_VALUE) {
    console.error("CRITICAL ERROR: 'COOKIES' environment variable is missing!");
    process.exit(1);
}
// Ensure we handle both cases: if user pasted full token or just value
const MY_COOKIE = MY_COOKIE_VALUE.startsWith('__Secure') 
    ? MY_COOKIE_VALUE 
    : `__Secure-next-auth.session-token=${MY_COOKIE_VALUE}`;

// ----------------------------------------------------------------------
// 3. MIDDLEWARE
// ----------------------------------------------------------------------
const proxyMiddleware = createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    agent: proxyAgent, // Apply the fixed agent
    cookieDomainRewrite: { "*": "" },
    followRedirects: false,

    on: {
        proxyReq: (proxyReq, req, res) => {
            // Safety check
            if (proxyReq.destroyed) return;

            try {
                // Strip Identity
                proxyReq.removeHeader('Cookie');
                proxyReq.removeHeader('User-Agent');
                proxyReq.removeHeader('x-forwarded-for');
                
                // Inject Identity
                proxyReq.setHeader('User-Agent', MY_USER_AGENT);
                proxyReq.setHeader('Cookie', MY_COOKIE);
                proxyReq.setHeader('Origin', TARGET);
                proxyReq.setHeader('Referer', TARGET + '/'); 
                
            } catch (err) {
                console.error("Header injection warning:", err.message);
            }

            if (req.url.includes('/backend-api/conversation')) {
                console.log(`[Injecting] Spoofing chat request...`);
            }
        },
        
        proxyRes: (proxyRes, req, res) => {
            // Clean up headers to prevent browser errors
            delete proxyRes.headers['content-security-policy'];
            delete proxyRes.headers['content-security-policy-report-only'];
            delete proxyRes.headers['x-frame-options'];
            delete proxyRes.headers['strict-transport-security'];
            proxyRes.headers['access-control-allow-origin'] = '*';
        },

        error: (err, req, res) => {
            console.error('Proxy Connection Error:', err.message);
            if (!res.headersSent) {
                res.status(502).send("Proxy Error: The residential proxy failed to connect.");
            }
        }
    }
});

app.use('/', proxyMiddleware);

// Global crash prevention
process.on('uncaughtException', (err) => {
    console.error('CRITICAL UNCAUGHT ERROR (Server kept running):', err.message);
});

app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});