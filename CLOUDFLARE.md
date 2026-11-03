# Héberger le serveur sans abonnement payant

Le site reste sur GitHub Pages. Un **Cloudflare Worker Free** reçoit les requêtes du site et communique avec Bitpanda ; une **base D1 gratuite** conserve le journal des ordres. Tout peut être configuré depuis le navigateur, sans terminal local ni achat de domaine.

## Ce qui est gratuit, et ses limites

D'après la [documentation Workers](https://developers.cloudflare.com/workers/platform/pricing/) et [D1](https://developers.cloudflare.com/d1/platform/pricing/), vérifiées le 3 novembre 2026 : Workers Free inclut 100 000 requêtes par jour et 10 ms de CPU par invocation ; D1 Free inclut 5 millions de lignes lues par jour, 100 000 lignes écrites par jour et 5 Go au total. Ce sont des limites de compte, pas une réservation pour cette application.

Sur Free, atteindre un quota peut bloquer les requêtes. La [documentation D1](https://developers.cloudflare.com/d1/platform/pricing/#frequently-asked-questions) précise que les requêtes échouent quand les limites gratuites sont atteintes. Restez sur Workers **Free**, sans activer Workers Paid. Les plafonds et conditions de l'offre peuvent évoluer. Les frais de trading de Bitpanda restent applicables.

Ce backend fournit le portefeuille, la recherche d'actifs, les devis et les confirmations d'ordres réels. Le laboratoire CSV Python n'y est pas exécuté ; l'interface le signale. Aucun trading autonome ou stop réel n'est activé.

## 1. Créer le compte et le Worker

1. Créez un compte sur [Cloudflare](https://dash.cloudflare.com/sign-up) et conservez le forfait Workers Free.
2. Dans **Workers & Pages**, créez un Worker JavaScript à partir du modèle Hello World et choisissez un nom, par exemple `bdltradingbot-api`.
3. Ouvrez son éditeur de code. Remplacez le code du Worker par le contenu intégral de [cloudflare/worker.mjs](cloudflare/worker.mjs), puis déployez.
4. Cloudflare fournit une adresse HTTPS en `workers.dev`. Gardez-la : vous la saisirez dans le site GitHub. Aucun domaine personnel n'est nécessaire.

Le Worker refuse les routes privées tant que ses paramètres ne sont pas configurés. Il ne tente aucun ordre lors de son déploiement.

## 2. Créer le journal persistant D1

1. Dans le tableau de bord Cloudflare, ouvrez **Storage & databases → D1** et créez une base `bdltradingbot` sur le forfait gratuit.
2. Dans sa console SQL, exécutez les instructions de [cloudflare/schema.sql](cloudflare/schema.sql), une par une si la console l'exige. Ce script crée les tables sans effacer d'anciens ordres.
3. Retournez dans votre Worker, puis **Bindings → Add binding → D1 database**. Nommez la liaison exactement **`DB`** et sélectionnez la base créée.
4. Appliquez la liaison et redéployez si le tableau de bord le demande.

Gardez toujours la même base pour ce compte Bitpanda. Ne la remplacez pas par une base vide pour débloquer un ordre. N'utilisez pas en parallèle un autre backend avec un journal indépendant pour le même bot.

## 3. Ajouter les paramètres du Worker

Dans **Settings → Variables and Secrets**, ajoutez :

| Nom | Type | Valeur |
| --- | --- | --- |
| `DASHBOARD_PUBLIC_ORIGIN` | Texte | `https://bdlglua.github.io` exactement, sans chemin ni slash final. |
| `DASHBOARD_ACCESS_TOKEN` | Secret | Un code aléatoire de 32 à 256 caractères ASCII sans espaces, créé dans votre gestionnaire de mots de passe. Il protège le tableau de bord. |
| `BITPANDA_API_KEY` | Secret | Votre clé API Bitpanda. Ne la saisissez jamais dans le site GitHub, le code ou le chat. |
| `BITPANDA_ENABLE_TRADING` | Texte | `0` pour commencer par vérifier le compte en lecture seule. |
| `BITPANDA_TRADING_CURRENCY_ID` | Texte | UUID de votre devise de trading, à renseigner avant l'activation des ordres. |
| `BITPANDA_MAX_ORDER_AMOUNT` | Texte | Votre plafond positif par ordre dans cette devise, à renseigner avant l'activation. |

Enregistrez puis déployez les changements si Cloudflare le demande. Une clé déjà configurée dans l'environnement Codex n'est pas automatiquement copiée chez Cloudflare. Le code d'accès au tableau de bord est **distinct** de la clé Bitpanda.

## 4. Connecter le site à ce serveur

1. Ouvrez [votre site](https://bdlglua.github.io/BDLTradingBot/).
2. Dans « Se connecter à votre serveur », saisissez l'adresse HTTPS `workers.dev` et le **code d'accès au tableau de bord**.
3. Cliquez sur « Connecter le serveur », puis « Actualiser le compte ».
4. Vérifiez que les positions réelles s'affichent. La liste des devises fournit les UUID à utiliser.

Le code d'accès reste en mémoire dans cet onglet, sans stockage local ou session et sans être inscrit dans l'adresse. Votre clé Bitpanda reste dans les secrets du Worker.

## 5. Activer les ordres si vous le souhaitez

Après vérification du compte, renseignez la devise et le plafond, puis passez `BITPANDA_ENABLE_TRADING` à `1` et appliquez les changements chez Cloudflare. Reconnectez le site ou actualisez le compte.

Choisissez un actif, un sens et un montant **en devise**, puis obtenez un devis. Aucun ordre n'est passé à ce stade. Vérifiez le devis, cochez la confirmation et cliquez sur « Exécuter l'ordre réel » pour envoyer une acceptation à Bitpanda. Le plafond porte sur le montant du devis, sans garantie de couvrir des coûts supplémentaires non exposés par l'API.

La disponibilité des actifs et les autorisations API dépendent de votre compte. La préparation du code et les tests locaux ne valident pas ces accès. Il n'est pas nécessaire de faire une transaction pour vérifier la connexion au portefeuille.

## En cas d'erreur ou de résultat inconnu

Le verrou d'ordre et le journal sont persistés dans D1 avant l'appel financier. Les confirmations concurrentes, les redémarrages et les doubles clics ne renvoient pas le même devis. Aucune requête d'ordre n'est relancée automatiquement.

Si une acceptation échoue, expire côté réseau ou réussit sans que D1 puisse enregistrer la réponse, l'état reste `unknown` ou `submitted` et le verrou bloque les nouveaux ordres. Vérifiez les opérations Bitpanda avant toute autre action. La levée du verrou après rapprochement n'est pas proposée dans l'interface : ne supprimez pas la base ou la ligne du verrou pour contourner cette protection.

Un arrêt du Worker pendant une demande de devis peut aussi laisser le verrou en `requesting`. Une intervention après vérification de l'état réel est alors nécessaire. Une base non initialisée, un quota ou une panne de D1 empêche l'envoi de nouveaux ordres plutôt que de travailler sans journal.

Les tests couvrent le code du Worker avec une API fictive et SQLite local. La configuration et le fonctionnement sur l'infrastructure Cloudflare devront être vérifiés après création de votre compte et déploiement. Les quotas gratuits n'offrent pas une garantie de disponibilité continue.
