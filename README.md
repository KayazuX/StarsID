# Stars ID Backend

Proxy API Node.js pour Stars ID, intégrant TMDB et Gemini.

## Endpoints

- `GET /health` - Santé de l'API
- `GET /api/search/multi?query=...&type=actor|movie|tv&page=N` - Recherche unifiée
- `GET /api/actors/search?query=...&page=N` - Recherche d'acteurs
- `POST /api/actors/recognize` - Reconnaissance d'acteur depuis image (Gemini)
- `GET /api/actors/:id` - Détail d'un acteur
- `GET /api/actors/:id/works` - Filmographie d'un acteur
- `GET /api/works/:mediaType/:id/details` - Détail d'une œuvre
- `GET /api/works/:mediaType/:id/similar` - Œuvres similaires

## Variables d'environnement requises

```
TMDB_API_KEY=<your-tmdb-key>
GEMINI_API_KEY=<your-gemini-key>
GEMINI_MODEL=models/gemini-2.5-flash
PORT=8080
```

## Déploiement sur back4app

1. Connecte-toi à https://www.back4app.com
2. Crée un projet ou utilise le projet existant "StarsID"
3. Va dans Settings → App Details
4. Copie les credentials Git
5. Depuis ce répertoire:
   ```bash
   git remote add back4app <url-du-repo-back4app>
   git push back4app main
   ```
6. Configure les env vars dans back4app Dashboard:
   - TMDB_API_KEY
   - GEMINI_API_KEY
   - GEMINI_MODEL
7. L'app redémarrera automatiquement

## Développement local

```bash
npm install
npm run dev
```

L'API sera disponible sur `http://localhost:8080`
