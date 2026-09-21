# Spotify Setup

LyricVision LCD signs in with Spotify using OAuth 2.0 with PKCE
(Proof Key for Code Exchange, S256). No client secret is needed
and you must never enter one — the desktop app is a public client.

## 1. Create a Spotify application

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and sign in with your Spotify account.
2. Click **Create app** and fill in a name and description of your choice.
3. In the app settings, add this redirect URI:

```text
http://127.0.0.1:17321/callback
```

The app listens for the OAuth callback on `127.0.0.1`, starting at
port `17321` and walking a fallback chain up to `17331` when the
first port is busy (see `shell-notes.md`). Registering the
first URI is enough for the standard flow.
4. Save the settings and copy the **Client ID** shown on the app page.

A free Spotify account plus this client ID is enough to sign in.
What the API exposes for a given session is decided by Spotify,
not by this app (see `faq.md`).

## 2. Enter the Client ID in the app

1. Start LyricVision LCD.
2. Paste the Client ID into the **Client ID** field in the app window.
3. Click **Connect**.

The value is stored in the local settings file. It is a public
identifier, not a secret, but keep it free of extra spaces when
pasting.

## 3. Expected OAuth flow

1. A browser window opens on the Spotify sign-in page.
2. Approve the requested permissions.
3. The browser redirects back to the app (`127.0.0.1` callback).
4. The app exchanges the code for tokens and the status changes
   to connected. Tokens refresh automatically in the background.

## 4. Token storage

Tokens are stored in the OS credential vault through Electron
`safeStorage`, never as plaintext. The diagnostics export is
redacted by design and contains no tokens. Do not paste tokens,
client secrets, or absolute local paths into issue reports.

## 5. Reconnect or revoke

- **Reconnect:** click Connect again in the app window and repeat
  the browser sign-in. Restarting the app keeps the session.
- **Revoke:** remove access from your Spotify account settings page
  (Apps with access), then reconnect in the app to start over.
- **Sign-in fails:** confirm the Client ID has no extra spaces and
  the redirect back to the app completes in the browser. More steps
  in [troubleshooting](troubleshooting.md) and the [FAQ](faq.md).
