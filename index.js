import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";
import dotenv from 'dotenv';
import zlib from 'zlib';
import https from 'https';
import fs from 'fs';
import { Transform } from 'stream'; // <--- NEW: Required for streaming

dotenv.config();

const app = express();
const TARGET = 'https://chatgpt.com';

// !!! HTTPS URL !!!
const MY_PROXY_URL = 'https://192.168.10.42:3000'; 

const MY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const MY_COOKIE = [
    process.env.AUTH_TOKEN, 
    process.env.DEVICE_ID, 
    process.env.CF_COOKIE
].filter(Boolean).join('; ');

console.log("##################################################");
console.log(`## SECURE PROXY RUNNING ON: ${MY_PROXY_URL}`);
console.log("##################################################");

app.use(cors({ origin: true, credentials: true }));

// --- HELPER FUNCTION: URL REWRITER ---
// This handles both HTTPS and WSS (WebSocket) replacements
const replaceUrls = (str) => {
    // 1. Replace Standard HTTPS URLs
    let newBody = str.replace(/https:\/\/chatgpt\.com/g, MY_PROXY_URL);
    newBody = newBody.replace(/https:\\\/\\\/chatgpt\.com/g, MY_PROXY_URL);
    
    // 2. Replace WebSocket (WSS) URLs (CRITICAL FOR CHAT)
    // We convert wss://chatgpt.com -> wss://192.168.10.42:3000
    const myWssUrl = MY_PROXY_URL.replace('https://', 'wss://');
    newBody = newBody.replace(/wss:\/\/chatgpt\.com/g, myWssUrl);
    newBody = newBody.replace(/wss:\\\/\\\/chatgpt\.com/g, myWssUrl);

    // 3. Strip Integrity Checks (Prevents browser from blocking modified scripts)
    newBody = newBody.replace(/integrity="[^"]*"/g, '');
    
    return newBody;
};

const proxyMiddleware = createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    selfHandleResponse: true,
    ws: true,
    secure: false,
    cookieDomainRewrite: "*",
    
    on: {
        proxyReq: (proxyReq, req, res) => {
            // Request compression (gzip/br) to speed things up
            // We will decompress it manually in proxyRes
            proxyReq.setHeader('Accept-Encoding', 'gzip, deflate, br');
            
            proxyReq.setHeader('Host', 'chatgpt.com');
            proxyReq.setHeader('Origin', 'https://chatgpt.com');
            proxyReq.setHeader('Referer', 'https://chatgpt.com/');
            proxyReq.setHeader('User-Agent', MY_USER_AGENT);
            proxyReq.setHeader('Cookie', MY_COOKIE);
        },

        proxyReqWs: (proxyReq, req, socket, options, head) => {
            proxyReq.setHeader('Host', 'chatgpt.com');
            proxyReq.setHeader('Origin', 'https://chatgpt.com');
            proxyReq.setHeader('User-Agent', MY_USER_AGENT);
            proxyReq.setHeader('Cookie', MY_COOKIE);
            console.log(`[WS] WebSocket Connected`);
        },

        proxyRes: (proxyRes, req, res) => {
            res.statusCode = proxyRes.statusCode;

            // 1. STRIP HEADERS
            Object.keys(proxyRes.headers).forEach(key => {
                const k = key.toLowerCase();
                if (
                    k !== 'content-security-policy' && 
                    k !== 'content-security-policy-report-only' &&
                    k !== 'strict-transport-security' && 
                    k !== 'content-encoding' && // We handle decoding manually
                    k !== 'content-length' &&
                    k !== 'transfer-encoding' &&
                    k !== 'set-cookie'
                ) {
                    res.setHeader(key, proxyRes.headers[key]);
                }
            });

            // 2. COOKIE FIX
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

            // --- DECOMPRESSION SETUP ---
            const encoding = proxyRes.headers['content-encoding'];
            const contentType = proxyRes.headers['content-type'] || '';
            
            let decompressStream;
            if (encoding === 'gzip') decompressStream = zlib.createGunzip();
            else if (encoding === 'br') decompressStream = zlib.createBrotliDecompress();
            else if (encoding === 'deflate') decompressStream = zlib.createInflate();
            
            // --- DECISION: STREAM OR BUFFER? ---
            
            // A. STREAMING MODE (For Chat Response)
            // 'text/event-stream' is used by ChatGPT to type out answers.
            // We use a Pipe to send data INSTANTLY as it arrives.
            if (contentType.includes('text/event-stream')) {
                
                const rewriteStream = new Transform({
                    transform(chunk, encoding, callback) {
                        // Rewrite the chunk immediately
                        const modifiedChunk = replaceUrls(chunk.toString());
                        this.push(modifiedChunk);
                        callback();
                    }
                });

                if (decompressStream) {
                    proxyRes.pipe(decompressStream).pipe(rewriteStream).pipe(res);
                    decompressStream.on('error', (e) => { console.error('Zip Error', e); res.end(); });
                } else {
                    proxyRes.pipe(rewriteStream).pipe(res);
                }
            } 
            
            // B. BUFFER MODE (For HTML, JS, JSON)
            // We wait for the full file to ensure we don't break JSON syntax during rewrite
            else if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
                
                let chunks = [];
                const source = decompressStream ? proxyRes.pipe(decompressStream) : proxyRes;

                source.on('data', (c) => chunks.push(c));
                source.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const newBody = replaceUrls(body); // <--- This runs your REQUIRED rewrites
                        res.end(newBody);
                    } catch (e) {
                        console.error('Buffer Error:', e);
                        res.end(); 
                    }
                });
                source.on('error', (e) => { console.error('Source Error:', e); res.end(); });
            } 
            
            // C. BINARY MODE (Images, Fonts)
            // Pass through raw
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

// --- LOAD CERTIFICATES AND START HTTPS SERVER ---
try {
    const httpsOptions = {
        key: fs.readFileSync('./key.pem'),
        cert: fs.readFileSync('./cert.pem')
    };

    https.createServer(httpsOptions, app).listen(3000, '0.0.0.0', () => {
        console.log(`HTTPS Server Ready! https://192.168.10.42:3000`);
    });
} catch (error) {
    console.error("FAILED TO LOAD CERTIFICATES. Did you run step 1?");
    console.error(error.message);
}