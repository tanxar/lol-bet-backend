# Lol Bet Tracker — Node Server

API server για sync και ιστορικό αγώνων — Node.js 18+ και PostgreSQL (Render) ή JSON τοπικά.

## Γρήγορη εκκίνηση

```bash
cd server
cp .env.example .env
# Επεξεργάσου το .env — βάλε API_KEY
node src/index.js
```

Ή: `npm start`

Health check: `http://localhost:5080/health`

## Ρύθμιση εφαρμογής (Windows)

Στο `src/LolBetTracker/appsettings.json`:

```json
"Server": {
  "Enabled": true,
  "BaseUrl": "http://YOUR_SERVER_IP:5080",
  "RegisterMatchPath": "/api/matches",
  "ApiKey": "το-ίδιο-κλειδί-με-το-.env",
  "TimeoutSeconds": 15,
  "RetryOnStartup": true
}
```

## API

| Method | Path | Περιγραφή |
|--------|------|-----------|
| GET | `/health` | Έλεγχος ότι τρέχει |
| POST | `/api/matches` | Καταχώρηση αγώνα |
| GET | `/api/matches?completed=true` | Λίστα ολοκληρωμένων αγώνων (για History tab) |
| GET | `/api/matches` | Λίστα αγώνων |
| GET | `/api/matches/:id` | Λεπτομέρειες |
| GET | `/api/matches/:id?format=raw` | Αρχικό JSON |

Header (αν έχεις API_KEY):

```
X-Api-Key: your-secret-key
```

## Deploy στο Render

### Αν το repo είναι `lol-bet-backend/server/...` (υποφάκελος server)

Στο Render → **Settings → Build & Deploy**:

| Ρύθμιση | Τιμή |
|---------|------|
| **Root Directory** | `server` |
| **Build Command** | *(κενό)* |
| **Start Command** | `node src/index.js` |

Ή βάλε `render.yaml` στο **root** του GitHub repo (όχι μέσα στον `server/`).

### Αν τα αρχεία είναι απευθείας στο root του repo

| Ρύθμιση | Τιμή |
|---------|------|
| **Root Directory** | *(κενό)* |
| **Start Command** | `node src/index.js` |

---

1. Push τον κώδικα στο GitHub.
2. [render.com](https://render.com) → **New → Blueprint** (αν έχεις `render.yaml`) ή **New → Web Service**.
3. Σύνδεσε το GitHub repo.
4. Ρυθμίσεις (αν δεν χρησιμοποιείς Blueprint):
   - **Build Command:** *(κενό)*
   - **Start Command:** `node src/index.js`
5. **New → PostgreSQL** στο ίδιο project (ή υπάρχον DB) — Render δημιουργεί αυτόματα `DATABASE_URL`.
6. Στο **Web Service → Environment → Add:**
   - `API_KEY` = μυστικό κλειδί (π.χ. `my-secret-key-123`)
   - `HOST` = `0.0.0.0`
   - `DATABASE_URL` = *(από το linked PostgreSQL — συνήθως γίνεται αυτόματα)*
7. **Build Command:** `npm install`
8. Deploy → URL π.χ. `https://lol-bet-tracker-server.onrender.com`

Έλεγχος: `https://YOUR-APP.onrender.com/health`

Στην εφαρμογή Windows (`appsettings.json`):

```json
"Server": {
  "Enabled": true,
  "BaseUrl": "https://YOUR-APP.onrender.com",
  "RegisterMatchPath": "/api/matches",
  "ApiKey": "το-ίδιο-API_KEY",
  "TimeoutSeconds": 30,
  "RetryOnStartup": true
}
```

**Σημαντικό:** Μην ανεβάσεις `.env` στο GitHub — μόνο `.env.example`.

## Deploy σε VPS

```bash
cd server
cp .env.example .env && nano .env
node src/index.js
```

Με **pm2**:

```bash
npm install -g pm2
pm2 start src/index.js --name lol-bet-server
pm2 save && pm2 startup
```

Firewall: `sudo ufw allow 5080/tcp`

## Δεδομένα

**Production (Render):** PostgreSQL — πίνακας `matches` δημιουργείται αυτόματα στην εκκίνηση.

**Τοπικά (χωρίς DATABASE_URL):** `data/store.json` (φάκελος `DATA_DIR`).

Έλεγχος DB: `GET /health` → `{ "database": { "ok": true, "mode": "postgres" } }`
