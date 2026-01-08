import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const TARGET = 'https://chatgpt.com';

const MY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const MY_COOKIE = [
    process.env.AUTH_TOKEN, 
    process.env.DEVICE_ID, 
    process.env.CF_COOKIE
].filter(Boolean).join('; ');

// --- STARTUP LOG ---
console.log("\n\n");
console.log("##################################################");
console.log("## SERVER STARTED - WATCH THIS TERMINAL FOR LOGS ##");
console.log("##################################################");
console.log("Cookie Length:", MY_COOKIE.length);
console.log("\n");

app.use(cors({
    origin: true, 
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with', '*']
}));

const MY_PROXY_URL = 'https://resonantly-creatable-santana.ngrok-free.dev'; // <--- PUT YOUR NGROK URL HERE

const proxyMiddleware = createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    selfHandleResponse: true, // <--- IMPORTANT: Allows us to modify the body
    ws: true,
    secure: false,
    cookieDomainRewrite: "*",
    
    on: {
        proxyReq: (proxyReq, req, res) => {
            // 1. Force server to send plain text (so we can read/edit it)
            proxyReq.setHeader('Accept-Encoding', 'identity');
            
            // Standard spoofing
            proxyReq.setHeader('Host', 'chatgpt.com');
            proxyReq.setHeader('Origin', 'https://chatgpt.com');
            proxyReq.setHeader('Referer', 'https://chatgpt.com/');
            proxyReq.setHeader('User-Agent', MY_USER_AGENT);
            proxyReq.setHeader('Cookie', MY_COOKIE);
        },

        proxyRes: (proxyRes, req, res) => {
            // Copy status code
            res.statusCode = proxyRes.statusCode;

            // Copy headers (excluding ones we might break by changing body size)
            Object.keys(proxyRes.headers).forEach(key => {
                if (key !== 'content-length' && key !== 'transfer-encoding') {
                    res.setHeader(key, proxyRes.headers[key]);
                }
            });

            // Force CORS on the response
            res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
            res.setHeader('Access-Control-Allow-Credentials', 'true');

            // --- BODY REWRITING LOGIC ---
            let bodyChunks = [];
            
            proxyRes.on('data', (chunk) => {
                bodyChunks.push(chunk);
            });

            proxyRes.on('end', () => {
                let body = Buffer.concat(bodyChunks).toString('utf8');

                // ONLY REWRITE IF IT'S TEXT/HTML or JS
                const contentType = proxyRes.headers['content-type'] || '';
                if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
                    
                    console.log(`[REWRITE] Modifying content for ${req.url}`);

                    // 1. Replace the hardcoded domain with your proxy domain
                    // This creates a global regex to replace all instances
                    const regex = new RegExp('https://chatgpt.com', 'g');
                    body = body.replace(regex, MY_PROXY_URL);
                    
                    // 2. Also replace encoded versions just in case (optional but safe)
                    // body = body.replace(/https:\\\/\\\/chatgpt\.com/g, MY_PROXY_URL);
                }

                res.end(body);
            });
        },
        
        error: (err, req, res) => {
            console.error('   !!! PROXY ERROR:', err.message);
            if(!res.headersSent) res.end();
        }
    }
});

app.use('/', proxyMiddleware);

app.listen(3000, () => {
    console.log('Server Ready on port 3000...');
});