# Bananra

A local conversation dashboard at **http://localhost:8081**. Bananra collects profile details through warm email conversations and saves confirmed information into one Google Sheets row per person.

## Start

Use Node.js 22 or newer:

```sh
npm install
npm start
```

After a code update, stop the old process with Ctrl+C, run `npm start` again, and refresh the browser. Credential JSON files are auto-detected in the project root and never served to the browser. `.env.example` documents custom credential paths, model/backend, spreadsheet ID, and tab gid.

## Google setup

The app uses three Google services: Gmail through your signed-in Google account, Gemini through Vertex AI, and Sheets through a service account. Set up only the APIs and access described in the [Google access setup guide](GOOGLE_SETUP.md); you do not need to enable every API or grant project-wide Owner access. The app's OAuth redirect is `http://localhost:8081/oauth/callback`.

## Conversation dashboard

- **New conversation:** enter a person's email and click **Generate intro**. Review the preview and choose **Send intro**.
- **Continue:** click any saved thread in the sidebar. The thread shows its complete history, recipient reply count, Bananra emails out of five, total messages, and collected profile details.
- After the introduction, the action changes to **Generate reply** and **Send reply**. Generate reply can continue the conversation even if no new recipient response has arrived. It uses the full thread and known profile, asks for missing details, and never invents new answers. Generating does not send an email.
- **Existing Gmail threads:** refresh/load the Gmail list, click a conversation, then choose Generate reply to continue it as an intake. Historical outgoing messages count toward the five-email limit. Reopening an already-managed thread preserves its identity and counter.
- New conversations default to **review mode**. Replies arriving in the background are processed into the profile and a staged preview, without sending. The selected thread refreshes every 15 seconds while the page is visible.
- To continue automatically, explicitly enable **Send follow-ups automatically after recipient replies** for that thread. The background worker waits for new recipient messages; it does not generate unsolicited reminders. Operator-requested proactive previews are not auto-sent simply by turning automation on.
- Pause and resume are per thread. Unknown delivery outcomes are paused for review and never retried automatically.

The freeform email composer and random scheduled check-ins have been removed from the interface. The running intake service does not execute legacy random schedules.

## Profile data

The sheet must have an `Email` header within its first 20 rows. The app finds that row and reads the column names from it; the columns can be in any order. Keep all headers together on the same row:

```text
Person ID, First Name, Last Name, Age, Gender, Date of Birth, Email, Phone,
Country, City, State, Postal Code, Address, Nationality, Occupation, Company,
Department, Marital Status, Education, Employment Status
```

The header names define the fields the model collects and the columns the app updates. Keep an `Email` column so it can match people to conversations; `Person ID` is optional and system-managed when present. Other columns are asked about conversationally. Dropdown choices are read from the sheet and included in the model prompt; the app only writes an exact allowed choice to those cells. If a reply does not clearly match an option, Bananra asks the recipient to choose one. Explicit declines are recorded as `Declined`; missing values stay blank. The model must cite the recipient's actual text, and unsupported or inferred values are rejected. Birth dates require unambiguous calendar dates.

Confirmed details update the same row incrementally. Existing matching Person ID/Email rows are reused. Duplicate identities or missing/duplicate headers stop the write rather than guessing. Other columns and rows are preserved. Writes use `RAW`, preserving phone/postal formatting and preventing text from becoming spreadsheet formulas.

Full message text goes to Gemini for context. Attachment names are shown, but attachment contents are excluded. Threads exceeding 500,000 serialized context characters are explicitly refused rather than silently truncated.

## Five-email limit

The limit includes the opening email and is stored across restarts. Once five outgoing emails are used, no sixth email is sent in that thread. Late replies can still be recorded. Use **Start a new thread** to explicitly generate a new introduction while keeping the same Person ID, row, and collected details.

A send slot is reserved before contacting Gmail. Ambiguous attempts count conservatively toward the limit; check Sent before starting another thread. Recipient requests to stop persist independently of spreadsheet errors and block new automated intake threads. Completed/stopped profiles with pending spreadsheet writes retry saving without sending email.

Keep the app running and the computer awake for background processing. The browser may be closed; the backend still processes active intake threads. Connecting another Gmail account prevents processing threads owned by the previous account until that account is connected again.

## Verification and local data

```sh
npm test
npm run diagnose
# Optional rendered workflow checks (simulated Google services):
npx playwright install chromium
npm run test:browser
```

`diagnose` requires the local app to be running and performs a small real Gemini generation plus Gmail identity/read-access checks, without sending mail. Automated tests use simulated Google services and never send real email or write the live spreadsheet. See TESTING.md for environment limitations.

`.data/` stores OAuth tokens, profiles, evidence, previews, thread identities, counters, and sync status. Files are mode `0600`, with directory mode `0700`. It and the credential files are excluded from Git. Loaded thread bodies remain in memory; extracted profiles and generated drafts are persisted. Do not publish credentials or this data directory.

Reference: [Gmail threading](https://developers.google.com/workspace/gmail/api/guides/threads), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Sheets values API](https://developers.google.com/workspace/sheets/api/guides/values).
