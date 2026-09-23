# Changelog

Ce que change chaque version des plugins de ce dépôt.

Les numéros suivent [semver](https://semver.org/lang/fr/) : le chiffre du milieu bouge quand une fonctionnalité arrive, le dernier quand un bug est corrigé. Pour récupérer une version, voir [Mettre à jour](README.md#mettre-à-jour) dans le README.

`audit-cv-ats` en est encore à sa première version. `humanizer` est relayé depuis [le dépôt de blader](https://github.com/blader/humanizer) et suit son propre rythme, épinglé ici sur sa v3.0.0.

---

## recherche-emploi

### 2.10.1 - 2026-09-23

Corrige la détection de Playwright quand le skill est installé par plugin.

Claude Code préfixe les serveurs MCP livrés par un plugin. Les outils ne s'appellent donc pas `mcp__playwright__browser_*` mais `mcp__plugin_recherche-emploi_playwright__browser_*`. Le skill testait le premier nom : il concluait que Playwright manquait, affichait la commande d'installation manuelle et passait la case du dashboard au rouge, alors que le serveur tournait et répondait.

Le bug est là depuis la 2.10.0. Il touchait uniquement les installations par plugin sans Playwright déjà ajouté à la main, c'est-à-dire la configuration que la 2.10.0 venait justement rendre possible. Une machine qui avait gardé son serveur `playwright` d'une installation manuelle ne voyait rien.

Le skill cherche maintenant un outil dont le nom se termine par `__browser_navigate` et réutilise le préfixe trouvé, quel qu'il soit. Les deux modes d'installation fonctionnent.

### 2.10.0 - 2026-09-23

Le type de contrat devient un vrai paramètre de recherche.

Jusqu'ici rien ne disait à Claude si vous cherchiez un CDI, une alternance ou un CDD. Il le devinait depuis le CV, ce qui tombe juste pour un profil expérimenté en recherche de CDI et rate complètement quelqu'un en reconversion. Le contrat ne pesait que dans le critère Conditions, noyé avec le salaire et le diplôme.

- Le contrat est désormais la troisième question posée au lancement, stocké sur la recherche et utilisé pour filtrer la page de résultats avant de dépenser le budget de lecture.
- Une offre dont le contrat ne correspond pas est écartée, au lieu de perdre quelques points.
- Le tableau des offres gagne un filtre contrat, l'historique une colonne contrat.
- Le détecteur derrière le filtre lit du texte libre : `CDI`, `C.D.I.`, `contrat a duree indeterminee`, `CDD - 6 mois`, `alternance`, `mi-temps`. 22 cas testés.

Ajoute aussi ce changelog et une section du README sur les mises à jour.

### 2.9.0 - 2026-09-23

Trois murs séparaient un utilisateur non technique d'une installation qui marche. Ils tombent.

- **Playwright MCP est livré avec le plugin** via son `.mcp.json`, lancé par un petit launcher. Un `"command": "npx"` statique ne suffisait pas : sous Windows `npx` est un `.cmd`, qui échoue en ENOENT sans shell et en EINVAL quand on l'appelle `npx.cmd`. Le launcher passe explicitement par `cmd.exe` et n'ajoute aucune dépendance, Node étant de toute façon requis.
- **`humanizer` est relayé par ce marketplace**, épinglé sur le tag v3.0.0 du dépôt d'origine. Rien n'est copié ici, rien ne peut devenir obsolète.
- **[GUIDE-DEBUTANT.md](GUIDE-DEBUTANT.md)** déroule l'installation complète pour quelqu'un qui n'a jamais ouvert un terminal, puis explique comment lancer une vraie recherche.

Supprime au passage deux dossiers `cv/` et `data/` créés par erreur en lançant le script depuis le dossier du skill. Les deux étaient gitignorés, rien n'a fuité.

### 2.8.0 - 2026-09-23

- **Colonnes redimensionnables** : tirez le bord droit d'un en-tête pour élargir une colonne, double-cliquez pour la remettre à zéro. Les largeurs vivent dans le localStorage, un jeu par tableau, pour qu'un intitulé de poste à rallonge ait la place qu'il mérite.
- **Chat par session** : le watcher ouvre une conversation neuve à chaque démarrage et le dashboard n'affiche que la courante. Avant, toutes les sessions Claude Code s'empilaient sur le même fil jusqu'à le rendre illisible. Rien n'est supprimé, `list-messages --all` lit toujours les anciennes, et une question laissée sans réponse par une session morte est annulée pour qu'on ne puisse plus cliquer dans le vide.

### 2.7.1 - 2026-09-23

Neuf captures du dashboard en thème sombre dans le README, plus une paire clair/sombre pour le sélecteur de thème. Les données derrière sont fictives : CV, entreprises et annonces sont inventés, les URLs ne mènent nulle part.

La démo a révélé deux bugs, corrigés ici : le panneau de détail affichait la date de publication brute au lieu de la formater comme le tableau, et l'historique montrait la clé interne `les_deux` plutôt qu'un libellé.

### 2.7.0 - 2026-09-23

Refonte du dashboard et sélecteur de thème.

- Six palettes d'accent (bleu, violet, vert, ambre, rose, ardoise) avec un basculement auto/clair/sombre, stocké dans le localStorage et appliqué avant le premier rendu pour que la page ne clignote jamais dans la mauvaise couleur.
- Rayons plus doux, ombres en couches, élévation au survol, anneaux de focus, indicateur d'onglet animé, transitions de popover et de panneau. Tout se désactive sous `prefers-reduced-motion`.
- L'animation d'entrée est limitée aux changements d'onglet, pour qu'un sondage en arrière-plan ne la rejoue pas sur toute la liste.
- Tableau des offres plus dense : les colonnes secondaires se tronquent avec une infobulle au lieu de déborder sur cinq lignes, le statut devient une pastille.

### 2.6.3 - 2026-09-23

- Détecte les skills installés comme plugins et derrière des jonctions de répertoire, cas fréquent sous Windows.
- Le README proposait de créer le dossier `cv/` à la main alors que le script le crée au premier contrôle. Il suggérait aussi une phrase plutôt que la commande slash, qui est le point d'entrée fiable.
- Quand Node manque ou est trop vieux, Claude propose de l'installer au lieu de s'arrêter sur le constat.

### 2.6.2 - 2026-09-23

Première version publiée sur le marketplace. Recherche sur HelloWork et Indeed avec un vrai navigateur, notation de chaque annonce face au CV, base SQLite locale, dashboard sur `localhost:3000` avec kanban de suivi et rédaction de lettres de motivation.

---

## audit-cv-ats

### 1.0.0 - 2026-09-23

Première version. Audite un CV comme le ferait un ATS : note sur 20 répartie sur six critères, liste des mots-clés manquants, version optimisée du CV.
