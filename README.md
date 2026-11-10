# NitM
News in the Morning

## Cloudflare Worker

This repository starts with a minimal Cloudflare Worker.

### Develop locally

```sh
npm install
npm run dev
```

Wrangler serves the Worker locally, where it responds with `NitM is running.`

### Deploy

Authenticate with Cloudflare using `npx wrangler login`, then run:

```sh
npm run deploy
```
