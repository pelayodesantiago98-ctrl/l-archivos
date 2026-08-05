'use strict';
/*
 * Guardar un .docx o un .xlsx a partir de lo que se edita en el navegador.
 *
 * Se escribe el minimo que Word y Excel dan por bueno, no todo lo que admite el
 * formato: un documento con parrafos, titulos, negrita, cursiva y listas, y una
 * hoja con celdas de texto o numero. Lo que no se toca se pierde, y por eso al
 * abrir un fichero que traiga cosas raras la pantalla avisa antes de dejar
 * guardar encima.
 *
 * Los XML van escritos a mano y no con una libreria de plantillas porque son
 * cuatro ficheros fijos: lo unico que cambia de verdad es el cuerpo.
 */
const zip = require('./zip');

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Los caracteres de control revientan el XML y Word se niega a abrir el fichero
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/* ── Word ─────────────────────────────────────────────────────────────────── */

const TIPOS_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const RELS_DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/* Los estilos de titulo tienen que estar declarados o Word ignora el nombre y
   los pinta como texto normal. */
const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
${[1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}">
<w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="${n - 1}"/><w:spacing w:before="${320 - n * 40}" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="${36 - n * 4}"/></w:rPr></w:style>`).join('')}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;

function docx(parrafos) {
  const cuerpo = (parrafos || []).map((p) => {
    const trozos = (p.trozos && p.trozos.length ? p.trozos : [{ texto: p.texto || '' }]);
    const runs = trozos.map((t) => {
      const props = []
        .concat(t.negrita ? '<w:b/>' : [])
        .concat(t.cursiva ? '<w:i/>' : [])
        .concat(t.subrayado ? '<w:u w:val="single"/>' : []);
      return '<w:r>' + (props.length ? '<w:rPr>' + props.join('') + '</w:rPr>' : '')
        // xml:space preserve o Word se come los espacios de los extremos
        + '<w:t xml:space="preserve">' + esc(t.texto) + '</w:t></w:r>';
    }).join('');

    const pPr = [];
    if (p.titulo) pPr.push(`<w:pStyle w:val="Heading${Math.min(3, p.titulo)}"/>`);
    else if (p.lista) pPr.push('<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    if (p.alineacion && p.alineacion !== 'left') pPr.push(`<w:jc w:val="${esc(p.alineacion)}"/>`);

    return '<w:p>' + (pPr.length ? '<w:pPr>' + pPr.join('') + '</w:pPr>' : '') + runs + '</w:p>';
  }).join('');

  return zip.crear([
    { nombre: '[Content_Types].xml', datos: TIPOS_DOCX },
    { nombre: '_rels/.rels', datos: RELS },
    { nombre: 'word/_rels/document.xml.rels', datos: RELS_DOC },
    { nombre: 'word/styles.xml', datos: ESTILOS },
    { nombre: 'word/document.xml', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${cuerpo}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
</w:body></w:document>` },
  ]);
}

/* ── Excel ────────────────────────────────────────────────────────────────── */

const TIPOS_XLSX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const RELS_XLSX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const RELS_LIBRO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/*
 * Los nombres de funcion, al ingles.
 *
 * Dentro del XML las formulas van SIEMPRE en ingles: "SUMA" es como lo pinta
 * Excel en espanol, no como lo guarda. Escribiendo "SUMA(B2:B3)" el fichero se
 * abre pero la celda dice #NAME?, porque no conoce esa funcion. Se vio
 * convirtiendo la hoja con LibreOffice, que dio #NAME? en las dos formulas.
 *
 * Se traduce al guardar y no al escribir en la celda para que se pueda seguir
 * escribiendo en espanol, que es como esta el resto de la casa.
 */
const FUNCIONES = {
  SUMA: 'SUM', PROMEDIO: 'AVERAGE', CONTAR: 'COUNT', CONTARA: 'COUNTA',
  MINIMO: 'MIN', MAXIMO: 'MAX', REDONDEAR: 'ROUND', SI: 'IF',
  CONCATENAR: 'CONCATENATE', HOY: 'TODAY', AHORA: 'NOW',
};

function aIngles(formula) {
  // Solo lo que va pegado a un parentesis es un nombre de funcion; asi no se
  // toca un texto que casualmente diga "SI" ni una referencia llamada MAX1.
  return formula.replace(/([A-Za-zÁÉÍÓÚÑáéíóúñ]+)\s*\(/g, (todo, nombre) => {
    const clave = nombre.toUpperCase()
      .replace(/Á/g, 'A').replace(/É/g, 'E').replace(/Í/g, 'I')
      .replace(/Ó/g, 'O').replace(/Ú/g, 'U').replace(/Ñ/g, 'N');
    return (FUNCIONES[clave] || nombre.toUpperCase()) + '(';
  });
}

// A, B, ... Z, AA, AB...
function columna(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function xlsx(filas, nombreHoja) {
  const xmlFilas = (filas || []).map((celdas, i) => {
    const cs = (celdas || []).map((v, j) => {
      const ref = columna(j) + (i + 1);
      if (v === '' || v == null) return '';
      const texto = String(v);

      /* Una formula empieza por "=" y se guarda como tal para que Excel la
         calcule al abrir. No se guarda el resultado: si lo guardaramos con el
         que hemos calculado aqui y Excel no estuviera de acuerdo, ganaria el
         nuestro y saldria un numero mal. */
      if (texto.startsWith('=')) {
        return `<c r="${ref}"><f>${esc(aIngles(texto.slice(1)))}</f></c>`;
      }
      // Numero solo si lo es de verdad y no se pierde nada al convertirlo
      if (texto.trim() !== '' && !isNaN(Number(texto)) && String(Number(texto)) === texto.trim()) {
        return `<c r="${ref}"><v>${texto.trim()}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(texto)}</t></is></c>`;
    }).join('');
    return cs ? `<row r="${i + 1}">${cs}</row>` : '';
  }).join('');

  return zip.crear([
    { nombre: '[Content_Types].xml', datos: TIPOS_XLSX },
    { nombre: '_rels/.rels', datos: RELS_XLSX },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: RELS_LIBRO },
    { nombre: 'xl/workbook.xml', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(nombreHoja || 'Hoja1').slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { nombre: 'xl/worksheets/sheet1.xml', datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlFilas}</sheetData></worksheet>` },
  ]);
}

module.exports = { docx, xlsx, columna };
