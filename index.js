import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import dotenv from 'dotenv'

dotenv.config();


const app = express();

const TARGET = 'https://chatgpt.com';
const MY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';


const MY_COOKIE_VALUE = process.env.COOKIES;

console.log(MY_COOKIE_VALUE)
const MY_COOKIE = `__Secure-next-auth.session-token=${MY_COOKIE_VALUE}`;

const proxyMiddleware = createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    cookieDomainRewrite: "localhost",
    followRedirects: false, 
    on: {
        proxyReq: (proxyReq, req, res) => {
            proxyReq.removeHeader('Cookie');
            proxyReq.removeHeader('User-Agent');

            proxyReq.setHeader('User-Agent', MY_USER_AGENT);
            proxyReq.setHeader('Cookie', MY_COOKIE);
            proxyReq.setHeader('Origin', TARGET);
            proxyReq.setHeader('Referer', TARGET + '/'); 

            if (req.url.includes('/backend-api/conversation')) {
                console.log(`[Injecting] Spoofing chat request to OpenAI...`);
            }
        },
        proxyRes: (proxyRes, req, res) => {
            delete proxyRes.headers['content-security-policy'];
            delete proxyRes.headers['content-security-policy-report-only'];
            delete proxyRes.headers['x-frame-options'];
            delete proxyRes.headers['strict-transport-security'];
        },

        error: (err, req, res) => {
            console.error('Proxy Error (Caught):', err.message);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Proxy encountered an error, but server is still running.');
        }
    }
});

app.use('/', proxyMiddleware);

process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR:', err);
});

app.listen(3000, () => {
    console.log('Proxy running on http://localhost:3000');
});