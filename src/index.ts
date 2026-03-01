import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";

// ── Configuration ─────────────────────────────────────────────────────────────
const REALM_ID      = process.env.QBO_REALM_ID ?? "";
const CLIENT_ID     = process.env.QBO_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET ?? "";
const ENVIRONMENT   = (process.env.QBO_ENVIRONMENT ?? "sandbox") as "sandbox" | "production";
const PORT          = parseInt(process.env.PORT ?? "3000", 10);
const TRANSPORT     = process.env.TRANSPORT ?? "http";
const MINOR_VERSION = "70";

let accessToken  = process.env.QBO_ACCESS_TOKEN ?? "";
let refreshToken = process.env.QBO_REFRESH_TOKEN ?? "";

if (!REALM_ID || (!accessToken && !refreshToken)) {
  console.error(
    "Warning: QBO_REALM_ID and QBO_ACCESS_TOKEN (or QBO_REFRESH_TOKEN) must be set before using any tools."
  );
}

const BASE_URL = ENVIRONMENT === "production"
  ? "https://quickbooks.api.intuit.com"
  : "https://sandbox-quickbooks.api.intuit.com";

// ── OAuth token refresh ───────────────────────────────────────────────────────
async function doTokenRefresh(): Promise<void> {
  if (!refreshToken || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Cannot refresh token: set QBO_REFRESH_TOKEN, QBO_CLIENT_ID, and QBO_CLIENT_SECRET");
  }
  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string; refresh_token?: string };
  accessToken = data.access_token;
  if (data.refresh_token) refreshToken = data.refresh_token;
}

// ── API fetch helper ──────────────────────────────────────────────────────────
async function apiFetch(
  path: string,
  options: RequestInit = {},
  params: Record<string, string> = {}
): Promise<unknown> {
  if (!REALM_ID) throw new Error("QBO_REALM_ID is not set. Add it in the Railway Variables tab.");
  if (!accessToken && !refreshToken) throw new Error("QBO_ACCESS_TOKEN or QBO_REFRESH_TOKEN is not set. Add it in the Railway Variables tab.");
  const makeReq = (token: string) => {
    const url = new URL(`${BASE_URL}/v3/company/${REALM_ID}${path}`);
    url.searchParams.set("minorversion", MINOR_VERSION);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return fetch(url.toString(), {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers as Record<string, string> ?? {}),
      },
    });
  };

  let res = await makeReq(accessToken);
  if (res.status === 401 && refreshToken) {
    await doTokenRefresh();
    res = await makeReq(accessToken);
  }
  if (!res.ok) throw new Error(`QBO API ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── CRUD + query helpers ──────────────────────────────────────────────────────
const qboRead   = (entity: string, id: string) =>
  apiFetch(`/${entity}/${id}`);

const qboCreate = (entity: string, body: unknown) =>
  apiFetch(`/${entity}`, { method: "POST", body: JSON.stringify(body) });

const qboUpdate = (entity: string, body: unknown) =>
  apiFetch(`/${entity}`, { method: "POST", body: JSON.stringify(body) });

const qboDelete = (entity: string, id: string, syncToken: string) =>
  apiFetch(`/${entity}`, {
    method: "POST",
    body: JSON.stringify({ Id: id, SyncToken: syncToken }),
  }, { operation: "delete" });

const qboQuery  = (sql: string) =>
  apiFetch("/query", {}, { query: sql });

const fetchReport = (reportType: string, params: Record<string, string> = {}) =>
  apiFetch(`/reports/${reportType}`, {}, params);

function buildQuery(entity: string, where?: string, max = 100, start = 1): string {
  let q = `SELECT * FROM ${entity}`;
  if (where) q += ` WHERE ${where}`;
  return `${q} MAXRESULTS ${max} STARTPOSITION ${start}`;
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  // ── ACCOUNTS ──────────────────────────────────────────────────────────────
  {
    name: "list_accounts",
    description: "Query the QuickBooks Online chart of accounts. Returns accounts matching an optional WHERE filter.",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL-style WHERE clause, e.g. \"AccountType='Bank' AND Active=true\"" },
        max_results: { type: "number", description: "Max records to return (default 100, max 1000)" },
        start_position: { type: "number", description: "Pagination offset, 1-based (default 1)" },
      },
    },
  },
  {
    name: "get_account",
    description: "Retrieve a single QuickBooks Online account by its ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Account ID" },
      },
    },
  },
  {
    name: "create_account",
    description: "Create a new account in the QuickBooks Online chart of accounts. AccountType values: Bank, AccountsReceivable, AccountsPayable, CreditCard, Expense, Income, OtherCurrentAsset, OtherCurrentLiability, LongTermLiability, Equity, OtherExpense, OtherIncome, CostOfGoodsSold.",
    inputSchema: {
      type: "object",
      required: ["name", "account_type"],
      properties: {
        name: { type: "string", description: "Account name (must be unique)" },
        account_type: { type: "string", description: "Account type, e.g. Bank, Expense, Income" },
        account_sub_type: { type: "string", description: "Account subtype (optional, must match AccountType)" },
        description: { type: "string", description: "Account description" },
        account_number: { type: "string", description: "Account number displayed in QBO" },
        currency_ref: { type: "string", description: "Currency code, e.g. USD (defaults to company currency)" },
      },
    },
  },
  {
    name: "update_account",
    description: "Update an existing QuickBooks Online account using sparse update. Requires Id and SyncToken from the current record.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Account ID" },
        sync_token: { type: "string", description: "SyncToken from the latest read (optimistic locking)" },
        name: { type: "string", description: "New account name" },
        description: { type: "string", description: "New description" },
        active: { type: "boolean", description: "Set false to deactivate the account" },
        account_number: { type: "string", description: "New account number" },
      },
    },
  },

  // ── CUSTOMERS ─────────────────────────────────────────────────────────────
  {
    name: "list_customers",
    description: "Query QuickBooks Online customers. Returns all customers or filtered results.",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"DisplayName LIKE '%Acme%' AND Active=true\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_customer",
    description: "Retrieve a single QuickBooks Online customer by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Customer ID" },
      },
    },
  },
  {
    name: "create_customer",
    description: "Create a new customer in QuickBooks Online.",
    inputSchema: {
      type: "object",
      required: ["display_name"],
      properties: {
        display_name: { type: "string", description: "Unique display name for the customer" },
        given_name: { type: "string", description: "First name" },
        family_name: { type: "string", description: "Last name" },
        company_name: { type: "string", description: "Company name" },
        email: { type: "string", description: "Primary email address" },
        phone: { type: "string", description: "Primary phone number" },
        billing_address_json: { type: "string", description: "JSON object for billing address, e.g. {\"Line1\":\"123 Main St\",\"City\":\"Springfield\",\"CountrySubDivisionCode\":\"IL\",\"PostalCode\":\"62701\"}" },
        currency_ref: { type: "string", description: "Currency code, e.g. USD" },
        notes: { type: "string", description: "Notes about the customer" },
      },
    },
  },
  {
    name: "update_customer",
    description: "Update an existing QuickBooks Online customer using sparse update. Requires Id and SyncToken.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Customer ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
        display_name: { type: "string", description: "New display name" },
        given_name: { type: "string", description: "First name" },
        family_name: { type: "string", description: "Last name" },
        company_name: { type: "string", description: "Company name" },
        email: { type: "string", description: "Primary email" },
        phone: { type: "string", description: "Primary phone" },
        active: { type: "boolean", description: "Set false to deactivate" },
        notes: { type: "string", description: "Notes" },
      },
    },
  },

  // ── VENDORS ───────────────────────────────────────────────────────────────
  {
    name: "list_vendors",
    description: "Query QuickBooks Online vendors/suppliers.",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"DisplayName LIKE '%Vendor%' AND Active=true\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_vendor",
    description: "Retrieve a single QuickBooks Online vendor by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Vendor ID" },
      },
    },
  },
  {
    name: "create_vendor",
    description: "Create a new vendor in QuickBooks Online.",
    inputSchema: {
      type: "object",
      required: ["display_name"],
      properties: {
        display_name: { type: "string", description: "Unique display name for the vendor" },
        given_name: { type: "string", description: "First name" },
        family_name: { type: "string", description: "Last name" },
        company_name: { type: "string", description: "Company name" },
        email: { type: "string", description: "Primary email" },
        phone: { type: "string", description: "Primary phone" },
        billing_address_json: { type: "string", description: "JSON object for billing address" },
        account_number: { type: "string", description: "Vendor account number" },
        currency_ref: { type: "string", description: "Currency code, e.g. USD" },
      },
    },
  },
  {
    name: "update_vendor",
    description: "Update an existing QuickBooks Online vendor using sparse update. Requires Id and SyncToken.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Vendor ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
        display_name: { type: "string", description: "New display name" },
        email: { type: "string", description: "Email" },
        phone: { type: "string", description: "Phone" },
        active: { type: "boolean", description: "Set false to deactivate" },
        account_number: { type: "string", description: "Vendor account number" },
      },
    },
  },

  // ── ITEMS (Products & Services) ───────────────────────────────────────────
  {
    name: "list_items",
    description: "Query QuickBooks Online items (products and services used on invoices/bills).",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"Type='Service' AND Active=true\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_item",
    description: "Retrieve a single QuickBooks Online item (product/service) by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Item ID" },
      },
    },
  },
  {
    name: "create_item",
    description: "Create a new item (product/service) in QuickBooks Online. Type values: Service, Inventory, NonInventory.",
    inputSchema: {
      type: "object",
      required: ["name", "type", "income_account_id"],
      properties: {
        name: { type: "string", description: "Item name (must be unique)" },
        type: { type: "string", description: "Item type: Service, Inventory, NonInventory" },
        description: { type: "string", description: "Sales description shown on invoices" },
        unit_price: { type: "number", description: "Default selling price" },
        income_account_id: { type: "string", description: "Income account ID for sales (required)" },
        expense_account_id: { type: "string", description: "Expense/COGS account ID (required for Inventory)" },
        asset_account_id: { type: "string", description: "Asset account ID (required for Inventory)" },
        sku: { type: "string", description: "Item SKU" },
        track_qty_on_hand: { type: "boolean", description: "Track inventory quantity (Inventory items)" },
        qty_on_hand: { type: "number", description: "Initial quantity on hand (Inventory items)" },
        inv_start_date: { type: "string", description: "Inventory start date YYYY-MM-DD (Inventory items)" },
        taxable: { type: "boolean", description: "Whether item is taxable" },
      },
    },
  },
  {
    name: "update_item",
    description: "Update an existing QuickBooks Online item using sparse update. Requires Id and SyncToken.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Item ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
        name: { type: "string", description: "New item name" },
        description: { type: "string", description: "New description" },
        unit_price: { type: "number", description: "New unit price" },
        active: { type: "boolean", description: "Set false to deactivate" },
        taxable: { type: "boolean", description: "Whether item is taxable" },
      },
    },
  },

  // ── INVOICES ──────────────────────────────────────────────────────────────
  {
    name: "list_invoices",
    description: "Query QuickBooks Online invoices. Filter by customer, status, date range, etc.",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"CustomerRef='1' AND TxnDate>='2024-01-01'\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_invoice",
    description: "Retrieve a single QuickBooks Online invoice by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Invoice ID" },
      },
    },
  },
  {
    name: "create_invoice",
    description: "Create a new invoice in QuickBooks Online. The lines_json must be a JSON array of line objects with Amount, DetailType='SalesItemLineDetail', and SalesItemLineDetail containing ItemRef.value.",
    inputSchema: {
      type: "object",
      required: ["customer_id", "lines_json"],
      properties: {
        customer_id: { type: "string", description: "Customer ID (CustomerRef.value)" },
        lines_json: { type: "string", description: "JSON array of line items, e.g. [{\"Amount\":100,\"DetailType\":\"SalesItemLineDetail\",\"SalesItemLineDetail\":{\"ItemRef\":{\"value\":\"1\"},\"UnitPrice\":100,\"Qty\":1}}]" },
        txn_date: { type: "string", description: "Transaction date YYYY-MM-DD (defaults to today)" },
        due_date: { type: "string", description: "Due date YYYY-MM-DD" },
        customer_memo: { type: "string", description: "Message displayed on the invoice" },
        private_note: { type: "string", description: "Private note (not shown to customer)" },
        bill_email: { type: "string", description: "Email address to send invoice to" },
        shipping_amount: { type: "number", description: "Shipping amount" },
        discount_rate: { type: "number", description: "Discount percentage (0–100)" },
      },
    },
  },
  {
    name: "update_invoice",
    description: "Update an existing invoice using sparse update. Requires Id and SyncToken from the current record.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Invoice ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
        customer_id: { type: "string", description: "Customer ID" },
        lines_json: { type: "string", description: "JSON array of line items (replaces existing lines)" },
        txn_date: { type: "string", description: "Transaction date YYYY-MM-DD" },
        due_date: { type: "string", description: "Due date YYYY-MM-DD" },
        customer_memo: { type: "string", description: "Customer memo" },
        private_note: { type: "string", description: "Private note" },
      },
    },
  },
  {
    name: "delete_invoice",
    description: "Void/delete a QuickBooks Online invoice. Requires Id and SyncToken from the current record.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Invoice ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
      },
    },
  },

  // ── BILLS ─────────────────────────────────────────────────────────────────
  {
    name: "list_bills",
    description: "Query QuickBooks Online bills (vendor expenses). Filter by vendor, date, etc.",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"VendorRef='10' AND TxnDate>='2024-01-01'\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_bill",
    description: "Retrieve a single QuickBooks Online bill by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Bill ID" },
      },
    },
  },
  {
    name: "create_bill",
    description: "Create a new bill (vendor invoice) in QuickBooks Online. lines_json must be a JSON array with Amount, DetailType='AccountBasedExpenseLineDetail', and AccountBasedExpenseLineDetail containing AccountRef.value.",
    inputSchema: {
      type: "object",
      required: ["vendor_id", "lines_json"],
      properties: {
        vendor_id: { type: "string", description: "Vendor ID (VendorRef.value)" },
        lines_json: { type: "string", description: "JSON array of bill lines, e.g. [{\"Amount\":100,\"DetailType\":\"AccountBasedExpenseLineDetail\",\"AccountBasedExpenseLineDetail\":{\"AccountRef\":{\"value\":\"7\"}}}]" },
        txn_date: { type: "string", description: "Bill date YYYY-MM-DD" },
        due_date: { type: "string", description: "Due date YYYY-MM-DD" },
        doc_number: { type: "string", description: "Vendor's bill/reference number" },
        private_note: { type: "string", description: "Private memo" },
        ap_account_id: { type: "string", description: "Accounts Payable account ID (defaults to first AP account)" },
      },
    },
  },
  {
    name: "update_bill",
    description: "Update an existing QuickBooks Online bill using sparse update. Requires Id and SyncToken.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Bill ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
        lines_json: { type: "string", description: "JSON array of bill lines (replaces existing lines)" },
        due_date: { type: "string", description: "Due date YYYY-MM-DD" },
        doc_number: { type: "string", description: "Vendor bill reference number" },
        private_note: { type: "string", description: "Private memo" },
      },
    },
  },
  {
    name: "delete_bill",
    description: "Delete a QuickBooks Online bill. Requires Id and SyncToken.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Bill ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
      },
    },
  },

  // ── PAYMENTS (Customer Payments) ──────────────────────────────────────────
  {
    name: "list_payments",
    description: "Query QuickBooks Online customer payments. Filter by customer, date, amount, etc.",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"CustomerRef='5' AND TxnDate>='2024-01-01'\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_payment",
    description: "Retrieve a single QuickBooks Online customer payment by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Payment ID" },
      },
    },
  },
  {
    name: "create_payment",
    description: "Record a customer payment in QuickBooks Online. Link to invoices via lines_json. lines_json example: [{\"Amount\":100,\"LinkedTxn\":[{\"TxnId\":\"15\",\"TxnType\":\"Invoice\"}]}]",
    inputSchema: {
      type: "object",
      required: ["customer_id", "total_amount"],
      properties: {
        customer_id: { type: "string", description: "Customer ID" },
        total_amount: { type: "number", description: "Total payment amount" },
        txn_date: { type: "string", description: "Payment date YYYY-MM-DD" },
        payment_ref_num: { type: "string", description: "Check number or payment reference" },
        payment_method_id: { type: "string", description: "Payment method ID (e.g. cash, check, credit card)" },
        deposit_account_id: { type: "string", description: "Bank/deposit account ID" },
        lines_json: { type: "string", description: "JSON array linking payment to invoices. If omitted, applies as unapplied credit." },
        private_note: { type: "string", description: "Private memo" },
      },
    },
  },
  {
    name: "delete_payment",
    description: "Delete/void a QuickBooks Online customer payment. Requires Id and SyncToken.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Payment ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
      },
    },
  },

  // ── PURCHASES (Expenses / Checks / Credit Card Charges) ───────────────────
  {
    name: "list_purchases",
    description: "Query QuickBooks Online purchases (expenses, checks, credit card charges).",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"PaymentType='Cash' AND TxnDate>='2024-01-01'\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_purchase",
    description: "Retrieve a single QuickBooks Online purchase (expense/check/credit card charge) by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Purchase ID" },
      },
    },
  },
  {
    name: "create_purchase",
    description: "Create a new purchase/expense in QuickBooks Online. PaymentType: Cash, Check, CreditCard. lines_json example: [{\"Amount\":50,\"DetailType\":\"AccountBasedExpenseLineDetail\",\"AccountBasedExpenseLineDetail\":{\"AccountRef\":{\"value\":\"7\"}}}]",
    inputSchema: {
      type: "object",
      required: ["account_id", "payment_type", "total_amount", "lines_json"],
      properties: {
        account_id: { type: "string", description: "Payment account ID (bank account, credit card)" },
        payment_type: { type: "string", description: "Payment type: Cash, Check, CreditCard" },
        total_amount: { type: "number", description: "Total purchase amount" },
        lines_json: { type: "string", description: "JSON array of expense lines" },
        txn_date: { type: "string", description: "Purchase date YYYY-MM-DD" },
        doc_number: { type: "string", description: "Reference number" },
        vendor_id: { type: "string", description: "Vendor ID (EntityRef.value)" },
        private_note: { type: "string", description: "Private memo" },
      },
    },
  },
  {
    name: "delete_purchase",
    description: "Delete a QuickBooks Online purchase. Requires Id and SyncToken.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Purchase ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
      },
    },
  },

  // ── ESTIMATES ─────────────────────────────────────────────────────────────
  {
    name: "list_estimates",
    description: "Query QuickBooks Online estimates (quotes sent to customers).",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"CustomerRef='3' AND TxnStatus='Accepted'\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_estimate",
    description: "Retrieve a single QuickBooks Online estimate by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Estimate ID" },
      },
    },
  },
  {
    name: "create_estimate",
    description: "Create a new estimate (quote) in QuickBooks Online.",
    inputSchema: {
      type: "object",
      required: ["customer_id", "lines_json"],
      properties: {
        customer_id: { type: "string", description: "Customer ID" },
        lines_json: { type: "string", description: "JSON array of line items (same format as invoice lines)" },
        txn_date: { type: "string", description: "Estimate date YYYY-MM-DD" },
        expiration_date: { type: "string", description: "Expiration date YYYY-MM-DD" },
        customer_memo: { type: "string", description: "Message to customer" },
        private_note: { type: "string", description: "Private memo" },
      },
    },
  },
  {
    name: "delete_estimate",
    description: "Close/delete a QuickBooks Online estimate. Requires Id and SyncToken.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Estimate ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
      },
    },
  },

  // ── SALES RECEIPTS ────────────────────────────────────────────────────────
  {
    name: "list_sales_receipts",
    description: "Query QuickBooks Online sales receipts (immediate-payment sales).",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"CustomerRef='2' AND TxnDate>='2024-01-01'\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_sales_receipt",
    description: "Retrieve a single QuickBooks Online sales receipt by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Sales receipt ID" },
      },
    },
  },
  {
    name: "create_sales_receipt",
    description: "Create a new sales receipt in QuickBooks Online (used when payment is received at time of sale).",
    inputSchema: {
      type: "object",
      required: ["customer_id", "lines_json"],
      properties: {
        customer_id: { type: "string", description: "Customer ID" },
        lines_json: { type: "string", description: "JSON array of line items (same format as invoice lines)" },
        txn_date: { type: "string", description: "Sale date YYYY-MM-DD" },
        payment_method_id: { type: "string", description: "Payment method ID" },
        deposit_account_id: { type: "string", description: "Deposit to account ID" },
        customer_memo: { type: "string", description: "Message to customer" },
        private_note: { type: "string", description: "Private memo" },
      },
    },
  },
  {
    name: "delete_sales_receipt",
    description: "Delete a QuickBooks Online sales receipt. Requires Id and SyncToken.",
    inputSchema: {
      type: "object",
      required: ["id", "sync_token"],
      properties: {
        id: { type: "string", description: "Sales receipt ID" },
        sync_token: { type: "string", description: "SyncToken from latest read" },
      },
    },
  },

  // ── CREDIT MEMOS ──────────────────────────────────────────────────────────
  {
    name: "list_credit_memos",
    description: "Query QuickBooks Online credit memos issued to customers.",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_credit_memo",
    description: "Retrieve a single QuickBooks Online credit memo by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Credit memo ID" },
      },
    },
  },
  {
    name: "create_credit_memo",
    description: "Create a new credit memo in QuickBooks Online (credit issued to a customer).",
    inputSchema: {
      type: "object",
      required: ["customer_id", "lines_json"],
      properties: {
        customer_id: { type: "string", description: "Customer ID" },
        lines_json: { type: "string", description: "JSON array of credit lines (same format as invoice lines)" },
        txn_date: { type: "string", description: "Credit memo date YYYY-MM-DD" },
        customer_memo: { type: "string", description: "Message to customer" },
        private_note: { type: "string", description: "Private memo" },
      },
    },
  },

  // ── TRANSFERS ─────────────────────────────────────────────────────────────
  {
    name: "list_transfers",
    description: "Query QuickBooks Online transfers between accounts.",
    inputSchema: {
      type: "object",
      properties: {
        where: { type: "string", description: "SQL WHERE clause, e.g. \"TxnDate>='2024-01-01'\"" },
        max_results: { type: "number", description: "Max records (default 100)" },
        start_position: { type: "number", description: "Pagination offset (default 1)" },
      },
    },
  },
  {
    name: "get_transfer",
    description: "Retrieve a single QuickBooks Online transfer by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Transfer ID" },
      },
    },
  },
  {
    name: "create_transfer",
    description: "Create a funds transfer between two QuickBooks Online accounts.",
    inputSchema: {
      type: "object",
      required: ["from_account_id", "to_account_id", "amount"],
      properties: {
        from_account_id: { type: "string", description: "Source account ID (FromAccountRef.value)" },
        to_account_id: { type: "string", description: "Destination account ID (ToAccountRef.value)" },
        amount: { type: "number", description: "Transfer amount" },
        txn_date: { type: "string", description: "Transfer date YYYY-MM-DD" },
        private_note: { type: "string", description: "Private memo" },
      },
    },
  },

  // ── COMPANY INFO ──────────────────────────────────────────────────────────
  {
    name: "get_company_info",
    description: "Retrieve QuickBooks Online company information (name, address, contact info, fiscal year, currency, etc.).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // ── REPORTS ───────────────────────────────────────────────────────────────
  {
    name: "get_profit_and_loss_report",
    description: "Get a Profit and Loss (Income Statement) report from QuickBooks Online.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Report start date YYYY-MM-DD (default: first day of current month)" },
        end_date: { type: "string", description: "Report end date YYYY-MM-DD (default: today)" },
        accounting_method: { type: "string", description: "Accrual or Cash (default: Accrual)" },
        summarize_columns_by: { type: "string", description: "Column grouping: Total, Month, Quarter, Year, Customers, Vendors, Classes, Departments (default: Total)" },
        customer_id: { type: "string", description: "Filter by customer ID" },
        class_id: { type: "string", description: "Filter by class ID" },
        department_id: { type: "string", description: "Filter by department ID" },
      },
    },
  },
  {
    name: "get_balance_sheet_report",
    description: "Get a Balance Sheet report from QuickBooks Online.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Report start date YYYY-MM-DD" },
        end_date: { type: "string", description: "Report end date YYYY-MM-DD (default: today)" },
        accounting_method: { type: "string", description: "Accrual or Cash (default: Accrual)" },
        summarize_columns_by: { type: "string", description: "Column grouping (default: Total)" },
      },
    },
  },
  {
    name: "get_cash_flow_report",
    description: "Get a Cash Flow Statement report from QuickBooks Online.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Report start date YYYY-MM-DD" },
        end_date: { type: "string", description: "Report end date YYYY-MM-DD" },
        summarize_columns_by: { type: "string", description: "Column grouping (default: Total)" },
      },
    },
  },
  {
    name: "get_accounts_receivable_aging_report",
    description: "Get an Accounts Receivable Aging Summary report from QuickBooks Online showing outstanding customer balances by age.",
    inputSchema: {
      type: "object",
      properties: {
        report_date: { type: "string", description: "As-of date YYYY-MM-DD (default: today)" },
        aging_period: { type: "number", description: "Number of days per aging bucket (default: 30)" },
        num_periods: { type: "number", description: "Number of aging periods (default: 4)" },
        customer_id: { type: "string", description: "Filter by customer ID" },
      },
    },
  },
  {
    name: "get_accounts_payable_aging_report",
    description: "Get an Accounts Payable Aging Summary report from QuickBooks Online showing outstanding vendor balances by age.",
    inputSchema: {
      type: "object",
      properties: {
        report_date: { type: "string", description: "As-of date YYYY-MM-DD (default: today)" },
        aging_period: { type: "number", description: "Number of days per aging bucket (default: 30)" },
        num_periods: { type: "number", description: "Number of aging periods (default: 4)" },
        vendor_id: { type: "string", description: "Filter by vendor ID" },
      },
    },
  },
  {
    name: "get_trial_balance_report",
    description: "Get a Trial Balance report from QuickBooks Online.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Report start date YYYY-MM-DD" },
        end_date: { type: "string", description: "Report end date YYYY-MM-DD (default: today)" },
        accounting_method: { type: "string", description: "Accrual or Cash (default: Accrual)" },
      },
    },
  },

  // ── GENERIC QUERY ─────────────────────────────────────────────────────────
  {
    name: "query_qbo",
    description: "Execute a custom SQL-style query against any QuickBooks Online entity. Supports SELECT, WHERE, ORDER BY, STARTPOSITION, MAXRESULTS. Example: \"SELECT * FROM Invoice WHERE TotalAmt > '500' ORDERBY TxnDate DESC MAXRESULTS 10\"",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: {
        sql: { type: "string", description: "QBO SQL query string (see QBO Query Language docs)" },
      },
    },
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────────
async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  const str  = (k: string) => args[k] as string | undefined;
  const num  = (k: string, def: number) => (args[k] as number | undefined) ?? def;
  const bool = (k: string) => args[k] as boolean | undefined;
  const json = (k: string) => {
    const v = str(k);
    return v ? JSON.parse(v) : undefined;
  };

  switch (name) {
    // ── Accounts ────────────────────────────────────────────────────────────
    case "list_accounts":
      return JSON.stringify(await qboQuery(buildQuery("Account", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_account":
      return JSON.stringify(await qboRead("account", str("id")!), null, 2);

    case "create_account": {
      const body: Record<string, unknown> = {
        Name: str("name"),
        AccountType: str("account_type"),
      };
      if (str("account_sub_type")) body.AccountSubType = str("account_sub_type");
      if (str("description"))      body.Description    = str("description");
      if (str("account_number"))   body.AcctNum        = str("account_number");
      if (str("currency_ref"))     body.CurrencyRef    = { value: str("currency_ref") };
      return JSON.stringify(await qboCreate("account", body), null, 2);
    }

    case "update_account": {
      const body: Record<string, unknown> = {
        Id: str("id"), SyncToken: str("sync_token"), sparse: true,
      };
      if (str("name") !== undefined)           body.Name    = str("name");
      if (str("description") !== undefined)    body.Description = str("description");
      if (bool("active") !== undefined)        body.Active  = bool("active");
      if (str("account_number") !== undefined) body.AcctNum = str("account_number");
      return JSON.stringify(await qboUpdate("account", body), null, 2);
    }

    // ── Customers ───────────────────────────────────────────────────────────
    case "list_customers":
      return JSON.stringify(await qboQuery(buildQuery("Customer", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_customer":
      return JSON.stringify(await qboRead("customer", str("id")!), null, 2);

    case "create_customer": {
      const body: Record<string, unknown> = { DisplayName: str("display_name") };
      if (str("given_name"))    body.GivenName   = str("given_name");
      if (str("family_name"))   body.FamilyName  = str("family_name");
      if (str("company_name"))  body.CompanyName = str("company_name");
      if (str("email"))         body.PrimaryEmailAddr = { Address: str("email") };
      if (str("phone"))         body.PrimaryPhone     = { FreeFormNumber: str("phone") };
      if (str("notes"))         body.Notes        = str("notes");
      if (str("currency_ref"))  body.CurrencyRef  = { value: str("currency_ref") };
      if (str("billing_address_json")) body.BillAddr = json("billing_address_json");
      return JSON.stringify(await qboCreate("customer", body), null, 2);
    }

    case "update_customer": {
      const body: Record<string, unknown> = { Id: str("id"), SyncToken: str("sync_token"), sparse: true };
      if (str("display_name") !== undefined)  body.DisplayName  = str("display_name");
      if (str("given_name") !== undefined)    body.GivenName    = str("given_name");
      if (str("family_name") !== undefined)   body.FamilyName   = str("family_name");
      if (str("company_name") !== undefined)  body.CompanyName  = str("company_name");
      if (str("email") !== undefined)         body.PrimaryEmailAddr = { Address: str("email") };
      if (str("phone") !== undefined)         body.PrimaryPhone     = { FreeFormNumber: str("phone") };
      if (bool("active") !== undefined)       body.Active       = bool("active");
      if (str("notes") !== undefined)         body.Notes        = str("notes");
      return JSON.stringify(await qboUpdate("customer", body), null, 2);
    }

    // ── Vendors ─────────────────────────────────────────────────────────────
    case "list_vendors":
      return JSON.stringify(await qboQuery(buildQuery("Vendor", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_vendor":
      return JSON.stringify(await qboRead("vendor", str("id")!), null, 2);

    case "create_vendor": {
      const body: Record<string, unknown> = { DisplayName: str("display_name") };
      if (str("given_name"))    body.GivenName   = str("given_name");
      if (str("family_name"))   body.FamilyName  = str("family_name");
      if (str("company_name"))  body.CompanyName = str("company_name");
      if (str("email"))         body.PrimaryEmailAddr = { Address: str("email") };
      if (str("phone"))         body.PrimaryPhone     = { FreeFormNumber: str("phone") };
      if (str("account_number"))body.AcctNum     = str("account_number");
      if (str("currency_ref"))  body.CurrencyRef = { value: str("currency_ref") };
      if (str("billing_address_json")) body.BillAddr = json("billing_address_json");
      return JSON.stringify(await qboCreate("vendor", body), null, 2);
    }

    case "update_vendor": {
      const body: Record<string, unknown> = { Id: str("id"), SyncToken: str("sync_token"), sparse: true };
      if (str("display_name") !== undefined)  body.DisplayName = str("display_name");
      if (str("email") !== undefined)         body.PrimaryEmailAddr = { Address: str("email") };
      if (str("phone") !== undefined)         body.PrimaryPhone     = { FreeFormNumber: str("phone") };
      if (bool("active") !== undefined)       body.Active      = bool("active");
      if (str("account_number") !== undefined) body.AcctNum   = str("account_number");
      return JSON.stringify(await qboUpdate("vendor", body), null, 2);
    }

    // ── Items ────────────────────────────────────────────────────────────────
    case "list_items":
      return JSON.stringify(await qboQuery(buildQuery("Item", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_item":
      return JSON.stringify(await qboRead("item", str("id")!), null, 2);

    case "create_item": {
      const body: Record<string, unknown> = {
        Name: str("name"),
        Type: str("type"),
        IncomeAccountRef: { value: str("income_account_id") },
      };
      if (str("description"))     body.Description   = str("description");
      if (args.unit_price !== undefined) body.UnitPrice = num("unit_price", 0);
      if (str("sku"))             body.Sku           = str("sku");
      if (bool("taxable") !== undefined) body.Taxable = bool("taxable");
      if (str("expense_account_id")) body.ExpenseAccountRef = { value: str("expense_account_id") };
      if (str("asset_account_id"))   body.AssetAccountRef   = { value: str("asset_account_id") };
      if (bool("track_qty_on_hand") !== undefined) body.TrackQtyOnHand = bool("track_qty_on_hand");
      if (args.qty_on_hand !== undefined) body.QtyOnHand = num("qty_on_hand", 0);
      if (str("inv_start_date"))  body.InvStartDate  = str("inv_start_date");
      return JSON.stringify(await qboCreate("item", body), null, 2);
    }

    case "update_item": {
      const body: Record<string, unknown> = { Id: str("id"), SyncToken: str("sync_token"), sparse: true };
      if (str("name") !== undefined)        body.Name        = str("name");
      if (str("description") !== undefined) body.Description = str("description");
      if (args.unit_price !== undefined)    body.UnitPrice   = num("unit_price", 0);
      if (bool("active") !== undefined)     body.Active      = bool("active");
      if (bool("taxable") !== undefined)    body.Taxable     = bool("taxable");
      return JSON.stringify(await qboUpdate("item", body), null, 2);
    }

    // ── Invoices ─────────────────────────────────────────────────────────────
    case "list_invoices":
      return JSON.stringify(await qboQuery(buildQuery("Invoice", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_invoice":
      return JSON.stringify(await qboRead("invoice", str("id")!), null, 2);

    case "create_invoice": {
      const body: Record<string, unknown> = {
        CustomerRef: { value: str("customer_id") },
        Line: json("lines_json"),
      };
      if (str("txn_date"))      body.TxnDate       = str("txn_date");
      if (str("due_date"))      body.DueDate       = str("due_date");
      if (str("customer_memo")) body.CustomerMemo  = { value: str("customer_memo") };
      if (str("private_note"))  body.PrivateNote   = str("private_note");
      if (str("bill_email"))    body.BillEmail     = { Address: str("bill_email") };
      if (args.shipping_amount !== undefined) body.ShipFromAddr = undefined;
      if (args.discount_rate !== undefined)   body.DiscountRate = num("discount_rate", 0);
      return JSON.stringify(await qboCreate("invoice", body), null, 2);
    }

    case "update_invoice": {
      const body: Record<string, unknown> = { Id: str("id"), SyncToken: str("sync_token"), sparse: true };
      if (str("customer_id"))   body.CustomerRef  = { value: str("customer_id") };
      if (str("lines_json"))    body.Line         = json("lines_json");
      if (str("txn_date"))      body.TxnDate      = str("txn_date");
      if (str("due_date"))      body.DueDate      = str("due_date");
      if (str("customer_memo")) body.CustomerMemo = { value: str("customer_memo") };
      if (str("private_note"))  body.PrivateNote  = str("private_note");
      return JSON.stringify(await qboUpdate("invoice", body), null, 2);
    }

    case "delete_invoice":
      return JSON.stringify(await qboDelete("invoice", str("id")!, str("sync_token")!), null, 2);

    // ── Bills ────────────────────────────────────────────────────────────────
    case "list_bills":
      return JSON.stringify(await qboQuery(buildQuery("Bill", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_bill":
      return JSON.stringify(await qboRead("bill", str("id")!), null, 2);

    case "create_bill": {
      const body: Record<string, unknown> = {
        VendorRef: { value: str("vendor_id") },
        Line: json("lines_json"),
      };
      if (str("txn_date"))     body.TxnDate     = str("txn_date");
      if (str("due_date"))     body.DueDate     = str("due_date");
      if (str("doc_number"))   body.DocNumber   = str("doc_number");
      if (str("private_note")) body.PrivateNote = str("private_note");
      if (str("ap_account_id")) body.APAccountRef = { value: str("ap_account_id") };
      return JSON.stringify(await qboCreate("bill", body), null, 2);
    }

    case "update_bill": {
      const body: Record<string, unknown> = { Id: str("id"), SyncToken: str("sync_token"), sparse: true };
      if (str("lines_json"))   body.Line        = json("lines_json");
      if (str("due_date"))     body.DueDate     = str("due_date");
      if (str("doc_number"))   body.DocNumber   = str("doc_number");
      if (str("private_note")) body.PrivateNote = str("private_note");
      return JSON.stringify(await qboUpdate("bill", body), null, 2);
    }

    case "delete_bill":
      return JSON.stringify(await qboDelete("bill", str("id")!, str("sync_token")!), null, 2);

    // ── Payments ─────────────────────────────────────────────────────────────
    case "list_payments":
      return JSON.stringify(await qboQuery(buildQuery("Payment", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_payment":
      return JSON.stringify(await qboRead("payment", str("id")!), null, 2);

    case "create_payment": {
      const body: Record<string, unknown> = {
        CustomerRef: { value: str("customer_id") },
        TotalAmt: num("total_amount", 0),
      };
      if (str("txn_date"))          body.TxnDate       = str("txn_date");
      if (str("payment_ref_num"))   body.PaymentRefNum = str("payment_ref_num");
      if (str("payment_method_id")) body.PaymentMethodRef = { value: str("payment_method_id") };
      if (str("deposit_account_id")) body.DepositToAccountRef = { value: str("deposit_account_id") };
      if (str("private_note"))      body.PrivateNote   = str("private_note");
      if (str("lines_json"))        body.Line          = json("lines_json");
      return JSON.stringify(await qboCreate("payment", body), null, 2);
    }

    case "delete_payment":
      return JSON.stringify(await qboDelete("payment", str("id")!, str("sync_token")!), null, 2);

    // ── Purchases ────────────────────────────────────────────────────────────
    case "list_purchases":
      return JSON.stringify(await qboQuery(buildQuery("Purchase", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_purchase":
      return JSON.stringify(await qboRead("purchase", str("id")!), null, 2);

    case "create_purchase": {
      const body: Record<string, unknown> = {
        AccountRef: { value: str("account_id") },
        PaymentType: str("payment_type"),
        TotalAmt: num("total_amount", 0),
        Line: json("lines_json"),
      };
      if (str("txn_date"))    body.TxnDate     = str("txn_date");
      if (str("doc_number"))  body.DocNumber   = str("doc_number");
      if (str("private_note")) body.PrivateNote = str("private_note");
      if (str("vendor_id"))   body.EntityRef   = { value: str("vendor_id"), type: "Vendor" };
      return JSON.stringify(await qboCreate("purchase", body), null, 2);
    }

    case "delete_purchase":
      return JSON.stringify(await qboDelete("purchase", str("id")!, str("sync_token")!), null, 2);

    // ── Estimates ────────────────────────────────────────────────────────────
    case "list_estimates":
      return JSON.stringify(await qboQuery(buildQuery("Estimate", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_estimate":
      return JSON.stringify(await qboRead("estimate", str("id")!), null, 2);

    case "create_estimate": {
      const body: Record<string, unknown> = {
        CustomerRef: { value: str("customer_id") },
        Line: json("lines_json"),
      };
      if (str("txn_date"))        body.TxnDate       = str("txn_date");
      if (str("expiration_date")) body.ExpirationDate = str("expiration_date");
      if (str("customer_memo"))   body.CustomerMemo  = { value: str("customer_memo") };
      if (str("private_note"))    body.PrivateNote   = str("private_note");
      return JSON.stringify(await qboCreate("estimate", body), null, 2);
    }

    case "delete_estimate":
      return JSON.stringify(await qboDelete("estimate", str("id")!, str("sync_token")!), null, 2);

    // ── Sales Receipts ────────────────────────────────────────────────────────
    case "list_sales_receipts":
      return JSON.stringify(await qboQuery(buildQuery("SalesReceipt", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_sales_receipt":
      return JSON.stringify(await qboRead("salesreceipt", str("id")!), null, 2);

    case "create_sales_receipt": {
      const body: Record<string, unknown> = {
        CustomerRef: { value: str("customer_id") },
        Line: json("lines_json"),
      };
      if (str("txn_date"))          body.TxnDate       = str("txn_date");
      if (str("payment_method_id")) body.PaymentMethodRef = { value: str("payment_method_id") };
      if (str("deposit_account_id")) body.DepositToAccountRef = { value: str("deposit_account_id") };
      if (str("customer_memo"))     body.CustomerMemo  = { value: str("customer_memo") };
      if (str("private_note"))      body.PrivateNote   = str("private_note");
      return JSON.stringify(await qboCreate("salesreceipt", body), null, 2);
    }

    case "delete_sales_receipt":
      return JSON.stringify(await qboDelete("salesreceipt", str("id")!, str("sync_token")!), null, 2);

    // ── Credit Memos ─────────────────────────────────────────────────────────
    case "list_credit_memos":
      return JSON.stringify(await qboQuery(buildQuery("CreditMemo", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_credit_memo":
      return JSON.stringify(await qboRead("creditmemo", str("id")!), null, 2);

    case "create_credit_memo": {
      const body: Record<string, unknown> = {
        CustomerRef: { value: str("customer_id") },
        Line: json("lines_json"),
      };
      if (str("txn_date"))      body.TxnDate      = str("txn_date");
      if (str("customer_memo")) body.CustomerMemo = { value: str("customer_memo") };
      if (str("private_note"))  body.PrivateNote  = str("private_note");
      return JSON.stringify(await qboCreate("creditmemo", body), null, 2);
    }

    // ── Transfers ─────────────────────────────────────────────────────────────
    case "list_transfers":
      return JSON.stringify(await qboQuery(buildQuery("Transfer", str("where"), num("max_results", 100), num("start_position", 1))), null, 2);

    case "get_transfer":
      return JSON.stringify(await qboRead("transfer", str("id")!), null, 2);

    case "create_transfer": {
      const body: Record<string, unknown> = {
        FromAccountRef: { value: str("from_account_id") },
        ToAccountRef:   { value: str("to_account_id") },
        Amount: num("amount", 0),
      };
      if (str("txn_date"))     body.TxnDate     = str("txn_date");
      if (str("private_note")) body.PrivateNote = str("private_note");
      return JSON.stringify(await qboCreate("transfer", body), null, 2);
    }

    // ── Company Info ──────────────────────────────────────────────────────────
    case "get_company_info":
      return JSON.stringify(await qboRead("companyinfo", REALM_ID), null, 2);

    // ── Reports ───────────────────────────────────────────────────────────────
    case "get_profit_and_loss_report": {
      const p: Record<string, string> = {};
      if (str("start_date"))            p.start_date           = str("start_date")!;
      if (str("end_date"))              p.end_date             = str("end_date")!;
      if (str("accounting_method"))     p.accounting_method    = str("accounting_method")!;
      if (str("summarize_columns_by"))  p.summarize_column_by  = str("summarize_columns_by")!;
      if (str("customer_id"))           p.customer             = str("customer_id")!;
      if (str("class_id"))              p.class                = str("class_id")!;
      if (str("department_id"))         p.department           = str("department_id")!;
      return JSON.stringify(await fetchReport("ProfitAndLoss", p), null, 2);
    }

    case "get_balance_sheet_report": {
      const p: Record<string, string> = {};
      if (str("start_date"))           p.start_date          = str("start_date")!;
      if (str("end_date"))             p.end_date            = str("end_date")!;
      if (str("accounting_method"))    p.accounting_method   = str("accounting_method")!;
      if (str("summarize_columns_by")) p.summarize_column_by = str("summarize_columns_by")!;
      return JSON.stringify(await fetchReport("BalanceSheet", p), null, 2);
    }

    case "get_cash_flow_report": {
      const p: Record<string, string> = {};
      if (str("start_date"))           p.start_date          = str("start_date")!;
      if (str("end_date"))             p.end_date            = str("end_date")!;
      if (str("summarize_columns_by")) p.summarize_column_by = str("summarize_columns_by")!;
      return JSON.stringify(await fetchReport("CashFlow", p), null, 2);
    }

    case "get_accounts_receivable_aging_report": {
      const p: Record<string, string> = {};
      if (str("report_date"))  p.report_date  = str("report_date")!;
      if (args.aging_period)   p.aging_period = String(num("aging_period", 30));
      if (args.num_periods)    p.num_periods  = String(num("num_periods", 4));
      if (str("customer_id"))  p.customer     = str("customer_id")!;
      return JSON.stringify(await fetchReport("AgedReceivableSummary", p), null, 2);
    }

    case "get_accounts_payable_aging_report": {
      const p: Record<string, string> = {};
      if (str("report_date")) p.report_date  = str("report_date")!;
      if (args.aging_period)  p.aging_period = String(num("aging_period", 30));
      if (args.num_periods)   p.num_periods  = String(num("num_periods", 4));
      if (str("vendor_id"))   p.vendor       = str("vendor_id")!;
      return JSON.stringify(await fetchReport("AgedPayableSummary", p), null, 2);
    }

    case "get_trial_balance_report": {
      const p: Record<string, string> = {};
      if (str("start_date"))        p.start_date        = str("start_date")!;
      if (str("end_date"))          p.end_date          = str("end_date")!;
      if (str("accounting_method")) p.accounting_method = str("accounting_method")!;
      return JSON.stringify(await fetchReport("TrialBalance", p), null, 2);
    }

    // ── Generic Query ─────────────────────────────────────────────────────────
    case "query_qbo":
      return JSON.stringify(await qboQuery(str("sql")!), null, 2);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server factory ────────────────────────────────────────────────────────
function createServer() {
  const server = new Server(
    { name: "qbo-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const text = await handleTool(name, (args ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Transport ─────────────────────────────────────────────────────────────────
if (TRANSPORT === "stdio") {
  const server = createServer();
  await server.connect(new StdioServerTransport());
} else {
  const app = express();
  const sessions = new Map<string, SSEServerTransport>();

  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, transport);
    res.on("close", () => sessions.delete(transport.sessionId));
    await createServer().connect(transport);
  });

  app.post("/messages", express.json(), async (req, res) => {
    const transport = sessions.get(req.query.sessionId as string);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.listen(PORT, () =>
    console.error(`QBO MCP server running on port ${PORT} (${ENVIRONMENT})`)
  );
}
