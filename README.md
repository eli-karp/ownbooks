# OwnBooks — local-first bookkeeping

Your books live on **your** device. No account, no cloud, no subscription.

## Open it
- **Computer:** double-click `dist/OwnBooks.html` (Chrome, Edge, Firefox, Safari). Bookmark it. Works offline.
- **Phone (installable app):** put the `dist/web/` folder on any static web host you control (GitHub Pages, Netlify, your own site), open it on the phone, then *Share → Add to Home Screen* (iPhone) or *Install app* (Android). Data is still stored only on the phone.

## What it does
Clients, vendors, invoices, payments, bills, expenses, deposits, transfers, journal entries · chart of accounts & general ledger (true double-entry) ·
bank/credit-card statement import (CSV, OFX, QFX) with review queue, auto-categorization rules, matching & reconciliation ·
📷 receipt capture from the phone camera · projects with per-project P&L · GST/HST return worksheet & T2125 income-tax summary ·
P&L, Balance Sheet, Trial Balance, A/R & A/P aging, sales/expense by name, cash flow · custom fields · every past entry editable, with a full change history and one-click undo.

## Your data
Stored in the browser's IndexedDB on that device. **Settings → Download full backup** gives you one `.json` file (including receipt photos) that you can keep, move to another device (Restore), or give to your accountant. On desktop Chrome/Edge you can also link a file and it auto-saves there on every change.

## Develop
Edit files in `src/`, then run `python3 build.py`.

## Sign in to your bank with your username & password (like QuickBooks)
Banking → 🔗 Bank connections → **Sign in to your bank**:
1. Start the Bank Bridge (below). First time only it installs its helper (needs internet once) and needs Google Chrome or Microsoft Edge installed.
2. Choose an **OwnBooks master password** — it encrypts the bank logins you save (AES-256-GCM, scrypt). It is never written to disk; logins auto-lock after 30 minutes.
3. **+ Add a bank** → pick your bank → enter your online-banking username & password → **Save & connect**.
4. A browser window opens your bank and signs in for you. If the bank asks for a security code, enter it in that window.
5. First time only: click **I'm signed in — start**, go to your account activity, click Download/Export and pick **OFX/QFX** (best) or CSV. Do it for each account, then close the window. OwnBooks remembers those clicks (never what you type).
6. From then on, **⟳ Sign in & download** does everything automatically; new transactions land in *For review*.

Where things live: encrypted logins → `~/.ownbooks-bridge.json`; the bank browser profile (so your bank remembers this device) → `~/.ownbooks-bank-browser`; downloaded statement files are deleted as soon as OwnBooks reads them.
If your bank changes its website, sync stops and asks you to finish by hand — use **Teach the download steps again**.

## Live bank connection (Bank Bridge)
Banks only share data through bank-data services (Plaid, SimpleFIN), and those services require a secret key that must not sit inside a web page.
`dist/bank-bridge/` is a tiny program that runs **on your own computer only** (127.0.0.1, nothing exposed to the network):

1. Install Node.js LTS from nodejs.org.
2. Double-click `start-bank-bridge.bat` (Windows) / `start-bank-bridge.command` (Mac) / `start-bank-bridge.sh` (Linux). Your browser opens http://127.0.0.1:8765.
3. Banking → 🔗 Bank connections → paste your Plaid client ID + secret (free account at dashboard.plaid.com) → **Connect a bank account** → log in in Plaid's window.
4. Choose which OwnBooks account each bank account records into. Click **Sync**. New transactions appear in *For review*.

Where things live: Plaid/SimpleFIN keys + bank access tokens → `~/.ownbooks-bridge.json` (owner-only permissions). Transactions → OwnBooks on this device. The bank-data service sees your transactions in transit (that's how every bank-connected app works) but OwnBooks has no server and stores nothing elsewhere.
Note: the copy of OwnBooks at http://127.0.0.1:8765 keeps its own data separate from a double-clicked OwnBooks.html — use Backup/Restore once to move your books, or paste the bridge key into the double-clicked copy.
Plaid notes: Sandbox = test banks (user `user_good` / `pass_good`). Production requires Plaid to approve your account; some banks (OAuth) also need a redirect URI registered with Plaid — use `http://localhost:8765/oauth` if Plaid allows it for your account.
