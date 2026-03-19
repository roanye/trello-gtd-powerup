# Trello GTD Table View — Power-Up

## Overview

A Trello Power-Up that adds a full-screen **Table View** button to any board. Cards are displayed in a spreadsheet-style table with inline editing, column toggling, filtering, and sorting.

## Columns

| Column | Source | Editable |
|--------|--------|----------|
| Name | Native Trello card name | Click to open card |
| List | Native Trello list | Read-only |
| Labels | Native Trello labels | Read-only |
| Next Action | Plugin storage | Inline text edit |
| Who | Plugin storage | Inline text edit (comma-separated, displays as chips) |
| Status | Plugin storage | Dropdown: Not Started / In Progress / Waiting / Done |
| Priority | Plugin storage | Dropdown: Critical / High / Medium / Low |
| Due Date | Native Trello | Read-only |
| Members | Native Trello | Read-only (toggle on via Columns) |

## Features

- Click any **Status** or **Priority** cell to open a dropdown
- Click any **Next Action** or **Who** cell to type inline
- Click **Name** to open the card in Trello
- Sort by any column by clicking the column header
- Filter by: text search, list, status, or priority
- Toggle column visibility with the **Columns** button (saved per-user)
- Refresh button to reload live board data without closing the modal

## Setup

### 1. Create a Power-Up in Trello

1. Go to: https://trello.com/power-ups/admin
2. Click **New** → give it a name (e.g. "GTD Table View")
3. Set the **Connector URL** to the hosted URL of `index.html`

### 2. Host the files

The Power-Up must be served over HTTPS (Trello requires it). Options:

**Option A — GitHub Pages (free, recommended)**
1. Push this folder to a GitHub repo
2. Enable GitHub Pages (Settings → Pages → Deploy from branch)
3. Your Connector URL will be: `https://<username>.github.io/<repo>/index.html`

**Option B — Netlify / Vercel (drag-and-drop)**
1. Drag this folder onto https://app.netlify.com/drop
2. Copy the generated URL and append `/index.html`

**Option C — Local development with ngrok**
1. Install ngrok: https://ngrok.com
2. Run a local server: `npx serve .` (from this folder)
3. Run: `ngrok http 3000`
4. Use the ngrok HTTPS URL as your Connector URL

### 3. Add the Power-Up to your board

1. Open your Trello board
2. Click **Power-Ups** in the board menu
3. Search for your custom Power-Up name and enable it
4. A **Table View** button will appear in the board header

## Design Notes

- **Plugin storage** (`t.set/get`) stores Next Action, Who, Status, Priority per card. Data is stored under your Power-Up's namespace and is shared across all board members.
- Column visibility and sort preferences are saved per-member privately.
- The table reloads all board data on open; use the Refresh button for live updates.

## Appendix

### Storage limits
Trello allows 4 KB of shared plugin data per card. Each card's GTD fields use well under 1 KB.

### To add a new dropdown option
Edit the `options` array for that column in `js/table.js` and update the matching color map.

### To edit card names
Card name editing requires the Trello REST API with user OAuth. This can be added by implementing `t.getRestApi()` with an API key registered in the Power-Up admin. The current version opens the card instead.
