# audit-cv-ats

Audit d'un CV face aux ATS (Applicant Tracking Systems), avec une note sur 20, la liste des mots-clés manquants et une version optimisée du CV.

## Deux usages

**Le CV seul** - évaluation générale, avec recensement des 40 mots-clés les plus employés dans les offres publiées pour l'intitulé visé.

```
analyse mon CV : C:\docs\CV-Dupont.pdf
```

**Le CV et une offre** - même grille, mais les mots-clés viennent de l'offre.

```
est-ce que mon CV passe pour cette offre ? CV : C:\docs\CV-Dupont.pdf
offre : https://www.hellowork.com/fr-fr/emplois/12345.html
```

## Ce que ça produit

Dans `audit-ats/`, à côté du CV :

| Fichier | Contenu |
|---|---|
| `rapport-ats.md` | la grille des six items notés sur 5, ramenée sur 20, et les alertes classées par gravité |
| `mots-cles-a-integrer.md` | les 40 mots-clés, présents et absents, avec l'endroit où placer chaque manquant |
| `cv-optimise.md` | le CV réécrit, prêt à mettre en forme dans Word |
| `texte-extrait.txt` | le CV tel qu'un parseur ATS le lit |
| `flux-natif.txt` | le CV dans l'ordre brut du fichier, tel qu'un parseur basique le lit |
| `analyse.json` | toutes les mesures |

## Les six items notés

Titre, format du fichier, structure et titres de section, couverture des 40 mots-clés, images et abréviations, éléments illisibles (tableaux, zones de texte, colonnes). Chacun sur 5, total ramené sur 20.

Un CV en image ou un PDF plat plafonne le total à 5/20 : pour un ATS, le contenu n'existe pas.

## Le script d'analyse

`scripts/analyse-cv.mjs` ouvre le fichier comme le ferait un parseur et mesure ce qui ne se voit pas à l'écran : couche de texte réelle, colonnes et lignes fusionnées à l'extraction, tableaux, zones de texte Word, SmartArt, images, polices d'icônes, texte blanc sur blanc, coordonnées perdues en en-tête, révisions non acceptées, dates exploitables.

```bash
node scripts/analyse-cv.mjs cv.pdf --offre offre.txt --out audit-ats
```

Formats reconnus : PDF, DOCX, DOC, ODT, RTF, et détection des CV envoyés en image. Node 22 ou plus, aucune dépendance à installer - pdf.js est embarqué dans `scripts/vendor/`.

Le script fonctionne aussi seul, hors du skill, si on veut juste le diagnostic technique.

## Références

`references/grille-notation.md` (barème détaillé), `references/pieges-ats.md` (comportement des ATS du marché), `references/mots-cles-methode.md` (construction des 40 mots-clés), `references/modele-cv-optimise.md` (structure de CV compatible ATS).
