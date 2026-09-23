#!/usr/bin/env node
/**
 * analyse-cv.mjs - diagnostic de lisibilite ATS d'un fichier CV.
 *
 * Usage :
 *   node analyse-cv.mjs <cv> [--offre <fichier>] [--mots-cles <fichier>]
 *                            [--out <dossier>] [--json]
 *
 * Ecrit dans <dossier> : texte-extrait.txt et analyse.json.
 * Aucune dependance npm. PDF lu via pdf.js embarque dans vendor/.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

for (const P of [Map.prototype, WeakMap.prototype]) {
  if (!P.getOrInsert) P.getOrInsert = function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); };
  if (!P.getOrInsertComputed) P.getOrInsertComputed = function (k, fn) { if (!this.has(k)) this.set(k, fn(k)); return this.get(k); };
}
if (!Math.sumPrecise) Math.sumPrecise = (xs) => { let s = 0; for (const x of xs) s += x; return s; };

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node 22 minimum requis (version detectee : ${process.versions.node}). Le lecteur PDF embarque ne fonctionne pas en dessous.`);
  process.exit(1);
}

/* ------------------------------------------------------------------ outils */

const alertes = [];
const add = (gravite, item, code, message, detail) =>
  alertes.push({ gravite, item, code, message, ...(detail === undefined ? {} : { detail }) });

const sansAccents = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = (s) => sansAccents(String(s).toLowerCase().replace(/\b([ldjmnstc]|qu)['’]/g, '$1 '))
  .replace(/[^a-z0-9+#./ -]/g, ' ').replace(/\s+/g, ' ').trim();
const uniq = (a) => [...new Set(a)];
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function magic(buf) {
  const h = buf.subarray(0, 12);
  const s = (n) => h.subarray(0, n).toString('latin1');
  if (s(5) === '%PDF-') return 'pdf';
  if (s(4) === 'PK') return 'zip';
  if (h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0) return 'ole';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpeg';
  if (h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (s(3) === 'GIF') return 'gif';
  if (s(2) === 'BM') return 'bmp';
  if (s(4) === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (s(4) === 'II*\0' || s(4) === 'MM\0*') return 'tiff';
  if (buf.subarray(4, 12).toString('latin1').includes('ftyphei')) return 'heic';
  if (s(5) === '{\\rtf') return 'rtf';
  return 'inconnu';
}

/* --------------------------------------------------------------- lecteur zip */

function lireZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('archive zip illisible (fin de catalogue absente)');
  const nbEntrees = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error('archive zip64 non geree');
  const entrees = new Map();
  for (let n = 0; n < nbEntrees; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const methode = buf.readUInt16LE(off + 10);
    const tailleComp = buf.readUInt32LE(off + 20);
    const lnNom = buf.readUInt16LE(off + 28);
    const lnExtra = buf.readUInt16LE(off + 30);
    const lnComm = buf.readUInt16LE(off + 32);
    const offLocal = buf.readUInt32LE(off + 42);
    const nom = buf.subarray(off + 46, off + 46 + lnNom).toString('utf8');
    entrees.set(nom, { methode, tailleComp, offLocal });
    off += 46 + lnNom + lnExtra + lnComm;
  }
  const lire = (nom) => {
    const e = entrees.get(nom);
    if (!e) return null;
    const lnNom = buf.readUInt16LE(e.offLocal + 26);
    const lnExtra = buf.readUInt16LE(e.offLocal + 28);
    const debut = e.offLocal + 30 + lnNom + lnExtra;
    const data = buf.subarray(debut, debut + e.tailleComp);
    return e.methode === 0 ? data : zlib.inflateRawSync(data);
  };
  return { noms: [...entrees.keys()], lire };
}

/* ------------------------------------------------------------------ analyse PDF */

async function analysePdf(chemin, buf, rapport) {
  const base = pathToFileURL(path.join(HERE, 'vendor')).href + '/';
  const silence = console.warn;
  console.warn = () => {};
  const lib = await import(base + 'pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';

  let doc;
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true,
      isEvalSupported: false, verbosity: 0,
    }).promise;
  } catch (e) {
    console.warn = silence;
    add('bloquant', 'format', 'PDF_CORROMPU', `Le PDF ne s'ouvre pas : ${e.message}. Aucun ATS ne pourra le lire.`);
    rapport.pdf = { erreur: e.message };
    return '';
  }

  const meta = await doc.getMetadata().catch(() => ({}));
  const info = meta?.info ?? {};
  const permissions = await doc.getPermissions().catch(() => null);
  const marque = await doc.getMarkInfo?.().catch(() => null);

  const pdf = {
    pages: doc.numPages,
    producteur: info.Producer || null,
    createur: info.Creator || null,
    titre_metadonnees: info.Title || null,
    auteur_metadonnees: info.Author || null,
    pdf_balise: Boolean(marque?.Marked),
    chiffre: Boolean(info.IsEncrypted) || permissions !== null,
    formulaire_xfa: Boolean(info.IsXFAPresent),
    formulaire_acroform: Boolean(info.IsAcroFormPresent),
  };
  rapport.pdf = pdf;

  if (pdf.pages > 3) add('mineur', 'structure', 'PDF_TROP_LONG', `${pdf.pages} pages. Au-dela de 2 pages (3 pour un profil tres senior), les recruteurs decrochent.`);
  if (pdf.formulaire_xfa) add('bloquant', 'format', 'PDF_XFA', 'PDF de type formulaire XFA : le texte est dans une couche que la quasi-totalite des ATS ignore.');
  if (permissions && !permissions.includes(lib.PermissionFlag?.COPY ?? 16)) {
    add('bloquant', 'format', 'PDF_COPIE_INTERDITE', "Le PDF interdit la copie de texte. Beaucoup de parseurs ATS s'arretent la et enregistrent une fiche vide.");
  }
  if (/canva/i.test(pdf.producteur || '') || /canva/i.test(pdf.createur || '')) {
    add('majeur', 'format', 'PDF_CANVA', 'PDF exporte depuis Canva : ordre de lecture souvent melange, texte parfois vectorise, aucune balise de structure.');
  }
  if (/photoshop|illustrator|gimp|paint/i.test(`${pdf.producteur} ${pdf.createur}`)) {
    add('bloquant', 'format', 'PDF_GRAPHIQUE', `PDF produit par un logiciel graphique (${pdf.producteur || pdf.createur}) : le texte a de fortes chances d'etre une image ou des courbes.`);
  }
  if (!pdf.pdf_balise) {
    add('mineur', 'format', 'PDF_NON_BALISE', "PDF non balise (pas de structure logique). Les ATS recents s'appuient dessus pour separer les sections ; exportez depuis Word avec l'option d'accessibilite.");
  }

  const pages = [];
  let texteTotal = '', fluxNatif = '';
  let imagesTotal = 0, puaTotal = 0, texteInvisible = 0, texteBlanc = 0;
  const exemplesFusion = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vue = page.getViewport({ scale: 1 });
    const [, , largeur, hauteur] = [vue.viewBox[0], vue.viewBox[1], vue.viewBox[2] - vue.viewBox[0], vue.viewBox[3] - vue.viewBox[1]];
    const tc = await page.getTextContent();

    const items = tc.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({
        s: i.str,
        x: i.transform[4],
        y: i.transform[5],
        w: i.width || 0,
        h: Math.abs(i.transform[3]) || i.height || 0,
        f: i.fontName,
      }));

    const lignes = grouperLignes(items);
    const texte = lignes.map((l) => l.texte).join('\n');
    texteTotal += (n > 1 ? '\n\n' : '') + texte;
    fluxNatif += (n > 1 ? '\n\n' : '') + fluxBrut(items);

    let images = 0, invisible = 0, blanc = 0;
    try {
      const ops = await page.getOperatorList();
      const O = lib.OPS;
      let mode = 0, couleur = null;
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        if (fn === O.paintImageXObject || fn === O.paintJpegXObject || fn === O.paintImageMaskXObject || fn === O.paintInlineImageXObject) images++;
        else if (fn === O.setTextRenderingMode) mode = ops.argsArray[k][0];
        else if (fn === O.setFillRGBColor) couleur = ops.argsArray[k];
        else if (fn === O.showText || fn === O.showSpacedText) {
          if (mode === 3 || mode === 7) invisible++;
          else if (couleur && couleur[0] > 245 && couleur[1] > 245 && couleur[2] > 245) blanc++;
        }
      }
    } catch { /* liste d'operateurs indisponible : on garde le reste */ }

    imagesTotal += images; texteInvisible += invisible; texteBlanc += blanc;
    puaTotal += (texte.match(/[\uE000-\uF8FF]/g) || []).length;

    const mep = miseEnPage(items, lignes, largeur, hauteur);
    exemplesFusion.push(...mep.exemples_fusion);
    delete mep.exemples_fusion;

    pages.push({
      page: n, largeur: Math.round(largeur), hauteur: Math.round(hauteur),
      caracteres: texte.replace(/\s/g, '').length,
      lignes: lignes.length, images,
      mise_en_page: mep,
      entete_pied: enteteEtPied(lignes, hauteur),
    });
  }
  console.warn = silence;
  rapport.flux_natif = fluxNatif;

  const carTotal = texteTotal.replace(/\s/g, '').length;
  const parPage = Math.round(carTotal / doc.numPages);
  pdf.caracteres_par_page = parPage;
  pdf.images_total = imagesTotal;

  if (carTotal < 40) {
    add('bloquant', 'format', 'PDF_PLAT', "PDF plat : aucune couche de texte exploitable (CV scanne ou entierement transforme en image). Un ATS enregistre une fiche vide. C'est le defaut le plus grave possible.");
  } else if (parPage < 250) {
    add('bloquant', 'format', 'PDF_TEXTE_PARTIEL', `Seulement ${parPage} caracteres extraits par page. L'essentiel du CV est une image ou du texte vectorise, donc invisible pour l'ATS.`);
  } else if (parPage < 600) {
    add('majeur', 'format', 'PDF_TEXTE_MAIGRE', `${parPage} caracteres extraits par page seulement. Soit le CV est tres aere, soit une partie du contenu (titres, encadres, barres de competences) est en image et ne sera pas lue.`);
  }
  if (texteInvisible > 0) add('majeur', 'elements_illisibles', 'TEXTE_INVISIBLE', `${texteInvisible} bloc(s) de texte en mode de rendu invisible. Si c'est du bourrage de mots-cles, les ATS modernes le detectent et certains recruteurs ecartent la candidature.`);
  if (texteBlanc > 0) add('majeur', 'elements_illisibles', 'TEXTE_BLANC', `${texteBlanc} bloc(s) de texte en blanc sur fond blanc. Meme remarque : pratique consideree comme frauduleuse.`);
  if (puaTotal > 0) add('majeur', 'images_abreviations', 'GLYPHES_ICONES', `${puaTotal} caractere(s) issus d'une police d'icones (Font Awesome et equivalents). Ils ressortent en symboles illisibles dans la fiche ATS, souvent collles a l'email ou au telephone.`);
  if (imagesTotal > 1) add('majeur', 'images_abreviations', 'IMAGES_MULTIPLES', `${imagesTotal} images detectees. Au-dela de la photo, tout ce qui est image (logos, barres de competences, pictogrammes, QR code) est perdu a l'import.`);

  const pagesCol = pages.filter((p) => p.mise_en_page.colonnes >= 2);
  const fusion = pages.reduce((s, p) => s + p.mise_en_page.lignes_fusionnees, 0);
  if (pagesCol.length) {
    add('bloquant', 'elements_illisibles', 'MULTI_COLONNES',
      `Mise en page sur 2 colonnes (page${pagesCol.length > 1 ? 's' : ''} ${pagesCol.map((p) => p.page).join(', ')}) et ${fusion} ligne(s) ou les deux colonnes se retrouvent collees a l'extraction. Le parseur lit de gauche a droite sans voir la separation : le contenu de la barre laterale s'intercale au milieu des phrases.`,
      exemplesFusion.slice(0, 4));
  }
  const desordre = Math.max(...pages.map((p) => p.mise_en_page.desordre_flux), 0);
  if (desordre > 20) add('majeur', 'elements_illisibles', 'ORDRE_LECTURE', `Ordre de lecture du flux interne incoherent avec la mise en page (${desordre} % de retours en arriere). Les parseurs qui lisent le flux brut, sans reconstruire la geometrie, recuperent un texte melange.`);
  const tab = pages.reduce((s, p) => s + p.mise_en_page.blocs_tabulaires, 0);
  if (tab > 0) add('majeur', 'elements_illisibles', 'BLOCS_TABULAIRES', `${tab} bloc(s) en colonnes juxtaposees (tableau ou pseudo-tableau). Le texte des cellules est concatene n'importe comment.`);
  const enTete = pages.filter((p) => p.entete_pied.contact_en_zone).map((p) => p.page);
  if (enTete.length) add('majeur', 'elements_illisibles', 'CONTACT_EN_MARGE', `Coordonnees placees dans la zone d'en-tete ou de pied de page (page ${enTete.join(', ')}). Les ATS anciens (Taleo, iCIMS) ignorent ces zones : la fiche part sans email ni telephone.`);

  rapport.pages = pages;
  return texteTotal;
}

function grouperLignes(items) {
  const tri = [...items].sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x));
  const lignes = [];
  for (const it of tri) {
    const l = lignes[lignes.length - 1];
    if (l && Math.abs(l.y - it.y) <= 3) { l.items.push(it); l.y = (l.y + it.y) / 2; }
    else lignes.push({ y: it.y, items: [it] });
  }
  for (const l of lignes) {
    l.items.sort((a, b) => a.x - b.x);
    l.x0 = l.items[0].x;
    l.x1 = Math.max(...l.items.map((i) => i.x + i.w));
    l.h = Math.max(...l.items.map((i) => i.h));
    l.texte = l.items.map((i, k) => {
      const prec = l.items[k - 1];
      const espace = prec && i.x - (prec.x + prec.w) > Math.max(1.5, i.h * 0.22) ? ' ' : '';
      return espace + i.s;
    }).join('').replace(/\s+/g, ' ').trim();
    l.ordre = l.items[0];
  }
  return lignes.filter((l) => l.texte);
}

function fluxBrut(items) {
  return items.map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim();
}

function miseEnPage(items, lignes, largeur, hauteur) {
  const BINS = 100;
  const couverture = new Array(BINS).fill(0);
  for (const it of items) {
    const a = Math.max(0, Math.floor((it.x / largeur) * BINS));
    const b = Math.min(BINS - 1, Math.ceil(((it.x + it.w) / largeur) * BINS));
    for (let i = a; i <= b; i++) couverture[i] += it.s.length;
  }
  const max = Math.max(...couverture, 1);
  let meilleure = null, courant = null;
  for (let i = 15; i <= 85; i++) {
    if (couverture[i] < max * 0.03) courant = courant ?? i;
    else {
      if (courant !== null && i - courant >= 3) {
        const g = { debut: courant, fin: i };
        if (!meilleure || g.fin - g.debut > meilleure.fin - meilleure.debut) meilleure = g;
      }
      courant = null;
    }
  }

  let colonnes = 1, fusionnees = 0;
  const exemples = [];
  if (meilleure) {
    const xCoupe = ((meilleure.debut + meilleure.fin) / 2 / BINS) * largeur;
    const gauche = items.filter((i) => i.x + i.w <= xCoupe);
    const droite = items.filter((i) => i.x >= xCoupe);
    const carG = gauche.reduce((s, i) => s + i.s.length, 0);
    const carD = droite.reduce((s, i) => s + i.s.length, 0);
    if (gauche.length >= 5 && droite.length >= 5 && Math.min(carG, carD) > (carG + carD) * 0.12) {
      colonnes = 2;
      for (const l of lignes) {
        const aG = l.items.some((i) => i.x + i.w <= xCoupe);
        const aD = l.items.some((i) => i.x >= xCoupe);
        if (aG && aD) { fusionnees++; if (exemples.length < 4) exemples.push(l.texte); }
      }
    }
  }

  let retours = 0;
  for (let i = 1; i < items.length; i++) if (items[i].y > items[i - 1].y + 6) retours++;

  let tabulaires = 0, serie = 0;
  for (const l of lignes) {
    let trous = 0;
    for (let i = 1; i < l.items.length; i++) {
      if (l.items[i].x - (l.items[i - 1].x + l.items[i - 1].w) > largeur * 0.08) trous++;
    }
    if (trous >= 2) { serie++; if (serie === 3) tabulaires++; } else serie = 0;
  }

  return {
    colonnes,
    lignes_fusionnees: fusionnees,
    gouttiere: meilleure ? { debut_pct: meilleure.debut, fin_pct: meilleure.fin } : null,
    desordre_flux: pct(retours, Math.max(1, items.length - 1)),
    blocs_tabulaires: tabulaires,
    hauteur_page: Math.round(hauteur),
    exemples_fusion: exemples,
  };
}

const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;
const RE_TEL = /(?:\+\d{1,3}[\s.-]?)?(?:\(?0\)?[\s.-]?)?\d(?:[\s.-]?\d){8,11}/;

function enteteEtPied(lignes, hauteur) {
  const haut = lignes.filter((l) => l.y > hauteur * 0.94);
  const bas = lignes.filter((l) => l.y < hauteur * 0.06);
  const t = [...haut, ...bas].map((l) => l.texte).join(' ');
  return {
    entete: haut.map((l) => l.texte),
    pied: bas.map((l) => l.texte),
    contact_en_zone: RE_EMAIL.test(t) || RE_TEL.test(t),
  };
}

/* ----------------------------------------------------------------- analyse DOCX */

function analyseDocx(buf, rapport) {
  let zip;
  try { zip = lireZip(buf); }
  catch (e) { add('bloquant', 'format', 'DOCX_ILLISIBLE', `Archive Word illisible : ${e.message}`); return ''; }

  const xml = (n) => { const b = zip.lire(n); return b ? b.toString('utf8') : ''; };
  const corps = xml('word/document.xml');
  if (!corps) {
    add('bloquant', 'format', 'PAS_UN_DOCX', "L'archive ne contient pas word/document.xml : ce n'est pas un .docx exploitable (ancien .doc renomme ?).");
    return '';
  }
  const enTetes = zip.noms.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n));
  const medias = zip.noms.filter((n) => n.startsWith('word/media/'));
  const compte = (re, s = corps) => (s.match(re) || []).length;

  const docx = {
    tableaux: compte(/<w:tbl[ >]/g),
    zones_texte: compte(/<w:txbxContent[ >]/g),
    images: compte(/<a:blip[ >]/g) + compte(/<v:imagedata[ >]/g),
    fichiers_media: medias.length,
    colonnes: Math.max(0, ...[...corps.matchAll(/<w:cols[^>]*w:num="(\d+)"/g)].map((m) => Number(m[1]))),
    entetes_pieds: enTetes.length,
    smartart_graphiques: compte(/<a:graphicData[^>]*(diagram|chart)/g),
    champs_dynamiques: compte(/<w:fldChar[ >]/g),
    revisions: compte(/<w:(ins|del)[ >]/g),
    commentaires: zip.noms.includes('word/comments.xml'),
    styles_titres: uniq([...corps.matchAll(/<w:pStyle[^>]*w:val="([^"]*)"/g)].map((m) => m[1])).filter((s) => /head|titre|title/i.test(s)),
  };
  rapport.docx = docx;

  if (docx.tableaux > 0) add('majeur', 'elements_illisibles', 'TABLEAUX_WORD', `${docx.tableaux} tableau(x) Word. Beaucoup d'ATS lisent les cellules colonne par colonne ou les ignorent : dates et intitules se retrouvent dissocies.`);
  if (docx.zones_texte > 0) add('bloquant', 'elements_illisibles', 'ZONES_TEXTE_WORD', `${docx.zones_texte} zone(s) de texte. Le contenu d'une zone de texte est hors du flux principal : la plupart des parseurs ne le voient pas du tout.`);
  if (docx.colonnes >= 2) add('majeur', 'elements_illisibles', 'COLONNES_WORD', `Section en ${docx.colonnes} colonnes. Le texte des colonnes est entrelace a l'extraction.`);
  const nbImages = Math.max(docx.images, docx.fichiers_media);
  if (nbImages > 1) add('majeur', 'images_abreviations', 'IMAGES_WORD', `${nbImages} image(s) dans le document. Hors photo d'identite, tout contenu en image (logo, barre de competences, pictogramme, QR code) est perdu a l'import.`);
  if (docx.smartart_graphiques > 0) add('bloquant', 'elements_illisibles', 'SMARTART', 'SmartArt ou graphique detecte : contenu totalement invisible pour un ATS.');
  if (docx.revisions > 0) add('majeur', 'elements_illisibles', 'REVISIONS', `${docx.revisions} marque(s) de revision non acceptees. Le texte supprime peut ressortir dans la fiche ATS.`);
  if (docx.commentaires) add('majeur', 'elements_illisibles', 'COMMENTAIRES', 'Le document contient des commentaires Word. A supprimer avant envoi.');

  let texte = corps
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  const texteEnTete = enTetes.map(xml).join(' ').replace(/<[^>]+>/g, ' ');
  if (RE_EMAIL.test(texteEnTete) || RE_TEL.test(texteEnTete)) {
    add('majeur', 'elements_illisibles', 'CONTACT_EN_MARGE', "Coordonnees placees dans l'en-tete ou le pied de page Word. Les ATS anciens n'extraient pas ces zones.");
  }
  return texte.trim();
}

/* ------------------------------------------------------------- analyse contenu */

const SECTIONS = {
  profil: /^(profil|a propos|resume|accroche|presentation|objectif|profile|summary|about)\b/i,
  experience: /^(experiences?|parcours|carriere|emplois?|work experience|professional experience)\b/i,
  formation: /^(formations?|etudes?|diplomes?|scolarite|cursus|education|academic)\b/i,
  competences: /^(competences?|savoir-?faire|expertises?|skills|technical skills|stack)\b/i,
  langues: /^(langues?|languages?)\b/i,
  contact: /^(contacts?|coordonnees|me contacter)\b/i,
  certifications: /^(certifications?|habilitations?|accreditations?|licences?)\b/i,
  projets: /^(projets?|realisations?|portfolio|projects)\b/i,
  centres: /^(centres? d'?interets?|loisirs|hobbies|interests|divers)\b/i,
};

const RE_METIER = /\b(ingenieur|developpeu|administrateu|technicien|consultant|charge|responsable|directeu|manager|assistant|analyste|architecte|chef de|commercial|comptable|juriste|designer|devops|data|alternan|apprenti|stagiaire|expert|specialiste|conseill|gestionnaire|coordinat|supervis|operateu|agent|secretaire|infirmi|aide-soignant|vendeu|serveu|cuisini|electricien|plombier|mecanicien|logisticien|acheteu|product owner|scrum master|engineer|developer|lead|officer|specialist|analyst|director|head of|intern)\w*/i;

const ABREV_COURANTES = new Set(['CV', 'RH', 'PME', 'ETI', 'CDI', 'CDD', 'BTS', 'DUT', 'BUT', 'IUT', 'MBA', 'PDF', 'SQL', 'API', 'AWS', 'GCP', 'CSS', 'PHP', 'SAP', 'ERP', 'CRM', 'SEO', 'SEA', 'B2B', 'B2C', 'KPI', 'ROI', 'IA', 'UX', 'UI', 'QA', 'IT', 'CEO', 'CTO', 'CFO', 'COO', 'HTML', 'JSON', 'HTTP', 'HTTPS', 'REST', 'SSH', 'VPN', 'DNS', 'TCP', 'LAN', 'WAN', 'CI', 'CD', 'BAC', 'FR', 'EN', 'TOEIC', 'TOEFL']);

function analyseContenu(texte, rapport) {
  const lignes = texte.split('\n').map((l) => l.trim()).filter(Boolean);
  const mots = texte.split(/\s+/).filter(Boolean).length;

  const trouvees = [];
  for (const l of lignes) {
    const propre = l.replace(/[^\p{L}\p{N}' -]/gu, '').trim();
    if (propre.length > 40) continue;
    for (const [cle, re] of Object.entries(SECTIONS)) {
      if (re.test(sansAccents(propre)) && !trouvees.find((t) => t.section === cle)) trouvees.push({ section: cle, intitule: l });
    }
  }
  const attendues = ['experience', 'formation', 'competences'];
  const manquantes = attendues.filter((s) => !trouvees.find((t) => t.section === s));

  const exploitable = (l) => {
    const n = sansAccents(l).toLowerCase();
    return l.length >= 4 && l.length <= 90 && !RE_EMAIL.test(l) && !/^\+?[\d ().-]{8,}$/.test(l)
      && !/linkedin|github|www\.|https?:/.test(n) && /[a-z]/i.test(l)
      && !Object.values(SECTIONS).some((re) => re.test(n));
  };
  const tete = lignes.slice(0, 10).filter(exploitable);
  const titre = tete.find((l) => RE_METIER.test(sansAccents(l).toLowerCase())) ?? null;
  const nom = tete.find((l) => l !== titre) ?? null;

  const contact = {
    email: (texte.match(RE_EMAIL) || [null])[0],
    telephone: (texte.match(RE_TEL) || [null])[0],
    linkedin: /linkedin\.com\/in\//i.test(texte) || /linkedin/i.test(texte),
    ville: /\b\d{5}\b|\b(paris|lyon|marseille|toulouse|bordeaux|lille|nantes|nice|rennes|strasbourg|montpellier|remote|teletravail)\b/i.test(sansAccents(texte)),
  };

  const estTitreCapitales = (l) => {
    const lettres = l.replace(/[^\p{L}]/gu, '');
    return lettres.length >= 3 && lettres === lettres.toUpperCase();
  };
  const corpsMixte = lignes.filter((l) => !estTitreCapitales(l)).join('\n');
  const abreviations = uniq((corpsMixte.match(/(?<![\p{L}\p{N}])[A-Z][A-Z0-9]{1,5}(?![\p{L}\p{N}])/gu) || [])
    .filter((a) => !ABREV_COURANTES.has(a))
    .filter((a) => !new RegExp(`\\(\\s*${a}\\s*\\)`).test(texte))
    .filter((a) => !new RegExp(`\\b${a.charAt(0)}${a.slice(1).toLowerCase()}\\b`).test(texte)));

  const glyphes = uniq((texte.match(/[\uE000-\uF8FF\uFFFD\u2022\u25AA\u25CF\u2713\u2714\u2605\u2606\u2190-\u21FF]|[\u2700-\u27BF]|[\u{1F300}-\u{1FAFF}]/gu) || []));
  const puces = uniq((texte.match(/^[^\p{L}\p{N}\s]{1,2}(?=\s)/gmu) || [])).filter((p) => !['-', '*', '.', '>'].includes(p.trim()));

  const dates = texte.match(/\b(0?[1-9]|1[0-2])\/(19|20)\d{2}\b|\b(19|20)\d{2}\s*[-–—]\s*((19|20)\d{2}|aujourd|present|actuel)|\b(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(19|20)\d{2}/gi) || [];

  rapport.contenu = {
    mots, lignes: lignes.length,
    premieres_lignes: lignes.slice(0, 8),
    nom_candidat: nom,
    titre_candidat: titre,
    sections_detectees: trouvees,
    sections_manquantes: manquantes,
    coordonnees: contact,
    abreviations_non_glosees: abreviations,
    glyphes_exotiques: glyphes,
    puces_non_standard: puces,
    occurrences_dates: dates.length,
  };

  if (!titre) add('bloquant', 'titre', 'TITRE_ABSENT', `Aucun intitule de poste identifiable dans les premieres lignes (lues : ${tete.slice(0, 4).map((l) => `"${l}"`).join(', ') || 'aucune'}). L'ATS indexe et classe le candidat sur ce titre : sans lui, le CV ne remonte dans aucune recherche par intitule.`);
  else if (titre.split(/\s+/).length > 8) add('mineur', 'titre', 'TITRE_TROP_LONG', `Intitule trop long ("${titre}"). Un titre de 2 a 5 mots, calque mot pour mot sur celui des offres visees, est mieux reconnu.`);
  for (const s of manquantes) add('majeur', 'structure', `SECTION_${s.toUpperCase()}`, `Aucun titre de section "${s}" clairement identifie. Les ATS decoupent le CV sur ces intitules standards ; sans eux le contenu part dans la mauvaise rubrique.`);
  if (trouvees.length && trouvees.length < 4) add('mineur', 'structure', 'PEU_DE_SECTIONS', `Seulement ${trouvees.length} sections reconnues. Utilisez les intitules standards : Profil, Experience professionnelle, Formation, Competences, Langues.`);
  if (!contact.email) add('bloquant', 'structure', 'EMAIL_ABSENT', "Aucune adresse email extraite du texte. Si elle est en image ou dans une zone ignoree, l'ATS cree une fiche sans moyen de contact.");
  if (!contact.telephone) add('majeur', 'structure', 'TEL_ABSENT', 'Aucun numero de telephone extrait du texte.');
  if (abreviations.length) add('mineur', 'images_abreviations', 'ABREVIATIONS', `${abreviations.length} sigle(s) jamais explicites : ${abreviations.slice(0, 15).join(', ')}. Ecrivez la forme longue suivie du sigle entre parentheses - les deux formes sont recherchees par les recruteurs.`);
  if (glyphes.length) add('mineur', 'images_abreviations', 'SYMBOLES', `Symboles ou emojis presents (${glyphes.slice(0, 10).join(' ')}) : ils ressortent en caracteres parasites dans la fiche.`);
  if (puces.length) add('mineur', 'elements_illisibles', 'PUCES_EXOTIQUES', `Puces non standard (${puces.slice(0, 8).join(' ')}). Preferez un tiret ou une puce ronde classique.`);
  if (dates.length < 2) add('majeur', 'structure', 'DATES_ABSENTES', "Peu ou pas de dates au format reconnaissable. Les ATS calculent l'anciennete a partir de MM/AAAA - MM/AAAA : sans ce format, l'experience est comptee a zero.");
  if (mots < 250) add('majeur', 'structure', 'CV_TROP_COURT', `${mots} mots extraits seulement. Soit le CV est trop leger, soit une partie du texte n'est pas extractible.`);
}

/* -------------------------------------------------------------- mots-cles */

const VIDES = new Set(('le la les un une des du de d a au aux et ou ou mais donc or ni car que qui quoi dont ou ce cet cette ces son sa ses leur leurs notre nos votre vos mon ma mes ton ta tes il elle ils elles on nous vous je tu se sur sous dans par pour avec sans chez vers entre apres avant depuis pendant plus moins tres tout tous toute toutes meme aussi bien deja encore lors selon afin ainsi comme est sont etre ete avoir eu fait faire vous etes poste offre emploi mission missions profil recherche recherchons entreprise societe groupe equipe candidat candidature contrat cdi cdd stage alternance salaire remuneration avantages mutuelle teletravail annees annee an ans mois jour jours h f h/f w m the and or of to in for with a an is are be you your we our will who what this that on at as by from it its their they'
).split(/\s+/));

const PROTEGE = '';

function segmenter(txt) {
  return String(txt)
    .replace(/\b([ldjmnstcLDJMNSTC]|[qQ]u)['’]/g, '$1 ')
    .replace(/([A-Za-z0-9])\/([A-Za-z0-9])/g, `$1${PROTEGE}$2`)
    .split(/[\n\r.,;:!?()\[\]{}"«»•·|*]+|\s[-–—]\s/)
    .map((s) => s.replace(/^[\s\-–—•*>]+/, '').trim())
    .filter(Boolean);
}

const normJeton = (s) => sansAccents(s.toLowerCase()).replace(/[^a-z0-9+#-]/g, '').replace(/^-+|-+$/g, '');

/**
 * Extrait les expressions significatives d'un texte d'offre.
 * Un terme ecrit avec une majuscule ou un chiffre ailleurs qu'en tete de phrase
 * est traite comme un signal fort : c'est presque toujours un nom d'outil,
 * de techno ou de certification, donc un mot-cle indexe tel quel par l'ATS.
 */
function extraireTermes(txt, nMax = 3) {
  const stats = new Map();
  const forts = new Set();
  for (const segment of segmenter(txt)) {
    const bruts = segment.split(/\s+/).filter(Boolean);
    const jetons = bruts.map(normJeton);
    bruts.forEach((brut, j) => {
      const t = jetons[j];
      if (!t || VIDES.has(t)) return;
      if (/[A-Z]{2,}|[a-z][A-Z]|\d/.test(brut) || (j > 0 && /^[A-Z]/.test(brut))) forts.add(t);
    });
    for (let n = 1; n <= nMax; n++) {
      for (let i = 0; i + n <= jetons.length; i++) {
        const g = jetons.slice(i, i + n);
        if (g.some((t) => !t || t.length < 2)) continue;
        if (VIDES.has(g[0]) || VIDES.has(g[g.length - 1])) continue;
        if (n === 1 && (g[0].length < 3 || /^\d+$/.test(g[0]))) continue;
        const cle = g.join(' ');
        const e = stats.get(cle) ?? { occurrences: 0, mots: n };
        e.occurrences++;
        stats.set(cle, e);
      }
    }
  }
  return [...stats.entries()]
    .map(([terme, e]) => {
      const fort = terme.split(' ').some((t) => forts.has(t));
      return { terme: terme.replaceAll(PROTEGE, '/'), occurrences: e.occurrences, mots: e.mots, fort, score: e.occurrences * (1 + 0.4 * (e.mots - 1)) * (fort ? 2.2 : 1) };
    })
    .filter((e) => e.mots === 1 || e.occurrences > 1 || e.fort)
    .sort((a, b) => b.score - a.score || b.occurrences - a.occurrences);
}

function comparerOffre(texteCv, texteOffre, rapport) {
  const cv = ' ' + norm(texteCv).replaceAll(PROTEGE, '/') + ' ';
  const present = (t) => cv.includes(' ' + t) || cv.includes('/' + t) || cv.includes('-' + t);

  const tous = extraireTermes(texteOffre);
  const retenus = tous.slice(0, 100);
  const presents = retenus.filter((e) => present(e.terme));
  const absents = retenus.filter((e) => !present(e.terme));
  const fortsAbsents = tous.filter((e) => e.fort && e.mots === 1 && !present(e.terme));

  const exigences = uniq((texteOffre.match(/(?:maitris\w+|connaissanc\w+|experienc\w+|expertise|pratique|capacite)\s+(?:de\s+|du\s+|des\s+|en\s+|sur\s+|d'\s*)?[^.,;\n]{3,70}/gi) || [])
    .map((s) => s.trim().replace(/\s+/g, ' ')));
  const annees = uniq(texteOffre.match(/\d+\s*(?:a\s*\d+\s*)?an(?:s|nees)?\s+d(?:'|e\s+)?experienc\w*/gi) || []);
  const diplomes = uniq(texteOffre.match(/\b(bac\s*\+\s*\d|master|licence|bts|but|dut|doctorat|ingenieur diplome|mba)\b/gi) || []);

  rapport.mots_cles_offre = {
    termes_analyses: retenus.length,
    couverture_pct: pct(presents.length, retenus.length),
    couverture_termes_forts_pct: pct(tous.filter((e) => e.fort && e.mots === 1 && present(e.terme)).length,
      Math.max(1, tous.filter((e) => e.fort && e.mots === 1).length)),
    termes_forts_absents: fortsAbsents.slice(0, 40).map((e) => e.terme),
    presents: presents.slice(0, 50).map((e) => e.terme),
    absents: absents.slice(0, 50).map((e) => ({ terme: e.terme, occurrences: e.occurrences, fort: e.fort })),
    exigences_detectees: exigences.slice(0, 25),
    annees_experience_demandees: annees,
    diplomes_demandes: diplomes,
  };

  const c = rapport.mots_cles_offre.couverture_pct;
  if (c < 60) add('majeur', 'mots_cles', 'COUVERTURE_FAIBLE', `Seulement ${c} % des expressions significatives de l'offre figurent dans le CV. En dessous de 60 %, le score de rapprochement de l'ATS place la candidature en bas de pile.`);
  if (fortsAbsents.length) add('majeur', 'mots_cles', 'TECHNOS_ABSENTES', `${fortsAbsents.length} terme(s) techniques de l'offre absents du CV : ${fortsAbsents.slice(0, 20).map((e) => e.terme).join(', ')}. Ce sont ceux que le recruteur tape en priorite dans le moteur de recherche de l'ATS.`);
}

function verifierListe(texteCv, listeBrute, rapport) {
  const cv = norm(texteCv);
  const termes = uniq(listeBrute.split(/[\n,;]+/).map((s) => norm(s)).filter((s) => s.length > 1));
  const presents = termes.filter((t) => cv.includes(t));
  const absents = termes.filter((t) => !cv.includes(t));
  rapport.mots_cles_liste = { total: termes.length, couverture_pct: pct(presents.length, termes.length), presents, absents };
}

/* ------------------------------------------------------------------- rapport */

function afficher(rapport) {
  const f = rapport.fichier;
  const l = [];
  l.push(`\n=== Diagnostic ATS - ${f.nom} ===`);
  l.push(`Format : ${f.format_detecte.toUpperCase()}${f.coherence_extension ? '' : ` (extension .${f.extension} trompeuse)`} - ${f.taille_ko} Ko`);
  if (rapport.pdf) l.push(`PDF : ${rapport.pdf.pages} page(s), producteur ${rapport.pdf.producteur || 'inconnu'}, ${rapport.pdf.caracteres_par_page ?? 0} caracteres/page, ${rapport.pdf.images_total ?? 0} image(s)`);
  if (rapport.docx) l.push(`DOCX : ${rapport.docx.tableaux} tableau(x), ${rapport.docx.zones_texte} zone(s) de texte, ${rapport.docx.images} image(s), ${rapport.docx.colonnes || 1} colonne(s)`);
  if (rapport.contenu) {
    l.push(`Nom detecte : ${rapport.contenu.nom_candidat || 'AUCUN'}`);
    l.push(`Intitule de poste detecte : ${rapport.contenu.titre_candidat || 'AUCUN'}`);
    l.push(`Sections : ${rapport.contenu.sections_detectees.map((s) => s.section).join(', ') || 'aucune'}`);
    l.push(`Contenu : ${rapport.contenu.mots} mots, ${rapport.contenu.occurrences_dates} date(s) exploitables`);
  }
  if (rapport.mots_cles_offre) l.push(`Couverture de l'offre : ${rapport.mots_cles_offre.couverture_pct} % (${rapport.mots_cles_offre.absents.length} termes absents listes dans analyse.json)`);
  if (rapport.mots_cles_liste) l.push(`Couverture de la liste fournie : ${rapport.mots_cles_liste.couverture_pct} % (${rapport.mots_cles_liste.absents.length} manquants)`);

  const parGravite = { bloquant: [], majeur: [], mineur: [] };
  for (const a of rapport.alertes) parGravite[a.gravite].push(a);
  for (const [g, titre] of [['bloquant', 'BLOQUANTS'], ['majeur', 'MAJEURS'], ['mineur', 'MINEURS']]) {
    if (!parGravite[g].length) continue;
    l.push(`\n-- ${titre} (${parGravite[g].length}) --`);
    for (const a of parGravite[g]) l.push(`[${a.item}] ${a.code} : ${a.message}`);
  }
  if (!rapport.alertes.length) l.push('\nAucun probleme de lisibilite detecte.');
  l.push(`\nFichiers ecrits : ${rapport.sorties.join(', ')}\n`);
  return l.join('\n');
}

/* ---------------------------------------------------------------------- main */

async function main() {
  const args = process.argv.slice(2);
  const AVEC_VALEUR = new Set(['--offre', '--mots-cles', '--out']);
  const options = {};
  const positionnels = [];
  for (let i = 0; i < args.length; i++) {
    if (AVEC_VALEUR.has(args[i])) { options[args[i]] = args[++i] ?? null; }
    else if (args[i].startsWith('--')) options[args[i]] = true;
    else positionnels.push(args[i]);
  }
  const opt = (n) => (typeof options[n] === 'string' ? options[n] : null);
  const cible = positionnels[0];

  if (!cible || options['--help']) {
    console.log(`analyse-cv ${VERSION}\nUsage : node analyse-cv.mjs <cv.pdf|cv.docx> [--offre offre.txt] [--mots-cles liste.txt] [--out dossier] [--json]`);
    process.exit(cible ? 0 : 1);
  }
  if (!fs.existsSync(cible)) { console.error(`Fichier introuvable : ${cible}`); process.exit(1); }

  const buf = fs.readFileSync(cible);
  const ext = path.extname(cible).slice(1).toLowerCase();
  const reel = magic(buf);
  const sortie = opt('--out') || path.join(path.dirname(cible), 'audit-ats');
  fs.mkdirSync(sortie, { recursive: true });

  const rapport = {
    version: VERSION,
    fichier: {
      nom: path.basename(cible), chemin: path.resolve(cible), extension: ext,
      format_detecte: reel === 'zip' ? (ext === 'odt' ? 'odt' : 'docx') : reel,
      taille_ko: Math.round(buf.length / 102.4) / 10,
      coherence_extension: (reel === 'pdf' && ext === 'pdf') || (reel === 'zip' && ['docx', 'odt'].includes(ext)) || (reel === 'ole' && ext === 'doc') || ['jpeg', 'png', 'gif', 'webp', 'tiff', 'heic', 'bmp'].includes(reel),
    },
    alertes: [], sorties: [],
  };

  let texte = '';
  if (reel === 'pdf') {
    texte = await analysePdf(cible, buf, rapport);
  } else if (reel === 'zip' && ext === 'docx') {
    texte = analyseDocx(buf, rapport);
  } else if (['jpeg', 'png', 'gif', 'webp', 'tiff', 'heic', 'bmp'].includes(reel)) {
    add('bloquant', 'format', 'FORMAT_IMAGE', `Le CV est une image (${reel.toUpperCase()}). Aucun ATS n'en extrait le texte : la candidature est rejetee ou enregistree vide. Refaites le CV en PDF texte ou en .docx.`);
  } else if (reel === 'ole') {
    add('majeur', 'format', 'FORMAT_DOC', 'Ancien format .doc (Word 97-2003). Mal gere par plusieurs ATS recents. Enregistrez en .docx ou en PDF texte.');
  } else if (reel === 'zip' && ext === 'odt') {
    add('majeur', 'format', 'FORMAT_ODT', "Format OpenDocument (.odt) : rarement accepte par les formulaires de candidature. Exportez en PDF ou .docx.");
  } else if (reel === 'rtf') {
    add('majeur', 'format', 'FORMAT_RTF', 'Format RTF : accepte par certains ATS mais la mise en forme et les accents se degradent souvent.');
  } else {
    add('bloquant', 'format', 'FORMAT_INCONNU', `Format non reconnu (${reel}, extension .${ext}). Les formulaires de candidature refuseront le fichier.`);
  }

  if (!rapport.fichier.coherence_extension) {
    add('majeur', 'format', 'EXTENSION_TROMPEUSE', `Le contenu reel est du ${reel} alors que l'extension annonce .${ext}. Beaucoup de formulaires rejettent le fichier a l'upload.`);
  }
  if (rapport.fichier.taille_ko > 2048) {
    add('mineur', 'format', 'FICHIER_LOURD', `${rapport.fichier.taille_ko} Ko. Plusieurs portails limitent l'upload a 2 Mo et le poids vient en general d'images inutiles.`);
  }

  if (texte.trim()) analyseContenu(texte, rapport);

  const offre = opt('--offre');
  if (offre) {
    if (!fs.existsSync(offre)) { console.error(`Offre introuvable : ${offre}`); process.exit(1); }
    comparerOffre(texte, fs.readFileSync(offre, 'utf8'), rapport);
  }
  const liste = opt('--mots-cles');
  if (liste) {
    if (!fs.existsSync(liste)) { console.error(`Liste introuvable : ${liste}`); process.exit(1); }
    verifierListe(texte, fs.readFileSync(liste, 'utf8'), rapport);
  }

  rapport.alertes = alertes;
  rapport.synthese = {
    bloquants: alertes.filter((a) => a.gravite === 'bloquant').length,
    majeurs: alertes.filter((a) => a.gravite === 'majeur').length,
    mineurs: alertes.filter((a) => a.gravite === 'mineur').length,
    par_item: Object.fromEntries(['titre', 'format', 'structure', 'mots_cles', 'images_abreviations', 'elements_illisibles']
      .map((i) => [i, alertes.filter((a) => a.item === i).map((a) => a.code)])),
  };

  const fTexte = path.join(sortie, 'texte-extrait.txt');
  const fJson = path.join(sortie, 'analyse.json');
  rapport.sorties = [fTexte, fJson];
  fs.writeFileSync(fTexte, texte || '(aucun texte extractible)', 'utf8');

  if (rapport.flux_natif) {
    const fFlux = path.join(sortie, 'flux-natif.txt');
    fs.writeFileSync(fFlux, rapport.flux_natif, 'utf8');
    rapport.sorties.push(fFlux);
    delete rapport.flux_natif;
  }
  fs.writeFileSync(fJson, JSON.stringify(rapport, null, 2), 'utf8');

  console.log(options['--json'] ? JSON.stringify(rapport, null, 2) : afficher(rapport));
}

main().catch((e) => { console.error(`Echec de l'analyse : ${e.stack || e.message}`); process.exit(1); });
