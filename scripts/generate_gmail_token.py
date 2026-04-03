#!/usr/bin/env python3
"""
Generate Gmail OAuth2 token for use with the Socialisn briefing pipeline.

Usage:
    1. Download your OAuth client credentials JSON from Google Cloud Console
       (APIs & Services → Credentials → OAuth 2.0 Client IDs → Download JSON)
    2. Run this script:
         pip install google-auth-oauthlib
         python generate_gmail_token.py /path/to/client_secret.json
    3. A browser window will open — sign in and grant "Send email" permission.
    4. The script prints two JSON blocks:
         - GMAIL_CREDENTIALS  → paste into GitHub secret
         - GMAIL_TOKEN        → paste into GitHub secret

Notes:
    - If your OAuth consent screen is in "Testing" mode, tokens expire after
      7 days. Publish the app to production for long-lived refresh tokens.
    - Scope requested: gmail.send (send-only, cannot read your inbox).
"""

import json
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


def main():
    if len(sys.argv) < 2:
        print("Usage: python generate_gmail_token.py <client_secret.json>")
        sys.exit(1)

    client_secrets_file = sys.argv[1]

    # Read client credentials
    with open(client_secrets_file) as f:
        credentials_data = json.load(f)

    # Run OAuth flow — opens browser for consent
    flow = InstalledAppFlow.from_client_secrets_file(client_secrets_file, SCOPES)
    creds = flow.run_local_server(port=0)

    # Build token JSON
    token_data = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes),
    }

    print("\n" + "=" * 60)
    print("GMAIL_CREDENTIALS (paste into GitHub secret):")
    print("=" * 60)
    print(json.dumps(credentials_data))

    print("\n" + "=" * 60)
    print("GMAIL_TOKEN (paste into GitHub secret):")
    print("=" * 60)
    print(json.dumps(token_data))

    print("\n✓ Done. Copy the values above into your GitHub repo secrets:")
    print("  Settings → Secrets and variables → Actions")
    print("  Update GMAIL_CREDENTIALS and GMAIL_TOKEN")


if __name__ == "__main__":
    main()
