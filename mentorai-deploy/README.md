# MentorAI — Deployment Guide

## Folder Structure
```
mentorai-deploy/
├── index.html        ← Your full app (no API keys here)
├── api/
│   └── chat.js       ← Secure backend (API keys live here on Vercel)
├── vercel.json       ← Vercel config
├── .env.example      ← Template for your environment variables
└── README.md
```

## One-Time Setup (15 minutes)

### Step 1 — Push to GitHub
1. Go to github.com → New Repository → Name it `mentorai` → Create
2. Upload all files from this folder to the repository

### Step 2 — Connect to Vercel
1. Go to vercel.com → Add New Project
2. Import your `mentorai` GitHub repository
3. Click Deploy (ignore any settings for now)

### Step 3 — Add API Keys (Secret Environment Variables)
1. In Vercel → Your Project → Settings → Environment Variables
2. Add these one by one:
   - Name: `ANTHROPIC_API_KEY` → Value: your Claude key
   - Name: `OPENAI_API_KEY` → Value: your OpenAI key  
   - Name: `GEMINI_API_KEY` → Value: your Gemini key
3. Click Save → Go to Deployments → Redeploy

### Step 4 — Your app is live!
You'll get a URL like: `https://mentorai.vercel.app`
Share this with anyone. Keys are never visible to users.

## How to Update the App
1. Edit `index.html` on GitHub (click the file → pencil icon → edit → commit)
2. Vercel auto-deploys in 60 seconds
3. Every user on your URL gets the update instantly
4. No resharing needed. Ever.

## Admin Access
- Open your app
- Type the word `admin` anywhere (outside input boxes)
- Password: `mentorai2024` (change this in index.html)
