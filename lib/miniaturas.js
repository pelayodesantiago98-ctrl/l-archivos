'use strict';
/*
 * Miniaturas para la galeria.
 *
 * Sin esto una galeria de doscientas fotos son doscientos ficheros de cuatro
 * megas: un giga por pantallazo, que en el movil es inaceptable y en el
 * servidor tampoco tiene gracia. Cada foto se reduce una vez a un cuadrado y
 * se guarda; a partir de ahi la rejilla pesa unos kilobytes por foto.
 *
 * La cache vive en __miniaturas__ dentro de cada carpeta raiz, y el nombre de
 * cada una lleva un hash de la ruta MAS la fecha y el tamano del original. Asi
 * no hay que invalidar nada a mano: si cambias la foto, cambia la fecha, cambia
 * el hash y se genera otra. La vieja se queda hasta la limpieza.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { RAICES, resolver, raizDe } = require('./ficheros');

const LADO = 400;          // suficiente para una rejilla a 3x en movil
const CALIDAD = 72;

/* sharp abre la imagen entera en memoria antes de reducirla, y esta maquina
   tiene 1,8 GB compartidos con seis sitios. Un limite de pixeles evita que una
   foto absurda (o un PNG bomba, que es una imagen diminuta que se descomprime
   a gigabytes) se lleve la RAM por delante. */
const MAX_PIXELES = 80e6;

// Dos a la vez: son dos vCPU y la galeria no es lo mas urgente de la casa.
const A_LA_VEZ = 2;
let enCurso = 0;
const cola = [];

function turno() {
  return new Promise((suelta) => {
    const intentar = () => {
      if (enCurso < A_LA_VEZ) { enCurso++; suelta(); }
      else cola.push(intentar);
    };
    intentar();
  });
}

function libera() {
  enCurso--;
  const siguiente = cola.shift();
  if (siguiente) siguiente();
}

function carpetaCache(tipo) {
  const raiz = raizDe(tipo);
  if (!raiz) return null;
  const dir = path.join(raiz, '__miniaturas__');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return null; }
  return dir;
}

function nombreCache(rel, st) {
  const firma = rel + '|' + Math.round(st.mtimeMs) + '|' + st.size;
  return crypto.createHash('sha1').update(firma).digest('hex') + '.webp';
}

/*
 * Devuelve la ruta de la miniatura, generandola si hace falta.
 *
 * Si la imagen no se puede leer -- rota, o un formato que libvips no trae --
 * devuelve null y la pantalla ensena un hueco con su nombre, que es mejor que
 * una galeria que se cae entera por una foto mala.
 */
async function miniatura(tipo, rel) {
  const original = resolver(tipo, rel);
  if (!original) return null;

  let st;
  try { st = fs.statSync(original); } catch { return null; }
  if (!st.isFile()) return null;

  const dir = carpetaCache(tipo);
  if (!dir) return null;
  const destino = path.join(dir, nombreCache(rel, st));

  if (fs.existsSync(destino)) return destino;

  await turno();
  try {
    // Otra peticion pudo generarla mientras esperabamos el turno.
    if (fs.existsSync(destino)) return destino;

    const temporal = destino + '.' + process.pid + '.tmp';
    await sharp(original, { limitInputPixels: MAX_PIXELES, failOn: 'error' })
      .rotate()                     // respeta el EXIF: si no, las verticales salen tumbadas
      .resize(LADO, LADO, { fit: 'cover', position: 'attention' })
      .webp({ quality: CALIDAD })
      .toFile(temporal);

    /* Se escribe aparte y se mueve al final: si dos peticiones coinciden o el
       proceso se muere a medias, nadie llega a ver una miniatura incompleta. */
    fs.renameSync(temporal, destino);
    return destino;
  } catch (err) {
    console.warn('[miniaturas] ' + rel + ': ' + err.message);
    return null;
  } finally {
    libera();
  }
}

/* Ancho y alto reales, para que la rejilla sepa la forma antes de cargar nada
   y el visor no pegue un salto al abrir. */
async function medidas(tipo, rel) {
  const original = resolver(tipo, rel);
  if (!original) return null;
  try {
    const m = await sharp(original, { limitInputPixels: MAX_PIXELES }).metadata();
    // Con la foto girada por EXIF, ancho y alto van al reves de lo que dice el fichero.
    const tumbada = m.orientation && m.orientation >= 5;
    return {
      ancho: tumbada ? m.height : m.width,
      alto: tumbada ? m.width : m.height,
      formato: m.format,
    };
  } catch { return null; }
}

/*
 * Una version grande para el visor.
 *
 * Un movil no necesita los 48 megapixeles de la camara para verla a pantalla
 * completa, y un HEIC no lo abre ningun navegador. Se sirve un JPEG de 2000 px
 * de lado, que se ve igual y pesa una decima parte.
 */
async function grande(tipo, rel) {
  const original = resolver(tipo, rel);
  if (!original) return null;
  let st;
  try { st = fs.statSync(original); } catch { return null; }

  const dir = carpetaCache(tipo);
  if (!dir) return null;
  const destino = path.join(dir, 'g-' + nombreCache(rel, st).replace('.webp', '.jpg'));
  if (fs.existsSync(destino)) return destino;

  await turno();
  try {
    if (fs.existsSync(destino)) return destino;
    const temporal = destino + '.' + process.pid + '.tmp';
    await sharp(original, { limitInputPixels: MAX_PIXELES, failOn: 'error' })
      .rotate()
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(temporal);
    fs.renameSync(temporal, destino);
    return destino;
  } catch (err) {
    console.warn('[miniaturas] grande ' + rel + ': ' + err.message);
    return null;
  } finally {
    libera();
  }
}

/* Las miniaturas de fotos que ya no estan se quedan ocupando sitio. Esto las
   barre; lo llama el servidor de vez en cuando, no cada peticion. */
function limpiar(tipo, dias = 30) {
  const dir = carpetaCache(tipo);
  if (!dir) return 0;
  const limite = Date.now() - dias * 86400000;
  let fuera = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.atimeMs < limite) { fs.unlinkSync(p); fuera++; }
      } catch { /* ya no esta */ }
    }
  } catch { /* no hay cache */ }
  return fuera;
}

module.exports = { miniatura, grande, medidas, limpiar, LADO };
