# Review Wan27 credits and recent generation tasks in n8n

Import `account-and-tasks.json` into n8n. It uses only built-in nodes and performs
GET requests for your Wan27 account and the latest 20 generation tasks, then
returns a single structured report. It never creates media or spends generation
credits. API access still requires an eligible Wan27 account and an existing
access token: https://wan2-7.io/mcp/guide/ .

## Configure and run

1. In n8n create an **HTTP Header Auth** credential. Header name: `Authorization`.
   Header value: `Bearer ` followed by your existing Wan27 access token.
2. Select that credential in both **Read account** and **Read recent tasks**.
   The exported template contains no token or credential ID.
3. Run **Run report**, then inspect **Account and task report**. Account and task
   responses remain data; no returned prompt, error, or URL is executed.

The report returns the raw account and task response objects, with a timestamp.
It covers the first page only; it does not claim to report your complete task
history. Non-2xx responses stop the workflow so an auth/service failure is not
misreported as an empty history. Both requests use a 30-second timeout and reject
redirects to avoid forwarding credentials to another location.

n8n may retain execution data, including task metadata and media URLs. Keep the
workflow in your own n8n instance and configure execution retention as needed.
Do not export a real credential or pinned data when sharing the template.

## Verification

Import and execution are checked in an ephemeral n8n container with network
access disabled. The test copy uses a local mock service and a dummy credential;
it never calls Wan27 or uses real account data. These checks establish that the
template imports and runs in n8n, not that live account access has been tested.

This public template is not yet an approved n8n.io template-library listing.
Creator submission is a separate step: https://creators.n8n.io/hub .
