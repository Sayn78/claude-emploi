# Guide pas à pas

Ce guide s'adresse à quelqu'un qui n'a jamais installé de logiciel de développeur et qui n'a jamais ouvert un terminal. Si vous savez déjà ce qu'est npm, le [README](README.md) ira plus vite.

Comptez trois quarts d'heure la première fois, dont la moitié en téléchargements.

---

## À quoi ça sert, concrètement

Vous déposez votre CV dans un dossier. Claude ouvre une page web sur votre ordinateur, et c'est depuis cette page que tout se passe : vous cliquez sur « Lancer une recherche », vous remplissez un formulaire avec le poste, la ville et ce que vous ne voulez pas voir. Claude ouvre alors un navigateur sous vos yeux, parcourt France Travail, HelloWork, Free-Work, Indeed et LinkedIn, lit les annonces une par une et garde celles qui correspondent vraiment à votre CV, avec une note sur 100 et une explication. Vous obtenez une liste triée, un tableau pour suivre vos candidatures, et des lettres de motivation rédigées à partir de votre seul CV.

Rien ne part sur Internet à part les pages d'annonces que le navigateur consulte. Votre CV reste sur votre ordinateur.

**Ce que ça ne fait pas :** ça ne postule pas à votre place. Vous gardez la main sur chaque envoi.

---

## Ce que ça coûte

Un abonnement Claude Pro, autour de 20 € par mois, résiliable. C'est la seule dépense. Tout le reste est gratuit.

Une recherche d'une vingtaine d'annonces consomme une partie de votre quota mensuel. En pratique vous pouvez lancer plusieurs recherches par semaine sans y penser.

---

## Étape 1 : le compte Claude

Allez sur [claude.ai](https://claude.ai), créez un compte, puis prenez l'abonnement **Pro** dans les réglages. Le forfait gratuit ne suffit pas : il ne donne pas accès à Claude Code.

## Étape 2 : installer Claude Code

Rendez-vous sur [claude.com/product/claude-code](https://claude.com/product/claude-code) et téléchargez l'application pour votre système. Installez-la comme n'importe quel logiciel, puis ouvrez-la et connectez-vous avec le compte de l'étape 1.

L'application de bureau est plus simple que la version en ligne de commande. Si vous préférez cette dernière, le README explique comment faire.

## Étape 3 : installer Node.js

Node est le moteur qui fait tourner le skill. Sans lui, rien ne démarre.

Allez sur [nodejs.org](https://nodejs.org/fr) et cliquez sur le gros bouton vert **Obtenir Node.js**. Choisissez la version marquée **LTS** et non la dernière version.

![La page d'accueil de Node.js, le bouton vert au centre gauche](docs/captures/guide-node.png)

Lancez le fichier téléchargé, cliquez sur Suivant jusqu'au bout. Aucune option à changer.

**Important :** si Claude Code était ouvert, fermez-le et rouvrez-le. Sinon il ne verra pas Node.

## Étape 4 : installer Google Chrome

Si vous ne l'avez pas déjà : [google.com/chrome](https://www.google.com/chrome/). C'est le navigateur que Claude pilotera pendant la recherche. Vous le verrez s'ouvrir et défiler les annonces.

## Étape 5 : installer les skills

Ouvrez Claude Code et tapez ces trois lignes, une par une, en appuyant sur Entrée à chaque fois :

```text
/plugin marketplace add Sayn78/claude-emploi
/plugin install recherche-emploi@claude-emploi
/plugin install audit-cv-ats@claude-emploi
```

Une quatrième, facultative mais recommandée, pour que les lettres ne sonnent pas comme un robot :

```text
/plugin install humanizer@claude-emploi
```

Puis **fermez Claude Code et rouvrez-le**. C'est à ce moment que les skills deviennent actifs.

> Si vous ne trouvez pas où taper ces commandes : c'est dans la zone de saisie, là où vous écrivez normalement vos messages. La barre oblique au début fait apparaître une liste de suggestions.

Une dernière manipulation, pour recevoir les corrections et les nouveautés sans y penser. Tapez `/plugin`, allez sur l'onglet **Marketplaces** avec la touche Tab, choisissez `claude-emploi` et sélectionnez **Enable auto-update**. Sans ça vous resterez sur la version d'aujourd'hui. Le détail est dans la section [Mettre à jour](README.md#mettre-à-jour) du README.

## Étape 6 : votre dossier de travail

Créez un dossier quelque part, nommé par exemple `recherche-emploi`, dans vos Documents. Laissez-le vide.

Dans Claude Code, ouvrez ce dossier : l'application vous demande sur quel dossier travailler au démarrage, ou propose un bouton pour en changer. C'est important, tout se passera là-dedans.

## Étape 7 : c'est parti

Tapez :

```text
/recherche-emploi:recherche-emploi
```

Le nom est écrit deux fois, ce n'est pas une faute : Claude Code fait précéder chaque skill du nom du plugin qui le livre, et ici les deux s'appellent pareil. Tapez `/rech`, la liste vous proposera la bonne commande, vous n'aurez qu'à valider.

Et si ça vous embête, **dites-le simplement** : « lance ma recherche d'emploi » marche aussi bien.

Claude prend la main. Il vérifie que tout est en place, crée ce dont il a besoin et ouvre une page dans votre navigateur, à l'adresse `localhost:3000`. C'est votre tableau de bord.

Il vous dit alors de déposer votre CV en PDF dans le dossier `cv` qu'il vient de créer, avec un bouton qui vous ouvre ce dossier. Glissez-y votre CV, puis cliquez sur **Rescanner le dossier cv/** en haut de la page. Claude lit le PDF et vous résume ce qu'il a compris de votre parcours.

Et là, il s'arrête. **C'est normal, et c'est voulu : il ne lancera rien tant que vous n'aurez pas cliqué.** Tout part des boutons de la page.

## Étape 8 : votre première recherche

En haut du tableau de bord, cliquez sur **Lancer une recherche**. Un formulaire s'ouvre.

![Le formulaire de recherche](docs/captures/10-lancer-recherche.png)

À gauche, ce que vous cherchez : le poste, la ville avec son code postal, le type de contrat, et deux nombres dont on reparle plus bas. Claude a déjà rempli le poste et la ville à partir de votre CV, corrigez si ça ne vous convient pas.

À droite, ce que vous ne voulez **pas** voir. Les quatre cases sont facultatives, laissez-les vides pour votre première recherche :

- **Mots-clés à éviter** : tapez un mot, appuyez sur Entrée, il devient une pastille. Toute annonce dont le titre contient ce mot sera ignorée. Pratique quand « senior » ou « expérimenté » revient sans arrêt alors que vous débutez.
- **Salaire minimum** : un montant, et vous précisez s'il s'agit de brut ou de net, par an ou par mois. Les annonces qui n'affichent aucun salaire sont gardées quand même - c'est la majorité d'entre elles.
- **Score minimum** : la note en dessous de laquelle une offre n'est pas retenue. 50 par défaut, laissez tel quel pour commencer.
- **Distance maximale** : un rayon en kilomètres autour de votre ville. Les annonces sans adresse précise et celles en télétravail complet passent quand même.

En bas, les sites à parcourir : cliquez les logos qui vous intéressent. France Travail et HelloWork sont déjà cochés, c'est un bon départ.

Cliquez sur **Lancer**. Claude annonce dans le chat de la page ce qu'il fait, et vous regardez le navigateur travailler.

![Le chat du tableau de bord, avec une question de Claude et ses réponses en boutons](docs/captures/03-chat.png)

Il ne vous parlera que quand il a quelque chose à dire : un bilan entre deux sites, une question pour savoir s'il continue ou s'il élargit, ou un captcha à résoudre vous-même. Vous répondez en cliquant.

---

## Si quelque chose ne marche pas

Le tableau de bord a un bouton **Vérifier les dépendances**. Il affiche une case par élément nécessaire : vert tout va bien, rouge il manque quelque chose, et la case vous dit quoi.

![La page des dépendances](docs/captures/06-systeme.png)

| Ce que vous voyez | Ce qu'il faut faire |
| --- | --- |
| Case **Node.js** rouge | Refaites l'étape 3, puis fermez et rouvrez Claude Code |
| Case **Playwright MCP** rouge | Fermez et rouvrez Claude Code. Le serveur est livré avec le skill, mais il n'apparaît qu'au redémarrage |
| Case **Google Chrome** rouge | Refaites l'étape 4 |
| Case **Dossier cv/** rouge | Il manque votre CV en PDF dans le dossier `cv` |
| Case **Watcher** rouge | Votre session Claude Code s'est arrêtée. Relancez `/recherche-emploi:recherche-emploi` |
| Case **Skill humanizer** rouge | Facultatif. Les lettres se feront quand même, un peu moins naturelles |
| **Claude hors ligne** en haut de la page | Même chose : la session est fermée, relancez le skill |
| Une page qui demande « Êtes-vous un humain ? » | Résolvez-la vous-même dans la fenêtre du navigateur, puis dites à Claude de reprendre. Il ne la contournera jamais tout seul |

Si un message d'erreur vous échappe, collez-le simplement dans le chat de Claude Code et demandez ce que ça veut dire. C'est exactement à ça qu'il sert.

---

## Trouver un emploi, la méthode

L'outil ne cherche pas à votre place, il vous fait gagner les heures que vous passeriez à ouvrir des annonces. Voici l'ordre qui marche.

### D'abord, faites auditer votre CV

Avant toute recherche, tapez `/audit-cv-ats:audit-cv-ats` ou dites simplement « analyse mon CV ».

Vous obtenez une note sur 20 et, surtout, la liste des mots-clés que les recruteurs emploient dans les annonces de votre métier et qui ne figurent pas sur votre CV. Ces logiciels de tri automatique éliminent une candidature avant qu'un humain la voie ; c'est souvent là que ça bloque quand on n'a aucune réponse.

Corrigez votre CV, redéposez-le, puis passez à la suite. Les mots-clés qui manquaient feront de bons termes de recherche.

### Ensuite, une recherche modeste

Dans le formulaire, laissez l'**objectif** sur 10 offres et le **plafond** sur 40 annonces. L'objectif, c'est ce que vous voulez garder ; le plafond, c'est le nombre d'annonces que Claude a le droit d'ouvrir avant d'abandonner. Sans ce garde-fou, un intitulé trop large le ferait tourner une heure.

Soyez franc sur le **type de contrat** : il ne le devine pas et ne cherche pas à le déduire de votre CV. Quelqu'un avec quinze ans de métier peut très bien chercher une alternance.

Si les résultats sont à côté, changez l'intitulé plutôt que la ville. « Assistant administratif » et « Secrétaire administratif » ne ramènent pas les mêmes annonces.

### Les filtres, au deuxième tour

Laissez la colonne de droite vide la première fois. Une recherche sans filtre vous montre ce que le marché propose vraiment : les salaires affichés, les intitulés qui reviennent, le niveau demandé.

C'est en lisant ces résultats que vous saurez quoi filtrer. Trop d'annonces « senior » alors que vous démarrez ? Mettez-le en mot à éviter. Des salaires systématiquement sous ce que vous visez ? Posez un minimum. Des postes à l'autre bout du département ? Mettez 30 km.

Quatre filtres serrés dès le premier essai, sur un intitulé mal choisi, et vous ne ramenez rien sans comprendre pourquoi. À la fin de chaque recherche, Claude vous dit combien d'annonces chaque filtre a écartées : c'est ce chiffre qui vous dit lequel est trop sévère.

### Lisez les scores, pas seulement les titres

Chaque offre porte une note sur 100 et, dans le panneau de droite, ce qui colle avec votre CV et ce qui manque. C'est cette deuxième liste qui a de la valeur : elle vous dit quoi mettre en avant en entretien, et quelles compétences reviennent trop souvent pour être ignorées.

![La liste des offres, avec le détail à droite](docs/captures/01-offres.png)

Au-dessus de 70, postulez. Entre 50 et 70, lisez l'annonce avant de décider.

### Faites écrire les lettres, puis relisez-les

Claude ne met dans une lettre que ce qui figure dans votre CV. Pas d'expérience inventée, pas de diplôme ajouté. C'est une contrainte, pas une limite : une lettre qui ment se voit en entretien.

Relisez quand même chaque lettre avant de l'envoyer, et changez au moins une phrase pour qu'elle vous ressemble.

### Tenez le tableau de suivi

Chaque offre passe d'une colonne à l'autre à la souris : À postuler, Postulée, Entretien, Refus, Acceptée. Notez les dates de relance dans la zone prévue.

![Le tableau de suivi](docs/captures/02-suivi.png)

Ça paraît accessoire au début. Au bout de trente candidatures, c'est la seule chose qui vous évitera de relancer deux fois la même entreprise ou d'en oublier une.

### Recommencez chaque semaine

Les annonces tournent vite. Une recherche par semaine sur les mêmes mots-clés suffit : le skill vérifie en base avant d'ouvrir une annonce, donc il ne vous montrera jamais deux fois la même.

---

## Quelques conseils appris à l'usage

Passez une fois sur HelloWork et Indeed dans le navigateur que Claude ouvre, le temps de traiter leur bandeau de cookies. Ce n'est pas obligatoire pour chercher, mais Indeed affiche parfois un mur de connexion en deuxième page de résultats. France Travail et Free-Work n'en ont pas besoin, et sur LinkedIn ne vous connectez pas : Claude ne se servira pas de votre session.

Gardez deux versions de votre CV si vous visez deux métiers. Une même annonce peut passer de 45 à 72 selon le CV utilisé pour la noter.

N'ouvrez qu'une seule session Claude Code à la fois sur votre dossier. Sinon vos clics dans la page partent dans la mauvaise.

Le tableau de bord reste consultable même quand Claude est fermé. Vos offres, vos lettres et votre suivi sont enregistrés sur votre ordinateur.

---

## Questions qu'on se pose

**Est-ce que mon CV est envoyé quelque part ?** Il est lu par Claude pendant la session, comme n'importe quel document que vous lui soumettez. Il n'est stocké nulle part ailleurs que sur votre ordinateur, et le tableau de bord n'est accessible que depuis votre machine.

**Est-ce que je peux me faire repérer par les sites d'emploi ?** Le skill navigue au rythme d'une personne, une annonce à la fois, avec quelques secondes d'attente entre chaque. Il ne remplit aucun formulaire à part le champ de recherche et ne crée aucun compte.

**Et si je n'ai pas de CV en PDF ?** Exportez-le en PDF depuis Word ou Google Docs. C'est le seul format lu.

**Ça marche pour quels métiers ?** Tous ceux qu'on trouve sur France Travail, HelloWork et Indeed. Ce n'est pas réservé à l'informatique - Free-Work est le seul des cinq sites à ne couvrir que la tech.

**Et à l'étranger ?** Non. Les deux sites visés sont français.
