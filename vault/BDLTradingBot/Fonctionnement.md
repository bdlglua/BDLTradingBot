# Fonctionnement du coffre

1. Ouvrez ce dossier comme coffre dans Obsidian.
2. Dans les réglages d'Obsidian, autorisez l'extension communautaire locale **BDLTradingBot** incluse avec ce coffre, après examen de son code si souhaité.
3. Utilisez la palette de commandes : **BDLTradingBot : Connecter le bot**.
4. Saisissez l'adresse du Worker et de préférence le code dédié `OBSIDIAN_ACCESS_TOKEN` configuré dans Cloudflare. Ce code permet uniquement le journal et les notes. Le code général du tableau de bord fonctionne aussi, mais possède des droits plus larges. Ne saisissez pas votre clé Bitpanda.

Le code reste uniquement en mémoire : il faut se reconnecter après fermeture d'Obsidian. Il n'est jamais enregistré dans le coffre. L'extension synchronise les notes toutes les cinq minutes pendant qu'Obsidian est ouvert. Elle ne passe aucun ordre et ne déclenche pas la recherche : cela relève du serveur Cloudflare.

`Tableau de bord`, `Journal` et `Recherche` sont des notes gérées par le bot et seront remplacées lors de la synchronisation. Écrivez vos notes personnelles dans `Strategies` ou ailleurs. Quatre notes de stratégie de 2 000 caractères maximum sont synchronisées vers le serveur.

Le serveur n'interprète que les champs `family`, `fast` et `slow` de l'en-tête des notes. Il n'exécute jamais leur texte ni du code. Les limites de dépense restent fixées dans l'interface, et les variantes doivent être évaluées puis approuvées.

Le coffre reste local à votre appareil ; aucune synchronisation Obsidian Sync payante n'est nécessaire. La synchronisation fournie relie cet appareil au Worker, pas plusieurs appareils entre eux. Les notes contiennent des informations financières : gardez votre coffre privé.
