# Barème détaillé des six items

La note doit être reproductible : deux audits du même CV donnent la même note. Applique les barèmes ci-dessous plutôt que ton intuition.

## Méthode générale

Chaque item part de 5 et descend selon les alertes remontées par `analyse.json` sur cet `item`, puis selon les critères de jugement propres à la ligne.

| Gravité de l'alerte | Retrait |
|---|---|
| `bloquant` | l'item tombe directement à 1/5 (0 si plusieurs bloquants) |
| `majeur` | -1,5 point |
| `mineur` | -0,5 point |

Plancher à 0, plafond à 5. Arrondis chaque item au demi-point.

**Total** : somme des six items (sur 30), ramenée sur 20 par `brut × 20 / 30`, arrondie au demi-point.

**Plafonnement global** : si le CV est une image (`FORMAT_IMAGE`) ou un PDF plat (`PDF_PLAT`, `PDF_TEXTE_PARTIEL`, `PDF_COPIE_INTERDITE`, `PDF_XFA`), le total ne peut pas dépasser 5/20. Dis-le explicitement : tant que ce point n'est pas corrigé, le reste du travail ne sert à rien.

---

## 1. Titre clair et lisible

Ce qui est mesuré : l'ATS indexe le candidat sur l'intitulé trouvé en tête de document et s'en sert pour le rapprochement avec les postes ouverts. Un CV sans titre est un CV qui ne remonte dans aucune recherche par intitulé.

| Note | Situation |
|---|---|
| 5 | Intitulé présent sous le nom, 2 à 5 mots, calqué sur les intitulés réellement publiés pour ce métier. En mode 2 : identique ou quasi identique à celui de l'offre. |
| 4 | Intitulé présent et clair, mais légèrement décalé du vocabulaire du marché (« Responsable informatique » là où les offres disent « Administrateur systèmes et réseaux »). |
| 3 | Intitulé présent mais vague ou fourre-tout (« Consultant », « Ingénieur »), ou noyé dans une accroche. |
| 2 | Intitulé remplacé par un slogan personnel (« Passionné par la tech depuis toujours »). |
| 1 | `TITRE_ABSENT` : aucun intitulé identifiable, le nom sert de titre. |
| 0 | Intitulé présent uniquement dans une image ou dans une zone non extraite. |

Codes concernés : `TITRE_ABSENT` (bloquant), `TITRE_TROP_LONG` (mineur).

Vérifie aussi le nom du fichier. `CV-Prenom-Nom-Intitule-du-poste.pdf` est lu par plusieurs ATS et par tous les recruteurs. `cv_final_v3.pdf` coûte un demi-point.

## 2. Format du fichier

| Note | Situation |
|---|---|
| 5 | `.docx`, ou PDF texte balisé, moins de 2 Mo, extension cohérente avec le contenu réel. |
| 4 | PDF texte non balisé, propre par ailleurs. C'est le cas le plus courant. |
| 3 | PDF texte mais produit par un outil de design (Canva, InDesign) : `PDF_CANVA`, contenu extractible mais ordre de lecture fragile. Ou `.doc`, `.odt`, `.rtf`. |
| 2 | `PDF_TEXTE_MAIGRE` : une partie du contenu est en image. |
| 1 | `PDF_TEXTE_PARTIEL`, `PDF_COPIE_INTERDITE`, `PDF_XFA` : l'essentiel n'est pas extractible. |
| 0 | `FORMAT_IMAGE` (jpeg, png, heic) ou `PDF_PLAT` : rien n'est extractible. |

Codes concernés : `FORMAT_IMAGE`, `PDF_PLAT`, `PDF_TEXTE_PARTIEL`, `PDF_COPIE_INTERDITE`, `PDF_XFA`, `PDF_CORROMPU`, `PDF_GRAPHIQUE`, `FORMAT_DOC`, `FORMAT_ODT`, `FORMAT_RTF`, `FORMAT_INCONNU`, `EXTENSION_TROMPEUSE`, `PDF_TEXTE_MAIGRE`, `PDF_CANVA`, `PDF_NON_BALISE`, `FICHIER_LOURD`.

Le conseil par défaut : `.docx` quand le formulaire accepte les deux. C'est le format que tous les parseurs gèrent le mieux, y compris les plus anciens. Le PDF ne se justifie que s'il est exporté depuis Word avec l'option d'accessibilité, ou si le portail l'impose.

## 3. Structure et titres de section

Les parseurs découpent le document en cherchant des intitulés de rubrique standards. Un titre inventé (« Mon parcours », « Ce que je sais faire ») n'est pas reconnu : le contenu part dans la mauvaise rubrique, voire dans aucune.

| Note | Situation |
|---|---|
| 5 | Les cinq rubriques attendues sont présentes avec des intitulés standards, dans l'ordre habituel, et chaque expérience porte des dates au format MM/AAAA. |
| 4 | Rubriques standards mais une manque (langues, certifications) ou les dates sont en AAAA seul. |
| 3 | Deux rubriques manquantes, ou intitulés personnalisés non reconnus, ou coordonnées incomplètes. |
| 2 | Découpage confus : les expériences et les formations se mélangent, ou aucune date exploitable. |
| 1 | `EMAIL_ABSENT` : pas de moyen de contact extractible. |
| 0 | Aucune rubrique identifiable. |

Intitulés reconnus par les parseurs français : Profil (ou Accroche), Expérience professionnelle, Formation, Compétences, Langues, Certifications, Centres d'intérêt.

Codes concernés : `SECTION_EXPERIENCE`, `SECTION_FORMATION`, `SECTION_COMPETENCES`, `PEU_DE_SECTIONS`, `EMAIL_ABSENT` (bloquant), `TEL_ABSENT`, `DATES_ABSENTES`, `CV_TROP_COURT`, `PDF_TROP_LONG`.

## 4. Couverture des 40 mots-clés

**Mode 1** - part des 40 mots-clés du marché présents dans le CV :

| Note | Couverture |
|---|---|
| 5 | 90 % et plus |
| 4 | 75 à 89 % |
| 3 | 60 à 74 % |
| 2 | 45 à 59 % |
| 1 | 30 à 44 % |
| 0 | moins de 30 % |

**Mode 2** - moyenne de deux mesures de `analyse.json` : `couverture_pct` (expressions de l'offre) et `couverture_termes_forts_pct` (technologies, outils et certifications nommément cités). Applique ensuite la même échelle.

Retire un point supplémentaire si `termes_forts_absents` contient une exigence explicite de l'offre (un outil cité dans la rubrique « Profil recherché »). Retire un point si les mots-clés sont présents mais tous concentrés dans un bloc de compétences, sans jamais apparaître dans les expériences : les ATS qui pondèrent par section, comme Workday, accordent beaucoup moins de poids à une liste isolée qu'à un terme employé dans le descriptif d'un poste occupé.

Codes concernés : `COUVERTURE_FAIBLE`, `TECHNOS_ABSENTES`.

## 5. Images et abréviations

| Note | Situation |
|---|---|
| 5 | Aucune image hors photo d'identité, aucun sigle non explicité. |
| 4 | Photo et un logo discret, ou deux ou trois sigles non glosés. |
| 3 | Pictogrammes de contact, drapeaux de langues, ou nombreux sigles non glosés. |
| 2 | Barres ou étoiles de compétences, graphiques : une information que l'ATS ne reçoit pas du tout. |
| 1 | `GLYPHES_ICONES` : les icônes polluent le texte extrait et collent aux coordonnées. |
| 0 | Le texte de l'en-tête (nom, titre, coordonnées) est incrusté dans une image. |

Codes concernés : `IMAGES_MULTIPLES`, `IMAGES_WORD`, `GLYPHES_ICONES`, `SYMBOLES`, `ABREVIATIONS`.

Sur les sigles, la règle de recrutement : écrire la forme longue suivie du sigle entre parenthèses, une fois, à la première occurrence. « Maintien en condition opérationnelle (MCO) ». Les deux formes sont alors indexées, et le recruteur qui cherche l'une ou l'autre trouve le CV. Les sigles de niche non explicités sont aussi un signal de manque de recul pour un recruteur qui n'est pas du métier - et le premier filtre est presque toujours généraliste.

Sur la photo : neutre en France pour l'ATS, mais elle n'apporte rien au parsing. Déconseillée pour une candidature au Royaume-Uni, aux États-Unis ou au Canada, où elle peut motiver un rejet automatique pour raisons anti-discrimination.

## 6. Éléments illisibles

C'est l'item qui coûte le plus cher en pratique, et celui que les candidats voient le moins, parce que tout s'affiche parfaitement à l'écran.

| Note | Situation |
|---|---|
| 5 | Une seule colonne, aucun tableau, aucune zone de texte, coordonnées dans le corps du document. |
| 4 | Un tableau simple sans fusion de cellules, ou quelques puces exotiques. |
| 3 | Pseudo-tableaux par tabulations, ou coordonnées en pied de page. |
| 2 | Tableaux multiples structurant les expériences. |
| 1 | `MULTI_COLONNES` ou `ZONES_TEXTE_WORD` : une partie du contenu est mélangée ou invisible. |
| 0 | Plusieurs bloquants cumulés (colonnes et zones de texte et SmartArt). |

Codes concernés : `MULTI_COLONNES` (bloquant), `ZONES_TEXTE_WORD` (bloquant), `SMARTART` (bloquant), `TABLEAUX_WORD`, `COLONNES_WORD`, `BLOCS_TABULAIRES`, `ORDRE_LECTURE`, `CONTACT_EN_MARGE`, `REVISIONS`, `COMMENTAIRES`, `PUCES_EXOTIQUES`, `TEXTE_INVISIBLE`, `TEXTE_BLANC`.

`TEXTE_INVISIBLE` et `TEXTE_BLANC` méritent un traitement à part : si c'est du bourrage volontaire de mots-clés, dis-le sans détour. C'est détecté par les ATS récents, et un recruteur qui s'en aperçoit écarte la candidature sans appel.

Pour démontrer un problème de colonnes, cite trois lignes de `texte-extrait.txt` où les deux colonnes se sont collées. C'est plus convaincant que n'importe quelle explication.
