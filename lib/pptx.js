'use strict';
/*
 * Crear un .pptx vacio.
 *
 * Va en su propio fichero y no en escribir.js porque una presentacion pide
 * bastante mas andamiaje que un documento o una hoja: PowerPoint no abre un
 * pptx que no traiga, ademas de la diapositiva, su patron, su diseno y su tema.
 * Son nueve partes y ninguna es opcional; con que falte una, dice que el
 * fichero esta danado y no lo abre.
 *
 * Se escribe el minimo de la especificacion, igual que en el resto de la casa:
 * una diapositiva de titulo con dos marcos vacios, para poder escribir en
 * cuanto se abre. Lo que no se toca -- transiciones, animaciones, patrones
 * adicionales -- no se inventa.
 *
 * Medidas en EMU, que es la unidad del formato: 914.400 por pulgada. La
 * diapositiva es 12.192.000 x 6.858.000, o sea 13,3 x 7,5 pulgadas, que es el
 * 16:9 que usa PowerPoint por omision.
 */
const zip = require('./zip');

const CABECERA = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const TIPOS = CABECERA +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
  '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
  '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
  '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
  '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
  '</Types>';

const RELS = CABECERA +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
  '</Relationships>';

const PRESENTACION = CABECERA +
  '<p:presentation ' + NS_P + '>' +
  '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
  '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
  '<p:sldSz cx="12192000" cy="6858000"/>' +
  '<p:notesSz cx="6858000" cy="9144000"/>' +
  '</p:presentation>';

const RELS_PRESENTACION = CABECERA +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
  '</Relationships>';

/* Un arbol de formas vacio. Los tres primeros elementos son obligatorios en
   cualquier diapositiva, patron o diseno, aunque no haya nada dibujado. */
const ARBOL_VACIO =
  '<p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/* El mapa de colores es obligatorio en el patron: dice cual de los doce
   colores del tema hace de fondo, cual de texto y asi. */
const MAPA_COLOR = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"' +
  ' accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5"' +
  ' accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

const PATRON = CABECERA +
  '<p:sldMaster ' + NS_P + '>' +
  '<p:cSld>' + ARBOL_VACIO + '</p:spTree></p:cSld>' +
  MAPA_COLOR +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '</p:sldMaster>';

const RELS_PATRON = CABECERA +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  '</Relationships>';

/*
 * El diseno de portada: dos marcos, titulo y subtitulo, colocados donde los
 * pone PowerPoint. La diapositiva luego solo tiene que decir "aqui va el
 * titulo" y hereda de aqui el sitio y el tamano de letra.
 */
function marco(id, nombre, tipo, idx, x, y, cx, cy, tamano, centrado) {
  return '<p:sp><p:nvSpPr>' +
    '<p:cNvPr id="' + id + '" name="' + nombre + '"/>' +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="' + tipo + '"' + (idx != null ? ' idx="' + idx + '"' : '') + '/></p:nvPr>' +
    '</p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/>' +
    '<a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle>' +
    '<a:lvl1pPr' + (centrado ? ' algn="ctr"' : '') + '>' +
    '<a:defRPr sz="' + tamano + '"/></a:lvl1pPr></a:lstStyle>' +
    '<a:p><a:endParaRPr lang="es-ES"/></a:p></p:txBody></p:sp>';
}

const DISENO = CABECERA +
  '<p:sldLayout ' + NS_P + ' type="title" preserve="1">' +
  '<p:cSld name="Diapositiva de título">' + ARBOL_VACIO +
  marco(2, 'Título', 'ctrTitle', null, 1524000, 1867500, 9144000, 1965600, 4400, true) +
  marco(3, 'Subtítulo', 'subTitle', 1, 1524000, 3886200, 9144000, 1136800, 2400, true) +
  '</p:spTree></p:cSld>' +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
  '</p:sldLayout>';

const RELS_DISENO = CABECERA +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  '</Relationships>';

const RELS_DIAPOSITIVA = CABECERA +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '</Relationships>';

/* Los doce colores que exige el esquema, en gris y azul: un tema sobrio del
   que se pueda partir sin que parezca elegido por nadie. */
const COLORES = [
  ['dk1', '000000'], ['lt1', 'FFFFFF'], ['dk2', '44546A'], ['lt2', 'E7E6E6'],
  ['accent1', '4472C4'], ['accent2', 'ED7D31'], ['accent3', 'A5A5A5'],
  ['accent4', 'FFC000'], ['accent5', '5B9BD5'], ['accent6', '70AD47'],
  ['hlink', '0563C1'], ['folHlink', '954F72'],
];

const esquemaColor = '<a:clrScheme name="Office">' + COLORES.map(([nombre, valor]) => {
  /* Los dos primeros van envueltos en sysClr y el resto en srgbClr; es como lo
     escribe Office y lo que menos sorpresas da al abrirlo. */
  const dentro = nombre === 'dk1' ? '<a:sysClr val="windowText" lastClr="000000"/>'
    : nombre === 'lt1' ? '<a:sysClr val="window" lastClr="FFFFFF"/>'
      : '<a:srgbClr val="' + valor + '"/>';
  return '<a:' + nombre + '>' + dentro + '</a:' + nombre + '>';
}).join('') + '</a:clrScheme>';

const esquemaFuente = '<a:fontScheme name="Office">' +
  ['major', 'minor'].map((cual) =>
    '<a:' + cual + 'Font><a:latin typeface="Calibri"/><a:ea typeface=""/>' +
    '<a:cs typeface=""/></a:' + cual + 'Font>').join('') +
  '</a:fontScheme>';

/* Tres rellenos, tres lineas, tres efectos y tres fondos: el esquema de formato
   exige exactamente esas cantidades. */
const esquemaFormato = '<a:fmtScheme name="Office">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3) +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  ('<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">' +
   '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
   '<a:prstDash val="solid"/></a:ln>').repeat(3) +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) +
  '</a:effectStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3) +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme>';

const TEMA = CABECERA +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">' +
  '<a:themeElements>' + esquemaColor + esquemaFuente + esquemaFormato + '</a:themeElements>' +
  '<a:objectDefaults/><a:extraClrSchemeLst/>' +
  '</a:theme>';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/* Un marco de la diapositiva: hereda sitio y tamano del diseno, asi que aqui
   solo hace falta decir de que marco se trata y que pone dentro. */
function marcoDiapositiva(id, nombre, tipo, idx, texto) {
  const parrafo = texto
    ? '<a:p><a:r><a:rPr lang="es-ES" dirty="0"/><a:t>' + esc(texto) + '</a:t></a:r></a:p>'
    : '<a:p><a:endParaRPr lang="es-ES"/></a:p>';
  return '<p:sp><p:nvSpPr>' +
    '<p:cNvPr id="' + id + '" name="' + nombre + '"/>' +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="' + tipo + '"' + (idx != null ? ' idx="' + idx + '"' : '') + '/></p:nvPr>' +
    '</p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' + parrafo + '</p:txBody></p:sp>';
}

/*
 * La presentacion vacia. `titulo` se pone en el marco del titulo si se pasa;
 * al crear desde la pantalla se deja en blanco, que es lo que se espera de un
 * fichero nuevo.
 */
function pptx(titulo = '', subtitulo = '') {
  const diapositiva = CABECERA +
    '<p:sld ' + NS_P + '>' +
    '<p:cSld>' + ARBOL_VACIO +
    marcoDiapositiva(2, 'Título 1', 'ctrTitle', null, titulo) +
    marcoDiapositiva(3, 'Subtítulo 2', 'subTitle', 1, subtitulo) +
    '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '</p:sld>';

  return zip.crear([
    { nombre: '[Content_Types].xml', datos: TIPOS },
    { nombre: '_rels/.rels', datos: RELS },
    { nombre: 'ppt/presentation.xml', datos: PRESENTACION },
    { nombre: 'ppt/_rels/presentation.xml.rels', datos: RELS_PRESENTACION },
    { nombre: 'ppt/slideMasters/slideMaster1.xml', datos: PATRON },
    { nombre: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', datos: RELS_PATRON },
    { nombre: 'ppt/slideLayouts/slideLayout1.xml', datos: DISENO },
    { nombre: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', datos: RELS_DISENO },
    { nombre: 'ppt/slides/slide1.xml', datos: diapositiva },
    { nombre: 'ppt/slides/_rels/slide1.xml.rels', datos: RELS_DIAPOSITIVA },
    { nombre: 'ppt/theme/theme1.xml', datos: TEMA },
  ]);
}

module.exports = { pptx };
