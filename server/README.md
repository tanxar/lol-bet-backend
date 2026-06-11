# Lol Bet Tracker — Node Server

API server χωρίς εξωτερικές εξαρτήσεις — χρειάζεται μόνο Node.js 18+.

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
| GET | `/api/matches` | Λίστα αγώνων |
| GET | `/api/matches/:id` | Λεπτομέρειες |
| GET | `/api/matches/:id?format=raw` | Αρχικό JSON |

Header (αν έχεις API_KEY):

```
X-Api-Key: your-secret-key
```

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

`data/store.json` (φάκελος `DATA_DIR`)
