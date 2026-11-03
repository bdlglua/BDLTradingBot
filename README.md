# BDLTradingBot

Interface de trading **Bitpanda Public API de production**, avec portefeuille, recherche d'actifs, demande de devis et confirmation d'ordres réels. Le backend peut être hébergé sans abonnement avec **Cloudflare Workers Free et D1** ; voir [le guide gratuit](CLOUDFLARE.md). Le backend Python 3.12 reste disponible pour le développement et le laboratoire CSV, sans dépendance externe.

Le connecteur est implémenté à partir de la [documentation publique Bitpanda](https://github.com/bitpanda-labs/bitpanda-public-api), notamment le [schéma OpenAPI](https://github.com/bitpanda-labs/bitpanda-public-api/blob/master/docs/openapi.yaml). L'accès à votre compte et les produits disponibles doivent être vérifiés avec votre clé. Les tests automatisés utilisent des réponses fictives et ne prouvent pas qu'un ordre réel fonctionne sur votre compte.

**Pour le site accessible depuis GitHub**, suivez [le guide de déploiement](DEPLOYMENT.md). GitHub Pages héberge l'interface ; le backend HTTPS conserve la clé et exécute les appels Bitpanda. L'offre gratuite comporte des quotas ; les frais Bitpanda restent distincts. Le laboratoire Python n'est pas fourni par le Worker gratuit et est désactivé dans l'interface quand ce backend est connecté.

## Démarrage

### Interface web

Lancez `python3 web.py` depuis le dossier du dépôt, puis ouvrez le port local 8000 dans votre navigateur. L'écran d'accueil présente votre espace Bitpanda. Le bouton « Laboratoire » ouvre le backtest CSV séparé.

Par défaut le serveur reste local : écoute sur `127.0.0.1` ou `localhost`, contrôle de Host/Origin et jeton anti-CSRF pour les ordres. Le mode hébergé doit être configuré selon DEPLOYMENT.md, avec HTTPS et code d'accès privé ; il reste destiné à un seul propriétaire de compte. Les fichiers CSV sont traités temporairement puis supprimés (2 Mo et 20 000 observations maximum).

### Connecter Bitpanda

Dans les paramètres sécurisés de l'environnement, ajoutez la clé créée dans [Bitpanda, onglet Bitpanda des clés API](https://app.bitpanda.com/my-account/apikey). Ne collez jamais la clé dans le code, le navigateur, le chat ou une commande conservée dans l'historique. Utilisez uniquement les permissions nécessaires ; aucun transfert ni retrait n'est implémenté.

| Paramètre | Utilisation |
| --- | --- |
| `BITPANDA_API_KEY` | Secret serveur, transmis dans `x-api-key` uniquement vers `api.public.bitpanda.com`. |
| `BITPANDA_ENABLE_TRADING` | `0` pour consulter le compte sans permettre d'ordre ; `1` pour autoriser devis et confirmations. |
| `BITPANDA_TRADING_CURRENCY_ID` | UUID exact de la devise autorisée pour les ordres. Actualisez le compte pour consulter la liste des devises et leur UUID. |
| `BITPANDA_MAX_ORDER_AMOUNT` | Plafond strictement positif par ordre, dans cette devise. Aucun montant n'est choisi automatiquement. |

Autorisez la destination HTTPS `api.public.bitpanda.com` dans le réseau de l'environnement. Le connecteur conserve le proxy et la vérification TLS ; il refuse les redirections pour ne pas divulguer la clé. L'enregistrement d'un brouillon de configuration n'applique pas à lui seul les variables ou le réseau à la machine : enregistrez les paramètres puis redémarrez le serveur avec les nouvelles variables injectées.

Commencez avec le trading désactivé, cliquez sur « Actualiser le compte » et vérifiez que votre portefeuille réel s'affiche. Configurez votre devise et votre plafond puis activez le trading si vous souhaitez utiliser les ordres. Recherchez un symbole, sélectionnez l'actif exact et la devise, choisissez achat ou vente, puis saisissez un montant **en devise**. L'API accepte ce montant (`notional`) pour les deux sens ; les quantités sont fournies par le devis.

« Obtenir un devis » appelle `POST /rfq/quotes` sans exécution. Vérifiez l'actif, la devise, le sens, le montant, le prix, la quantité et l'expiration. Cochez la confirmation puis cliquez sur « Exécuter l'ordre réel » : ce bouton appelle `POST /rfq/quotes/{id}/accept` et peut engager votre argent. Les devis expirés sont refusés. Le plafond porte sur le montant `notional` du devis ; ne supposez pas qu'il couvre des coûts supplémentaires non décrits par la réponse API.

Les types d'actifs disponibles dépendent du compte et de l'API : l'application ne promet pas l'accès à tous les marchés. Les schémas publics des devises et opérations sont peu détaillés ; une réponse non reconnue est signalée, sans inventer de données. Les opérations affichées sont une première page (50 au maximum) ; l'historique complet reste accessible sur Bitpanda.

### Journal et résultats inconnus

Le journal SQLite privé `.state/bitpanda.sqlite3` (ou le fichier `bitpanda.sqlite3` sous `BITPANDA_STATE_DIR` si défini) conserve les devis et états, jamais la clé API. Il est ignoré par Git mais doit être préservé entre redémarrages : le supprimer détruit la protection contre le renvoi d'un même devis. Il contient des informations financières ; gardez-le privé. Un redémarrage ne reprend pas automatiquement un devis à confirmer : laissez-le expirer avant d'en demander un autre.

Une acceptation est enregistrée comme envoyée **avant** l'appel distant. Elle n'est jamais renvoyée automatiquement, même après timeout ou redémarrage. Un résultat ambigu devient `unknown` (ou reste `submitted` si le processus s'interrompt) et bloque les nouvelles demandes. Consultez les opérations réelles de Bitpanda et faites rapprocher ce devis avant toute reprise. La levée de ce blocage après rapprochement n'est pas encore proposée dans l'interface ; ne supprimez pas le journal pour le contourner.

Il n'y a pas encore de trading autonome, de stop réel, de boucle de stratégie sur données de marché ni de surveillance continue. Les paramètres de moyennes mobiles, allocation et stop du laboratoire n'agissent **pas** sur les ordres Bitpanda.

### Ligne de commande et tests

```bash
cd /workspace/BDLTradingBot
python3 -m unittest discover -s tests -v
python3 bot.py examples/prices.csv --fast 2 --slow 3
mkdir -p reports
python3 bot.py examples/prices.csv --fast 2 --slow 3 --output reports/backtest.json
```

Les tests du connecteur et du serveur sont hors ligne et n'exécutent aucun ordre financier. Test navigateur facultatif : `python3 tests/browser_smoke.py` (Playwright et Chromium requis). Ce test intercepte les routes de trading et couvre la confirmation avec des réponses fictives. L'application n'a pas besoin de ces outils pour fonctionner.

Le jeu fourni est synthétique et sert uniquement à vérifier le fonctionnement. Pour vos données, utilisez un CSV avec les colonnes `timestamp,close`, des dates ISO 8601 avec fuseau horaire, strictement croissantes, et des prix positifs. Conservez une fréquence régulière et une seule paire par fichier.

## Stratégie et risque

Un croisement haussier de la moyenne rapide au-dessus de la moyenne lente déclenche un achat. Un croisement baissier déclenche la vente. Chaque signal est exécuté au prix de clôture de la bougie suivante, frais inclus. Le bot conserve au maximum une position longue, sans levier ni vente à découvert.

Options par défaut : `--capital 10000 --fast 5 --slow 20 --allocation 0.2 --stop-loss 0.05 --fee 0.001`. L'allocation représente la fraction de trésorerie engagée, frais d'achat compris. Le stop est détecté à la clôture puis exécuté à la clôture suivante : il ne garantit donc pas une perte maximale de 5 %. Les périodes sont exprimées en nombre de bougies.

Le rapport JSON contient les transactions, frais, courbe de capital, rendement et drawdown maximal. Une position encore ouverte est valorisée au dernier prix, sans liquidation automatique ni frais de sortie hypothétiques. Un dernier signal sans bougie suivante n'est pas exécuté.

Ce modèle ignore le slippage, la liquidité, les montants minimums d'ordre et la fiscalité. Les résultats historiques ou synthétiques ne prédisent pas les rendements futurs. Une connexion de marché et une boucle de simulation en temps réel restent à ajouter pour un fonctionnement continu.
