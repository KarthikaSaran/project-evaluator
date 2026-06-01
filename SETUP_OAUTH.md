# Google OAuth Setup — Drive Sign-In

To evaluate Drive links shared only with the **@interviewkickstart.com** domain (i.e.
not "Anyone with the link"), the app needs each evaluator to sign in with their Google
account. This is a one-time setup.

---

## 1. Create the OAuth client in Google Cloud Console

1. Open **https://console.cloud.google.com/** and select (or create) a project — e.g.
   `ik-project-evaluator`.
2. **APIs & Services → Library**, search for **Google Drive API**, click **Enable**.
3. **APIs & Services → OAuth consent screen**
   - User Type: **Internal** (if the GCP project lives in IK's Workspace — recommended)
     - This restricts sign-in to @interviewkickstart.com accounts automatically and
       skips Google's verification process.
   - If you must use **External**, add evaluators as **Test users** while in testing
     mode.
   - App name: `Project Evaluator` (or whatever).
   - User support email: yours.
   - **Scopes**, click **Add or Remove Scopes** and add:
     - `.../auth/userinfo.email`
     - `.../auth/drive.readonly`
   - Save.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `Project Evaluator – Web`
   - **Authorized JavaScript origins**:
     ```
     https://project-evaluator-gold.vercel.app
     http://localhost:3000
     ```
   - **Authorized redirect URIs**:
     ```
     https://project-evaluator-gold.vercel.app/api/auth/google/callback
     http://localhost:3000/api/auth/google/callback
     ```
   - Click **Create**.
   - Copy the **Client ID** and **Client secret**.

---

## 2. Generate a SESSION_SECRET

A random string used to HMAC-sign the session cookie:

```bash
openssl rand -hex 32
```

Copy the 64-char hex output.

---

## 3. Set env vars on Vercel

1. Open the project on Vercel → **Settings → Environment Variables**.
2. Add (for **Production**, **Preview**, **Development**):

| Name | Value |
|------|-------|
| `GOOGLE_CLIENT_ID` | (from step 1) |
| `GOOGLE_CLIENT_SECRET` | (from step 1) |
| `SESSION_SECRET` | (from step 2) |
| `GOOGLE_HOSTED_DOMAIN` *(optional)* | `interviewkickstart.com` |

3. Redeploy from the **Deployments** tab (or push any commit).

---

## 4. Set env vars locally

Copy `.env.example` → `.env.local` and fill in the same values. Then:

```bash
npm run dev
```

Visit http://localhost:3000 and click **Sign in with Google** in the top-right.

---

## Troubleshooting

- **"redirect_uri_mismatch"** — the redirect URI in the OAuth client doesn't match the
  one the app is sending. Make sure both `localhost:3000` and the Vercel URL are listed
  exactly (no trailing slash).
- **"This app isn't verified"** — only appears if your OAuth consent screen is **External**
  and not in Testing. Use **Internal** instead.
- **"Drive sign-in not configured" banner in the app** — one of the three env vars above
  is missing or empty.
- **"Signed-in account doesn't have view access"** — the file was shared with a
  different group/domain than the signed-in account.
