# Google Workspace Studio: Incoming Webhook Bridge Starter

This repository is a starter demo that demonstrates how to build an incoming webhook trigger for **Google Workspace Studio**.

It serves as a bridge between external services and your automated Workspace workflows. When an external tool (such as GitHub, Stripe, a monitoring service, or your own backend) sends an HTTP POST request to the webhook URL, this bridge receives the payload and triggers the corresponding workflow in Google Workspace Studio.

---

## What It Does

- **Provides a Webhook Endpoint**: Generates a dedicated webhook URL for each workflow you configure.
- **Connects External Systems**: Listens for incoming HTTP notifications and events from third-party tools.
- **Triggers Workspace Studio**: Validates incoming requests and immediately kicks off your Workspace Studio workflow with the event payload.

---

## What This Demo Demonstrates

- **Custom Triggers in Workspace Studio**: How to create and register custom triggers (like *"When a webhook is received"*) that appear natively in the Workspace Studio workflow builder.
- **Interactive Configuration Cards**: How to build in-editor cards where users can configure trigger options, authorize their account, and copy their generated webhook URL.
- **Account Authorization & Delegation**: How to handle Google authorization so the bridge can securely invoke Workspace Studio workflows on behalf of the user.
- **Optional Webhook Security**: How to support optional secret keys or API keys so only authorized callers can trigger the workflow.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v20 or higher recommended)
- `npm` (comes with Node.js)

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Configuration

Copy the example environment file and configure your credentials:

```bash
cp .env.example .env
```

Edit `.env` and fill in your Google OAuth Web App client credentials and Google Workspace Add-on service account / client IDs.

### 3. Database Generation & Setup

This demo uses SQLite to store trigger configurations and user credentials. Run the following commands to generate and push the database schema:

```bash
# Generate database migration files from schema
npm run db:generate

# Push schema changes to initialize your local SQLite database
npm run db:push
```

### 4. Build the Project

Compile the TypeScript code to JavaScript:

```bash
npm run build
```

### 5. Run the Project

- **Development Mode** (with auto-reload on file changes):
  ```bash
  npm run dev
  ```
- **Production Mode** (after running `npm run build`):
  ```bash
  npm run start
  ```
- **Run Tests**:
  ```bash
  npm test
  ```

---

## Registering the Add-on (`deployment.json`)

The file `deployment.json` is a **deployment manifest template** used to register this add-on with Google Workspace:

1. **Host the application**: Deploy your server to a publicly reachable HTTPS host (such as Cloud Run, or use a tunneling tool like ngrok for local testing).
2. **Update the manifest template**: Open `deployment.json` and replace `DEPLOYED_HOST_NAME` with your actual domain (e.g., `https://your-service-url.run.app`).
3. **Register in Google Cloud**: Use this manifest when creating or updating your Google Workspace Add-on deployment in the Google Cloud Console.

Once deployed and installed, the webhook trigger will appear as an available starting step inside Google Workspace Studio.
