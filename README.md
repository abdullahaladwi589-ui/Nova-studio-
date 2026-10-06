# NOVA Studio — Production SaaS starter

NOVA is a real web application architecture for AI video generation.

## Included
- Arabic responsive frontend
- Express backend
- JWT authentication + bcrypt passwords
- Owner account with unlimited generation and admin controls
- Free plan: 1 generation per day
- Plus plan: unlimited generation (subject to provider/fair-use limits)
- Stripe Checkout subscription + signed webhook
- fal.ai video generation adapter
- Video job history
- Upload endpoint
- Environment-based secrets
- Production-oriented CORS and configuration

## Run locally
1. `npm install`
2. Copy `.env.example` to `.env`
3. Add your own FAL and Stripe keys.
4. Set `OWNER_EMAIL` and a strong `OWNER_PASSWORD`.
5. `npm start`
6. Open `http://localhost:8787`

## Stripe setup
Create a recurring monthly Price in Stripe and put its ID in `STRIPE_PRICE_ID`. Configure a webhook endpoint:
`https://YOUR_DOMAIN/api/billing/webhook`
Subscribe it to checkout.session.completed, customer.subscription.updated, and customer.subscription.deleted. Put the signing secret in `STRIPE_WEBHOOK_SECRET`.

## Video provider
Put your own fal.ai API key in `FAL_KEY`. The server calls the provider, so the key is never sent to browser JavaScript.

## Deployment
Deploy the Node application to any Node 20+ host. Set all environment variables in the host dashboard. Use a persistent database/storage solution for production rather than ephemeral local disk. For serious scale, move SQLite to Postgres and uploads to S3-compatible object storage.

## Pricing
The UI defaults to 1.99 USD/month as a low starting price. The actual billing amount is controlled by the Stripe Price referenced by `STRIPE_PRICE_ID`. Change it in Stripe, not only in the display label.
