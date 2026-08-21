# Campus School Bot

Campus is a standalone Discord school bot with persistent storage in Supabase.

## What this first build includes

- `/campus setup`
- Q1-Q4 setup and action-based grading
- classroom/location/club/discipline category scanning
- typed character names (no student registration)
- school activity dropdown + class/location routing
- optional assignment/book/activity names
- `/progress` and `/grade`
- Finals Mode with one final per day
- Detention, ISS, and Suspension
- school calendar awareness
- automated teacher profiles, status, frequency, cooldowns
- teacher conversation awareness
- spontaneous teacher messages
- teacher webhooks when Campus has Manage Webhooks
- persistent teacher memory in Supabase
- quiet hours
- health endpoint for Render web services

## Required Render environment variables

- `DISCORD_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

## Optional Render environment variables

- `OPENAI_API_KEY` — required for AI teacher speech/reactions
- `OPENAI_MODEL` — defaults to `gpt-5.6-luna`
- `REGISTER_COMMANDS` — defaults to `true`
- `TEACHER_TICK_MINUTES` — defaults to `10`

## Render settings

Build command:

`npm install`

Start command:

`npm start`

Node version: use Node 22 or newer.

## Discord permissions Campus should have

- View Channels
- Send Messages
- Read Message History
- Add Reactions
- Embed Links
- Manage Webhooks (recommended for teacher names/avatars)
- Use Application Commands

Message Content Intent must be enabled in the Discord Developer Portal for teacher conversation awareness.

## First commands to run after deployment

1. `/campus setup`
2. `/quarter setup` four times (Q1, Q2, Q3, Q4)
3. `/routes setup` for your Classrooms category
4. `/routes setup` for School Locations
5. `/routes setup` for Clubs & Activities
6. `/routes setup` for Discipline
7. `/teacher create`
8. `/activity`

Do not put real secrets inside `.env.example` or GitHub.
