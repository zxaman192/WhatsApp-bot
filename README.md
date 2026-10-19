# WhatsApp NEET PG prep bot

A WhatsApp bot for NEET PG preparation. Send it your notes, question banks and PYQs (PDF, photo or text). It splits them into questions and notes, files each one under its subject and topic, then quizzes you: one question a day, or a full test whenever you ask. Ask it about any topic and it explains from your own notes, with the file and page it came from.

## What it does

| You send | The bot |
|---|---|
| A PDF, photo or pasted text | Reads it, pulls out every MCQ (and writes MCQs from notes), sorts each into one of the 19 subjects and a chapter-level topic, and reports what went where. Duplicates are skipped. |
| `q` / `q pharma` | One question now, as a tappable A–D list. |
| `test` | Pick a subject and length from menus. |
| `test pharma 20`, `test pyq 2022`, `test 10 thyroid` | A custom test by subject, PYQ year or topic. Ends with a score, per-topic breakdown and the questions to review. |
| `revise` | A test of the questions you got wrong. |
| `explain <topic>` or any question | An answer built from your notes, citing them `[1]`, `[2]` with file and page. |
| `where <topic>` | Every note section and question about that topic, by subject › topic, file, page and PYQ year. |
| `why` | Explains the last question you answered, from your notes. |
| `bank` / `stats` | What's in your database / your accuracy, weak topics and active days. |
| `daily 07:30`, `daily off`, `daily pharma` | Your question of the day. |

After every answer you get the explanation plus the matching passage from your notes (`📖 Your notes: Pharmacology › Antiepileptics (marrow.pdf p.12)`).

Question picking favours questions you got wrong before (spaced review), then ones you have never seen.

## How it is built

- **Node.js + Express** webhook for the official **WhatsApp Cloud API** (`src/server.js`, `src/whatsapp.js`).
- **Postgres** storage with full-text search (`src/db.js`): **Supabase** in production; an embedded Postgres (PGlite) when `DATABASE_URL` is empty, for local testing.
- **Claude API** reads PDFs (in 15-page chunks) and photos, extracts and sorts questions, and answers from your notes (`src/ingest/claude.js`). Text that is already laid out as numbered MCQs with an answer key is parsed without AI (`src/ingest/textParser.js`).
- A one-minute scheduler sends each user's daily question at their chosen time (`src/scheduler.js`). Outside WhatsApp's 24-hour window it sends your approved template instead.

## Try it locally (no WhatsApp needed)

```bash
npm install
cp .env.example .env        # leave everything empty for now; DRY_RUN=true
npm run chat                # talk to the bot in your terminal
```

In the chat, `/file path/to/notes.pdf pharma` sends a file and `/tap <id>` taps a menu option. PDFs and photos need `ANTHROPIC_API_KEY` in `.env`.

Bulk import from your computer: `npm run import -- qbank/*.pdf --caption pharma`

Tests: `npm test`

## Deploy (Render + Supabase)

1. **Database (Supabase).** In your Supabase project open **Connect → Session pooler** and copy the URI (reset the database password under Project settings → Database if you don't have it). That is `DATABASE_URL`. Tables are created automatically on first start (`schema.sql` has the same SQL).
2. **WhatsApp (Meta for Developers).** Create an app with the WhatsApp product. From **WhatsApp → API Setup** copy the phone number ID, and create a permanent token (System user in Business settings with `whatsapp_business_messaging` permission). Copy the **App secret** from App settings → Basic.
3. **Render.** Create a Web Service from this repo: build `npm install`, start `npm start`. Add the environment variables from `.env.example` (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `ALLOWED_NUMBERS`).
4. **Webhook.** In Meta, WhatsApp → Configuration: callback URL `https://<your-service>.onrender.com/webhook`, verify token = your `WHATSAPP_VERIFY_TOKEN`. Subscribe to the `messages` field.
5. **Go live.** Set `DRY_RUN=false` on Render. Send "hi" to the bot's number.
6. **Daily question on Render's free plan.** Free services sleep after 15 minutes without traffic, which pauses the scheduler. Either use a paid instance, or create a free job on cron-job.org that every 10 minutes sends `POST https://<your-service>.onrender.com/cron/daily` with header `x-cron-token: <WHATSAPP_VERIFY_TOKEN>`. That keeps it awake and sends any due questions.
7. **Daily question template (optional).** WhatsApp only lets a bot message you first within 24 hours of your last message. To get the daily question even on days you haven't messaged, create a Utility template in WhatsApp Manager (e.g. "Your NEET PG question of the day is ready 📚" with a quick-reply button "Start") and set `DAILY_TEMPLATE_NAME` to its name.

## Costs

- Supabase free plan and Render free plan: $0.
- WhatsApp: replies within 24 hours of your message are free; template messages are charged per Meta's pricing.
- Claude API: pay per use. Reading uploads is the main cost: roughly $0.20–0.40 per 15 PDF pages with the default model (an estimate; it depends on how dense the pages are). Answering from notes costs a fraction of a cent per question. Set `CLAUDE_MODEL` to change the model.
