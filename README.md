# BDLTradingBot

Interface de trading **Bitpanda Public API de production**, avec portefeuille, recherche d'actifs, demande de devis et confirmation d'ordres réels. Le backend peut être hébergé sans abonnement avec **Cloudflare Workers Free et D1** ; voir [le guide gratuit](CLOUDFLARE.md). Le backend Python 3.12 reste disponible pour le développement et le laboratoire CSV, sans dépendance externe.

Le connecteur suit la [documentation hébergée de la Bitpanda Public API](https://docs.public.bitpanda.com/) : base `https://api.public.bitpanda.com/v1`, champs en snake_case, réponses enveloppées dans `data`. Le [schéma OpenAPI du dépôt GitHub de Bitpanda](https://github.com/bitpanda-labs/bitpanda-public-api/blob/master/docs/openapi.yaml) décrit des chemins sans `/v1` (`/rfq/quotes`, `/portfolio/holdings`…) qui répondent HTTP 404 en production ; il n'est plus utilisé. Comme la documentation mélange snake_case et camelCase, les deux sont acceptés en lecture ; un devis dont le format n'est pas reconnu est refusé sans ordre. L'accès à votre compte et les produits disponibles doivent être vérifiés avec votre clé. Les tests automatisés utilisent des réponses fictives et ne prouvent pas qu'un ordre réel fonctionne sur votre compte.

**Pour le site accessible depuis GitHub**, suivez [le guide de déploiement](DEPLOYMENT.md). GitHub Pages héberge l'interface ; le backend HTTPS conserve la clé et exécute les appels Bitpanda. L'offre gratuite comporte des quotas ; les frais Bitpanda restent distincts. Le laboratoire Python n'est pas fourni par le Worker gratuit et est désactivé dans l'interface quand ce backend est connecté.

## Démarrage

### Interface web

Lancez `python3 web.py` depuis le dossier du dépôt, puis ouvrez le port local 8000 dans votre navigateur. L'interface comporte cinq écrans, accessibles par la barre latérale (ou la barre du bas sur mobile) :

| Écran | Contenu |
| --- | --- |
| **Portefeuille** | Valeur totale, nombre de positions, état du trading et plafond ; positions avec symbole, quantité, valeur et répartition. |
| **Trader** | Achat/vente, recherche d'actif, prix indicatif (`/v1/tickers/{id}`), montant en devise, devis avec compte à rebours puis confirmation explicite. |
| **Bot** | Mode, dernier prix, signal des moyennes, position et transactions du bot automatique ; bouton de pause. |
| **Historique** | Journal des ordres de l'application avec rapprochement, et opérations Bitpanda paginées. |
| **Laboratoire** | Backtest CSV (glisser-déposer), graphique interactif avec achats/ventes, export JSON. |
| **Connexion** | Adresse du serveur, code d'accès et liste de contrôle de la configuration. |

Le thème clair ou sombre suit celui de votre système.

Par défaut le serveur reste local : écoute sur `127.0.0.1` ou `localhost`, contrôle de Host/Origin et jeton anti-CSRF pour les ordres. Le mode hébergé doit être configuré selon DEPLOYMENT.md, avec HTTPS et code d'accès privé ; il reste destiné à un seul propriétaire de compte. Les fichiers CSV sont traités temporairement puis supprimés (2 Mo et 20 000 observations maximum).

### Connecter Bitpanda

Dans les paramètres sécurisés de l'environnement, ajoutez la clé créée dans [Bitpanda, onglet Bitpanda des clés API](https://app.bitpanda.com/my-account/apikey). Ne collez jamais la clé dans le code, le navigateur, le chat ou une commande conservée dans l'historique. Utilisez uniquement les permissions nécessaires ; aucun transfert ni retrait n'est implémenté. Le portefeuille demande la permission de lecture des soldes (« Balances »), l'historique celle des opérations (« Transaction ») et les ordres celle de trading. Une réponse `401 Credentials / Access token wrong` sur le portefeuille alors que les actifs s'affichent indique en général une clé sans la bonne permission ou une ancienne clé : recréez-en une sur la page des clés API.

| Paramètre | Utilisation |
| --- | --- |
| `BITPANDA_API_KEY` | Secret serveur, transmis dans `x-api-key` uniquement vers `api.public.bitpanda.com`. |
| `BITPANDA_ENABLE_TRADING` | `0` pour consulter le compte sans permettre d'ordre ; `1` pour autoriser devis et confirmations. |
| `BITPANDA_TRADING_CURRENCY_ID` | UUID exact de la devise autorisée pour les ordres. Actualisez le compte pour consulter la liste des devises et leur UUID. |
| `BITPANDA_MAX_ORDER_AMOUNT` | Plafond strictement positif par ordre, dans cette devise. Aucun montant n'est choisi automatiquement. |

Autorisez la destination HTTPS `api.public.bitpanda.com` dans le réseau de l'environnement. Le connecteur conserve le proxy et la vérification TLS ; il refuse les redirections pour ne pas divulguer la clé. L'enregistrement d'un brouillon de configuration n'applique pas à lui seul les variables ou le réseau à la machine : enregistrez les paramètres puis redémarrez le serveur avec les nouvelles variables injectées.

Commencez avec le trading désactivé : le compte est lu automatiquement à la connexion (bouton « Actualiser » ensuite) ; vérifiez que votre portefeuille réel s'affiche. Configurez votre devise et votre plafond puis activez le trading si vous souhaitez utiliser les ordres. Dans « Trader », choisissez achat ou vente, recherchez un symbole, sélectionnez l'actif exact et la devise, puis saisissez un montant **en devise** (virgule ou point décimal acceptés). L'API accepte ce montant (`notional`) pour les deux sens ; les quantités sont fournies par le devis.

« Obtenir un devis » appelle `POST /v1/quotes` sans exécution. Vérifiez l'actif, la devise, le sens, le montant, le prix, la quantité et l'expiration. Cochez la confirmation puis cliquez sur « Exécuter l'ordre réel » : ce bouton appelle `POST /v1/quotes/{id}/accept` et peut engager votre argent. Le prix affiché est le prix prime incluse (`price_with_premium`) fourni par le devis. Les devis expirés sont refusés. Le plafond porte sur le montant `notional` du devis ; ne supposez pas qu'il couvre des coûts supplémentaires non décrits par la réponse API.

Les types d'actifs disponibles dépendent du compte et de l'API : l'application ne promet pas l'accès à tous les marchés. Les schémas publics des devises et opérations sont peu détaillés ; une réponse non reconnue est signalée, sans inventer de données. Les opérations affichées sont une première page (50 au maximum) ; l'historique complet reste accessible sur Bitpanda.

### Journal et résultats inconnus

Le journal SQLite privé `.state/bitpanda.sqlite3` (ou le fichier `bitpanda.sqlite3` sous `BITPANDA_STATE_DIR` si défini) conserve les devis et états, jamais la clé API. Il est ignoré par Git mais doit être préservé entre redémarrages : le supprimer détruit la protection contre le renvoi d'un même devis. Il contient des informations financières ; gardez-le privé. Un redémarrage ne reprend pas automatiquement un devis à confirmer : laissez-le expirer avant d'en demander un autre.

Une acceptation est enregistrée comme envoyée **avant** l'appel distant. Elle n'est jamais renvoyée automatiquement, même après timeout ou redémarrage. Un résultat ambigu devient `unknown` (ou reste `submitted` si le processus s'interrompt) et bloque les nouvelles demandes. Consultez les opérations réelles de Bitpanda, puis cliquez sur « Rapprocher » dans l'Historique et indiquez ce que vous constatez (exécuté ou non exécuté). Le rapprochement n'envoie **aucune** requête à Bitpanda : il met seulement le journal à jour et lève le blocage. Il n'est accepté que 30 secondes après l'expiration du devis, quand celui-ci ne peut plus être exécuté. Ne supprimez jamais le journal pour contourner ce blocage.

Les paramètres saisis dans le laboratoire n'agissent **pas** sur les ordres Bitpanda. Le trading automatique est réglé séparément, par les variables du Worker décrites ci-dessous.

### Bot automatique (Worker Cloudflare)

Le Worker exécute un cycle toutes les 15 minutes (tâche planifiée `*/15 * * * *` de `wrangler.jsonc`). Il est **arrêté par défaut** : rien ne se passe tant que `BOT_MODE` vaut `off` ou n'est pas défini. Le serveur Python ne l'exécute pas.

À chaque cycle, le bot relève le prix de l'actif (`GET /v1/tickers/{id}`), le conserve dans D1 (500 derniers relevés) et applique la stratégie du laboratoire : achat quand la moyenne rapide croise au-dessus de la moyenne lente, vente au croisement inverse ou quand le prix passe sous le stop de sortie. Il ne détient qu'une position à la fois, sans levier ni vente à découvert. Un croisement n'est prise en compte qu'une fois les relevés suffisants collectés (6 h avec les réglages par défaut).

| Variable (type Text) | Rôle | Défaut |
| --- | --- | --- |
| `BOT_MODE` | `off`, `paper` (simulation : prix réels, achats et ventes fictifs, aucun devis) ou `live` (ordres réels) | `off` |
| `BOT_ASSET_SYMBOL` / `BOT_ASSET_ID` | Actif suivi ; l'UUID évite toute ambiguïté de symbole | `BTC` |
| `BOT_ORDER_AMOUNT` | Montant de chaque achat, dans la devise de trading ; doit rester ≤ `BITPANDA_MAX_ORDER_AMOUNT` | `10` |
| `BOT_FAST_PERIOD` / `BOT_SLOW_PERIOD` | Périodes des moyennes, en nombre de relevés de 15 min | `6` / `24` |
| `BOT_STOP_LOSS_PERCENT` | Stop de sortie sous le prix d'entrée, vérifié à chaque cycle | `5` |
| `BOT_MAX_BUYS_PER_DAY` | Nombre maximal d'achats par jour (UTC) ; les ventes ne sont jamais bloquées | `3` |

En mode `live`, le trading réel doit être activé (`BITPANDA_ENABLE_TRADING`, devise et plafond). Chaque ordre passe par le même verrou et le même journal D1 que les ordres manuels, avec la mention `origin: bot`. Les achats utilisent le montant fixe ; la sortie revend **exactement la quantité achetée** par le bot (seule exception au plafond, puisqu'elle réduit l'exposition). Le bot ne gère que sa propre position : il ne vend jamais les actifs que vous déteniez déjà.

Garde-fous : si une acceptation échoue ou reste incertaine, le bot se met en pause et l'ordre est à rapprocher dans l'Historique ; il ne renvoie jamais un ordre. Si l'ordre s'avère exécuté, le bot ne le sait pas : vérifiez votre position avant de le relancer. Le bouton « Mettre en pause » de l'onglet Bot bloque tout nouvel ordre ; passer `BOT_MODE` à `off` l'arrête complètement. Ne recopiez pas `BOT_MODE` dans `wrangler.jsonc` : la variable du tableau de bord reste votre interrupteur.

Commencez en `paper` pendant plusieurs jours. Le stop est vérifié toutes les 15 minutes au prix du ticker : il ne garantit pas une perte maximale. Les frais, la prime du devis et la fiscalité réduisent les résultats ; les performances simulées ou passées ne garantissent rien.

### Ligne de commande et tests

```bash
cd /workspace/BDLTradingBot
python3 -m unittest discover -s tests -v
python3 bot.py examples/prices.csv --fast 2 --slow 3
mkdir -p reports
python3 bot.py examples/prices.csv --fast 2 --slow 3 --output reports/backtest.json
```

Les tests du connecteur et du serveur sont hors ligne et n'exécutent aucun ordre financier. Tests navigateur facultatifs : `python3 tests/browser_smoke.py` et `python3 tests/browser_pages.py` (Playwright pour Python et Chromium requis ; `CHROMIUM_PATH` peut indiquer le binaire). Ils interceptent toutes les routes Bitpanda et couvrent portefeuille, devis, confirmation, rapprochement et affichage mobile avec des réponses fictives. L'application n'a pas besoin de ces outils pour fonctionner.

Le jeu fourni est synthétique et sert uniquement à vérifier le fonctionnement. Pour vos données, utilisez un CSV avec les colonnes `timestamp,close`, des dates ISO 8601 avec fuseau horaire, strictement croissantes, et des prix positifs. Les exports Excel français (séparateur `;`, virgule décimale, BOM UTF-8) sont acceptés. Conservez une fréquence régulière et une seule paire par fichier.

## Stratégie et risque

Un croisement haussier de la moyenne rapide au-dessus de la moyenne lente déclenche un achat. Un croisement baissier déclenche la vente. Chaque signal est exécuté au prix de clôture de la bougie suivante, frais inclus. Le bot conserve au maximum une position longue, sans levier ni vente à découvert.

Options par défaut : `--capital 10000 --fast 5 --slow 20 --allocation 0.2 --stop-loss 0.05 --fee 0.001`. L'allocation représente la fraction de trésorerie engagée, frais d'achat compris. Le stop est détecté à la clôture puis exécuté à la clôture suivante : il ne garantit donc pas une perte maximale de 5 %. Les périodes sont exprimées en nombre de bougies.

Le rapport JSON contient les transactions, frais, courbe de capital, rendement et drawdown maximal. Une position encore ouverte est valorisée au dernier prix, sans liquidation automatique ni frais de sortie hypothétiques. Un dernier signal sans bougie suivante n'est pas exécuté.

Ce modèle ignore le slippage, la liquidité, les montants minimums d'ordre et la fiscalité. Les résultats historiques ou synthétiques ne prédisent pas les rendements futurs. Une connexion de marché et une boucle de simulation en temps réel restent à ajouter pour un fonctionnement continu.
