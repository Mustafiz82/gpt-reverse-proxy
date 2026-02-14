import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";
import dotenv from 'dotenv';
import zlib from 'zlib';
import https from 'https';
import fs from 'fs';
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Transform } from 'stream'; 

dotenv.config();

const app = express();
const TARGET = 'https://chatgpt.com';

// Configuration from .env
const MY_IP = process.env.MY_IP || '192.168.10.42';
const MY_PROXY_URL = `https://${MY_IP}:3000`; 
const MY_COOKIEEnv = process.env.CHATGPT_COOKIES;
console.log(MY_COOKIEEnv)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function cookiesArrayToHeader(cookies) {
  return cookies
    .filter(c => c.name && c.value)
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}

async function cookiesFileToHeader(filePath) {
  const data = await readFile(filePath, "utf8");
  const cookies = JSON.parse(data);
  return cookiesArrayToHeader(cookies);
}

// usage
const cookiesPath = path.join(__dirname, "cookies.json");
const MY_COOKIE = await cookiesFileToHeader(cookiesPath);

console.log(MY_COOKIE)

// Consistency: This must match the browser you took the cookies from
const MY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

console.log("##################################################");
console.log(`## PROXY STARTING ON: ${MY_PROXY_URL}`);
console.log(`## COOKIE LOADED: ${MY_COOKIE ? MY_COOKIE.substring(0, 30) + "..." : "MISSING!"}`);
console.log("##################################################");

app.use(cors({ origin: true, credentials: true }));

// --- HELPER: URL REWRITER ---
const replaceUrls = (str) => {
    if (!str) return str;
    // 1. Replace Standard HTTPS URLs
    let newBody = str.replace(/https:\/\/chatgpt\.com/g, MY_PROXY_URL);
    newBody = newBody.replace(/https:\\\/\\\/chatgpt\.com/g, MY_PROXY_URL);
    
    // 2. Replace WebSocket (WSS) URLs (Critical for Chat response)
    const myWssUrl = MY_PROXY_URL.replace('https://', 'wss://');
    newBody = newBody.replace(/wss:\/\/chatgpt\.com/g, myWssUrl);
    newBody = newBody.replace(/wss:\\\/\\\/chatgpt\.com/g, myWssUrl);

    // 3. Strip Integrity Checks (Prevents script blocking)
    newBody = newBody.replace(/integrity="[^"]*"/g, '');
    
    return newBody;
};

const proxyMiddleware = createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    selfHandleResponse: true, // Crucial for our streaming/rewriting
    ws: true,
    secure: false,
    cookieDomainRewrite: "*",
    
    on: {
        proxyReq: (proxyReq, req, res) => {
            // Support compression
            proxyReq.setHeader('Accept-Encoding', 'gzip, deflate, br');
            
            // Standard Spoofing
            proxyReq.setHeader('Host', 'chatgpt.com');
            proxyReq.setHeader('Origin', 'https://chatgpt.com');
            proxyReq.setHeader('Referer', 'https://chatgpt.com/');
            
            // INJECT ALL COOKIES
            proxyReq.setHeader('Cookie', MY_COOKIE);

            // ANTI-DETECTION: Forced Consistency
            proxyReq.setHeader('User-Agent', MY_USER_AGENT);
            proxyReq.setHeader('sec-ch-ua', '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"');
            proxyReq.setHeader('sec-ch-ua-mobile', '?0');
            proxyReq.setHeader('sec-ch-ua-platform', '"Windows"');
        },

        proxyReqWs: (proxyReq, req, socket, options, head) => {
            proxyReq.setHeader('Host', 'chatgpt.com');
            proxyReq.setHeader('Origin', 'https://chatgpt.com');
            proxyReq.setHeader('Cookie', MY_COOKIE);
            proxyReq.setHeader('User-Agent', MY_USER_AGENT);
            console.log(`[WS] WebSocket Connected`);
        },

        proxyRes: (proxyRes, req, res) => {
            res.statusCode = proxyRes.statusCode;

            // 1. STRIP SECURITY HEADERS
            Object.keys(proxyRes.headers).forEach(key => {
                const k = key.toLowerCase();
                if (
                    k !== 'content-security-policy' && 
                    k !== 'content-security-policy-report-only' &&
                    k !== 'strict-transport-security' && 
                    k !== 'content-encoding' && 
                    k !== 'content-length' &&
                    k !== 'transfer-encoding' &&
                    k !== 'set-cookie'
                ) {
                    res.setHeader(key, proxyRes.headers[key]);
                }
            });

            // 2. COOKIE REWRITE (For Browser Support)
            if (proxyRes.headers['set-cookie']) {
                const cookies = proxyRes.headers['set-cookie'].map(c => {
                    let newCookie = c.replace(/; Domain=[^;]+/, '');
                    if (!newCookie.includes('; Secure')) newCookie += '; Secure';
                    return newCookie.replace(/; SameSite=[^;]+/, '') + '; SameSite=None';
                });
                res.setHeader('set-cookie', cookies);
            }

            // 3. CORS
            res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
            res.setHeader('Access-Control-Allow-Credentials', 'true');

            // --- DECOMPRESSION ---
            const encoding = proxyRes.headers['content-encoding'];
            const contentType = proxyRes.headers['content-type'] || '';
            
            let decompressStream;
            if (encoding === 'gzip') decompressStream = zlib.createGunzip();
            else if (encoding === 'br') decompressStream = zlib.createBrotliDecompress();
            else if (encoding === 'deflate') decompressStream = zlib.createInflate();
            
            // --- STREAMING MODE (FAST CHAT) ---
            if (contentType.includes('text/event-stream')) {
                const rewriteStream = new Transform({
                    transform(chunk, encoding, callback) {
                        this.push(replaceUrls(chunk.toString()));
                        callback();
                    }
                });

                if (decompressStream) {
                    proxyRes.pipe(decompressStream).pipe(rewriteStream).pipe(res);
                } else {
                    proxyRes.pipe(rewriteStream).pipe(res);
                }
            } 
            
            // --- BUFFER MODE (HTML / JS / JSON) ---
            else if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
                let chunks = [];
                const source = decompressStream ? proxyRes.pipe(decompressStream) : proxyRes;

                source.on('data', (c) => chunks.push(c));
                source.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        res.end(replaceUrls(body));
                    } catch (e) {
                        res.end(); 
                    }
                });
            } 
            
            // --- BINARY MODE ---
            else {
                proxyRes.pipe(res);
            }
        },
        error: (err, req, res) => {
            console.error('PROX_ERR:', err.message);
            if(!res.headersSent) res.end();
        }
    }
});

app.use('/', proxyMiddleware);

// --- START SERVER ---
try {
    const httpsOptions = {
        key: fs.readFileSync('./key.pem'),
        cert: fs.readFileSync('./cert.pem')
    };
    https.createServer(httpsOptions, app).listen(3000, '0.0.0.0', () => {
        console.log(`HTTPS Server Ready! ${MY_PROXY_URL}`);
    });
} catch (error) {
    console.error("CERT ERROR: Check key.pem and cert.pem");
}