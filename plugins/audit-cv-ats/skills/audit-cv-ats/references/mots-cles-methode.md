# Construire les 40 mots-clés

## Pourquoi 40

C'est l'ordre de grandeur du vocabulaire qui revient dans la quasi-totalité des offres d'un même métier. En dessous de 25, la liste rate des termes courants. Au-delà de 50, on descend dans le vocabulaire d'entreprise, propre à une offre et sans valeur ailleurs.

## Répartition cible

| Catégorie | Nombre | Contenu |
|---|---|---|
| Intitulés et variantes | 4 à 6 | le titre visé et ses synonymes de marché, y compris la version anglaise si elle circule en France |
| Compétences techniques du cœur de métier | 10 à 14 | ce que le poste consiste à faire |
| Outils, logiciels, technologies | 8 à 12 | tout ce qui se cite par son nom propre |
| Méthodes, normes, cadres | 4 à 6 | agile, Scrum, ITIL, ISO, RGPD, lean, etc. |
| Savoir-être et compétences transverses | 4 à 6 | uniquement ceux réellement écrits dans les offres |
| Diplômes, certifications, niveaux | 3 à 5 | Bac+5, RNCP niveau 6, AWS, PMP, TOEIC |

## Méthode de sourcing

1. **Fixer l'intitulé.** En mode 2 c'est celui de l'offre. En mode 1, celui du CV s'il est cohérent avec le poste visé - sinon, demander. Un audit sur le mauvais intitulé ne sert à rien.
2. **Collecter 8 à 12 offres réelles et récentes.** France Travail, HelloWork, Indeed, APEC, LinkedIn, Welcome to the Jungle. Varier les tailles d'entreprise : une offre de grand groupe et une offre de PME n'emploient pas le même vocabulaire, et le CV doit passer les deux.
3. **Concaténer dans un seul fichier** `audit-ats/offres-marche.txt`, puis relancer `analyse-cv.mjs` avec `--offre` sur ce fichier. Le classement par fréquence sort du corpus réel, pas de la mémoire.
4. **Lire le champ `termes_forts_absents`** en priorité : ce sont les noms propres techniques, ceux que le recruteur tape en premier dans le moteur de recherche interne de l'ATS.
5. **Compléter et nettoyer.** Le script remonte des fréquences, pas du sens. Écarte le vocabulaire d'annonce (« rejoignez », « dynamique », « mutuelle ») et les noms d'entreprise. Regroupe les variantes d'un même terme en gardant la forme la plus employée.

Si le réseau est indisponible, construis la liste avec tes connaissances du métier et dis-le dans le rapport. Une liste non sourcée reste utile, mais elle n'a pas le même statut.

## Écrire le fichier de sortie

`audit-ats/mots-cles-a-integrer.md` :

```markdown
# 40 mots-clés - Administrateur systèmes et réseaux
Source : 11 offres relevées le 22/09/2026 (France Travail, HelloWork, APEC)
Couverture actuelle du CV : 26/40 (65 %)

## Présents dans le CV (26)
Linux, Windows Server, VMware, Active Directory, sauvegarde, supervision, ...

## Absents - à intégrer (14)

| Mot-clé | Fréquence dans les offres | Où l'intégrer |
|---|---|---|
| ITIL | 8 offres sur 11 | Bloc compétences + expérience Alpha si le processus d'incident y était suivi |
| PRA | 6 sur 11 | Expérience Beta, phrase sur la reprise d'activité |
| ... | | |

## À ne pas ajouter sans vérification
Kubernetes (4 offres sur 11) : absent du CV et rien n'indique que tu l'aies pratiqué.
Ne l'ajoute que si c'est vrai, sinon le premier entretien technique le révèle.
```

La colonne « Où l'intégrer » est la partie utile. Un mot-clé posé dans une liste de compétences pèse moins qu'un mot-clé employé dans la description d'un poste occupé : indique une expérience précise à chaque fois que c'est possible.

## Règles de placement

- **Le titre d'abord.** L'intitulé visé sous le nom, mot pour mot celui de l'offre en mode 2.
- **L'accroche ensuite.** Trois ou quatre lignes qui reprennent l'intitulé, l'ancienneté et les trois ou quatre compétences les plus demandées.
- **Puis les expériences.** C'est la zone la mieux pondérée par les ATS qui pondèrent par rubrique. Chaque mission décrite avec le vocabulaire des offres.
- **Le bloc compétences en dernier recours**, pour les termes qui ne trouvent leur place nulle part ailleurs. Utile, mais moins scoré.
- **Les deux formes des sigles**, forme longue puis sigle entre parenthèses à la première occurrence.

## Vocabulaire de départ par famille

À utiliser comme amorce de recherche, jamais comme liste finale.

**Informatique - infrastructure et systèmes** : Linux, Windows Server, VMware, Hyper-V, Active Directory, virtualisation, supervision, monitoring, sauvegarde, PRA, PCA, MCO, ITIL, ticketing, GLPI, réseau, TCP/IP, VLAN, VPN, pare-feu, DNS, DHCP, scripting, PowerShell, Bash, Python, Ansible, Terraform, Docker, Kubernetes, CI/CD, GitLab, cloud, AWS, Azure, GCP, sécurité, durcissement, astreinte, incident, N2, N3.

**Développement** : selon la stack, mais toujours : langage, framework, tests unitaires, revue de code, Git, intégration continue, API REST, base de données, SQL, agile, Scrum, sprint, refactoring, performance, accessibilité, documentation technique.

**Ressources humaines et recrutement** : sourcing, chasse, entretien structuré, présélection, multidiffusion, ATS, marque employeur, onboarding, intégration, gestion administrative du personnel, paie, SIRH, GPEC, entretien annuel, formation, plan de développement des compétences, droit du travail, CSE, reporting RH, KPI recrutement, cost per hire, time to fill.

**Commerce et vente** : prospection, qualification, cycle de vente, closing, portefeuille clients, CRM, Salesforce, HubSpot, négociation, appel d'offres, proposition commerciale, objectifs, chiffre d'affaires, marge, reporting, B2B, B2C, grands comptes, fidélisation, upsell.

**Comptabilité et finance** : saisie, lettrage, rapprochement bancaire, TVA, liasse fiscale, bilan, compte de résultat, clôture, immobilisations, consolidation, contrôle de gestion, budget, prévisionnel, écarts, SAP, Sage, Cegid, Excel, tableau croisé dynamique, reporting, normes IFRS.

**Marketing et communication** : stratégie éditoriale, SEO, SEA, content marketing, réseaux sociaux, community management, emailing, marketing automation, CRM, Google Analytics, KPI, taux de conversion, acquisition, notoriété, brand content, plan média, budget, agence.

**Logistique et supply chain** : approvisionnement, gestion des stocks, inventaire, préparation de commandes, ERP, WMS, SAP, transport, affrètement, douane, incoterms, prévision de la demande, S&OP, taux de service, OTIF, lean, 5S, amélioration continue, sécurité, CACES.

**Santé et médico-social** : soins, protocole, traçabilité, dossier patient, transmissions, hygiène, prévention, démarche qualité, accompagnement, projet de soins, coordination, pluridisciplinaire, urgence, bientraitance, diplôme d'État.

## Garde-fou

Un mot-clé ne s'ajoute que s'il est vrai. Un CV optimisé qui décroche un entretien sur une compétence fictive coûte plus cher qu'un CV mal classé. En cas de doute sur une compétence, pose la question à l'utilisateur plutôt que de trancher à sa place.
