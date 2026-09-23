# Comment les ATS lisent réellement un CV

## La chaîne de traitement

Un ATS enchaîne quatre opérations sur le fichier reçu. Chacune peut échouer sans que personne ne s'en aperçoive.

1. **Extraction du texte.** Le fichier est converti en flux de caractères. Un PDF scanné, un PDF protégé contre la copie ou un CV en image ne franchissent pas cette étape : la fiche candidat est créée vide, ou la candidature est rejetée à l'upload.
2. **Segmentation.** Le flux est découpé en rubriques à partir des intitulés reconnus et de la mise en forme. C'est là que les colonnes, les tableaux et les titres inventés font des dégâts.
3. **Extraction d'entités.** Des règles et des modèles NLP identifient le nom, les coordonnées, les intitulés de poste, les employeurs, les dates, les diplômes, les compétences. Les dates alimentent le calcul d'ancienneté ; les compétences sont rapprochées d'un référentiel interne (ontologie de skills).
4. **Rapprochement.** Le CV normalisé est comparé aux postes ouverts. Le score mélange correspondance d'intitulé, couverture des compétences requises, ancienneté calculée et, de plus en plus souvent, similarité sémantique par embeddings.

Point essentiel : un mot-clé absent n'est jamais compensé par un synonyme évident. Les référentiels rapprochent « JS » de « JavaScript », mais pas « animation d'équipe » de « management d'équipe » si le référentiel du client ne le prévoit pas. Le vocabulaire de l'offre prime toujours.

## Ce qui casse le parsing, par ordre de gravité

**Le CV en image ou le PDF plat.** Aucun texte à extraire. La quasi-totalité des ATS n'embarque pas d'OCR. Les portails qui proposent un pré-remplissage du formulaire à partir du CV renvoient des champs vides : le candidat doit tout ressaisir, et beaucoup abandonnent.

**Les deux colonnes.** L'erreur la plus répandue, et la plus invisible. Les modèles modernes placent les coordonnées et les compétences dans une barre latérale. Un parseur qui lit ligne par ligne produit « CONTACT PROJETS DEVOPS ET CLOUD » puis « 06 08 92 59 17 ARCHITECTURE CLOUD HAUTE DISPONIBILITÉ ». Les entités deviennent inextricables. Les parseurs récents détectent parfois les colonnes ; les anciens, jamais.

**Les zones de texte Word.** Le contenu d'une zone de texte n'est pas dans le flux principal du document. La plupart des parseurs ne le voient pas du tout. C'est pire qu'un tableau : ce n'est pas mal lu, c'est absent.

**Les en-têtes et pieds de page.** Taleo et iCIMS, notamment, extraient le corps du document et ignorent ces zones. Des coordonnées placées dans l'en-tête Word donnent une fiche candidat sans email ni téléphone. Le recruteur ne peut pas rappeler, même s'il le voulait.

**Les tableaux.** Certains parseurs lisent les cellules colonne par colonne, d'autres ligne par ligne, d'autres les ignorent. Le tableau à deux colonnes « dates | poste » est très courant et très risqué : les dates se détachent des intitulés, et l'ancienneté calculée devient fausse.

**Les graphiques, SmartArt, barres de compétences.** Zéro information transmise. « Python ★★★★☆ » n'est rien pour l'ATS, et pas grand-chose pour un recruteur.

**Les polices d'icônes.** Font Awesome et équivalents placent les pictogrammes dans la zone Unicode à usage privé. À l'extraction, ils deviennent des caractères parasites, souvent collés à l'email ou au téléphone, ce qui invalide l'extraction de l'entité.

**Les dates non normalisées.** « Depuis septembre dernier », « 3 ans chez Alpha », « 2021-22 » ne se calculent pas. Le format sûr est `MM/AAAA - MM/AAAA`, avec `Aujourd'hui` ou `En poste` pour le poste actuel.

## Notes par éditeur

| ATS | Diffusion | Comportement à connaître |
|---|---|---|
| **Workday** | grands comptes internationaux | Parsing correct, mais pondération forte par rubrique : un terme dans une expérience pèse plus que le même terme dans une liste de compétences. Formulaire de re-saisie long, souvent pré-rempli à partir du CV. |
| **Taleo** (Oracle) | grands groupes, secteur public | Génération ancienne, très répandue. Ignore en-têtes et pieds de page. Gère mal les colonnes et les tableaux. C'est le dénominateur commun à viser. |
| **SuccessFactors** (SAP) | grands comptes | Parsing correct. Filtrage fréquent par questions éliminatoires (mobilité, permis, niveau de diplôme) en amont de la lecture du CV. |
| **iCIMS** | ETI, Amérique du Nord | Parsing textuel simple, sensible à la mise en page. Ignore les zones de marge. |
| **Greenhouse, Lever, Ashby** | tech, scale-ups | Parsing moderne et plus tolérant. Le tri se fait surtout par recherche manuelle du recruteur : les mots-clés exacts comptent toujours autant. |
| **Talentsoft / Cegid** | France, grands comptes | Parsing français correct. Attention aux accents dans les PDF mal encodés. |
| **Flatchr, Teamtailor, Recruitee** | PME et ETI françaises | Parsing correct sur PDF texte et `.docx`, plus fragile sur les mises en page créatives. |
| **France Travail** | dépôt de CV public | Le CV est converti en fiche structurée. Un CV non extractible devient une fiche vide, invisible dans les recherches employeurs. |

## Ce qui ne relève pas du mythe

Trois idées fausses fréquentes, à corriger si l'utilisateur les évoque :

- **« 75 % des CV sont rejetés par un robot avant lecture humaine. »** Le chiffre est une extrapolation marketing. Les ATS trient, classent et filtrent sur des critères explicites, mais le rejet purement automatique à partir d'un score reste minoritaire. Ce qui est vrai : un CV mal parsé se retrouve en fin de liste et n'est jamais consulté.
- **« Il faut mettre des mots-clés en blanc sur blanc. »** Détecté par les ATS récents, et considéré comme une tentative de fraude quand un recruteur le repère.
- **« Le PDF est toujours plus sûr. »** Faux pour les ATS anciens. Quand le formulaire accepte les deux, le `.docx` passe mieux partout.

## La règle de conception

Un CV doit être lisible par le plus ancien des parseurs et agréable pour un humain pressé. En pratique : une colonne, des intitulés de rubrique standards, des dates normalisées, le texte dans le corps du document, et la mise en forme portée par la typographie plutôt que par des blocs graphiques.
