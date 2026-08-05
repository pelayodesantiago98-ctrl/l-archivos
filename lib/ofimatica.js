'use strict';
/*
 * Leer por dentro un .docx, un .xlsx o un .odt sin instalar LibreOffice.
 *
 * LibreOffice convertiria con fidelidad, pero son 600 MB en disco y 300 de RAM
 * por conversion, en una maquina de 1,8 GB que ya sostiene seis sitios,
 * Jellyfin y las recompresiones del buzon. Para *leer* un documento no hace
 * falta tanto.
 *
 * El truco es que todos esos formatos son un ZIP con XML dentro. Se saca el
 * XML que lleva el contenido y se convierte a algo que el navegador pueda
 * pintar. Se pierde el formato -- tipografias, colores, margenes -- y se queda
 * el texto, las tablas y la estructura, que es lo que se quiere cuando abres un
 * documento para mirarlo.
 *
 * El ZIP se lee a mano con zlib, que trae Node. No hay unzip en la maquina y
 * meter una dependencia para descomprimir cuarenta kilobytes de XML no compensa.
 *
 * Lo que NO entra aqui: .doc, .xls y .ppt de los viejos, que son formatos
 * binarios de los noventa y no hay forma honrada de leerlos sin LibreOffice.
 * Esos se ofrecen para descargar.
 */
const fs = require('fs');
const zlib = require('zlib');

const MAX_ZIP = 80 * 1024 * 1024;        // un documento mayor que esto no es un documento
const MAX_SALIDA = 4 * 1024 * 1024;      // ni se pinta un texto de mas de 4 MB

/*
 * Un ZIP se lee desde el final: al final esta el "directorio central", que dice
 * donde empieza cada fichero. Buscar las cabeceras locales desde el principio
 * tambien parece funcionar, hasta que un fichero lleva esa firma dentro de sus
 * datos y todo se descoloca.
 */
function leerZip(ruta) {
  const st = fs.statSync(ruta);
  if (st.size > MAX_ZIP) throw new Error('El fichero es demasiado grande para abrirlo aqui.');
  const buf = fs.readFileSync(ruta);

  // El fin del directorio central: firma PK\5\6, en los ultimos 65 KB
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) throw new Error('No parece un fichero valido (no encuentro el indice).');

  const cuantos = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);

  const dentro = new Map();
  for (let i = 0; i < cuantos && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const largoNombre = buf.readUInt16LE(p + 28);
    const largoExtra = buf.readUInt16LE(p + 30);
    const largoComent = buf.readUInt16LE(p + 32);
    const desplaz = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + largoNombre);
    dentro.set(nombre, { metodo, comprimido, desplaz });
    p += 46 + largoNombre + largoExtra + largoComent;
  }

  return {
    lista: () => [...dentro.keys()],
    sacar(nombre) {
      const e = dentro.get(nombre);
      if (!e) return null;
      // La cabecera local repite el nombre y trae su propio campo extra, que
      // casi nunca mide lo mismo que el del indice: hay que leerlo de aqui.
      const q = e.desplaz;
      if (buf.readUInt32LE(q) !== 0x04034b50) return null;
      const ln = buf.readUInt16LE(q + 26);
      const le = buf.readUInt16LE(q + 28);
      const datos = buf.subarray(q + 30 + ln + le, q + 30 + ln + le + e.comprimido);
      if (e.metodo === 0) return datos;                    // guardado tal cual
      if (e.metodo === 8) return zlib.inflateRawSync(datos, { maxOutputLength: MAX_SALIDA });
      throw new Error('El documento usa una compresion que no se leer.');
    },
  };
}

const desescapar = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&');

/* ── Word ─────────────────────────────────────────────────────────────────── */

function docx(zip) {
  const xml = zip.sacar('word/document.xml');
  if (!xml) throw new Error('No encuentro el texto dentro del documento.');
  const s = xml.toString('utf8');

  const parrafos = [];
  // Cada <w:p> es un parrafo; dentro, cada <w:t> un trozo de texto.
  for (const m of s.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const bloque = m[0];
    let texto = '';
    for (const t of bloque.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
      texto += desescapar(t[1]);
    }
    // <w:tab/> y <w:br/> son separaciones de verdad, no adorno
    if (/<w:br\s*\/>/.test(bloque) && !texto) texto = '';
    const estilo = /<w:pStyle[^>]*w:val="([^"]*)"/.exec(bloque);
    const nivel = estilo && /^Heading(\d)/i.exec(estilo[1]);
    parrafos.push({
      texto: texto.trim(),
      titulo: nivel ? Math.min(6, +nivel[1]) : 0,
      lista: /<w:numPr>/.test(bloque),
    });
  }

  return { clase: 'documento', parrafos };
}

/* ── Excel ────────────────────────────────────────────────────────────────── */

function xlsx(zip) {
  /* Las celdas de texto no guardan su texto: guardan un numero que apunta a
     esta tabla comun. Es lo que hace que un Excel con la misma palabra mil
     veces no ocupe mil veces. */
  const compartidas = [];
  const sst = zip.sacar('xl/sharedStrings.xml');
  if (sst) {
    for (const si of sst.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let t = '';
      for (const m of si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) t += desescapar(m[1]);
      compartidas.push(t);
    }
  }

  const hojas = [];
  for (const nombre of zip.lista().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
    const s = zip.sacar(nombre).toString('utf8');
    const filas = [];
    for (const fila of s.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const celdas = [];
      for (const c of fila[1].matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>|<c\s([^>]*)\/>/g)) {
        const attrs = c[1] || c[3] || '';
        const cuerpo = c[2] || '';
        const ref = /r="([A-Z]+)\d+"/.exec(attrs);
        const tipo = /t="([^"]+)"/.exec(attrs);
        const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo);
        const inline = /<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(cuerpo);
        const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(cuerpo);

        let valor = '';
        /*
         * La formula manda sobre el valor.
         *
         * Una celda con formula guarda las dos cosas: la formula y el ultimo
         * resultado que calculo Excel. Leyendo solo el resultado, abrir y volver
         * a guardar convertia la formula en el numero de aquel dia -- y si la
         * hoja se acababa de escribir aqui, donde todavia no hay resultado, la
         * celda salia VACIA y al guardar se perdia la formula del todo. Pasaba:
         * un "=SUMA(B2:B3)" desaparecia al reabrir la hoja.
         */
        if (formula) valor = '=' + desescapar(formula[1]);
        else if (inline) valor = desescapar(inline[1]);
        else if (v) {
          valor = tipo && tipo[1] === 's' ? (compartidas[+v[1]] || '') : desescapar(v[1]);
        }
        celdas.push({ col: ref ? ref[1] : '', valor });
      }
      // Una fila entera vacia no aporta nada
      if (celdas.some((c) => c.valor !== '')) filas.push(celdas);
    }
    hojas.push({ nombre: nombre.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''), filas });
  }

  return { clase: 'hoja', hojas };
}

/* ── PowerPoint ───────────────────────────────────────────────────────────── */

function pptx(zip) {
  const laminas = [];
  const nombres = zip.lista()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+/(\d+)/.exec(a)[1]) - (+/(\d+)/.exec(b)[1]));

  for (const n of nombres) {
    const s = zip.sacar(n).toString('utf8');
    const lineas = [];
    for (const p of s.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      let t = '';
      for (const m of p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) t += desescapar(m[1]);
      if (t.trim()) lineas.push(t.trim());
    }
    laminas.push({ numero: laminas.length + 1, lineas });
  }
  return { clase: 'laminas', laminas };
}

/* ── OpenDocument ─────────────────────────────────────────────────────────── */

function opendocument(zip, ext) {
  const xml = zip.sacar('content.xml');
  if (!xml) throw new Error('No encuentro el contenido del documento.');
  const s = xml.toString('utf8');

  if (ext === 'ods') {
    const hojas = [];
    for (const t of s.matchAll(/<table:table[^>]*table:name="([^"]*)"[\s\S]*?<\/table:table>/g)) {
      const filas = [];
      for (const fila of t[0].matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
        const celdas = [];
        for (const c of fila[1].matchAll(/<table:table-cell[\s\S]*?(?:\/>|<\/table:table-cell>)/g)) {
          let v = '';
          for (const p of c[0].matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>/g)) {
            v += desescapar(p[1].replace(/<[^>]+>/g, ''));
          }
          celdas.push({ col: '', valor: v });
        }
        if (celdas.some((c) => c.valor !== '')) filas.push(celdas);
      }
      hojas.push({ nombre: t[1], filas });
    }
    return { clase: 'hoja', hojas };
  }

  const parrafos = [];
  for (const p of s.matchAll(/<text:(p|h)[^>]*>([\s\S]*?)<\/text:\1>/g)) {
    const nivel = /text:outline-level="(\d)"/.exec(p[0]);
    parrafos.push({
      texto: desescapar(p[2].replace(/<[^>]+>/g, '')).trim(),
      titulo: p[1] === 'h' ? (nivel ? Math.min(6, +nivel[1]) : 1) : 0,
      lista: false,
    });
  }
  return { clase: 'documento', parrafos };
}

/* ── Entrada ──────────────────────────────────────────────────────────────── */

function leer(ruta, ext) {
  const zip = leerZip(ruta);
  switch (ext) {
    case 'docx': return docx(zip);
    case 'xlsx': return xlsx(zip);
    case 'pptx': return pptx(zip);
    case 'odt': return opendocument(zip, 'odt');
    case 'ods': return opendocument(zip, 'ods');
    case 'odp': return opendocument(zip, 'odp');
    default: throw new Error('No se abrir un .' + ext + ' aqui.');
  }
}

module.exports = { leer };
