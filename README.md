# Haven — AI support companion (Express + Postgres + Groq)

Runs locally with a SQLite file (Node 22.5+), and on Vercel with a hosted Postgres (Neon free tier) because Vercel's filesystem is not persistent. The server picks Postgres automatically when DATABASE_URL is set.

## Local run
```
npm install
copy .env.example .env      # fill GROQ_API_KEY and JWT_SECRET
npm start                   # http://localhost:3000
```
Tables are created automatically on first request.

## Deploy to Vercel
1. Create a free Postgres at neon.tech; copy its connection string (DATABASE_URL).
2. Push this folder to GitHub (`.env` is git-ignored).
3. vercel.com -> Add New Project -> import the repo. Framework: Other. No build command.
4. Add environment variables: GROQ_API_KEY, JWT_SECRET, DATABASE_URL, MODEL, NODE_ENV=production.
5. Deploy and open the URL.

## Notes
Crisis detection is keyword-based (safety net, not clinical). Accounts use bcrypt + httpOnly JWT cookie. Guest data is deleted on sign-out. Messages are sent to Groq to generate replies.
