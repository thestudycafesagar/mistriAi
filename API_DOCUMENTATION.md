# Hybrid GST Invoice Extractor — Backend API Documentation

Welcome to the **Hybrid GST Invoice Extractor Backend API**. This backend provides robust, hybrid (Local NLM + Cloud AI) OCR and invoice digitization capabilities, with real-time WebSocket progress tracking, fair round-robin multi-user queueing, and strict validation rules.

---

## 🌐 Base URL & CORS
- **Default Port:** `http://localhost:3000` (or your server domain)
- **CORS Policy:** Fully enabled (`*`) for all origins and HTTP methods (`GET`, `POST`).

---

## 🏥 1. System Health Check

### `GET /health`
Verify that the backend server is online and running.

#### **Response (200 OK)**
```json
{
  "status": "ok",
  "message": "Hybrid Invoice Backend is running perfectly!"
}
```

---

## 🤖 2. Model & Pipeline Discovery

### `GET /api/extract/models`
Fetch the list of locally available AI models (e.g., via Ollama/Dolphin) and determine if local extraction is available.

#### **Response (200 OK)**
```json
{
  "models": [
    "llama3.2:latest",
    "mistral:latest"
  ]
}
```
> [!NOTE]
> If local services are offline, the backend may return a `503 Server unreachable` error or an empty list, and the frontend should fall back to requesting `'cloud'` processing.

---

## 📄 3. Document Extraction Endpoints

### `POST /api/extract` (Synchronous Single File Upload)
Upload a single invoice (PDF or Image) for immediate OCR and GST JSON extraction.
- **Max Page Limit:** PDFs must not exceed **2 pages**. Any PDF over 2 pages is rejected immediately with a `400 Bad Request`.
- **Company Context:** Optional buyer/seller role identification.

#### **Request Headers**
- `Content-Type: multipart/form-data`

#### **Form Data Parameters**
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `file` | File (Binary) | **Yes** | Invoice file (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`). Max 2 pages for PDF. |
| `model` | String | No | Target model name (e.g. `'llama3.2'` or `'cloud'`). Defaults to local NLM or cloud if configured. |
| `companyName` | String | No | Your company name (used to detect and correct swapped Buyer/Seller roles). |
| `companyGSTIN` | String | No | Your company GSTIN number. |
| `transactionType` | String | No | `'purchase'` (we are Buyer) or `'sale'` (we are Seller). Defaults to `'purchase'`. |

#### **Example Request (JavaScript / Fetch)**
```javascript
const formData = new FormData();
formData.append('file', fileInput.files[0]);
formData.append('model', 'cloud'); // or 'llama3.2'
formData.append('companyName', 'Techgrail Private Limited');
formData.append('companyGSTIN', '09AAKCT5650N1ZM');
formData.append('transactionType', 'purchase');

const response = await fetch('http://localhost:3000/api/extract', {
  method: 'POST',
  body: formData
});
const gstJson = await response.json();
```

#### **Response (200 OK — GST JSON Schema)**
```json
{
  "invoiceNumber": "250418-31",
  "invoiceDate": "18-04-2025",
  "sellerName": "Walkover Web Solutions Private Limited",
  "sellerGSTIN": "23AAACW9768L1ZO",
  "buyerName": "TECHGRAIL PRIVATE LIMITED",
  "buyerGSTIN": "09AAKCT5650N1ZM",
  "lineItems": [
    {
      "description": "Messaging Wallet 18-04-2025",
      "hsnSac": "998413(S)",
      "goodsQuantity": null,
      "goodsRate": 10000.0,
      "amount": 11800.0
    }
  ],
  "taxableValue": 10000.0,
  "cgstAmount": 0.0,
  "sgstAmount": 0.0,
  "igstAmount": 1800.0,
  "totalInvoiceAmount": 11800.0
}
```

---

### `POST /api/extract/batch` (Asynchronous Multi-File Upload)
Upload multiple invoice files (up to **10 files per request**) for background queue processing.
- **Fair Round-Robin Scheduling:** The backend automatically interleaves jobs between different users so no single user monopolizes the AI pipeline.
- **Max Page Limit:** Any individual PDF exceeding **2 pages** is marked as `failed` immediately without blocking the rest of the batch.

#### **Request Headers**
- `Content-Type: multipart/form-data`

#### **Form Data Parameters**
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `files` | File[] | **Yes** | Array of up to 10 invoice files (`.pdf`, `.png`, `.jpg`). |
| `userId` | String | **Yes** | Unique user identifier (used for WebSocket rooms and round-robin queue fairness). |
| `model` | String | No | Target AI model (`'cloud'` or local NLM). |
| `companyName` | String | No | Company name for role verification. |
| `companyGSTIN` | String | No | Company GSTIN. |
| `transactionType` | String | No | `'purchase'` or `'sale'`. |

#### **Example Request (JavaScript / Fetch)**
```javascript
const formData = new FormData();
for (const file of fileInput.files) {
  formData.append('files', file);
}
formData.append('userId', 'user_12345');
formData.append('model', 'cloud');

const response = await fetch('http://localhost:3000/api/extract/batch', {
  method: 'POST',
  body: formData
});
const result = await response.json();
```

#### **Response (200 OK)**
```json
{
  "message": "10 of 10 files queued for processing.",
  "jobs": [
    {
      "id": "9fb117e0-aa7e-4365-97ca-419cb3d40003",
      "userId": "user_12345",
      "filename": "Invoice_Nov_2025.pdf",
      "status": "queued",
      "pipeline": "cloud",
      "model": "cloud",
      "createdAt": 1785151052120
    }
  ],
  "maxFilesPerUpload": 10
}
```

---

## 📊 4. Queue Management & Polling

### `GET /api/extract/jobs` (Get Queue Stats or User Jobs)
Fetch global queue statistics or list all active/completed jobs for a specific user.

#### **Query Parameters**
- `?userId={userId}` *(Optional)*: If provided, returns an array of jobs belonging to that user. If omitted, returns global server queue statistics.

#### **Example Request (Global Stats)**
`GET http://localhost:3000/api/extract/jobs`
```json
{
  "stats": {
    "queued": 2,
    "extracting": 1,
    "formatting": 1,
    "cloudProcessing": 3,
    "completed": 15,
    "failed": 0,
    "total": 22
  }
}
```

#### **Example Request (User Jobs)**
`GET http://localhost:3000/api/extract/jobs?userId=user_12345`
```json
{
  "jobs": [
    {
      "id": "9fb117e0-aa7e-4365-97ca-419cb3d40003",
      "userId": "user_12345",
      "filename": "Invoice_Nov_2025.pdf",
      "status": "completed",
      "pipeline": "cloud",
      "result": {
        "invoiceNumber": "INV-2025-99",
        "totalInvoiceAmount": 4500.0
      },
      "createdAt": 1785151052120,
      "completedAt": 1785151063400
    }
  ]
}
```

---

### `GET /api/extract/jobs/:jobId` (Single Job Polling)
Fetch real-time status and extracted JSON for a single background job ID. Useful as a fallback for mobile apps or clients that do not use WebSockets.

#### **Response (200 OK)**
```json
{
  "id": "9fb117e0-aa7e-4365-97ca-419cb3d40003",
  "status": "completed",
  "result": {
    "invoiceNumber": "INV-2025-99",
    "totalInvoiceAmount": 4500.0
  },
  "error": null
}
```
> **Job Status Values:** `'queued'`, `'extracting'`, `'formatting_queued'`, `'formatting'`, `'cloud_processing'`, `'completed'`, `'failed'`.

---

## 💾 5. Invoice Storage & History

### `GET /api/invoices`
Fetch all permanently saved GST invoice records from the database/storage.

#### **Response (200 OK)**
```json
[
  {
    "invoiceNumber": "250418-31",
    "invoiceDate": "18-04-2025",
    "sellerName": "Walkover Web Solutions",
    "totalInvoiceAmount": 11800.0
  }
]
```

### `POST /api/invoices`
Save a verified or user-edited GST invoice JSON object to permanent storage.

#### **Request Body (`application/json`)**
Send the complete GST JSON schema object (as received from extraction or modified by the user in the UI).

#### **Response (200 OK)**
Returns the saved invoice object confirming persistence.

---

## ⚡ 6. Real-Time WebSockets (Socket.IO)

The backend runs a **Socket.IO server** on the exact same HTTP port (`http://localhost:3000`). WebSockets should be used by the frontend to display real-time live progress bars, spinners, and instant completion updates without polling.

### **Connection & Authentication**
When connecting, the client must immediately emit a `'join'` event with their `userId` so the backend knows which room to send targeted progress updates to.

#### **Frontend Implementation Example (JavaScript / React)**
```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

// 1. Join user-specific room upon connection
socket.on('connect', () => {
  console.log('Connected to WebSocket:', socket.id);
  socket.emit('join', 'user_12345'); // MUST match userId passed in POST /api/extract/batch
});

// 2. Listen for real-time job status updates
socket.on('job:queued', (job) => {
  console.log(`Job queued: ${job.filename}`);
});

socket.on('job:extracting', (job) => {
  console.log(`Extracting text from: ${job.filename} (Stage 1)...`);
});

socket.on('job:formatting', (job) => {
  console.log(`AI formatting JSON for: ${job.filename} (Stage 2)...`);
});

socket.on('job:completed', (job) => {
  console.log(`✅ Scan complete: ${job.filename}`, job.result);
  // Update React state with job.result (the extracted GST JSON)
});

socket.on('job:failed', (job) => {
  console.error(`❌ Scan failed: ${job.filename} — Reason: ${job.error}`);
});

// 3. Listen for entire batch completion
socket.on('batch:completed', (batchSummary) => {
  console.log('🏁 Entire upload batch finished!', batchSummary);
  // Example batchSummary: { userId: 'user_12345', total: 10, successful: 10, failed: 0, elapsedSeconds: 45.2 }
});
```

---

## 🛡️ Summary of Key Validation Rules for Frontend
1. **Max Page Count:** Never allow users to upload PDFs with more than **2 pages**. The backend will actively block and reject any PDF over 2 pages.
2. **Max Batch Size:** Limit multi-file uploads to a maximum of **10 files** per HTTP request.
3. **User IDs:** Always generate or persist a consistent `userId` (e.g. UUID stored in `localStorage`) across HTTP requests and WebSocket `'join'` rooms to ensure round-robin fairness and correct socket delivery.
