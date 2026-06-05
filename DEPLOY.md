# Deploy to Vercel

This is a standard Next.js 16 app, so Vercel deploys it with zero config. The only
thing you must add is a real RPC URL, because the public RPC rate-limits and rejects
the pre-sign simulation.

## Option A: Vercel dashboard (recommended, ~3 minutes)

1. Go to https://vercel.com/new and sign in with GitHub.
2. Import the repo `plutohan/solana-agentic-tx-reviewer`.
3. Framework preset is detected as **Next.js**. Leave the build settings as-is.
4. Open **Environment Variables** and add:
   - `SOLANA_RPC_URL` = your Helius / QuickNode / Triton mainnet URL
     (free Helius key works: https://dev.helius.xyz). This is required for the
     pre-sign demo.
   - Optional, to make the LLM explanation live:
     `AI_PROVIDER` = `anthropic` (or `openai`), plus `ANTHROPIC_API_KEY`
     (or `OPENAI_API_KEY`). Without it, the free deterministic explanation is used.
5. Click **Deploy**. You get a URL like `https://solana-agentic-tx-reviewer.vercel.app`.
6. (Optional) Set `NEXT_PUBLIC_SITE_URL` to that URL (or your custom domain) so the
   OpenGraph card uses absolute URLs, then redeploy. It also auto-detects from
   `VERCEL_URL` if you skip this.

## Option B: Vercel CLI

```bash
npm i -g vercel
vercel login
vercel link            # link to a new project
vercel env add SOLANA_RPC_URL production    # paste your RPC URL
vercel --prod
```

## After deploy: smoke test

- Open the URL, paste a recent mainnet signature, click **Review**.
- Switch to **Unsigned tx**, paste a base64 unsigned transaction, and confirm the
  SIMULATED result renders.
- Paste a `/tx/<signature>` link into Discord/Twitter and confirm the OG risk card
  unfurls.

## Notes

- The review route sets `maxDuration = 30` so the multi-RPC pre-sign path does not
  hit the default serverless timeout.
- Nothing is ever signed or sent. The server only reads and simulates.
- No secrets ship to the browser. All RPC and LLM calls run server-side.
