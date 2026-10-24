# Google access setup

Bananra needs access to three Google services. Set up each connection in the Google Cloud project that owns the corresponding credential. The OAuth client and service account may belong to different projects. You do not need to enable every API or give a credential broad project access.

## 1. Find which Google project owns each credential

There are two different JSON credentials:

- The **OAuth client** is a Web application credential. It lets you sign in to Gmail and approve the app's email permissions.
- The **service account** is a non-human identity used for Vertex AI and Google Sheets.

In Google Cloud Console, use the project picker at the top to select the project that owns the credential you are configuring. Check **APIs & Services → Credentials** for the OAuth client. Find the service account under **IAM & Admin → Service Accounts**. The service account's email is listed in its row; use that email when sharing a spreadsheet. Do not copy a private key into this document, source code, or a support message.

## 2. Gmail: sign-in and email access

In the OAuth client's project:

1. Open **APIs & Services → Library**, find **Gmail API**, and click **Enable**.
2. Open **Google Auth Platform → Audience**. While the app is in **Testing**, add the Google account you will use with Bananra under **Test users**. This resolves the “app has not completed Google verification” access block for your own test account. Publishing the app for general users is a separate Google verification process.
3. Open **Google Auth Platform → Clients**, select the Web application OAuth client, and add this exact authorized redirect URI:

   ```text
   http://localhost:8081/oauth/callback
   ```

4. Start Bananra, open `http://localhost:8081`, and connect Gmail. Sign in with the account added as a test user and approve the requested identity and Gmail permissions. The app requests `openid`, `email`, `https://www.googleapis.com/auth/gmail.send`, and `https://www.googleapis.com/auth/gmail.readonly` so it can identify the sender, send messages, and load complete threads.

If Gmail access was previously authorized with fewer permissions, disconnect/reconnect or clear the app's local OAuth token in `.data/` and authorize again. Google will not update an old token's permissions until consent is granted again.

## 3. Gemini: Vertex AI access

In the service account's project:

1. Open **APIs & Services → Library**, find **Vertex AI API**, and click **Enable**.
2. Make sure billing is enabled for the project.
3. Open **IAM & Admin → IAM** and grant the service account the **Vertex AI User** role (`roles/aiplatform.user`). No Owner role is needed.

The service account key must correspond to that service account. Bananra uses it for Gemini calls through Vertex AI. If you choose the optional Gemini Developer API backend instead, follow that API's key setup as described in `.env.example` rather than granting additional Cloud IAM roles.

## 4. Google Sheets access

In the project used by Bananra's service account, enable **Google Sheets API** from **APIs & Services → Library**. Then:

1. Open the spreadsheet in Google Sheets and click **Share**.
2. Add the service account email shown under **IAM & Admin → Service Accounts**.
3. Give it **Editor** access. Viewer access can read but cannot save collected answers.
4. In Bananra's sidebar, paste the spreadsheet URL under **Profile spreadsheet** and click **Connect sheet**. Use **Check spreadsheet** to verify access and headers. These checks do not write test cells or send email.

The app reads the header row and dropdown choices. It updates only the matching person's row as answers are confirmed. The connected service account needs edit access to that spreadsheet; you do not need to share your entire Drive or grant it broad Drive access.

## Troubleshooting

- **OAuth `403 access_denied` / app is being tested:** add the Google account you sign in with under **Google Auth Platform → Audience → Test users** in the OAuth client's project, then reconnect Gmail.
- **Gmail API has not been used or is disabled:** enable Gmail API in the OAuth client's project, wait briefly for Google to propagate the change, and retry.
- **`aiplatform.endpoints.predict` denied:** check that Vertex AI API is enabled and billing is active in the service account's project, and that the credential's service account has **Vertex AI User** on that project.
- **Spreadsheet permission denied:** share the sheet with the exact service account email as **Editor**. This identity is separate from your Gmail account.
- **Redirect URI mismatch:** compare the OAuth client's authorized redirect URI character-for-character with `http://localhost:8081/oauth/callback`.

## Keep credentials private

Keep both credential JSON files and `.env` in the local project root only. Root-level JSON files are ignored by Git (except the Node package manifests). Keep `.data/` private too; it contains OAuth tokens and conversation data. Never commit, publish, or email credential files or service account private keys. If a key was exposed, revoke it in **IAM & Admin → Service Accounts → Keys** and create a replacement.
