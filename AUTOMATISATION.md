# Automatisation, recherche et Obsidian

Le module est préparé, mais les ordres automatiques restent désactivés tant que vous n'avez pas fourni la base D1, les autorisations serveur, un actif, vos budgets et une stratégie approuvée. Aucune somme et aucun investissement ne sont choisis à votre place.

## Les trois limites à comprendre

- **Actif autorisé** : l'instrument que le bot peut négocier. Recherchez son symbole dans l'interface et sélectionnez le résultat exact. Cette première version suit un seul actif à la fois, sans levier ni vente à découvert.
- **Montant par achat** : la somme en devise utilisée pour chaque achat du bot ; elle doit rester sous le plafond Bitpanda du serveur.
- **Maximum des achats par jour** : la somme des montants engagés par les achats automatiques durant un jour UTC. Les ordres incertains et réservations en cours comptent aussi. Les achats manuels ne sont pas inclus. Les ventes ne consomment pas ce budget, pour permettre une sortie de position.

Par exemple, « un actif choisi, 10 unités de devise par achat, au plus 50 unités engagées en achats par jour » illustre seulement le format. Le budget limite les engagements, pas les pertes. Il ne garantit pas de couvrir des frais supplémentaires qui ne seraient pas exposés dans le montant du devis.

## 1. Préparer D1 sans effacer l'historique

Dans **la même base** que le journal Bitpanda, exécutez d'abord `cloudflare/schema.sql` si nécessaire, puis le complément [cloudflare/automation-schema.sql](cloudflare/automation-schema.sql). Les instructions `CREATE IF NOT EXISTS` ne vident pas les tables.

La liaison `DB` et son UUID réel doivent être déclarés dans `wrangler.jsonc`, comme décrit dans CLOUDFLARE.md. Le dépôt ne contient pas cet UUID tant que vous ne l'avez pas fourni. Ne créez pas une base vide à la place d'un journal existant pour débloquer un cycle.

## 2. Préparer les autorisations Cloudflare

Les secrets et paramètres habituels de Bitpanda restent requis. Ajoutez dans les paramètres **du Worker**, jamais dans les variables publiques GitHub :

| Paramètre | Effet |
|---|---|
| `AUTOMATION_ENABLED=1` | Autorise la collecte d'un cours toutes les cinq minutes pour l'actif configuré, et les comparaisons horaires quand l'historique est suffisant. |
| `AUTOMATION_TRADING_ENABLED=1` | Autorise le module à exécuter des ordres, en plus de la collecte. Ne renseignez cette valeur que si vous souhaitez autoriser le réel. |
| `BITPANDA_ENABLE_TRADING=1` | Autorisation globale de trading déjà utilisée par les ordres manuels. |
| `OBSIDIAN_ACCESS_TOKEN` | Secret aléatoire distinct, de 32 à 256 caractères ASCII sans espaces, réservé au journal et aux notes. Il ne permet ni achat, ni vente, ni activation du bot. |

Ces autorisations ne suffisent pas seules à lancer le bot : les limites doivent être sauvegardées, une stratégie approuvée et l'activation confirmée dans le site. Le dépôt ne définit pas les drapeaux d'automatisation à `1`. Le déclencheur planifié existe mais retourne immédiatement quand `AUTOMATION_ENABLED` est absent ou différent de `1`.

Pour commencer par observer, autorisez seulement la collecte, enregistrez vos réglages et laissez les ordres en pause. La collecte n'engage pas d'argent.

## 3. Utiliser l'écran Automatisation

1. Connectez votre serveur depuis l'écran Bitpanda.
2. Ouvrez **Automatisation**, recherchez et choisissez votre actif.
3. Saisissez le montant par achat, le budget quotidien et une estimation des frais pour les comparaisons. Aucun champ financier n'est rempli automatiquement. Le stop de sortie est facultatif.
4. Enregistrez. Cette opération met les ordres en pause ; la collecte peut continuer si le serveur l'autorise.
5. Attendez au moins 200 observations consécutives de cinq minutes, soit environ 17 heures. Une interruption peut prolonger l'attente.
6. Lancez la comparaison, ou attendez la comparaison horaire. Les variantes proposées avec moins de deux transactions dans la période test ne sont pas activables.
7. Examinez et approuvez une variante. Une nouvelle approbation met le bot en pause ; vous gardez la décision sur tout changement de stratégie.
8. Si les autorisations serveur sont prêtes, cochez votre consentement puis cliquez sur **Activer les ordres automatiques**.

Le bot utilise les croisements des moyennes mobiles pour ouvrir puis fermer une position. Il ne rachète pas tant qu'une position suivie est ouverte. Il vend uniquement la quantité suivie dans son propre journal, après contrôle des positions du compte. Le montant d'une vente reste limité par le plafond serveur, donc une sortie peut être partielle. La devise du cours doit correspondre à celle autorisée par le serveur.

Le bouton **Mettre en pause** bloque les prochains envois, pas une acceptation déjà marquée en cours d'envoi. Un stop est vérifié uniquement au passage du cycle ; il ne garantit pas le prix de sortie ou une perte maximale. Évitez de modifier manuellement la position du même actif pendant que le bot la suit : un rapprochement peut devenir nécessaire.

## 4. Ce que fait la recherche

Le module compare trois variantes de moyennes mobiles (3/12, 5/20, 10/40), ainsi que les paramètres valides de quatre notes Obsidian au maximum. Il conserve au plus 500 points pour la comparaison et une fenêtre roulante bornée dans D1.

Les paramètres sont fixés avant l'évaluation sur les 30 % de points les plus récents. Le modèle applique les frais estimés, exécute les signaux au point suivant, et affiche rendement, drawdown et transactions. Il ne modélise pas toute la liquidité, les arrondis de marché, la fiscalité ni tous les frais réels. Les résultats sont exploratoires sur un historique court, sans garantie sur les rendements futurs.

Il s'agit d'un comparateur de règles explicites, pas d'une recherche documentaire ou d'un générateur d'algorithmes par IA. Aucun code trouvé sur Internet ou contenu dans une note n'est exécuté. L'approbation d'une stratégie est toujours votre action, pas une décision automatique issue du classement.

## 5. Créer votre coffre Obsidian gratuit

Depuis l'écran Automatisation, téléchargez **le coffre Obsidian**. Décompressez `Coffre-BDLTradingBot.zip` dans un dossier personnel, puis ouvrez ce dossier comme coffre dans Obsidian. N'ouvrez pas le dossier source `vault/` du dépôt comme coffre personnel : il sert uniquement de modèle.

L'extension locale BDLTradingBot est incluse, mais n'est pas activée automatiquement. Après examen si souhaité, activez-la dans les extensions communautaires. Dans la palette de commandes, choisissez **BDLTradingBot : Connecter le bot**, puis indiquez l'adresse du Worker et le code dédié `OBSIDIAN_ACCESS_TOKEN`. Le code général du tableau de bord reste accepté pour compatibilité, avec des droits plus larges.

L'extension met à jour `BDLTradingBot/Journal.md`, `Recherche.md` et `Tableau de bord.md` toutes les cinq minutes pendant qu'Obsidian est ouvert. Ces trois notes sont gérées et remplacées par le bot ; conservez vos commentaires ailleurs. Le code d'accès n'est jamais enregistré dans le coffre : une reconnexion est nécessaire après fermeture de l'application.

Les notes du dossier `BDLTradingBot/Strategies` sont envoyées au serveur comme données. Un en-tête au format suivant propose une variante à comparer :

```yaml
---
family: sma
fast: 5
slow: 20
---
```

Seuls ces champs sont interprétés, avec `1 <= fast < slow <= 200`. Le texte libre reste une note et ne change ni budget ni autorisation. Quatre notes de 2 000 caractères maximum peuvent être envoyées ; le serveur reçoit un instantané de cette collection. La suppression d'une note retire sa candidature pour les comparaisons suivantes, sans changer une stratégie déjà approuvée. Le transfert reste limité à 16 Ko par requête : un contenu riche en caractères multioctets peut devoir être raccourci.

Obsidian Sync payant n'est pas requis. Cette extension synchronise votre appareil avec le Worker, pas plusieurs appareils entre eux. Quand Obsidian est fermé, le coffre local n'est pas mis à jour ; la collecte et les ordres serveur continuent selon les autorisations. Gardez ce coffre privé : il contient votre historique financier.

## 6. Blocages et quotas

Un cycle est revendiqué durablement avant toute exécution. Un doublon du même déclenchement n'est pas rejoué. Les budgets sont réservés avant un achat et un résultat incertain continue de consommer le budget. Un état `collecting`, `reserved`, `submitting` ou `unknown` abandonné après une interruption bloque les cycles suivants jusqu'au rapprochement, plutôt que de renvoyer un ordre.

En cas d'erreur après envoi ou d'écart avec le compte, consultez Bitpanda et les journaux avant de reprendre. La levée d'un verrou après rapprochement n'est pas encore proposée dans l'interface. Ne supprimez pas les lignes ou la base pour contourner ce blocage.

Le forfait Cloudflare Free conserve ses quotas de requêtes, de CPU et de D1 ; les interruptions ou dépassements peuvent arrêter la collecte et les ordres. Les appels sont bornés à un seul actif et les calculs de comparaison utilisent des sommes roulantes pour limiter le CPU. Il n'y a pas de garantie de disponibilité continue ni de validation de charge sur votre compte Cloudflare. Les frais Bitpanda restent applicables.

## Validation

Les tests utilisent une API financière fictive et SQLite local pour vérifier les budgets, doublons, pauses, quantités, reprises et approbations. L'extension Obsidian est testée avec un coffre en mémoire ; son installation dans votre application reste à effectuer. Aucun ordre réel et aucune activation des drapeaux serveur ne sont exécutés par ces vérifications.
