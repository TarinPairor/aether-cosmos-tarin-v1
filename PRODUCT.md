# Cosmos

<!-- impeccable:product-schema 1 -->

## Platform

web

## Purpose and user

A single local operator manages natural email conversations that collect 20 profile columns into one Google Sheets row per person. The service runs on localhost:8081 using Google service account and Gmail OAuth credentials.

## Confirmed requirements

Warm conversational persona Cosmos; source-supported answers without guessing personal details; incremental header-based spreadsheet updates; at most five outgoing emails per thread including the introduction; explicit new threads after the cap.

The thread dashboard supports clicking existing conversations, full message history and recipient reply counts. Before the first send, actions are Generate intro / Send intro. Afterward they are Generate reply / Send reply. The operator can generate a continuation without waiting for another recipient response. The bottom freeform email composer is removed.

## Operating defaults and constraints

New threads default to preview/review before sending. Automatic follow-ups are an explicit per-thread option, triggered only by recipient replies. Background extraction and sheet sync continue while the app runs. Row 1 in the connected spreadsheet defines the fields to collect; Email is required for identity matching and Person ID is generated/reused when that column exists. Other columns must be supplied, explicitly declined, or explicitly marked not applicable. Unknowns remain blank. Stops suppress further intake. Attachment contents, CC/BCC, and reply-all are excluded.

Credential contents must never appear in logs or browser responses. Live email and sheet writes require Google configuration and consent; source and automated test verification are separate from live verification. See TESTING.md.
