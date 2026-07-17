# SmartReview — Custom Domain Setup Guide

This guide covers connecting your own domain (e.g. `smartreview.in`) to both
the frontend (Vercel) and backend (Railway).

---

## Prerequisites

- A registered domain — recommended registrars for `.in` domains: GoDaddy,
  Namecheap, or BigRock (India-based, faster support for `.in` TLDs)
- Access to your domain's DNS settings (the registrar's control panel)

---

## 1. Frontend on Vercel — `app.smartreview.in`

1. Go to your Vercel project → **Settings → Domains**
2. Add `app.smartreview.in`
3. Vercel will show a CNAME record to add. In your domain's DNS panel, add:

   | Type  | Name | Value                  |
   |-------|------|------------------------|
   | CNAME | app  | cname.vercel-dns.com   |

4. Wait 5–30 minutes for DNS propagation. Vercel auto-issues an SSL
   certificate once the CNAME resolves.
5. Repeat for any other frontend subdomains:
   - `menu.smartreview.in` → customer-facing online menu QR app
   - `admin.smartreview.in` → admin super-dashboard

---

## 2. Backend API on Railway — `api.smartreview.in`

1. Go to your Railway project → select the **smartreview-api** service →
   **Settings → Networking → Custom Domain**
2. Click **Add Domain**, enter `api.smartreview.in`
3. Railway shows a CNAME target (e.g. `xxxx.up.railway.app`). Add to DNS:

   | Type  | Name | Value                      |
   |-------|------|----------------------------|
   | CNAME | api  | xxxx.up.railway.app        |

4. Railway auto-provisions a Let's Encrypt SSL certificate (takes ~2-10 min)

---

## 3. Update environment variables after domain is live

Once both domains resolve, update these to match:

**On Vercel (frontend project):**
```
NEXT_PUBLIC_API_URL=https://api.smartreview.in/api/v1
```

**On Railway (backend service):**
```
FRONTEND_URL=https://app.smartreview.in
ALLOWED_ORIGINS=https://app.smartreview.in,https://menu.smartreview.in,https://admin.smartreview.in
```

Redeploy both services after changing env vars so the new values take effect.

---

## 4. Root domain redirect (optional)

To make `smartreview.in` (no subdomain) redirect to `app.smartreview.in`:

1. In Vercel, add `smartreview.in` as a domain on the same project
2. Vercel will offer to set it as a redirect to your primary domain —
   accept this, or configure manually:
   - Add an `A` record pointing `@` to Vercel's IP (`76.76.21.21`)
   - Vercel auto-redirects root → `app.smartreview.in`

---

## 5. Verify everything works

```bash
# Backend health check
curl https://api.smartreview.in/health

# Should return:
# {"status":"ok","version":"1.0.0",...}

# Frontend
open https://app.smartreview.in
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| SSL certificate pending for hours | Double-check the CNAME value matches exactly what Railway/Vercel gave you — typos are the #1 cause |
| CORS errors in browser console | `ALLOWED_ORIGINS` on Railway doesn't include your exact frontend domain (with `https://`, no trailing slash) |
| DNS not resolving after 1 hour | Some registrars cache DNS — try `nslookup api.smartreview.in` from a different network, or use Google's DNS checker tool |
| Razorpay webhook failing after domain change | Update the webhook URL in your Razorpay dashboard to `https://api.smartreview.in/webhooks/razorpay` |
