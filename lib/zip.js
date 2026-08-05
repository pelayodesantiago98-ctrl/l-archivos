'use strict';
/*
 * Escribir un ZIP, que es lo que hay dentro de un .docx o un .xlsx.
 *
 * El lector ya estaba en ofimatica.js; esto es la otra mitad. Se hace a mano
 * con el zlib de Node por la misma razon: meter una dependencia para comprimir
 * cuarenta kilobytes de XML no compensa, y el formato son cuatro cabeceras.
 *
 * Un ZIP es: cada fichero con su cabecera local y sus datos, y al final un
 * indice que dice donde empieza cada uno. Word y Excel exigen que ese indice
 * este bien; si no, dicen que el fichero esta danado y no lo abren.
 */
const zlib = require('zlib');

/* La tabla del CRC-32, que es lo unico incomodo del formato. Se calcula una vez
   al cargar el modulo. */
const TABLA = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLA[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/*
 * ficheros: [{ nombre, datos (string o Buffer) }]
 *
 * La fecha va fija a 1980 a proposito: asi el mismo contenido da siempre el
 * mismo fichero, byte a byte. Ademas evita explicar la conversion a la hora
 * MS-DOS, que se guarda en dos campos de dieciseis bits con el ano contado
 * desde 1980 y los segundos divididos entre dos.
 */
function crear(ficheros) {
  const trozos = [];
  const indice = [];
  let desplazamiento = 0;

  for (const f of ficheros) {
    const datos = Buffer.isBuffer(f.datos) ? f.datos : Buffer.from(f.datos, 'utf8');
    const nombre = Buffer.from(f.nombre, 'utf8');
    const comprimido = zlib.deflateRawSync(datos, { level: 9 });
    const suma = crc32(datos);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);     // firma
    local.writeUInt16LE(20, 4);             // version necesaria
    local.writeUInt16LE(0, 6);              // banderas
    local.writeUInt16LE(8, 8);              // metodo: deflate
    local.writeUInt16LE(0, 10);             // hora
    local.writeUInt16LE(33, 12);            // fecha: 1 de enero de 1980
    local.writeUInt32LE(suma, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);             // sin campo extra

    trozos.push(local, nombre, comprimido);
    indice.push({ nombre, suma, comprimido: comprimido.length, original: datos.length, desplazamiento });
    desplazamiento += 30 + nombre.length + comprimido.length;
  }

  const central = [];
  let largoCentral = 0;
  for (const e of indice) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);                 // version con la que se creo
    c.writeUInt16LE(20, 6);                 // version necesaria
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(33, 14);
    c.writeUInt32LE(e.suma, 16);
    c.writeUInt32LE(e.comprimido, 20);
    c.writeUInt32LE(e.original, 24);
    c.writeUInt16LE(e.nombre.length, 28);
    c.writeUInt16LE(0, 30);                 // extra
    c.writeUInt16LE(0, 32);                 // comentario
    c.writeUInt16LE(0, 34);                 // disco
    c.writeUInt16LE(0, 36);                 // atributos internos
    c.writeUInt32LE(0, 38);                 // atributos externos
    c.writeUInt32LE(e.desplazamiento, 42);
    central.push(c, e.nombre);
    largoCentral += 46 + e.nombre.length;
  }

  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(0, 4);
  fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(indice.length, 8);
  fin.writeUInt16LE(indice.length, 10);
  fin.writeUInt32LE(largoCentral, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  fin.writeUInt16LE(0, 20);

  return Buffer.concat([...trozos, ...central, fin]);
}

module.exports = { crear };
