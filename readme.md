# GPT Reverse Proxy (Local IP Only)

A Node.js reverse proxy designed to access ChatGPT via a direct IP address (e.g., `https://127.0.0.1:3000`).
## 🚀 How It Works

1.  **Interception**: The server listens on HTTPS (port 3000).
2.  **Cookie Injection**: It reads a `cookies.json` file containing valid ChatGPT session tokens and injects them into the request headers.
3.  **Header Spoofing**: It rewrites the `Host`, `Origin`, and `User-Agent` headers so OpenAI thinks the request is coming directly from a supported browser.
4.  **Content Rewriting**:
    *   **Decompression**: Handles Gzip/Brotli/Deflate compression on the fly.
    *   **Link Replacement**: Replaces all `chatgpt.com` links with your proxy's IP.
    *   **WebSocket Handling**: Rewrites `wss://` URLs to ensure the real-time chat stream works through the proxy.
    *   **Security Stripping**: Removes strict Content-Security-Policy (CSP) headers that would otherwise block the proxy.

## 🛠️ Prerequisites

*   Node.js (v18 or higher)
*   OpenSSL (to generate self-signed certificates)
*   A valid ChatGPT account
