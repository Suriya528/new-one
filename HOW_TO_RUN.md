# How to Run — Profit What-If Simulator

## Prerequisites
- **Node.js 20+** (verified on Node v24.12.0)

## 1. Install Dependencies
```bash
npm install
```
*(Installs both `backend/` and `frontend/` packages automatically via root `postinstall`.)*

## 2. Initialize & Seed Database (Idempotent)
```bash
npm run seed
```
This runs `backend/migrations/001_initial_schema.sql` from scratch, imports `repo-data/Profit What-If Simulator/data/company-data.json` into `backend/simulator.db`, and prints table row counts and a deterministic SHA-256 checksum.

## 3. Start Backend API + Frontend Dashboard
```bash
npm run dev
```
- Dashboard: `http://localhost:5173`
- API Health: `http://localhost:4000/api/health`

## 4. Run Automated Tests, Showcase Query & Scenario Verifier
```bash
npm test
npm run query
npm run verify
npm run build
```
