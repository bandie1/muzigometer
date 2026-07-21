// lib/db.js — single shared Postgres connection pool (Supabase).
// Every API route does:  const pool = require('../lib/db');  then pool.query(...)
//
// On Vercel, set these as Environment Variables in your project settings
// (Project -> Settings -> Environment Variables). Locally, create a
// `.env.local` file (never commit it) with the same names, and run
// `vercel dev` which loads it automatically.

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'aws-0-eu-west-1.pooler.supabase.com',
  port: Number(process.env.DB_PORT) || 6543, // transaction pooler — best fit for short-lived serverless connections
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres.pvnqkfjznpwqfatjgqto',
  password: process.env.DB_PASS || 'REPLACE_WITH_RAW_PASSWORD',
  ssl: { rejectUnauthorized: false },
  max: 1, // serverless functions should hold at most one connection each; the pooler handles concurrency
});

module.exports = pool;
