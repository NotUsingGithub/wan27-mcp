## Review Wan27 credits and recent generation tasks

### Who this is for
For creators and operators who use Wan27 for image or video generation and want to check their remaining credits and recent task outcomes from n8n before starting another batch.

### What it does
The workflow reads account status, retrieves the latest 20 tasks, and builds one timestamped report with account details, task status counts, original task records, and an indicator that more history is available. It only makes GET requests: no media generation, purchases, or credit spending occurs. A failed authentication or service response stops the workflow instead of producing a misleading empty report.

### Set up
Import the JSON. Create an HTTP Header Auth credential with header name `Authorization` and value `Bearer ` followed by your existing Wan27 access token. Select that credential in both HTTP Request nodes. Do not paste a real token into the workflow JSON or sticky note. Execute manually and open the final report node.

### Requirements and customization
You need your own n8n instance and eligible Wan27 API access. Adjust the task limit between 1 and 50; this is a one-page report, not a complete historical audit. Requests have a 30-second timeout and reject redirects. Configure n8n execution retention because task data can include media URLs.

Setup documentation: https://wan2-7.io/mcp/guide/
