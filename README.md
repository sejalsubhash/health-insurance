# ACC Health Insurance Underwriting Automation Platform

> **Version:** 4.0.0 — STP Fast-Lane + Custom Rules Enforcement + UW Routing  
> **Operator:** SBI General Insurance Co. Ltd. (POC deployment)  
> **Stack:** Node.js · Express · PostgreSQL · Redis · AWS (S3, Bedrock, SES, ECR) · Docker

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Complete Application Workflow](#2-complete-application-workflow)
3. [System Architecture](#3-system-architecture)
4. [Directory Structure](#4-directory-structure)
5. [AWS & Cloud Services Used](#5-aws--cloud-services-used)
6. [Backend Modules & Libraries](#6-backend-modules--libraries)
7. [Frontend Pages](#7-frontend-pages)
8. [Database Schema](#8-database-schema)
9. [Configuration Files](#9-configuration-files)
10. [Authentication & Authorization](#10-authentication--authorization)
11. [User Roles & Authority Tiers](#11-user-roles--authority-tiers)
12. [Vendor (PPHC) Network](#12-vendor-pphc-network)
13. [Communication System](#13-communication-system)
14. [CI/CD Pipeline](#14-cicd-pipeline)
15. [Docker & Infrastructure](#15-docker--infrastructure)
16. [Environment Variables](#16-environment-variables)
17. [API Endpoints Summary](#17-api-endpoints-summary)
18. [Running the Application](#18-running-the-application)

---

## 1. Project Overview

The **ACC Health Insurance Underwriting Automation Platform** is an AI-powered, end-to-end health insurance underwriting system. It automates the journey from a customer's insurance proposal submission to final policy issuance, orchestrating:

- **STP (Straight-Through Processing):** Proposals meeting clean-risk criteria are auto-issued in under 60 seconds without human intervention.
- **NSTP (Non-STP) Full Pipeline:** Complex proposals are routed through physical health check-up (PPHC), AI-powered medical document extraction using AWS Bedrock/Claude, rule-engine risk scoring, and human underwriter (UW) review.
- **TeleMER (Tele Medical Examination Report):** A lightweight phone/video-based medical interview route for borderline STP cases.
- **Intelligent UW Routing:** Cases are automatically assigned to the right underwriter tier (Junior → Senior → Chief → Medical Officer) based on case complexity, Sum Assured, medical specialty, and current workload.
- **Multi-channel Communication:** Automated notifications via Email (AWS SES), SMS, and WhatsApp at every stage.
- **Policy Issuance:** Connects to a Policy Administration System (PAS) to generate policy numbers after UW approval.

---

## 2. Complete Application Workflow

### Phase 0: Proposal Intake
```
Customer submits a proposal form via the frontend
  ↓
POST /api/workflow/create
  ↓
Proposal data captured:
  - Proposer name, age, gender
  - Sum Assured & Product Name
  - Lifestyle (smoking, alcohol, tobacco, occupation hazard, exercise, diet)
  - Medical history (pre-existing conditions, family history, hospitalizations, surgeries)
  - Declared BMI (height/weight)
```

### Phase 1: STP Eligibility Evaluation
```
evaluateSTPEligibility() runs IMMEDIATELY on every proposal
  ↓
Hard Knockout Checks:
  - Age > 45 years       → BLOCK
  - Sum Assured > ₹25L   → BLOCK
  - Any declared PEC     → BLOCK
  - Current smoker       → BLOCK
  - Current tobacco user → BLOCK
  - Occupation hazard >= moderate → BLOCK
  - BMI < 17 or > 32     → BLOCK
  - Heavy alcohol use    → BLOCK
  - Critical family hx (cancer/cardiac/stroke/multiple) → BLOCK
  - Prior hospitalizations declared → BLOCK
  - CRM blacklist / prior claims    → BLOCK
  ↓
If NO hard knockouts → Soft Flag Checks:
  - Age 46–50 band           → Soft flag
  - SA ₹25L–1Cr band         → Soft flag
  - BMI 28–32 borderline     → Soft flag
  - Regular alcohol          → Soft flag
  - Former smoker            → Soft flag
  - Non-critical family hx   → Soft flag
  ↓
STP Routing Decision:
  ┌─ All clean                → Route: stp_auto_issue   (State: auto_issued)
  ├─ Soft flags present       → Route: nstp_telemer     (State: nstp_flagged)
  └─ Hard knockouts present   → Route: nstp_full_pphc   (State: nstp_flagged)
```

### Phase 1A: STP Auto-Issue Path (Fast Lane)
```
State: stp_evaluating → auto_issued
  ↓
runDeclaredDataAnalysis() — scores declared data only:
  - Declared BMI component
  - Lifestyle risk component
  - Medical history component
  - Clinical correlation (full credit — no docs to check)
  ↓
Score ≥ 80        → accept_standard
Score 65–79       → accept_with_loading
Score < 65        → refer
  ↓
Policy Number generated via PAS Adapter
  ↓
Customer notified immediately (Email + SMS + WhatsApp)
  ↓
State: auto_issued → policy_issued → customer_notified
```

### Phase 2: NSTP TeleMER Path
```
State: nstp_flagged → vendor_assigned (VEND-003: DigiMedic)
  ↓
DigiMedic conducts:
  - Phone/video medical interview
  - Structured questionnaire (telemer-questions.json — 50+ questions)
  - Voice analysis (anxiety/stress indicators)
  - Examiner assessment
  ↓
Transcript uploaded → POST /api/workflow/:id/documents
  ↓
processTeleMERModule() → extractor.extractTeleMERData()
  → AWS Bedrock (Claude) parses transcript
  ↓
telemerModel.scoreTeleMER(modelInput) — 5-parameter scoring:
  - Lifestyle risk
  - Medical history
  - Questionnaire responses
  - Voice analysis
  - Declared BMI
  ↓
Score → recommendation → routed to UW review or auto-approved
```

### Phase 3: NSTP Full PPHC Path
```
State: nstp_flagged → vendor_assigned → pphc_scheduled → pphc_completed
  ↓
CAT Assignment (based on Sum Assured):
  - CAT 1 (≤₹25L)    → VEND-001: MedCheck India   → MER + CBC + ESR + SGPT + HbA1c + Creatinine
  - CAT 2 (≤₹1Cr)    → VEND-002: HealthAssure      → CAT1 + ECG + Cholesterol + Triglycerides
  - TeleMER (≤₹1Cr)  → VEND-003: DigiMedic         → Phone/video interview only
  - CAT 3 (≤₹5Cr)    → VEND-004: ClinAssure        → CAT2 + Lipid Profile + LFT + KFT + 2D Echo + TMT
  - CAT 4 (>₹5Cr)    → VEND-005: MedElite          → CAT3 + Chest X-Ray + PSA/PAP + Thyroid Panel + Extended KFT
  ↓
Vendor conducts health check-up, submits reports
  ↓
Vendor User uploads reports to portal:
  POST /api/workflow/:id/documents  (files stored in AWS S3)
  ↓
POST /api/workflow/:id/submit-documents (final submission)
```

### Phase 4: AI-Powered Document Extraction
```
State: pphc_completed → extraction_in_progress
  ↓
BullMQ job queued (Redis-backed async worker)
  ↓
Claude Extractor (lib/claude-extractor.js) calls AWS Bedrock:
  
  Documents processed per type:
  ├─ blood_chemistry  → extractPPHCBloodChemistry()
  │     Extracts: glucose, HbA1c, lipid panel, LFT, KFT, thyroid, HIV, HBsAg
  ├─ hematology       → extractPPHCHematology()
  │     Extracts: Hb, RBC, WBC, platelets, ESR, differential count
  ├─ urine_analysis   → extractPPHCUrineAnalysis()
  │     Extracts: protein, glucose, microalbumin, ACR, microscopy
  ├─ cardiac          → extractPPHCCardiac()
  │     Extracts: ECG (rhythm, intervals, ST changes), 2D Echo (LVEF), TMT result
  ├─ physical_exam    → extractPPHCPhysicalExam()
  │     Extracts: BMI, BP, pulse, SpO2, general examination
  └─ imaging          → extractPPHCImaging()
        Extracts: Chest X-Ray, USG abdomen findings
  ↓
Per-page images rendered as JPEGs, uploaded to S3 (extraction-pages/...)
  ↓
Page-by-page extraction tracking (side-by-side view in UI)
  ↓
State: extraction_in_progress → extraction_done
```

### Phase 5: Risk Scoring Engine
```
State: extraction_done → rule_engine_processing
  ↓
lib/medical-risk-engine.js → calculateAll(extractedData, correlationData)
  ↓
5 Component Scoring Modules:
  ┌─ 1. Medical Parameters  (max 30 pts)
  │     BMI + BP + glucose + HbA1c + lipids + LFT + KFT + CBC + cardiac markers
  ├─ 2. Lifestyle Risk      (max 20 pts)
  │     Smoking + alcohol + tobacco + exercise + diet + occupation
  ├─ 3. Medical History     (max 15 pts)
  │     PEC count + family history + hospitalization + surgical history
  ├─ 4. Clinical Correlation (max 15 pts)
  │     Cross-validation of declared vs extracted data
  └─ 5. Documentation Quality (max 20 pts)
        Report completeness + recency + authenticity
  ↓
Total → Normalized 0–100 → Grade (A+/A/B+/B/C/D)
  ↓
Loading Table Applied (risk-params.json):
  - BMI overweight: +5%    | BMI obese I: +10%  | BMI obese II: +20%
  - Current smoker: +75%   | Former smoker: +25%
  - HTN controlled: +10–15% | HTN uncontrolled: +25%
  - Diabetes controlled: +15–20% | Uncontrolled: +35%
  - Cardiac history: +100%
  ↓
Age Loading:
  - 18–45: 0%  | 46–50: +10% | 51–55: +25% | 56–60: +50% | 61–65: +100%
  ↓
Loading Cap: Max 50% → if exceeded → route to refer (not decline)
  ↓
Decision:
  - Score ≥ 80 + no violations   → accept_standard
  - Score 65–79 / has loading    → accept_with_loading
  - Loading > 50% / complex      → refer (manual UW review)
  - HIV+ / active cancer / ESRD / LVEF <30% / fraud → decline
```

### Phase 6: UW Routing (Referred Cases)
```
State: rule_engine_processing → referred → uw_reviewing
  ↓
lib/uw-router.js → classifyCaseSpecialty(workflow)
  ↓
Complexity Scoring:
  - Violations × 15 pts (capped at 60)
  - Loading % × 0.5 (capped at 30)
  - Secondary specialties × 10 (capped at 30)
  - SA tier bonus: 0–5–10–20 pts
  ↓
Primary Specialty Detected:
  Metabolic (diabetes/thyroid/BMI) | Cardiac (ECG/LVEF/BP)
  Renal (creatinine/eGFR) | Hepatic (LFT) | Oncology | General
  ↓
Tier Assignment:
  Complexity 0–30, SA ≤ ₹25L     → Junior UW
  Complexity 31–60, SA ≤ ₹1Cr    → Senior UW
  Complexity 61–85, SA ≤ ₹5Cr    → Chief UW
  Complexity >85, SA >₹5Cr / oncology / critical violations → Medical Officer
  ↓
Load Balancing:
  - Prefer lowest qualified tier
  - Prefer least-loaded underwriter
  - Respect out-of-office flags
  - SA limit, loading limit, specialty scope enforced per user
  ↓
Assigned UW email saved to workflow
  ↓
UW logs into portal → reviews AI summary, findings, violations, documents
  ↓
UW Decision:
  ├─ Approve       → State: uw_approved → payment_confirmed → policy_issued
  ├─ Reject        → State: uw_rejected → customer_notified
  ├─ Counter-Offer → State: counter_offered
  └─ Request Info  → State: awaiting_additional_info
```

### Phase 7: Counter-Offer Handling
```
State: counter_offered
  ↓
Counter-offer sent to customer (email/SMS/WhatsApp):
  - Modified terms: loading % + exclusions + waiting periods
  - Online acceptance portal (counter-offer.html)
  - Deadline (typically 30 days)
  ↓
Customer visits /counter-offer?token=...
  ├─ Accepts → State: counter_offer_accepted → payment_confirmed → policy_issued
  └─ Rejects → State: counter_offer_rejected → customer_notified
  (Deadline passes) → State: counter_offer_expired → customer_notified
```

### Phase 8: Information Request
```
State: awaiting_additional_info
  ↓
UW raises info request (specific missing documents/data)
  ↓
Customer notified with secure upload link (info-request.html?token=...)
  ↓
Customer uploads additional documents
  ↓
UW reviews additional info → resumes UW decision
  ↓
Reminder sent at D-3 and D-1 before deadline
  (Deadline passes) → auto-decline or proceed with available data
```

### Phase 9: Policy Issuance
```
State: payment_confirmed → policy_issued
  ↓
PAS Adapter → issuePolicy(workflow):
  - Mock: Generates HLT-YYYY-XXXXXXX policy number
  - Real: Calls external PAS API (HDFC Ergo / Tata AIG / SBI General)
  ↓
Policy fields saved to workflow:
  - policy_number, effective_date, expiry_date
  - sum_assured, annual_premium, loading_pct, exclusions, waiting_periods
  ↓
Policy certificate available in UW report PDF
  ↓
Customer notified: Policy Issued (Email + SMS + WhatsApp)
  ↓
State: policy_issued → customer_notified ✓ COMPLETE
```

### SLA & TAT
- **STP cases:** < 60 seconds from submission to policy issuance
- **TeleMER NSTP:** 24-hour SLA (DigiMedic)
- **CAT 1/2 NSTP:** 48–72-hour SLA (vendor TAT + AI processing)
- **CAT 3/4 NSTP:** 96–120-hour SLA
- **Overall SLA deadline:** 72 hours from workflow creation (configurable)
- **SLA breach monitoring:** Real-time tracking via analytics API

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         INTERNET / CLIENTS                              │
│   Browser (UW Staff)  │  Customer (Counter-offer / Info-request)        │
└───────────────┬─────────────────────────┬───────────────────────────────┘
                │                         │
                ▼                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   DOCKER NETWORK: sbi-net                    │
│                                                              │
│  ┌─────────────────────────────┐                             │
│  │   FRONTEND (Nginx:80→8085)  │                             │
│  │   Static HTML/CSS/JS        │                             │
│  │   Pages: login, index,      │                             │
│  │   counter-offer, info-req   │                             │
│  │                             │                             │
│  │   Nginx reverse-proxies:    │                             │
│  │   /api/* → backend:5000     │                             │
│  │   /auth/* → backend:5000    │                             │
│  │   /socket.io/ → backend:5000│                             │
│  └──────────────┬──────────────┘                             │
│                 │ HTTP Proxy                                  │
│                 ▼                                            │
│  ┌─────────────────────────────┐                             │
│  │   BACKEND (Node.js:5000)    │◄──────── Redis :6379        │
│  │   Express.js REST API       │          (Session Store +    │
│  │   Socket.io (WebSocket)     │           BullMQ Queue)      │
│  │   BullMQ Worker (async)     │                             │
│  │   Passport.js (Auth)        │◄──────── PostgreSQL :5432   │
│  │                             │          (Workflows, Users,  │
│  │   Modules:                  │           Documents, Audit)  │
│  │   ├─ workflow-engine        │                             │
│  │   ├─ stp-classifier         │                             │
│  │   ├─ medical-risk-engine    │                             │
│  │   ├─ claude-extractor       │                             │
│  │   ├─ telemer-scoring-engine │                             │
│  │   ├─ uw-router              │                             │
│  │   ├─ comms-engine           │                             │
│  │   ├─ vendor-api             │                             │
│  │   └─ pas-adapter            │                             │
│  └──────────────┬──────────────┘                             │
└─────────────────┼────────────────────────────────────────────┘
                  │ External AWS Calls
       ┌──────────┼──────────────────────────────┐
       ▼          ▼                              ▼
  ┌─────────┐ ┌─────────────────┐         ┌──────────┐
  │  AWS S3  │ │  AWS Bedrock    │         │  AWS SES │
  │Documents │ │ (Claude 3       │         │  Email   │
  │Users     │ │  Sonnet via     │         │  Delivery│
  │Workflows │ │  Cross-Account  │         └──────────┘
  │Config    │ │  STS Role)      │
  └─────────┘ └─────────────────┘
                 Cross-account
                 Role ARN →
             ┌──────────────────┐
             │ AWS STS AssumeRole│
             │ (auto-refresh     │
             │  every ~55 min)   │
             └──────────────────┘
```

### Real-time Communication Flow (Socket.io)
```
Browser ←─── WebSocket ─── Backend ←─── BullMQ Job
                                         (processing_progress events)
Events emitted:
  - processing:started
  - processing:extraction_in_progress
  - processing:clinical_correlation
  - processing:completed
  - workflow:state_changed
```

---

## 4. Directory Structure

```
health-insurance/
├── .env                          # Environment variables (secrets)
├── .github/
│   └── workflows/
│       └── deploy.yml            # CI/CD: GitHub Actions → AWS ECR
├── docker-compose.yml            # 4 services: postgres, redis, backend, frontend
├── schema.sql                    # PostgreSQL schema (DDL)
├── restore_cat_scoring.sql       # CAT scoring seed data
├── package.json                  # Root package (same as backend)
│
├── backend/
│   ├── Dockerfile                # Node.js 18 Alpine image
│   ├── server.js                 # Main Express app (8128 lines) — all routes
│   ├── package.json              # npm dependencies
│   ├── config/
│   │   ├── risk-params.json      # Loading table, age loading, STP rules, waiting periods
│   │   ├── premium-rates.json    # Base premium rates by product/age/SA
│   │   ├── uw-guidelines.json    # 50 UW rules (operators, thresholds, actions)
│   │   ├── uw-tiers.json         # 4 UW authority tiers with limits
│   │   ├── medical-scoring.json  # Medical parameter scoring weights
│   │   ├── telemer-questions.json # 50+ TeleMER interview questions
│   │   └── telemer-scoring.json  # TeleMER response scoring matrix
│   └── lib/
│       ├── workflow-engine.js    # State machine — 17 states, transitions, persistence
│       ├── stp-classifier.js     # STP eligibility + declared-data scoring
│       ├── medical-risk-engine.js# Full risk scoring engine (125KB)
│       ├── claude-extractor.js   # AWS Bedrock Claude document extraction
│       ├── telemer-score.js      # TeleMER 5-parameter scoring model
│       ├── telemer-scoring-engine.js # Full TeleMER questionnaire engine
│       ├── uw-router.js          # Case specialty classification + UW assignment
│       ├── comms-engine.js       # Notification templates (email/SMS/WhatsApp)
│       ├── vendor-api.js         # PPHC vendor simulator (5 vendors)
│       ├── bull-queue.js         # BullMQ async job processor
│       ├── pg-client.js          # PostgreSQL client (workflows, users, config)
│       ├── s3-client.js          # AWS S3 client (documents, binary storage)
│       ├── auth-config.js        # Passport.js Azure AD OIDC + demo auth
│       ├── socket-manager.js     # Socket.io manager (real-time events)
│       ├── icmr-analyser.js      # ICMR reference range analysis
│       ├── info-request-suggester.js # AI-powered info gap detection
│       ├── diagnostic-triggers.js   # Alert/diagnostic rule triggers
│       ├── historical-uw-engine.js  # Historical claims/portfolio analysis
│       └── integrations/
│           ├── comms-dispatcher.js  # Dispatcher (routes to email/SMS/WhatsApp)
│           ├── email-adapter.js     # AWS SES email delivery
│           ├── sms-adapter.js       # SMS delivery (Twilio/AWS SNS/console)
│           ├── whatsapp-adapter.js  # WhatsApp delivery (Meta API/console)
│           ├── pas-adapter.js       # Policy Admin System (mock / real PAS)
│           └── webhook-dispatcher.js# Outbound webhooks to external systems
│
└── frontend/
    ├── Dockerfile                # Nginx Alpine image
    ├── nginx.conf                # Reverse proxy config
    ├── index.html                # Main UW dashboard (522KB — full SPA)
    ├── login.html                # Login page (credentials / Azure AD)
    ├── counter-offer.html        # Customer counter-offer acceptance portal
    └── info-request.html         # Customer info upload portal
```

---

## 5. AWS & Cloud Services Used

### 5.1 AWS Bedrock (AI/ML)
| Attribute | Value |
|---|---|
| **Region** | `ap-south-1` (Mumbai) |
| **Model** | `anthropic.claude-3-sonnet-20240229-v1:0` |
| **Access Method** | Cross-account STS AssumeRole |
| **Cross-Account Role ARN** | `arn:aws:iam::916292310858:role/poc-health-claims-acc-cross-account-role` |
| **Inference Profile** | `arn:aws:bedrock:ap-south-1:916292310858:application-inference-profile/9d6evt7kqmq0` |
| **Purpose** | Document extraction from PPHC reports; clinical correlation; TeleMER transcript parsing |
| **Credential Refresh** | Automatic every ~55 minutes via STS token rotation |

**Bedrock extraction tasks performed:**
- Blood chemistry report parsing (50+ parameters)
- CBC / hematology extraction
- Urine analysis extraction
- Cardiac report parsing (ECG, 2D Echo, TMT)
- Physical examination extraction
- Imaging report parsing (chest X-Ray, USG)
- TeleMER transcript extraction
- Clinical cross-correlation between modules
- Biometric liveness verification

### 5.2 Amazon S3
| Attribute | Value |
|---|---|
| **Region** | `ap-south-1` |
| **Bucket** | `poc-health-claims-acc-document-prod` |
| **Purpose** | Primary storage for all binary/document data |

**S3 storage layout:**
```
s3://poc-health-claims-acc-document-prod/
├── documents/{workflow_id}/{doc_id}     # Uploaded PPHC documents (PDFs, images)
├── extraction-pages/{workflow_id}/      # Per-page JPEGs rendered for side-by-side view
├── workflows/{workflow_id}.json         # Workflow state snapshots
├── users/users.json                     # User registry (roles, authority limits)
└── config/{key}.json                    # Dynamic config overrides
```

### 5.3 Amazon SES (Simple Email Service)
| Attribute | Value |
|---|---|
| **Region** | `ap-south-1` |
| **From Email** | `noreply@yourdomain.com` |
| **Purpose** | Transactional email notifications (PPHC scheduled, policy issued, counter-offer, rejection) |

### 5.4 AWS STS (Security Token Service)
| Attribute | Value |
|---|---|
| **Purpose** | Cross-account role assumption for Bedrock access |
| **Session Name** | `sbi-uw-bedrock-session` |
| **Token Duration** | 3600 seconds (auto-refreshed 10 min before expiry) |

### 5.5 Amazon ECR (Elastic Container Registry)
| Attribute | Value |
|---|---|
| **Account** | `412024807377` |
| **Region** | `ap-south-1` |
| **Backend Image** | `poc-health-claims-acc-uw-backend-ecr:latest` |
| **Frontend Image** | `poc-health-claims-acc-uw-frontend-ecr:latest` |
| **Push Trigger** | GitHub Actions on push to `main` branch |

---

## 6. Backend Modules & Libraries

### Core Framework
| Library | Version | Purpose |
|---|---|---|
| `express` | 4.21 | REST API server |
| `socket.io` | 4.8 | Real-time WebSocket for processing progress |
| `multer` | 1.4.5-lts | Multi-part file upload handling (max 15MB per file) |
| `compression` | 1.7 | gzip response compression |
| `helmet` | 8.0 | HTTP security headers |
| `cors` | 2.8 | CORS policy enforcement |
| `morgan` | 1.10 | HTTP request logging |
| `express-rate-limit` | 7.4 | API rate limiting (500 req/15min per IP) |

### Database & Storage
| Library | Version | Purpose |
|---|---|---|
| `pg` | 8.13 | PostgreSQL client (node-postgres) |
| `ioredis` | 5.4 | Redis client (session store + BullMQ) |
| `connect-redis` | 8.0 | Redis session store for Express |
| `connect-pg-simple` | 9.0 | PostgreSQL session store (fallback) |
| `@aws-sdk/client-s3` | 3.700 | AWS S3 operations |
| `@aws-sdk/lib-storage` | 3.700 | Multipart S3 uploads |

### AI / AWS
| Library | Version | Purpose |
|---|---|---|
| `@aws-sdk/client-bedrock-runtime` | 3.700 | AWS Bedrock Claude invocation |
| `@aws-sdk/client-sts` | 3.1064 | STS cross-account role assumption |
| `@anthropic-ai/sdk` | 0.39 | Anthropic Claude API (direct, alternative) |

### Authentication
| Library | Version | Purpose |
|---|---|---|
| `passport` | 0.7 | Authentication middleware |
| `passport-azure-ad` | 4.3.5 | Microsoft Entra ID (Azure AD) OIDC SSO |
| `express-session` | 1.18 | Server-side session management |
| `uuid` | 11.0 | UUID generation |

### Processing & Utilities
| Library | Version | Purpose |
|---|---|---|
| `bullmq` | 5.30 | Redis-backed async job queue (document processing) |
| `sharp` | 0.33 | PDF page-to-image conversion for extraction |
| `pdfkit` | 0.18 | PDF report generation (UW assessment export) |
| `dotenv` | 16.4 | Environment variable loading |

### Key Modules Description

#### `lib/workflow-engine.js`
The central state machine orchestrating the entire underwriting process.
- **17 workflow states** from `created` → `customer_notified`
- **Enforced state transitions** with valid-transitions map — prevents illegal state jumps
- **Dual persistence:** In-memory Map (fast reads) + PostgreSQL (durable writes)
- **TAT tracking:** Automatic turn-around time measurement
- **Hooks system:** Transition hooks trigger side-effects (notifications, assignments)

#### `lib/stp-classifier.js`
Pure function evaluating STP eligibility against `risk-params.json` rules.
- Hard knockout evaluation (15 check types)
- Soft flag evaluation (7 flag types)
- `runDeclaredDataAnalysis()` — re-normalized scoring for declared-only data (no lab docs)

#### `lib/medical-risk-engine.js` (125KB)
The core underwriting rule engine. Calculates a 100-point health risk score across 5 components. Applies UW guidelines, loading tables, waiting periods, and generates findings, violations, and recommendations.

#### `lib/claude-extractor.js`
Calls AWS Bedrock Claude Sonnet to parse medical reports. Uses structured prompts to extract lab values in a standardized JSON schema. Handles PDFs and images via `sharp` rendering.

#### `lib/uw-router.js`
Two-stage intelligent UW routing:
1. `classifyCaseSpecialty()` — detects primary medical specialty and complexity score from findings/violations
2. `assignToUnderwriter()` — selects the best qualified and least-loaded underwriter

#### `lib/telemer-scoring-engine.js` + `lib/telemer-score.js`
Scores a TeleMER interview transcript using a 5-parameter model covering lifestyle, medical history, questionnaire responses, voice analysis, and BMI.

#### `lib/comms-engine.js`
Template-based notification engine with 11 templates (PPHC scheduled, approved, rejected, counter-offer, policy issued, info-requested, info-received, info-reminder, info-expired, referred, PPHC complete). Dispatches via `comms-dispatcher.js`.

#### `lib/pg-client.js`
PostgreSQL abstraction layer with methods: `saveWorkflow`, `listWorkflowsFromS3`, `getConfig`, `saveConfig`, `getUsers`, `saveUsers`, `saveDocumentMeta`, `getDocumentFromS3`.

---

## 7. Frontend Pages

| Page | Route | Served To | Purpose |
|---|---|---|---|
| `login.html` | `/login` | All users | Credential login (demo) or Azure AD SSO redirect |
| `index.html` | `/app` | UW Staff | Main underwriting dashboard — full SPA (522KB) |
| `counter-offer.html` | `/counter-offer?token=...` | Customer | Accept/reject counter-offer terms |
| `info-request.html` | `/info-request?token=...` | Customer | Upload requested additional documents |

**Main Dashboard (`index.html`) Tabs/Sections:**
- **Dashboard:** Overview metrics, SLA breaches, STP vs NSTP breakdown
- **New Proposal:** Submit a new proposal (STP evaluation runs instantly)
- **Workflows:** List of all cases with filtering by state/vendor/UW
- **Workflow Detail:** Documents, AI extraction results, risk score, findings, violations, UW decision panel
- **Analytics:** TAT charts, decision distribution, compliance stats
- **Loading Table:** Editable premium loading parameters
- **UW Guidelines:** 50 configurable underwriting rules
- **CAT Scoring:** Sum Assured → test category assignment
- **Vendor Management:** PPHC vendor registry and status
- **Communications:** Notification log per workflow
- **User Management:** Role and authority assignment (Super Admin only)
- **UW Routing:** Live UW assignment engine test panel
- **PAS Integration:** Policy administration system status

---

## 8. Database Schema

Database: `sbi_uw` | User: `sbi_app` | Engine: PostgreSQL 16

```sql
-- Workflow lifecycle records (primary entity)
CREATE TABLE workflows (
  id           TEXT PRIMARY KEY,          -- UUID
  proposal_id  TEXT UNIQUE,               -- e.g. PROP-1234567890
  state        TEXT NOT NULL DEFAULT 'created',
  data         JSONB NOT NULL,            -- full workflow object (denormalized)
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
-- Indexes: state, updated_at DESC

-- User registry (roles, authority tiers, vendor mappings)
CREATE TABLE users (
  email      TEXT PRIMARY KEY,
  data       JSONB NOT NULL,             -- {name, role, authority_tier, specialties, ...}
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Dynamic configuration overrides (loading table, UW rules)
CREATE TABLE config (
  key        TEXT PRIMARY KEY,           -- 'loading-config', 'uw-rule-overrides', 'cat-scoring'
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Document metadata (binary content lives in S3)
CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL,
  name         TEXT,
  category     TEXT,                     -- blood_chemistry, cardiac, etc.
  s3_key       TEXT,                     -- S3 object path
  content_type TEXT,
  size_bytes   INTEGER,
  meta         JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
-- Index: workflow_id

-- AI analysis outputs (risk scores, decisions, findings)
CREATE TABLE analysis_results (
  id             SERIAL PRIMARY KEY,
  workflow_id    TEXT NOT NULL,
  ai_analysis    JSONB,
  extracted_data JSONB,
  decision       JSONB,
  risk_score     JSONB,
  analyzed_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Biometric scan results
CREATE TABLE biometrics (
  id          SERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  type        TEXT,                      -- face_scan, finger_scan
  s3_key      TEXT,
  score       NUMERIC,
  status      TEXT,
  meta        JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Full audit trail (every action with actor)
CREATE TABLE audit_log (
  id          SERIAL PRIMARY KEY,
  workflow_id TEXT,
  action      TEXT,
  actor       TEXT,                      -- email of user performing action
  data        JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

> **Pattern:** JSONB-heavy schema — the `data` column stores the complete denormalized workflow object, allowing schema-free evolution while maintaining indexed queryability.

---

## 9. Configuration Files

### `backend/config/risk-params.json`
- **Loading Table:** 15 medical conditions × loading percentages
- **Age Loading:** 7 age bands (18–66+) with loading percentages
- **Sum Assured Tiers:** 4 tiers with required tests and reinsurance flags
- **Waiting Periods:** 18 condition types with year counts
- **STP Eligibility Rules:** Hard knockouts + soft flag thresholds
- **Auto-Decline Rules:** HIV+, active cancer, ESRD, LVEF<30%, fraud
- **Gender Thresholds:** Hemoglobin and creatinine reference ranges by gender

### `backend/config/uw-guidelines.json`
- 50 UW rules with fields: `id`, `name`, `path` (JSON path to lab value), `operator` (`<`, `>`, `<=`, `>=`, `==`, `in`), `threshold`, `action` (`refer`/`decline`/`load`), `severity` (`critical`/`warning`)
- Overrides stored in `config` table (key: `uw-rule-overrides`) — changes survive Docker rebuilds

### `backend/config/uw-tiers.json`
- 4 tiers: junior, senior, chief, medical_officer
- Per-tier: SA limit, loading limit, allowed specialties, max concurrent cases
- Complexity scoring weights and tier thresholds

### `backend/config/premium-rates.json`
- Base premium rates by product (Health Shield, Comprehensive, Senior Care)
- Age bands × Sum Assured brackets × Gender modifiers

### `backend/config/telemer-questions.json`
- 50+ structured questions for TeleMER interview
- Categories: personal history, lifestyle, cardiovascular, respiratory, endocrine, musculoskeletal, etc.
- Expected answers and scoring signals per question

### `backend/config/telemer-scoring.json`
- Response-to-score matrix for each TeleMER question
- Weighted contribution to the 5 TeleMER scoring parameters

### `backend/config/medical-scoring.json`
- Parameter-level scoring for each lab value
- Normal ranges and penalty points for abnormal values

---

## 10. Authentication & Authorization

### Two authentication modes:

#### 1. Demo Credential Login (default, `SKIP_AUTH=true`)
```
POST /api/auth/login  { email, password }
  → Session cookie (Redis-backed in production)
  → req.session.demoUser populated
```

**Built-in demo accounts:**
| Email | Password | Role |
|---|---|---|
| `admin@sbigic.com` | `Admin@123` | Super Admin |
| `uwadmin@sbigic.com` | `UWAdmin@123` | UW Admin (Chief tier) |
| `senioruw@sbigic.com` | `SeniorUW@123` | Senior UW |
| `junioruw@sbigic.com` | `JuniorUW@123` | Junior UW |
| `cmo@sbigic.com` | `CMO@123` | Medical Officer |
| `vendor@medcheck.com` | `Vendor@123` | Vendor User (VEND-001) |

#### 2. Microsoft Entra ID SSO (production)
- Uses `passport-azure-ad` with OIDC strategy
- Flow: `GET /auth/login` → Azure AD → `POST /auth/callback` → `redirect /app`
- Requires: `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID`, `AZURE_AD_REDIRECT_URI`
- First login creates user record in S3/PostgreSQL with `Viewer` role (or `Super Admin` if email matches `SUPER_ADMIN_EMAIL`)

### Middleware
- `requireAuth` — checks `req.session.demoUser` → SKIP_AUTH → Passport isAuthenticated
- `requireRole(...roles)` — checks `req.user.role` against allowed roles list

---

## 11. User Roles & Authority Tiers

| Role | Authority Tier | SA Limit | Loading Limit | Max Cases | Specialties |
|---|---|---|---|---|---|
| Super Admin | — | Unlimited | Unlimited | Unlimited | All |
| UW Admin | chief | ₹5Cr | 200% | 10 | All |
| Senior UW | senior | ₹1Cr | 100% | 15 | General, Metabolic, Cardiac, Renal, Hepatic |
| Junior UW | junior | ₹25L | 50% | 20 | General only |
| Medical Officer | medical_officer | Unlimited | Unlimited | 8 | All + Reinsurance |
| Vendor User | — | — | — | — | Upload docs for assigned workflows |
| Viewer | — | — | — | — | Read-only access |

---

## 12. Vendor (PPHC) Network

| Vendor ID | Name | Type | CAT | Regions | SLA (hrs) | Capabilities |
|---|---|---|---|---|---|---|
| VEND-001 | MedCheck India | Full PPHC | CAT 1 | 8 cities | 48 | MER, CBC, ESR, SGPT, HbA1c, Creatinine, Cholesterol, Urine |
| VEND-002 | HealthAssure | Full PPHC | CAT 2 | 7 cities | 72 | CAT1 + ECG, Triglycerides, Microalbumin |
| VEND-003 | DigiMedic | Tele PPHC | TeleMER | Pan India | 24 | Phone/video MER, face scan, finger scan, chatbot |
| VEND-004 | ClinAssure Diagnostics | Full PPHC | CAT 3 | 7 cities | 96 | CAT2 + Lipid Panel, LFT, KFT, 2D Echo, TMT |
| VEND-005 | MedElite Advanced Diagnostics | Full PPHC | CAT 4 | 5 cities | 120 | CAT3 + Chest X-Ray, PSA, PAP Smear, Thyroid Panel, Extended KFT |

**Vendor simulation:** In POC mode, `submitPPHCRequest()` auto-completes reports after 3 seconds with realistic generated data using `completeVendorRequest()`.

---

## 13. Communication System

### Notification Templates (11 templates)
| Template Key | Trigger | Channels |
|---|---|---|
| `pphc_scheduled` | Vendor assigned & appointment set | Email, SMS, WhatsApp |
| `pphc_completed` | Vendor reports received | Email, SMS |
| `approved` | Auto-approved (standard) | Email, SMS, WhatsApp |
| `counter_offer` | Accept-with-loading decision | Email, SMS, WhatsApp |
| `rejected` | Auto or UW rejected | Email, SMS |
| `referred_uw` | Referred for expert review | Email, SMS |
| `policy_issued` | Policy number generated | Email, SMS, WhatsApp |
| `info_requested` | UW raises info request | Email, SMS, WhatsApp |
| `info_received` | Customer uploads additional docs | Email |
| `info_reminder` | Deadline approaching | Email, SMS, WhatsApp |
| `info_request_expired` | Deadline passed | Email, SMS |

### Delivery Adapters
| Channel | Production Provider | Dev Fallback |
|---|---|---|
| Email | AWS SES | Console log |
| SMS | Twilio / AWS SNS | Console log |
| WhatsApp | Meta Business API | Console log |

---

## 14. CI/CD Pipeline

**File:** `.github/workflows/deploy.yml`

**Trigger:** Push to `main` branch or manual `workflow_dispatch`

```
1. Checkout code
2. Configure AWS credentials (from GitHub Secrets)
3. Login to Amazon ECR
4. Build backend Docker image
   docker build -f backend/Dockerfile -t poc-health-claims-acc-uw-backend-ecr:latest ./backend
5. Tag backend image → ECR URI
6. Push backend image to ECR
7. Build frontend Docker image
   docker build -f frontend/Dockerfile -t poc-health-claims-acc-uw-frontend-ecr:latest ./frontend
8. Tag frontend image → ECR URI
9. Push frontend image to ECR
```

**GitHub Secrets Required:**
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_ACCOUNT_ID`

---

## 15. Docker & Infrastructure

### `docker-compose.yml` Services

| Service | Image | Port | Role |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | `127.0.0.1:5432` | Persistent relational store |
| `redis` | `redis:7-alpine` | `127.0.0.1:6379` | Session store + BullMQ queue |
| `backend` | `sbi-uw-backend:latest` | Internal `:5000` | REST API + WebSocket + Worker |
| `frontend` | `sbi-uw-frontend:latest` | `0.0.0.0:8085` | Nginx static + reverse proxy |

**Dependencies:** frontend → backend (health) → postgres + redis (health)

**Health Checks:**
- postgres: `pg_isready`
- redis: `redis-cli ping`
- backend: `wget -qO- http://localhost:5000/health`
- frontend: `wget -qO- http://localhost/login`

### Backend Dockerfile
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 5000
CMD ["node", "server.js"]
```

### Frontend Dockerfile
```dockerfile
FROM nginx:alpine
COPY . /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

---

## 16. Environment Variables

| Variable | Example Value | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | Enables Redis sessions, combined logging |
| `PORT` | `5000` | Backend listen port |
| `AWS_REGION` | `ap-south-1` | Default AWS region |
| `S3_BUCKET` | `poc-health-claims-acc-document-prod` | S3 bucket for all storage |
| `DB_NAME` | `sbi_uw` | PostgreSQL database name |
| `DB_USER` | `sbi_app` | PostgreSQL username |
| `DB_PASSWORD` | `SBIGIC1234` | PostgreSQL password |
| `DATABASE_URL` | `postgresql://...` | Full PostgreSQL connection URL (Docker) |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |
| `BEDROCK_REGION` | `ap-south-1` | AWS Bedrock service region |
| `BEDROCK_MODEL_ID` | `anthropic.claude-3-sonnet-20240229-v1:0` | Claude model ID |
| `BEDROCK_CROSS_ACCOUNT_ROLE_ARN` | `arn:aws:iam::916292310858:role/...` | STS role for cross-account Bedrock |
| `BEDROCK_INFERENCE_PROFILE` | `arn:aws:bedrock:ap-south-1:...` | Bedrock inference profile ARN |
| `SESSION_SECRET` | 64-char hex string | Express session signing key |
| `JWT_SECRET` | 64-char hex string | JWT token signing (future use) |
| `SES_REGION` | `ap-south-1` | AWS SES region |
| `SES_FROM_EMAIL` | `noreply@yourdomain.com` | SES sender address |
| `HTTPS_ONLY` | `false` | Force HTTPS-only cookies |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` | Skip TLS verification (dev only) |
| `SKIP_AUTH` | `true` | Bypass authentication (dev/demo) |
| `SUPER_ADMIN_EMAIL` | `admin1@sbigic.com` | Email with Super Admin privileges |
| `AZURE_AD_CLIENT_ID` | (optional) | Azure AD app client ID for SSO |
| `AZURE_AD_CLIENT_SECRET` | (optional) | Azure AD app secret |
| `AZURE_AD_TENANT_ID` | (optional) | Azure AD tenant ID |
| `AZURE_AD_REDIRECT_URI` | (optional) | Must be HTTPS for Azure AD |
| `COOKIE_DOMAIN` | (optional) | Cookie domain for multi-subdomain setup |
| `FRONTEND_URL` | `http://localhost:3000` | CORS allowed origin |
| `PAS_PROVIDER` | `mock` | Policy admin system: `mock`/`sbi_general`/etc. |
| `PAS_API_BASE` | (optional) | Real PAS API base URL |
| `PAS_API_KEY` | (optional) | Real PAS API key |
| `SMS_PROVIDER` | (optional) | `twilio`/`aws_sns`/`console` |
| `WHATSAPP_PROVIDER` | (optional) | `meta`/`console` |
| `BACKEND_IMAGE` | `412024807377.dkr.ecr...` | ECR backend image URI |
| `FRONTEND_IMAGE` | `412024807377.dkr.ecr...` | ECR frontend image URI |

---

## 17. API Endpoints Summary

### Health & Diagnostics
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | None | App health check |
| GET | `/api/health` | None | Service connectivity check |
| GET | `/api/s3-diagnostic` | None | S3 read/write test |

### Authentication
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/auth/login` | None | Azure AD SSO initiate |
| POST | `/auth/callback` | None | Azure AD OIDC callback |
| GET | `/auth/user` | Required | Get current user + role |
| GET | `/auth/logout` | None | Logout and redirect |
| POST | `/api/auth/login` | None | Demo credential login |
| POST | `/api/auth/logout` | None | Demo logout |

### Workflow Management
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/workflow/create` | Required | Create workflow + run STP evaluation |
| GET | `/api/workflows` | Required | List workflows (with filters) |
| GET | `/api/workflow/:id` | Required | Get single workflow |
| PUT | `/api/workflow/:id/state` | Required | Transition workflow state |
| PUT | `/api/workflow/:id/fields` | Required | Update workflow fields |
| GET | `/api/workflow/:id/audit-trail` | Required | Full audit log |
| GET | `/api/workflow/:id/api-log` | Required | AI API call log |
| GET | `/api/workflow/:id/export-pdf` | Required | Export UW report as PDF |

### Documents
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/workflow/:id/documents` | Required | Upload document (S3 + DB) |
| DELETE | `/api/workflow/:id/document/:docId` | Required | Remove document |
| POST | `/api/workflow/:id/submit-documents` | Required | Final document submission → triggers AI |
| GET | `/api/workflow/:id/document/:docId/preview` | Required | Get document as base64 |
| GET | `/api/workflow/:id/page-extractions` | Required | Get per-page extraction records |
| GET | `/api/workflow/:id/page-image/:page` | Required | Get rendered page image |

### Analysis & Decisions
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/workflow/:id/analyze` | Required | Trigger AI analysis (or async queue) |
| POST | `/api/workflow/:id/uw-decision` | Required | Submit UW decision |
| POST | `/api/workflow/:id/counter-offer` | Required | Issue counter-offer |
| POST | `/api/workflow/:id/issue-policy` | Required | Issue policy via PAS |

### Information Requests
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/workflow/:id/info-request` | Required | Create info request |
| GET | `/api/info-request/:token` | None | Customer-facing: get request details |
| POST | `/api/info-request/:token/respond` | None | Customer uploads response |

### Vendor & Communications
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/api/vendors` | Required | List all vendors |
| GET | `/api/vendor/:id/requests` | Required | Vendor's PPHC requests |
| GET | `/api/communications` | Required | Comms log |

### Configuration (Admin)
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/api/config/loading-table` | Required | Get loading params |
| PUT | `/api/config/loading-table` | Admin | Update loading params (persisted to DB) |
| GET | `/api/config/uw-guidelines` | Required | Get UW rules |
| PUT | `/api/config/uw-guideline/:id` | Admin | Update single UW rule |
| GET | `/api/config/cat-scoring` | Required | Get CAT scoring config |
| PUT | `/api/config/cat-scoring` | Admin | Update CAT scoring |

### Analytics
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/api/analytics` | Required | Workflow analytics (TAT, SLA, decisions, STP rate) |

---

## 18. Running the Application

### Prerequisites
- Docker & Docker Compose
- AWS credentials with S3, Bedrock, SES permissions
- Node.js ≥ 18 (for local dev)

### Quick Start (Docker)
```bash
# 1. Clone the repository
git clone https://github.com/sejalsubhash/health-insurance.git
cd health-insurance

# 2. Create .env (copy from template, fill in secrets)
cp .env .env.local
# Edit .env.local with your AWS credentials and DB passwords

# 3. Build Docker images
docker build -f backend/Dockerfile -t sbi-uw-backend:latest ./backend
docker build -f frontend/Dockerfile -t sbi-uw-frontend:latest ./frontend

# 4. Start all services
docker-compose up -d

# 5. Initialize the database
docker exec -i sbi-postgres psql -U sbi_app -d sbi_uw < schema.sql
docker exec -i sbi-postgres psql -U sbi_app -d sbi_uw < restore_cat_scoring.sql

# 6. Access the application
open http://localhost:8085/login

# 7. Login with demo credentials
# Email: admin@sbigic.com
# Password: Admin@123
```

### Local Development (without Docker)
```bash
cd backend
npm install
npm run dev   # node --watch server.js
# Backend runs at http://localhost:5000

# Open frontend/index.html directly in browser (or serve with any static server)
```

### Setup & Utility Scripts
| Script | Purpose |
|---|---|
| `setup.sh` | Full environment setup (Docker, dependencies, DB init) |
| `deploy.sh` | Build, tag and push Docker images to ECR |
| `checkdb.sh` | Verify PostgreSQL schema and data integrity |
| `dignose.sh` | Diagnose connectivity issues (DB, Redis, S3, Bedrock) |
| `extraction.sh` | Test document extraction pipeline end-to-end |
| `test-bedrock.sh` | Test AWS Bedrock connectivity and model access |
| `testing.js` | Integration test suite for all major API endpoints |
| `backend/test-stp.js` | Unit tests for STP classifier |
| `backend/test-stp-e2e.js` | End-to-end STP workflow tests |
| `backend/test-uw-routing.js` | Unit tests for UW routing engine |
| `backend/test-info-requests.js` | Integration tests for information request flow |

---

## Security Notes

> [!WARNING]
> The `.env` file in the repository contains real secrets (DB password, session keys). In production, rotate all secrets and use a secrets manager (AWS Secrets Manager / Parameter Store).

> [!CAUTION]
> `SKIP_AUTH=true` bypasses all authentication. Set to `false` and configure Azure AD for production deployments.

> [!NOTE]
> `NODE_TLS_REJECT_UNAUTHORIZED=0` disables TLS certificate verification. Remove this in production environments.

---

*Generated by code analysis of the complete repository. All workflows, configurations, and architectural decisions are derived directly from the source code.*
