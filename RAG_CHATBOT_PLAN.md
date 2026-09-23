# Plan: RAG Doctor Information Chatbot (LangChain)

**Complexity**: Medium
**Scope**: Read-only doctor discovery chatbot.

## Summary

Add a `chat` module that answers patient questions about doctors (who they are, specialization,
qualifications, experience, fee, bio, and today's available schedules) using a LangChain RAG
pipeline. Doctor profiles are embedded into a vector store for semantic matching ("I have skin
rash, who should I see?"), and the matched doctors are then re-fetched **live from Prisma** so
fees and slots are never stale. The endpoint is public (like `/doctor/public/*`) and follows the
existing `route → controller → service` module layout.

## Requirements

- `POST /api/v1/chat` — accepts a user message (+ optional `sessionId`) and returns an answer
  grounded only in doctor data from this system.
- Semantic search over approved, non-deleted doctors (name, specialization, qualifications,
  experience, bio).
- Answers include live data: consultation fee and today's published schedules with open slots.
- Short conversation memory per session so follow-ups work ("what is his fee?").
- No diagnosis / medical advice; emergency disclaimer.
- No booking, no multi-step agent, no LangGraph. The response returns `doctorId`s so the
  frontend can link to the existing doctor profile / booking flow.

## Architecture

```
POST /api/v1/chat
  └─ chatRateLimit (Redis)
  └─ validateRequest(SendChatMessageZodSchema)
  └─ ChatController.sendMessage  (catchAsync + sendResponse)
       └─ ChatServices.sendMessage(payload)
            1. load history          → Redis (existing redisClient), key chat:session:<id>
            2. condense question     → LLM rewrites follow-up into standalone query (only if history exists)
            3. retrieve              → vectorStore.similaritySearchWithScore(query, 5) → doctorIds
            4. enrich (live data)    → prisma.doctor.findMany({ id in doctorIds, APPROVED, !isDeleted })
                                        + today's PUBLISHED schedules with availableSlots > 0
            5. generate              → ChatPromptTemplate | chatModel | StringOutputParser (LCEL)
            6. save history          → Redis (trim to last 10 messages, TTL 1h)
            7. return { sessionId, answer, doctors: [{ id, name, specialization, consultationFee }] }
```

**Why this shape:** A plain LCEL chain (retrieve → prompt → model) is enough for Q&A. LangGraph
is only needed for tool loops / human-in-the-loop, which were dropped along with booking. Live
Prisma enrichment keeps fees and schedule availability accurate even if embeddings lag.

## Patterns to Mirror

| Category | Source | Pattern |
|---|---|---|
| Module layout | `src/app/module/doctor/*` | `chat.route.ts`, `chat.controller.ts`, `chat.service.ts`, `chat.validation.ts`, `chat.interface.ts`; exports `ChatRoutes`, `ChatController`, `ChatServices` |
| Route mounting | `src/app.ts:41-48` | `app.use("/api/v1/chat", ChatRoutes)` |
| Controller | `src/app/module/doctor/doctor.controller.ts` | `catchAsync(async (req, res) => { ... sendResponse(res, {...}) })` |
| Errors | `src/app/utils/AppError.ts` | `throw new AppError(httpStatus.X, "Message In Title Case")` inside services |
| Validation | `src/app/middleware/validateRequest.ts` + `*.validation.ts` | Zod v4 schema exported as `XxxZodSchema` |
| Public doctor query | `src/app/module/doctor/doctor.service.ts:561-650` | filter `isDeleted: false`, `verificationStatus: APPROVED`, explicit `select` (no email/phone/resume) |
| Today's schedules | `src/app/module/doctor/doctor.service.ts:460-485` | `status: PUBLISHED`, `availableSlots > 0`, `startDateTime` in `[startOfToday, startOfTomorrow)` and `gt: now` |
| Config | `src/app/config/index.ts` | add keys as `process.env.X!` |
| Singletons in lib | `src/app/lib/prisma.ts`, `src/app/lib/redis.ts` | one exported instance per file |
| Cron | `src/app/lib/cron.ts` | `cron.schedule(...)` with try/catch + `console.log` |
| Logging | whole codebase | `console.log` / `console.error` (no logger library) |
| Tests | — | **No test framework exists** (`npm test` is a stub). Vitest is introduced by this plan. |

## Files to Change

| File | Action | Why |
|---|---|---|
| `package.json` | UPDATE | add `@langchain/core`, `@langchain/community`, `pgvector`, provider package(s), `vitest`; scripts `index:doctors`, `test` |
| `.env.example` | UPDATE | `LLM_MODEL`, `LLM_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`, `CHAT_RATE_LIMIT_PER_MIN` |
| `src/app/config/index.ts` | UPDATE | expose new env keys |
| `prisma/migrations/<ts>_pgvector/migration.sql` | CREATE | `CREATE EXTENSION IF NOT EXISTS vector;` |
| `src/app/lib/llm.ts` | CREATE | chat model + embeddings singletons |
| `src/app/lib/vectorStore.ts` | CREATE | `PGVectorStore` singleton (table `doctor_embeddings`) |
| `src/app/module/chat/chat.route.ts` | CREATE | `POST /` |
| `src/app/module/chat/chat.controller.ts` | CREATE | `sendMessage` |
| `src/app/module/chat/chat.service.ts` | CREATE | RAG chain, history, live enrichment |
| `src/app/module/chat/chat.validation.ts` | CREATE | `SendChatMessageZodSchema` |
| `src/app/module/chat/chat.interface.ts` | CREATE | `ISendChatMessagePayload`, `IChatResponse` |
| `src/app/module/chat/chat.prompt.ts` | CREATE | system + condense-question prompts |
| `src/app/module/chat/chat.indexer.ts` | CREATE | `buildDoctorDocument`, `upsertDoctorEmbedding`, `removeDoctorEmbedding`, `reindexAllDoctors` |
| `src/app/middleware/chatRateLimit.ts` | CREATE | per-IP Redis rate limit |
| `src/app/scripts/indexDoctors.ts` | CREATE | one-off backfill (`bun run index:doctors`) |
| `src/app/module/doctor/doctor.service.ts` | UPDATE | call upsert after `approveDoctor` / `updateDoctorProfile` (non-blocking, try/catch) |
| `src/app/lib/cron.ts` | UPDATE | nightly `reindexAllDoctors` |
| `src/server.ts` | UPDATE | start the reindex cron next to `deleteUnverifiedDoctors()` |
| `src/app.ts` | UPDATE | mount `ChatRoutes` |
| `L2B7 Ph-Healthcare.postman_collection.json` | UPDATE | add chat request |
| `vitest.config.ts`, `src/app/module/chat/__tests__/*.test.ts` | CREATE | unit tests |

## Tasks

### Task 1: Dependencies & config
- **Action**: `bun add @langchain/core @langchain/community pgvector` + provider package
  (e.g. `@langchain/anthropic` for chat, `@langchain/openai` for embeddings — see Open Questions).
  `bun add -d vitest`. Add env keys to `.env.example` and `src/app/config/index.ts`.
- **Mirror**: `config/index.ts` key style (`llm_model: process.env.LLM_MODEL!`).
- **Validate**: `npx tsc --noEmit`

### Task 2: pgvector + vector store
- **Action**: Verify extension availability
  (`SELECT * FROM pg_available_extensions WHERE name = 'vector';`), add migration, create
  `src/app/lib/vectorStore.ts` exporting a lazily-initialized `PGVectorStore` using `DATABASE_URL`.
  The `doctor_embeddings` table is owned by LangChain (not a Prisma model) — document this in the
  README so schema drift is understood.
- **Mirror**: `src/app/lib/prisma.ts` singleton export.
- **Validate**: `npx prisma migrate dev` succeeds; smoke script can `addDocuments` + `similaritySearch`.

### Task 3: Doctor indexer
- **Action**: `chat.indexer.ts`
  - `buildDoctorDocument(doctor)` → `pageContent`:
    `"Dr. {name}. Specialization: {specialization}. Qualifications: {qualifications}. Experience: {experienceYears} years. {bio}"`;
    `metadata: { doctorId }` only (no email, phone, license, fee).
  - `upsertDoctorEmbedding(doctorId)` — delete by `doctorId`, then add (idempotent).
  - `removeDoctorEmbedding(doctorId)`.
  - `reindexAllDoctors()` — approved, non-deleted doctors, batched (e.g. 50).
  - Hook `upsertDoctorEmbedding` after `approveDoctor` and `updateDoctorProfile` in
    `doctor.service.ts`, wrapped in try/catch with `console.error` so indexing never fails the request.
  - Add nightly cron and `index:doctors` script.
- **Mirror**: `cron.ts` try/catch + log style; public `select` from `getSingleDoctorPublicProfile`.
- **Validate**: `bun run index:doctors`, then `SELECT count(*) FROM doctor_embeddings;` equals approved doctor count.

### Task 4: Chat service (RAG chain)
- **Action**: `ChatServices.sendMessage({ message, sessionId? })`
  1. `sessionId ??= crypto.randomUUID()`; load history from Redis `chat:session:<id>` (JSON list).
  2. If history exists, run condense prompt → standalone question; otherwise use the message as-is.
  3. `similaritySearchWithScore(query, 5)`; drop results below a score threshold.
  4. Fetch live doctors via Prisma with the public `select` + today's schedules
     (same `where` as `getAvailableDoctorByTodaysSchedule`). Preserve retrieval order.
  5. Format context as a compact list (name, specialization, qualifications, experience, fee,
     today's slots with times formatted via `date-fns`).
  6. LCEL: `ChatPromptTemplate.fromMessages([system, ...history, human]).pipe(model).pipe(new StringOutputParser())`.
  7. Push `{ human, ai }` to Redis, keep last 10 messages, `EXPIRE 3600`.
  8. Return `{ sessionId, answer, doctors }`.
  - No doctors retrieved → still call the model with empty context; prompt makes it reply
    "I couldn't find a matching doctor" (do not throw).
  - LLM / embedding provider failure →
    `throw new AppError(httpStatus.SERVICE_UNAVAILABLE, "Chat Service Is Temporarily Unavailable")`.
- **Mirror**: service functions + `export const ChatServices = { sendMessage }`.
- **Validate**: unit tests (Task 7).

### Task 5: Prompts & safety
- **Action**: `chat.prompt.ts` system prompt rules:
  - You help patients find doctors on PH Healthcare. Use **only** the provided doctor context.
  - Never invent doctors, fees, or times; if unknown, say so.
  - Do not diagnose or give treatment advice; you may suggest a relevant specialization.
  - For emergency symptoms (chest pain, breathing difficulty, severe bleeding, etc.) advise
    contacting emergency services immediately.
  - For booking, tell the user to open the doctor's profile / booking page.
  - Reply in the user's language, concisely.
- **Validate**: manual prompts in Task 8.

### Task 6: HTTP layer
- **Action**:
  - `chat.validation.ts`:
    `SendChatMessageZodSchema = z.object({ message: z.string().trim().min(1).max(1000), sessionId: z.uuid().optional() })`.
  - `chat.route.ts`:
    `router.post("/", chatRateLimit, validateRequest(SendChatMessageZodSchema), ChatController.sendMessage)`.
  - `chatRateLimit`: `redisClient.incr` + `expire` on `chat:rl:<ip>`; over limit →
    `AppError(httpStatus.TOO_MANY_REQUESTS, "Too Many Requests. Please Try Again Later")`.
  - Mount in `src/app.ts`: `app.use("/api/v1/chat", ChatRoutes)`.
  - Add request to the Postman collection.
- **Mirror**: public routes in `doctor.route.ts`; controller shape in `doctor.controller.ts`.
- **Validate**:
  `curl -X POST localhost:5000/api/v1/chat -H "Content-Type: application/json" -d '{"message":"Any cardiologist available today?"}'`

### Task 7: Tests (Vitest)
- **Action**: add `vitest.config.ts`, set `"test": "vitest run"`.
  - `chat.indexer.test.ts`: `buildDoctorDocument` includes profile fields; excludes email/contact/license.
  - `chat.service.test.ts` (mock vector store, Prisma, Redis; LangChain `FakeListChatModel`):
    - returns `sessionId`, `answer`, and `doctors` in retrieval order
    - only approved / non-deleted doctors reach the context
    - history trimmed to 10 and TTL set
    - provider error → `AppError` 503
  - `chat.validation.test.ts`: empty / oversized message rejected.
- **Validate**: `npm test`

### Task 8: Manual verification
- Seed tester doctor (existing `seedTesterDoctor`), approve, add a published schedule for today, reindex.
- Ask: "Who is available today?", "I have a skin problem", follow-up "what's the fee?",
  "I have severe chest pain" (expect emergency advice), "book me an appointment"
  (expect pointer to the booking page).

## Validation

```bash
npx tsc --noEmit
npm run lint:check && npm run format:check
npm test
npx prisma migrate dev
bun run index:doctors
npm run dev   # then POST /api/v1/chat
```

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Hosted Postgres lacks `vector` extension | Medium | Check first; fallback: Redis vector search on existing Redis, or `MemoryVectorStore` rebuilt at boot (fine for small doctor counts) |
| Hallucinated doctors / fees | Medium | Context-only prompt; fees/slots from live Prisma, not embeddings; structured `doctors` array returned |
| Stale embeddings after profile edits | Low | Upsert hooks + nightly reindex cron |
| Cron doesn't run on Vercel serverless (`vercel.json`) | Medium | Rely on upsert hooks; run `index:doctors` after deploy |
| Medical-safety wording | Medium | Strict no-diagnosis + emergency rules; review with healthcare reviewer |
| Cost / abuse on a public endpoint | Medium | Redis rate limit, message length cap, history trimming, `k = 5` |
| Prisma drift from LangChain-owned table | Low | Document it; keep table outside Prisma schema |

## Open Questions

1. **Chat LLM**: Claude (`claude-sonnet-5` via `@langchain/anthropic`), OpenAI, or Gemini?
2. **Embeddings**: OpenAI `text-embedding-3-small` (suggested), Voyage, or a local model?
3. **Vector store**: confirm pgvector is available on your Postgres host.

## Estimated Effort

- Setup + indexing: 2–3h
- Chat service + prompts: 3–4h
- HTTP layer: 1h
- Tests: 2–3h
- **Total: ~8–11h**

## Acceptance

- [ ] `POST /api/v1/chat` answers doctor questions with live fee + today's schedules
- [ ] Follow-up questions work within a session
- [ ] No booking, no LangGraph dependency
- [ ] Only approved, non-deleted doctors ever appear
- [ ] Type check, lint, and tests pass
- [ ] Patterns mirrored (module layout, `AppError`, `catchAsync`, `sendResponse`, Zod validation)
