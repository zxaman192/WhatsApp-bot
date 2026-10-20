# WhatsApp NEET PG prep bot

A WhatsApp bot for NEET PG preparation. Send it your notes, question banks and PYQs (PDF, photo or text). It splits them into questions and notes, files each one under its subject and topic, then quizzes you: one question a day, or a full test whenever you ask. Ask it about any topic and it explains from your own notes, with the file and page it came from.

It works on WhatsApp and Telegram. Both use the same database, so a PDF you upload in Telegram is in your WhatsApp tests too, and every command below works in both.

## What it does

| You send | The bot |
|---|---|
| A PDF, photo or pasted text | Reads it, pulls out every MCQ (and writes MCQs from notes), sorts each into one of the 19 subjects and a chapter-level topic, and reports what went where. Duplicates are skipped. |
| `q` / `q pharma` | One question now, as a tappable A–D list. |
| `test` | Pick a subject and length from menus. |
| `test pharma 20`, `test pyq 2022`, `test 10 thyroid` | A custom test by subject, PYQ year or topic. Ends with a score, per-topic breakdown and the questions to review. |
| `revise` / `due` | Spaced repetition: a question you get wrong comes back after 1, 3, 7 and 21 days. `revise` tests your review queue; `q` and `test` slip due reviews in too. |
| `grand` / `grand 50` | Pick 200, 100 or 50 questions. A full mock spread across subjects like the real paper: 1.05 minutes per question, +4/−1, skip allowed, answers only at the end, then marks and a subject breakdown. |
| Photo with caption `spot: <answer>` (or `spot derma: <answer>`) | Saves an image question (X-ray, specimen, lesion, instrument). `spot` quizzes you: A–D options once you have 4+ images, typed answers before that. |
| A voice note | Transcribed and handled like a typed message, so you can ask questions by voice. Needs Gemini. |
| A YouTube link, or a lecture recording (over 5 minutes or captioned "lecture") | Turned into notes and MCQs, filed like any upload. Needs Gemini. Recordings up to 14 MB. |
| `explain <topic>` or any question | An answer built from your notes, citing them `[1]`, `[2]` with file and page. |
| `where <topic>` | Every note section and question about that topic, by subject › topic, file, page and PYQ year. |
| `why` / `similar` | Explains the last question from your notes / lists questions like it, with a button to practise them. |
| `flash` / `flash pharma antiepileptics` | Five flashcards from your notes (AI-written, or fill-in-the-blank without a key), with "knew it / didn't" and a summary. |
| `hy` / `hy pharma` | High-yield topics: the ones asked in the most PYQ years, with your accuracy on each. |
| `coach` | Your three weakest topics, each with a 10-question drill. Every Sunday at your daily time you also get a weekly report. |
| `exam 15-01-2027`, `plan`, `today` | Exam countdown and a day-by-day subject plan. Heavier and weaker subjects get more days; the last 10% are for grand tests and revision. The daily question follows the plan (`D-45 · Today: Pharmacology`). `plan new` rebalances. |
| `name Harsh`, `buddy`, `buddy add CODE`, `lb` | Study buddies: friends join with your code, get the same daily question, and share a weekly leaderboard with streaks. Each friend must be in `ALLOWED_NUMBERS` / `TELEGRAM_ALLOWED_IDS`. |
| `bank` / `stats` / `report` | What's in your database / your accuracy, streak, review queue and weak topics / this week against last week. |
| `daily 07:30`, `daily off`, `daily pharma` | Your question of the day. |

After every answer you get the explanation plus the matching passage from your notes (`📖 Your notes: Pharmacology › Antiepileptics (marrow.pdf p.12)`).

## How it is built

- **Node.js + Express** webhooks for the official **WhatsApp Cloud API** and the **Telegram Bot API** (`src/server.js`, `src/whatsapp.js`, `src/telegram.js`). Telegram users are stored as `tg:<id>`; everything else is shared.
- **Postgres** storage with full-text search (`src/db.js`): **Supabase** in production; an embedded Postgres (PGlite) when `DATABASE_URL` is empty, for local testing.
- **AI (optional): Gemini or Claude** reads PDFs (in 15-page chunks) and photos, extracts and sorts questions, and answers from your notes (`src/ingest/gemini.js`, `src/ingest/claude.js`; `AI_PROVIDER` picks one, otherwise whichever key is set). Without a key, text and text PDFs are parsed and keyword-sorted locally (`src/ingest/textParser.js`, `src/ingest/keywords.js`).
- A one-minute scheduler sends each user's daily question at their chosen time (`src/scheduler.js`). Outside WhatsApp's 24-hour window it sends your approved template instead.

## Try it locally (no WhatsApp needed)

```bash
npm install
cp .env.example .env        # leave everything empty for now; DRY_RUN=true
npm run chat                # talk to the bot in your terminal
```

In the chat, `/file path/to/notes.pdf pharma` sends a file and `/tap <id>` taps a menu option. Photos and scanned PDFs need `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in `.env`.

Bulk import from your computer: `npm run import -- qbank/*.pdf --caption pharma`

Tests: `npm test`

## Deploy (Render + Supabase)

1. **Database (Supabase).** In your Supabase project open **Connect → Session pooler** and copy the URI (reset the database password under Project settings → Database if you don't have it). That is `DATABASE_URL`. Tables are created automatically on first start (`schema.sql` has the same SQL).
2. **WhatsApp (Meta for Developers).** Create an app with the WhatsApp product. From **WhatsApp → API Setup** copy the phone number ID, and create a permanent token (System user in Business settings with `whatsapp_business_messaging` permission). Copy the **App secret** from App settings → Basic.
3. **Render.** Create a Web Service from this repo: build `npm install`, start `npm start`. Add the environment variables from `.env.example` (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `DATABASE_URL`, `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`, `ALLOWED_NUMBERS`).
4. **Webhook.** In Meta, WhatsApp → Configuration: callback URL `https://<your-service>.onrender.com/webhook`, verify token = your `WHATSAPP_VERIFY_TOKEN`. Subscribe to the `messages` field.
5. **Go live.** Set `DRY_RUN=false` on Render. Send "hi" to the bot's number.
6. **Daily question on Render's free plan.** Free services sleep after 15 minutes without traffic, which pauses the scheduler. Either use a paid instance, or create a free job on cron-job.org that every 10 minutes sends `POST https://<your-service>.onrender.com/cron/daily` with header `x-cron-token: <WHATSAPP_VERIFY_TOKEN>`. That keeps it awake and sends any due questions.
7. **Telegram (optional).** In Telegram, message @BotFather, send `/newbot`, and copy the token it gives you into `TELEGRAM_BOT_TOKEN` on Render. On restart the bot registers its webhook by itself. Message your bot once: it replies with your Telegram ID; put that in `TELEGRAM_ALLOWED_IDS`. Telegram bots can receive files up to 20 MB.
8. **Daily question template (optional).** WhatsApp only lets a bot message you first within 24 hours of your last message. To get the daily question even on days you haven't messaged, create a Utility template in WhatsApp Manager (e.g. "Your NEET PG question of the day is ready 📚" with a quick-reply button "Start") and set `DAILY_TEMPLATE_NAME` to its name.

## Costs

- Supabase free plan and Render free plan: $0.
- WhatsApp: replies within 24 hours of your message are free; template messages are charged per Meta's pricing.
- Claude API: optional, pay per use. With the default model (Claude Haiku 5.5) reading uploads costs well under a cent per 15 PDF pages (an estimate; it depends on how dense the pages are), so $5 of credit goes a long way. `CLAUDE_MODEL=claude-sonnet-5-5` or `claude-opus-5-5` read messy scans more accurately at a higher price.

## Choosing an AI

- **Gemini (free).** Get a key at aistudio.google.com → Get API key (no card) and set `GEMINI_API_KEY`. The free tier allows about 20 requests a day per model, so the bot tries `GEMINI_MODEL` first and then each model in `GEMINI_FALLBACK_MODELS`, resting any model that is out of quota until it resets. When every model is out, practice still works, `explain` and `why` answer from your notes, and long PDFs pause and finish by themselves once the quota is back (upload jobs are saved in the database, so restarts don't lose them either). Google may use free-tier data to improve its products; check their terms before uploading anything private.
- **Claude.** Set `ANTHROPIC_API_KEY` (console.anthropic.com, pay per use).
- If both keys are set, Gemini is used unless `AI_PROVIDER=claude`.

## Without an AI key

Leave both keys empty and the bot still works for:
- text and PDFs with selectable text laid out as numbered MCQs, with the answer marked inline (`Ans: b`) or in an answer key (`1-b 2-c …`). They are sorted into subject and topic by keywords, or by your caption (`pharma`), with page numbers;
- other text, which is kept as notes page by page, so `explain` (shows the matching passages) and `where` work.

Photos, scanned PDFs, writing questions from notes, written explanations and AI flashcards need an AI key. Voice notes, lecture recordings and YouTube links need Gemini specifically, since Claude can't listen to audio or watch video. Set `CLAUDE_MODEL` to change the model.
