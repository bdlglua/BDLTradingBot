# Site GitHub Pages et serveur sans abonnement

L'interface se trouve sur `https://bdlglua.github.io/BDLTradingBot/`. GitHub Pages héberge uniquement les fichiers publics. Le compte Bitpanda et la clé API sont gérés par un backend séparé.

## Option gratuite : Cloudflare Workers et D1

Suivez [CLOUDFLARE.md](CLOUDFLARE.md). Un Worker JavaScript traite les requêtes HTTPS et la base D1 conserve le journal des ordres entre exécutions. Le forfait Workers **Free** inclut des quotas, sans abonnement payant requis pour ce montage. N'activez pas Workers Paid pour suivre ce guide.

Le backend gratuit fournit les lectures Bitpanda, les devis et les confirmations manuelles. Il ne fournit pas le laboratoire Python : ce point est indiqué dans l'interface. Il contient aussi un bot automatique, arrêté par défaut ; voir le README.

L'ancien Blueprint Render payant a été retiré. Aucune ressource d'hébergement n'est créée par les fichiers du dépôt. Les frais éventuels de transactions Bitpanda restent distincts de l'hébergement.

## Publication de l'interface

Le workflow `.github/workflows/pages.yml` reste manuel : il vérifie les deux backends hors ligne, construit les seuls fichiers publics puis déploie Pages. Dans GitHub, Settings → Pages doit utiliser GitHub Actions. Pour mettre à jour le site, lancez Actions → Publier l'interface GitHub Pages → Run workflow.

Facultatif : définissez la variable de dépôt **non secrète** `DASHBOARD_API_URL` avec l'origine HTTPS du Worker, sans chemin ni identifiants, avant de republier l'interface. Sans cette variable, saisissez son adresse dans le panneau de connexion du site.

Le build de `tools/build_pages.py` exclut le code serveur, les secrets et les journaux. Ne mettez jamais la clé Bitpanda ni le code d'accès du tableau de bord dans les variables Pages, `config.js`, un commit ou un workflow.

## Serveur Python sur un hébergement déjà disponible

Le backend Python et le Dockerfile restent utilisables si vous possédez déjà un serveur avec HTTPS et un disque persistant. Ce montage n'inclut aucune promesse d'hébergement gratuit ; il n'est pas nécessaire au parcours Cloudflare.

Configurez `DASHBOARD_PUBLIC_ORIGIN=https://bdlglua.github.io`, `DASHBOARD_API_HOST` avec le nom DNS exact du backend, un secret `DASHBOARD_ACCESS_TOKEN` aléatoire de 32 à 256 caractères ASCII sans espaces, les paramètres Bitpanda du README et `BITPANDA_STATE_DIR=/data` avec un volume persistant. Une clé configurée dans Codex n'est pas transférée automatiquement chez un autre hébergeur.

Lancez une seule instance du conteneur derrière un proxy HTTPS qui conserve le Host attendu. Le conteneur prépare le journal puis lance Python avec l'UID 10001. Préservez ce journal ; le supprimer détruit la protection contre les doubles envois. `/health` vérifie uniquement la disponibilité HTTP, pas l'accès Bitpanda.

## Vérifications hors ligne

```bash
python3 -m unittest discover -s tests -v
node cloudflare/tests/worker.test.mjs
node --check static/app.js
python3 tools/build_pages.py
```

Les 27 tests Workers utilisent une API Bitpanda fictive et un véritable moteur SQLite pour vérifier le SQL de D1. Ils ne prouvent pas qu'un Worker distant a été déployé ou qu'un compte réel est accessible. Node 24 est requis pour ces tests, pas pour utiliser le site.

Tests facultatifs avec Playwright et Chromium : `python3 tests/browser_smoke.py` et `python3 tests/browser_pages.py`. Pour tester le backend Python dans un moteur Docker Linux local, construisez `docker build -t bdltradingbot:pages .`, puis exécutez `python3 tests/docker_smoke.py`. Ces tests ne passent aucun ordre réel.
