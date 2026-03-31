"""
gmail_auth_setup.py
ONE-TIME LOCAL SETUP SCRIPT — do not run on GitHub Actions.

Run this once on your local machine to generate a Gmail OAuth token.
It will open a browser for you to authorise access, then print the
token JSON which you copy into GitHub Secrets as GMAIL_TOKEN.

Requirements (install locally):
  pip install google-auth-oauthlib google-auth-httplib2 google-api-python-client

Usage:
  1. Download OAuth credentials from Google Cloud Console as credentials.json
  2. Run: python scripts/gmail_auth_setup.py --credentials path/to/credentials.json
  3. Authorise in browser
  4. Copy printed token JSON into GitHub Secret: GMAIL_TOKEN
  5. Copy contents of credentials.json into GitHub Secret: GMAIL_CREDENTIALS
"""

import argparse
import json
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--credentials",
        default="credentials.json",
        help="Path to OAuth credentials JSON downloaded from Google Cloud Console",
    )
    args = parser.parse_args()

    creds_path = Path(args.credentials)
    if not creds_path.exists():
        print(f"ERROR: Credentials file not found: {creds_path}")
        print("\nTo get credentials.json:")
        print("  1. Go to https://console.cloud.google.com/")
        print("  2. Select your project (or create one)")
        print("  3. APIs & Services → Enable APIs → enable 'Gmail API'")
        print("  4. APIs & Services → Credentials → Create credentials → OAuth client ID")
        print("  5. Application type: Desktop app")
        print("  6. Download the JSON and save as credentials.json")
        return

    flow = InstalledAppFlow.from_client_secrets_file(str(creds_path), SCOPES)
    creds = flow.run_local_server(port=0)

    token_data = json.loads(creds.to_json())
    token_str = json.dumps(token_data, indent=2)

    print("\n" + "=" * 60)
    print("SUCCESS — copy the following into GitHub Secret: GMAIL_TOKEN")
    print("=" * 60)
    print(token_str)
    print("=" * 60)

    with open(creds_path, "r") as f:
        creds_content = f.read()

    print("\n" + "=" * 60)
    print("Also copy the following into GitHub Secret: GMAIL_CREDENTIALS")
    print("=" * 60)
    print(creds_content)
    print("=" * 60)

    print("\nDone. Add these two values as GitHub Secrets, then set:")
    print("  RECIPIENT_EMAIL = your Gmail address")


if __name__ == "__main__":
    main()
