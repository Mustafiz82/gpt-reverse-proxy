import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";
import dotenv from 'dotenv';
import zlib from 'zlib';
import https from 'https'; // <--- NEW IMPORT
import fs from 'fs';       // <--- NEW IMPORT

dotenv.config();

const app = express();
const TARGET = 'https://chatgpt.com';

// !!! NOTE: HTTPS !!!
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

const proxyMiddleware = createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    selfHandleResponse: true,
    ws: true,
    secure: false, // Ignore ChatGPT's cert errors (we trust them)
    cookieDomainRewrite: "*",
    
    on: {
        proxyReq: (proxyReq, req, res) => {
            proxyReq.setHeader('Accept-Encoding', 'gzip, deflate');
            proxyReq.setHeader('Host', 'chatgpt.com');
            proxyReq.setHeader('Origin', 'https://chatgpt.com');
            proxyReq.setHeader('Referer', 'https://chatgpt.com/');
            proxyReq.setHeader('User-Agent', MY_USER_AGENT);
            proxyReq.setHeader('Cookie', MY_COOKIE);
        },

        proxyRes: (proxyRes, req, res) => {
            res.statusCode = proxyRes.statusCode;

            // 1. STRIP SECURITY HEADERS (CSP)
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

            // 2. COOKIE LOGIC (HTTPS VERSION)
            // Since we are on HTTPS, we WANT "Secure".
            // We just need to remove the Domain so it sticks to our IP.
            if (proxyRes.headers['set-cookie']) {
                const cookies = proxyRes.headers['set-cookie'].map(c => {
                    let newCookie = c.replace(/; Domain=[^;]+/, '');
                    
                    // ENSURE SECURE IS PRESENT
                    if (!newCookie.includes('; Secure')) {
                        newCookie += '; Secure';
                    }
                    
                    // ENSURE SAMESITE=NONE (Allows cross-origin usage if needed)
                    // Note: SameSite=None REQUIRED Secure, which we now have!
                    newCookie = newCookie.replace(/; SameSite=[^;]+/, '') + '; SameSite=None';
                    
                    return newCookie;
                });
                res.setHeader('set-cookie', cookies);
            }

            // 3. BODY REWRITING
            let bodyChunks = [];
            proxyRes.on('data', (chunk) => bodyChunks.push(chunk));

            proxyRes.on('end', () => {
                const buffer = Buffer.concat(bodyChunks);
                const encoding = proxyRes.headers['content-encoding'];
                const contentType = proxyRes.headers['content-type'] || '';

                const processBody = (str) => {
                    // Replace https://chatgpt.com -> https://192.168...
                    let newBody = str.replace(/https:\/\/chatgpt\.com/g, MY_PROXY_URL);
                    newBody = newBody.replace(/https:\\\/\\\/chatgpt\.com/g, MY_PROXY_URL);
                    // Strip Integrity checks
                    newBody = newBody.replace(/integrity="[^"]*"/g, '');
                    return newBody;
                };

                if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
                    try {
                        if (encoding === 'gzip') {
                            zlib.gunzip(buffer, (err, decoded) => {
                                if (err) return res.end(buffer);
                                res.end(processBody(decoded.toString('utf8')));
                            });
                        } else if (encoding === 'br') {
                            zlib.brotliDecompress(buffer, (err, decoded) => {
                                if (err) return res.end(buffer);
                                res.end(processBody(decoded.toString('utf8')));
                            });
                        } else {
                            res.end(processBody(buffer.toString('utf8')));
                        }
                    } catch (e) {
                        res.end(buffer);
                    }
                } else {
                    res.end(buffer);
                }
            });
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