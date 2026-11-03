# Ouvrir le site depuis GitHub Pages

GitHub Pages héberge l'interface HTML/CSS/JavaScript. Il n'exécute pas Python et ne doit jamais recevoir la clé Bitpanda. Les opérations sur le compte passent par un backend HTTPS séparé, protégé par un code d'accès personnel.

Les fichiers sont préparés dans le dépôt ; cela ne signifie pas qu'ils sont déjà poussés sur GitHub ou publiés. Le workflow Pages est **manuel** et le backend n'a pas été créé.

## 1. Mettre le code sur GitHub

Ajoutez les fichiers du projet au dépôt `bdlglua/BDLTradingBot` sur la branche que vous souhaitez publier. Les dossiers `.state`, `_site`, les fichiers `.env` et les secrets ne doivent pas être ajoutés. Le build Pages utilise une liste fermée de fichiers publics : il ne copie ni le serveur Python, ni le journal, ni les variables du serveur.

## 2. Héberger le backend

Un compte d'hébergement est nécessaire. Une configuration Render est fournie dans `render.yaml` et une image portable dans `Dockerfile`. Vous pouvez utiliser un autre hébergeur capable d'exécuter ce conteneur derrière HTTPS, avec un disque persistant et **une seule instance**.

Pour Render, connectez le dépôt depuis votre compte et créez un Blueprint à partir de `render.yaml`. L'exemple utilise un service Starter et un disque persistant de 1 Go, susceptibles d'être payants : vérifiez le coût avant de créer le service. Aucune ressource ni souscription n'est créée par la préparation du dépôt.

Renseignez les paramètres du **backend chez l'hébergeur** :

| Paramètre | Valeur / rôle |
| --- | --- |
| `DASHBOARD_PUBLIC_ORIGIN` | `https://bdlglua.github.io` pour ce dépôt. Il s'agit de l'origine, sans `/BDLTradingBot/`. Utilisez l'origine réelle si vous avez un domaine personnalisé. |
| `DASHBOARD_API_HOST` | Nom DNS du backend sans protocole ni chemin. Sur Render, `RENDER_EXTERNAL_HOSTNAME` fourni automatiquement remplit ce rôle. |
| `DASHBOARD_ACCESS_TOKEN` | Code d'accès privé au tableau de bord, aléatoire, de 32 à 256 caractères ASCII sans espaces. Le Blueprint Render en génère un. Gardez-le dans un gestionnaire de mots de passe : il peut donner accès aux ordres. |
| `BITPANDA_API_KEY` | Clé Bitpanda, conservée comme secret du backend. Une clé configurée dans l'environnement cloud Codex n'est pas automatiquement transférée à un autre hébergeur. |
| `BITPANDA_ENABLE_TRADING` | `0` pour commencer par vérifier le compte en lecture seule. |
| `BITPANDA_TRADING_CURRENCY_ID` | UUID de la devise autorisée, à renseigner avant l'activation des ordres. |
| `BITPANDA_MAX_ORDER_AMOUNT` | Plafond par ordre dans cette devise, choisi par vous. |
| `BITPANDA_STATE_DIR` | `/data` dans le conteneur, répertoire du disque persistant. |

Le code d'accès au tableau de bord est distinct de la clé API Bitpanda. La clé Bitpanda n'est jamais saisie dans le site GitHub et ne doit jamais figurer dans une variable GitHub Pages, un workflow, un commit ou `config.js`.

Le conteneur prépare les permissions du journal puis lance l'application avec l'UID 10001. Conservez le disque entre déploiements. Ne lancez pas plusieurs instances avec des journaux indépendants. Ne configurez pas de déploiement éphémère qui perdrait ce journal à chaque redémarrage. L'URL `/health` vérifie uniquement que le serveur répond ; elle ne valide ni Bitpanda ni le journal financier.

Le backend accepte les appels depuis l'origine Pages déclarée, avec un jeton Bearer pour les routes privées et un jeton anti-CSRF supplémentaire pour les ordres. L'écoute publique est refusée si les paramètres d'accès sont incomplets. L'hébergeur doit terminer HTTPS et transmettre le bon Host ; le serveur Python ne fournit pas lui-même de certificat TLS.

## 3. Publier l'interface Pages

Dans le dépôt GitHub :

1. Ouvrez **Settings → Pages** et choisissez **GitHub Actions** comme source.
2. Facultatif : dans **Settings → Secrets and variables → Actions → Variables**, ajoutez `DASHBOARD_API_URL` avec uniquement l'adresse publique HTTPS du backend, par exemple `https://votre-service.onrender.com`. Aucun secret dans cette variable. Sans cette variable, vous pourrez saisir l'adresse dans le site.
3. Ouvrez **Actions → Publier l’interface GitHub Pages → Run workflow** et choisissez la branche contenant le code.
4. Attendez la réussite du déploiement. GitHub affiche l'adresse effective du site dans le résultat du job `deploy` et dans Settings → Pages.

L'adresse attendue, avec le dépôt et les paramètres standard, est `https://bdlglua.github.io/BDLTradingBot/`. Il ne s'agit pas d'une adresse de site déjà publié par cette préparation.

## 4. Utiliser le site

Ouvrez l'adresse publiée par GitHub, renseignez l'adresse HTTPS du backend et le **code d'accès au tableau de bord**, puis cliquez sur « Connecter le serveur ». Le code reste seulement en mémoire dans cet onglet : il n'est ni enregistré dans le stockage du navigateur ni inscrit dans l'adresse. Un rechargement demande une nouvelle connexion.

Cliquez ensuite sur « Actualiser le compte » pour vérifier l'accès réel à Bitpanda. Après avoir configuré votre devise et votre plafond, activez `BITPANDA_ENABLE_TRADING=1` chez l'hébergeur et redémarrez le backend si vous souhaitez passer des ordres. Chaque devis doit être confirmé séparément. Les limites et l'absence de robot autonome restent celles décrites dans README.md.

Sans backend, le site affiche une invitation à connecter le serveur ; aucune donnée de compte et aucun ordre ne sont inventés. L'exemple CSV reste téléchargeable, mais les calculs de backtest nécessitent également le backend Python.

## Vérifications avant publication

```bash
python3 -m unittest discover -s tests -v
node --check static/app.js
python3 tools/build_pages.py
```

Tests navigateur facultatifs avec Playwright et Chromium : `python3 tests/browser_smoke.py` pour le mode local, `python3 tests/browser_pages.py` pour le site sous `/BDLTradingBot/` et une API HTTPS fictive. Aucun de ces tests ne passe d'ordre financier réel. La construction et les tests locaux ne prouvent pas qu'un déploiement distant a été effectué ou qu'un compte Bitpanda réel est accessible.

Test du conteneur facultatif sur un moteur Docker Linux local : construisez `docker build -t bdltradingbot:pages .`, puis exécutez `python3 tests/docker_smoke.py`. Il crée un conteneur et un volume temporaires, utilise uniquement un code d'accès de test, vérifie l'absence de clé Bitpanda, l'authentification et le redémarrage, puis supprime ses propres ressources de test.
