# qbo-mcp

A Model Context Protocol (MCP) server for the **QuickBooks Online Accounting API**. Manage customers, vendors, invoices, bills, payments, items, reports, and more — all from Claude.

Supports both **stdio** (Claude Desktop) and **HTTP/SSE** (Railway / remote clients).

---

## Tools (48 total)

| Category | Tool | Description |
|---|---|---|
| **Accounts** | `list_accounts` | Query chart of accounts with optional WHERE filter |
| | `get_account` | Get account by ID |
| | `create_account` | Create a new account |
| | `update_account` | Sparse-update an account |
| **Customers** | `list_customers` | Query customers |
| | `get_customer` | Get customer by ID |
| | `create_customer` | Create a new customer |
| | `update_customer` | Sparse-update a customer |
| **Vendors** | `list_vendors` | Query vendors |
| | `get_vendor` | Get vendor by ID |
| | `create_vendor` | Create a new vendor |
| | `update_vendor` | Sparse-update a vendor |
| **Items** | `list_items` | Query products/services |
| | `get_item` | Get item by ID |
| | `create_item` | Create a new item |
| | `update_item` | Sparse-update an item |
| **Invoices** | `list_invoices` | Query invoices |
| | `get_invoice` | Get invoice by ID |
| | `create_invoice` | Create a new invoice |
| | `update_invoice` | Sparse-update an invoice |
| | `delete_invoice` | Delete/void an invoice |
| **Bills** | `list_bills` | Query vendor bills |
| | `get_bill` | Get bill by ID |
| | `create_bill` | Create a new bill |
| | `update_bill` | Sparse-update a bill |
| | `delete_bill` | Delete a bill |
| **Payments** | `list_payments` | Query customer payments |
| | `get_payment` | Get payment by ID |
| | `create_payment` | Record a customer payment |
| | `delete_payment` | Delete a payment |
| **Purchases** | `list_purchases` | Query purchases/expenses |
| | `get_purchase` | Get purchase by ID |
| | `create_purchase` | Create a purchase/expense |
| | `delete_purchase` | Delete a purchase |
| **Estimates** | `list_estimates` | Query estimates/quotes |
| | `get_estimate` | Get estimate by ID |
| | `create_estimate` | Create a new estimate |
| | `delete_estimate` | Delete an estimate |
| **Sales Receipts** | `list_sales_receipts` | Query sales receipts |
| | `get_sales_receipt` | Get sales receipt by ID |
| | `create_sales_receipt` | Create a new sales receipt |
| | `delete_sales_receipt` | Delete a sales receipt |
| **Credit Memos** | `list_credit_memos` | Query credit memos |
| | `get_credit_memo` | Get credit memo by ID |
| | `create_credit_memo` | Create a new credit memo |
| **Transfers** | `list_transfers` | Query account transfers |
| | `get_transfer` | Get transfer by ID |
| | `create_transfer` | Create a funds transfer |
| **Company** | `get_company_info` | Get company details |
| **Reports** | `get_profit_and_loss_report` | P&L / Income Statement |
| | `get_balance_sheet_report` | Balance Sheet |
| | `get_cash_flow_report` | Cash Flow Statement |
| | `get_accounts_receivable_aging_report` | A/R Aging Summary |
| | `get_accounts_payable_aging_report` | A/P Aging Summary |
| | `get_trial_balance_report` | Trial Balance |
| **Query** | `query_qbo` | Run a custom SQL-style QBO query |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `QBO_REALM_ID` | **Yes** | Company/Realm ID from your QBO URL |
| `QBO_CLIENT_ID` | For refresh | OAuth 2.0 Client ID from Intuit Developer Portal |
| `QBO_CLIENT_SECRET` | For refresh | OAuth 2.0 Client Secret |
| `QBO_ACCESS_TOKEN` | Yes* | OAuth 2.0 access token (expires every 60 min) |
| `QBO_REFRESH_TOKEN` | Yes* | OAuth 2.0 refresh token (used for auto-renewal) |
| `QBO_ENVIRONMENT` | No | `sandbox` (default) or `production` |
| `TRANSPORT` | No | `http` (default) or `stdio` |
| `PORT` | No | HTTP port (default `3000`) |

*Either `QBO_ACCESS_TOKEN` or `QBO_REFRESH_TOKEN` is required. For production, provide the refresh token plus client credentials for automatic token renewal.

### Getting credentials

1. Go to [developer.intuit.com](https://developer.intuit.com) and create an app
2. Under **Keys & credentials**, copy your `Client ID` and `Client Secret`
3. Use the **OAuth 2.0 Playground** in the dev portal to generate an `Access Token` and `Refresh Token`
4. Your `Realm ID` is in the QBO URL: `qbo.intuit.com/app/homepage?...realmId=XXXXXXXXXX`

---

## Claude Desktop Configuration

### Remote (Railway)

```json
{
  "mcpServers": {
    "quickbooks": {
      "url": "https://your-app.up.railway.app/sse"
    }
  }
}
```

### Local (stdio)

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["/absolute/path/to/qbo-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "QBO_REALM_ID": "your-realm-id",
        "QBO_ACCESS_TOKEN": "your-access-token",
        "QBO_REFRESH_TOKEN": "your-refresh-token",
        "QBO_CLIENT_ID": "your-client-id",
        "QBO_CLIENT_SECRET": "your-client-secret",
        "QBO_ENVIRONMENT": "sandbox"
      }
    }
  }
}
```

---

## Deploy to Railway

### Option A — GitHub deployer (recommended)

1. Push this repo to GitHub
2. In Railway: **New Project → Deploy from GitHub repo** → select this repo
3. Railway auto-detects the Dockerfile and `railway.toml`
4. Go to **Variables** and set:
   - `QBO_REALM_ID`
   - `QBO_ACCESS_TOKEN`
   - `QBO_REFRESH_TOKEN`
   - `QBO_CLIENT_ID`
   - `QBO_CLIENT_SECRET`
   - `QBO_ENVIRONMENT` → `production` (when ready)
5. Go to **Settings → Networking → Generate Domain**
6. Connect Claude to `https://your-app.up.railway.app/sse`

### Option B — Railway CLI

```bash
railway login
railway init
railway up
railway domain
```

---

## Local Development

```bash
npm install
cp .env.example .env   # fill in your credentials
npm run build
node dist/index.js
```
