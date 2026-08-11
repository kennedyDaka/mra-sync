# MRA Connect Hub

Product Requirement Document (PRD)

Project: MRA EIS Middleware Platform

Version: 1.0.0
Target Dev Team: OpenCode Engineers
Objective: Build a resilient integration layer linking standard POS/ERP systems to the Malawi Revenue Authority (MRA) Electronic Invoicing System (EIS).

1. Document Overview

1.1 Executive Summary

Malawi law requires fiscalization of invoices via the MRA EIS API. Direct integration introduces single points of failure (e.g., internet outages, breaking API updates). This middleware decouples ERP platforms from the MRA API. It guarantees 100% uptime for checkouts, handles cryptography, manages local data queues, and automates product mapping.

1.2 Core System Goals

Zero-Downtime Checkouts: The POS checkout process must never fail or lag due to MRA network dropouts.

Plug-and-Play ERP Interface: Provide clean, unchanging REST endpoints or webhooks for ERP engines.

Absolute Compliance: Maintain strict adherence to the MRA technical guidelines regarding Terminal Activation, HMAC signing, product registration, and offline limits.

2. System Architecture & Workflows

2.1 Technical Architecture Blueprint

The application operates as an on-premise or cloud-hosted state engine running an embedded database (SQLite) and an in-memory queue.

 +-----------------+                +------------------------------------+                +-----------------+

 |  ERP / POS      |                |            MIDDLEWARE              |                |     MRA EIS     |
 |  System         |                |                                    |                |     API V1      |
 +-----------------+                +------------------------------------+                +-----------------+

          |                                          |                                             |
          |  1. HTTP POST: /api/sales                |                                             |
          |----------------------------------------->|                                             |
          |                                          |  2. Network Health Check                    |
          |                                          |---\                                         |
          |                                          |   |                                         |
          |                                          |<--/                                         |
          |                                          |                                             |
          |                                          |  [IF ONLINE]                                |
          |                                          |  3. HMAC Sign & POST /api/v1/sales          |
          |                                          |-------------------------------------------->|
          |                                          |                                             |
          |                                          |  4. HTTP 200 + QR Meta / MRA Invoice ID     |
          |                                          |<--------------------------------------------|
          |                                          |                                             |
          |                                          |  [IF OFFLINE]                               |
          |                                          |  3b. Sign locally & Queue transaction       |
          |                                          |---\                                         |
          |                                          |   |                                         |
          |                                          |<--/                                         |
          |                                          |                                             |
          |  5. JSON (QR payload + Invoice Receipt)  |                                             |
          |<-----------------------------------------|                                             |


3. Functional Requirements (OpenCode Core Tasks)

3.1 Task 1: Module Onboarding & Terminal Acquisition and Activation (TAC)

Description: The system must provision a terminal instance safely using MRA configuration rules.

Input Interface: Secure environment file configuration or a local setup UI accepting the Terminal Activation Code (TAC).

Execution Flow:

Send an HTTP POST payload to MRA at /api/v1/onboarding/activate.

The application must parse out the resulting x-access-key and the unique terminal Secret Key.

Store these fields in an encrypted state in the local data layer.

Run a background cron runner hitting /api/v1/configuration/latest every 6 hours. Overwrite operational configs (tax brackets, version rules) seamlessly without breaking live sales tasks.

3.2 Task 2: Cryptographic Request Signing Engine

Description: Every data packet hitting MRA must feature verifiable proof of authenticity.

Technical Instruction for OpenCode:

Capture the exact string sequence of the raw outbound JSON request body.

Implement an execution block computing an HMAC-SHA512 hash.

Utilize the localized Secret Key as the cryptographic hashing salt.

Force block completion by injecting these precise HTTP headers into the outbound transport stream:

x-access-key: Localized access token.

x-signature: Computed HMAC-SHA512 hex string.

Authorization: Bearer <Session-Token>.

3.3 Task 3: Inventory Engine & Dynamic Product Mapping

Description: Cross-reference local inventory structures against compliance-approved product lists from the MRA portal.

Technical Instruction for OpenCode:

Maintain a structural mapping database matrix containing three core elements: [ERP_SKU | MRA_Product_ID | Product_Type].

Categorize items clearly inside the map as either Product-Based (requiring active quantity count tracks) or Service-Based.

Build an inbound webhook interface (/api/inventory/sync) listening to ERP modifications.

If an unmapped item is submitted via sales, the middleware must instantly block outbound execution and respond with a clean validation error: 422 Unmapped Compliance SKU.

Provide a special channel routing framework for "Informal Purchases" (items purchased from unregistered taxpayers) to apply matching input tax regulations automatically.

3.4 Task 4: Fault-Tolerant Offline Syncing Engine

Description: Maintain business execution safety across Blantyre/Lilongwe connectivity drops.

Technical Instruction for OpenCode:

On every sales request, run a 1500ms network timeout query test to the MRA gateway.

Online Execution Route: Directly sign, forward, obtain confirmation ID, and pass the success response block back to the POS printer.

Offline Execution Route (The Failover):

Stop active API calls. Change operational flag state to OFFLINE.

Store the raw transaction parameters inside a local SQLite database table with timestamp order preservation.

Calculate an internal signature hash layout using the stored local key block cache.

Generate the fallback QR print string pattern instantly and reply to the POS with a 201 Local Receipt Created state payload.

The Catch-Up Pipeline Daemon:

Create a decoupled background thread script executing every 120 seconds.

Detect network restoration.

Extract local offline transaction logs chronologically (First In, First Out).

Group packets and execute a clean structured dispatch to /api/v1/sales/offline-submit.

Empty out the offline cache dynamically upon receiving confirmed state replies from MRA.

4. Interface Mapping Specifications (JSON Schemas)

4.1 POS/ERP Inbound to Middleware (POST /api/sales)

This is the simplified layout the ERP developer uses.

json

{
  "erp_invoice_number": "INV-2026-00891",
  "cashier_id": "EMP-04",
  "customer_tin": "12345678",
  "line_items": [
    {
      "erp_sku": "SKU-9908",
      "quantity": 2,
      "unit_price": 5000.00,
      "tax_category": "STANDARD"
    }
  ]
}


Use code with caution.

4.2 Middleware Outbound to MRA EIS (POST /api/v1/sales)

The structured payload translated by the middleware, appended with tracking headers.

json

{
  "terminalId": "MW-TERM-0911",
  "invoiceSequence": 89432,
  "taxpayerTin": "99988776",
  "invoiceTimestamp": "2026-08-07T13:05:00Z",
  "items": [
    {
      "mraProductId": "MRA-PROD-7712",
      "quantity": 2.00,
      "unitPrice": 5000.00,
      "taxRate": 16.5,
      "taxAmount": 1650.00,
      "totalAmount": 11650.00
    }
  ],
  "totalVat": 1650.00,
  "grandTotal": 11650.00,
  "isOffline": false
}


Use code with caution.

5. Non-Functional Requirements & Safety Controls

5.1 Idempotency Safeguard

To prevent duplicate taxation penalties during unstable network periods:

Every client request must pass a unique string uuid tracking token in the header.

The middleware maintains a 24-hour log cache tracking every transaction uuid.

If a duplicate token lands on the middleware while a transaction is mid-flight or recently processed, it returns the cached result without creating a duplicate ticket.

5.2 Local Database Constraints

Use an explicit file-based lock management framework for SQLite transactions (WAL mode) to prevent structural database corruption during unexpected electrical or power system drops at local retail checkout environments.

6. Implementation Milestones

+------------+-------------------------------------------------------------+

| Phase      | Target Deliverable Focus                                    |
+------------+-------------------------------------------------------------+

| Phase 1    | Database schema layout + MRA TAC Onboarding endpoint setups |
| Phase 2    | HMAC-SHA512 Cryptography Engine implementation              |
| Phase 3    | ERP-to-MRA field transformation & verification loops       |
| Phase 4    | Offline state handling & Cron queue synchronization         |
+------------+-------------------------------------------------------------+


To refine this PRD further before handing it off to OpenCode, please tell me:

What programming language or framework (e.g., Go, Node.js, Python) will OpenCode use to implement this system?

Will this middleware be hosted on a central cloud server servicing multiple stores, or locally on individual on-premise checkout machines?

I can adapt the exact data-locking or queueing specifications based on your operational environment.

central cloud server

PRD Addendum: Central Cloud Architecture Specifications

Because this middleware will run on a Central Cloud Server servicing multiple distinct physical retail stores, the architectural requirements must shift from a lightweight single-terminal design to a multi-tenant, highly concurrent, and highly secure microservice.

Below are the explicit architectural upgrades OpenCode must implement to prevent system failure in a cloud-hosted environment.

1. Multi-Tenant Infrastructure Layer

1.1 Shared Infrastructure with Isolated Storage

Tenancy Architecture: OpenCode must implement a Multi-Tenant Single-Database Shared-Schema pattern. Every database table (terminals, inventory maps, offline sync queues, invoice logs) must include a strict tenant_id indexing column. [1]

Access Control Isolation: Database abstraction layers (ORMs/Query Builders) must enforce a global filter query on tenant_id to prevent cross-tenant data leaks.

1.2 Multi-Terminal Routing Engine

Instead of storing a single static Secret Key and x-access-key in a single local configuration file, the cloud middleware must query a key management table dynamically based on the originating store ID or terminal ID.

       +-----------------------+

       |   Physical Store A    |
       |  (Terminal ID: T-01)  |
       +-----------------------+
                   |
                   | Inbound HTTPS + Header: [X-Terminal-ID: T-01]
                   v
+-----------------------------------------------------+

|            CENTRAL CLOUD MIDDLEWARE                 |
|                                                     |
|  1. Intercepts request                              |
|  2. Fetches T-01 Secret Key from Secure Cache       |
|  3. Signs payload via HMAC-SHA512                   |
|  4. Routes out to MRA API using T-01 Credentials    |
+-----------------------------------------------------+
                   |
                   | Outbound HTTPS + Tenant-Specific Signature
                   v
       +-----------------------+

       |     MRA EIS API       |
       +-----------------------+


2. Technical Upgrades for Cloud Scale (OpenCode Tasks)

2.1 Task 1: Database Upgrade (Replacing SQLite)

Instruction: OpenCode must not use SQLite for the central cloud platform. SQLite does not safely handle multi-process concurrent write locking across multiple remote stores over a network.

Requirement: Implement PostgreSQL or MySQL utilizing connection pooling (e.g., PgBouncer if deploying a PostgreSQL-based microservice) to maintain persistent execution states under heavy concurrent traffic. [1]

2.2 Task 2: High-Throughput Redis Queue for Offline Transactions

Instruction: When a store goes offline, it will batch-send cached transactions once it recovers. If 50 stores reconnect simultaneously, the cloud platform will crash under the write load if transactions are processed synchronously.

Requirement: Implement an in-memory message queue using Redis (e.g., Celery, BullMQ, or Go Channels with a Redis backend).

Execution Flow:

Incoming bulk invoices from reconnected stores are quickly pushed directly into a Redis mra-sync-queue.

The middleware immediately issues an HTTP 202 Accepted response back to the physical retail shop.

Background worker daemons read the queue sequentially, enforce MRA rate-limits, sign the payloads, and push them to the MRA API asynchronously.

2.3 Task 3: Encrypted Credential Secret Store

Instruction: Storing hundreds of tenant MRA Secret Keys and Active Access Keys in plain-text database columns is a massive compliance risk.

Requirement: Implement application-level encryption (AES-256-GCM) for the secret_key field in the database. Alternatively, use an external secret management tool like HashiCorp Vault or AWS Secrets Manager to look up terminal signatures at runtime. [1, 2]

3. High-Scale Interface Mapping

3.1 Tenant-Aware POS Inbound Payload (POST /api/sales)

The inbound structure must pass unique identifier headers to allow the central cloud to safely process multi-tenant routing.

json

// Required Request Headers:
// Authorization: Bearer <Tenant_JWT_Token_Issued_By_Middleware>
// X-Terminal-ID: MW-BLANTYRE-POS-04
// X-Store-ID: STR-0012

{
  "erp_invoice_number": "INV-2026-99081",
  "cashier_id": "CASH-88",
  "customer_tin": "87654321",
  "line_items": [
    {
      "erp_sku": "SKU-4402",
      "quantity": 1,
      "unit_price": 12500.00,
      "tax_category": "STANDARD"
    }
  ]
}


Use code with caution.

4. Multi-Tenant Error and Compliance Handling

4.1 Cross-Tenant Inventory Isolation

The inventory mapping sync module must ensure that ERP_SKU -> MRA_Product_ID matches are isolated per tenant_id. Store A's custom SKU maps must never overwrite or collide with Store B's custom SKU maps inside the central database.

4.2 Distributed Rate Limiting

OpenCode must implement a token-bucket rate limiter (using Redis) per tenant. If one tenant’s local infrastructure breaks down and floods the cloud middleware with thousands of rapid loop requests, the middleware must rate-limit that specific tenant (429 Too Many Requests) to protect system stability for all other connected retail stores.

To let OpenCode begin drafting the structural database migrations for this cloud system, let me know:

What backend language or framework (e.g., Node.js/TypeScript, Go, Python/FastAPI) are you standardizing on for the cloud microservice?


Product Requirement Document (PRD)

Project: MRA EIS Multi-Tenant Cloud Middleware Platform
Version: 2.0.0
Target Dev Team: OpenCode Engineers
Objective: Build a high-throughput, multi-tenant cloud middleware connecting global POS/ERP systems to the Malawi Revenue Authority (MRA) Electronic Invoicing System (EIS) via a zero-downtime, microservice architecture.

1. Document Overview

1.1 Purpose

This document provides explicit technical specifications for building a cloud-hosted, multi-tenant middleware. It details how the system operates during the development phase (UAT) and outlines the progression path to transition seamlessly into production (Live Mode) without impacting retail operations.

1.2 Core Architectural Principles

Multi-Tenant Isolation: Safely manage multiple merchants (tenants) and distinct store terminals on a single cloud cluster.

Fail-Safe Processing: Decouple standard ERP checkout workflows from the MRA API using an asynchronous queue layer.

Dual-Mode Configurator: Switch from sandbox/testing to live governance via localized environment flags, preserving identical code business logic.

2. Infrastructure & Environment Configuration

OpenCode must implement structural environment segmentation. The middleware logic remains uniform; only the network paths, ciphers, and validation strictness alternate between phases.

2.1 Environment Matrix

ParameterDevelopment Mode (UAT / Sandbox)Production Mode (Live Mode)MRA Portal URLhttps://mra.mwhttps://mra.mwMRA API Base URLhttps://mra.mwhttps://mra.mwDatabase TierPostgreSQL (Development Instance)PostgreSQL (High-Availability Cluster with WAL)Queue TierLocal memory or Dev Redis instanceDistributed Redis Cluster (BullMQ / Celery)TLS EnforcementTLS 1.2 MinimumTLS 1.3 Strict EnforcementData EncryptionPlaintext allowed for UAT debuggingAES-256-GCM encryption on all stored keys

3. Detailed Functional Modules (OpenCode Tasks)

        +-------------------------------------------------------------+

        |                 CENTRAL CLOUD MIDDLEWARE                    |
        |                                                             |
        |   +------------------+             +--------------------+   |
        |   | Multi-Tenant API |             |  Background Worker |   |
        |   |     Gateway      |             |     (FIFO/Rate)    |   |
        |   +------------------+             +--------------------+   |
        +-------------------------------------------------------------+

                 |            \               /             |
                 |             \             /              |
    1. Inbound   |       2. Push\           /4. Pull        | 5. Signed Outbound
    ERP Payload  |       Invoice \         /  Invoice       |    HTTPS Request
                 v                v       v                 v
        +---------------+      +-------------+      +---------------+

        |   POS / ERP   |      | Redis Queue |      |    MRA EIS    |
        |  Store Nodes  |      |  (In-Mem)   |      |  API Gateway  |
        +---------------+      +-------------+      +---------------+


3.1 Module 1: Multi-Tenant Tenant Onboarding & Activation (TAC)

Description: Provisions a unique tenant configuration and links multiple store terminals under that tenant using the MRA Terminal Activation Code (TAC).

Technical Instruction for OpenCode:

Design a database schema featuring a tenants table and a terminals table.

Expose an authenticated endpoint for ERPs: POST /api/v1/tenant/activate.

The payload must accept tenant_id, store_id, terminal_id, and the raw TAC fetched from the MRA portal.

The middleware forwards this TAC to the appropriate environment URL (/api/v1/onboarding/activate).

Storage Rule: Capture the resulting x-access-key and Secret Key. If the environment flag APP_MODE=production, encrypt the keys using AES-256-GCM before writing them to the database.

3.2 Module 2: The Canonical Cryptographic Hashing Engine

Description: Generates the precise x-signature required to pass MRA security checks. This module handles the most frequent cause of connection failures.

Technical Instruction for OpenCode:

Retrieve the target terminal’s Secret Key from the secure store and decrypt it if running in Production Mode.

Capture the inbound JSON payload meant for MRA.

The Serialization Rule: Force serialization of the payload into a string with zero whitespace, tabs, padding, or newlines.

Pass this exact payload string into an HMAC-SHA512 hashing block, utilizing the decrypted Secret Key as the cryptographic salt.

The output must be formatted as a hexadecimal string and mapped to the x-signature header.

3.3 Module 3: Dual-Mode Inventory Mapping Engine

Description: Manages local item catalogs to ensure compliance alignment before dispatching sales events.

Technical Instruction for OpenCode:

Maintain a multi-tenant inventory relational ledger: [tenant_id | local_sku | mra_product_id | product_type].

Categorize data inputs cleanly into Product-Based or Service-Based structures.

UAT Behavior Mode: If a transaction hits the middleware containing a local_sku that is unmapped, auto-generate a fallback mock registration payload, pass it to MRA's inventory sync pipeline, wait for auto-approval, update the database mapping dynamically, and proceed with the sale. This enables rapid, non-blocking developer testing.

Production Behavior Mode: Turn off automated mapping helpers. If an unmapped local_sku is encountered, immediately drop execution and return an HTTP 422 Unprocessable Entity - Item Missing Compliance Mapping to block the sale from executing with faulty tax compliance tracking.

3.4 Module 4: High-Throughput Asynchronous Queue Engine

Description: Prevents the cloud system from crashing when network bottlenecks occur or when retail outlets batch-upload invoices after recovering from local internet outages.

Technical Instruction for OpenCode:

Upon receiving an invoice packet from an ERP (POST /api/v1/sales), evaluate the real-time availability of the MRA gateway.

Online Synced Pathway: If the MRA API responds under 1500ms, sign the invoice, forward it, write the structural confirmation data to the database, and return the output receipt immediately.

Asynchronous/Offline Queue Pathway: If the MRA API times out, returns a 5xx error, or if the payload flag marks it as an offline-generated invoice:

Write the raw payload to the database with status PENDING_SYNC.

Push the processing task containing the internal database invoice reference ID to a Redis-backed FIFO queue (mra-sync-queue).

Instantly release the POS client connection by returning an HTTP 202 Accepted along with locally calculated QR code structural markers.

The Queue Worker Daemon: Run decoupled background workers scaling horizontally based on processor load. The workers must read from mra-sync-queue, fetch terminal-specific credentials, sign sequentially, enforce a distributed rate-limiter per tenant (via Redis Token Bucket), and clear down backlog entries smoothly.

4. Specific MRA Implementation Phase Rules

4.1 Development Environment Execution Path

To clear development environment gates successfully, OpenCode must implement these steps sequentially:

Manual Portal Setup: Before executing code integrations, log into dev-eis-portal.mra.mw, generate a test branch, and upload a basic mock product list via a .csv format payload to activate your sandbox profile state.

Execute Terminal Linkage: Trigger the middleware activation workflow using a Sandbox-issued TAC token.

Run Configuration Baseline Sync: Force a pipeline execution to POST /api/v1/configuration/latest. This populates your local application memory cache with active dev environment parameters (such as the default 16.5% standard VAT rules).

Run Inbound End-to-End Tests: Feed mock transactions containing standard, zero-rated, and exempt properties through the middleware layer to verify signature handling.

4.2 Production Go-Live Transition Plan

When migrating the middleware system from sandbox configurations to Live Mode, execute this deployment routine without rewriting the core application code:

[STAGING/UAT TESTING] 
        |
        v
[1. Deploy Core Cloud Middleware Cluster to Production Instance Environment]
        |
        v
[2. Swap Global Environment Environment Variables to Live Paths]
    - Change BASE_URL to: https://mra.mw
    - Change TLS configuration to: STRICT_1.3
        |
        v
[3. Execute Production TAC Onboarding Routine]
    - Input actual operational TAC codes generated from the Live Taxpayer Portal
        |
        v
[4. Populate Live Database Inventory Product Mapping Schema Matrices]
        |
        v
[5. Point Physical Store ERP Endpoints to Production Cloud Middleware Instance]


Production Cluster Provisioning: Deploy a secondary clean instance of the middleware application on isolated server hardware or a production cloud network namespace.

Environment Variable Flip: Update your cloud system variables to mirror production configurations:

env

APP_MODE=production
MRA_BASE_URL=https://mra.mw
ENFORCE_TLS_1_3=true


Use code with caution.

Live Onboarding Phase: Taxpayers generate live TAC credentials within their official MRA Taxpayer Portal. Pass these live strings into the middleware's onboarding setup module to lock down official production hardware and access tokens.

Live Schema Mapping: Wipe out UAT test data from the inventory tables. Populate your mapping configurations with real, approved production commodity codes from the live portal database before opening checkouts.

DNS Traffic Routing: Route production ERP traffic directly to the live cloud middleware instance.

5. Non-Functional Specifications & Security Metrics

5.1 High-Availability Fault Isolation

If Tenant A's on-premise checkout loops encounter synchronization failures and continuously resend broken payloads, the Redis token-bucket rate limiter must sandbox that tenant's traffic. This prevents performance degradation for Tenant B or Tenant C sharing the cloud system.

5.2 Idempotency Rules

The middleware must maintain a 48-hour deduplication lookup ledger mapping tenant_id + erp_invoice_number. If an identical combination hits the gateway while a previous attempt is pending or completed, the system returns the cached transaction response without generating a duplicate compliance event.

6. Verification and Troubleshooting Checklist

OpenCode must confirm system performance using this troubleshooting hierarchy:

HTTP 401 / 403 Response Handling: Audit the signature pipeline. Confirm the JSON body string is completely minified and that the crypto salt matches the correct terminal's Secret Key exactly.

Connection Handshake Resets: Audit the outbound connection pipeline. Ensure the server engine isn't dropping back to TLS 1.0 or TLS 1.1 ciphers, which are routinely blocked by production government firewalls.

HTTP 422 Response Handling: Check compliance configurations. This indicates structural data errors inside formatting fields or tax rate mismatches against parameters fetched from the /configuration/latest configuration endpoint.


no complext frontend, just minimal, the guide for mra eis is there online and the swagger too

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/c78b8915-dcf4-48d2-9228-cc8e45a2c829).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
