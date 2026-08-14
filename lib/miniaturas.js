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

const { SECCIONES, resolver, raizDe } = require('./ficheros');
const { execFile } = require('child_process');

/* El ffmpeg de Jellyfin, que es el que hay en la maquina. Si no esta,
   los videos se quedan sin miniatura y la rejilla ensena su hueco con
   el nombre: mejor eso que una galeria que no carga. */
const FFMPEG = ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/ffmpeg']
  .find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

const ES_VIDEO = /\.(mp4|webm|mkv|mov|m4v|avi|3gp)$/i;

/*
 * Un fotograma del video, para que sharp pueda seguir desde ahi.
 *
 * Se coge al segundo 1 y no al 0: el primer fotograma de muchos videos
 * es negro y la galeria se llenaba de cuadros vacios. Si el video dura
 * menos, ffmpeg se queda con el ultimo que haya.
 */
function fotograma(origen, destino) {
  return new Promise((listo, falla) => {
    if (!FFMPEG) return falla(new Error('no hay ffmpeg'));
    execFile(FFMPEG, ['-v', 'error', '-ss', '1', '-i', origen,
                      '-frames:v', '1', '-y', destino],
      { timeout: 20000 }, (err) => (err ? falla(err) : listo()));
  });
}


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

function carpetaCache(usuario, tipo) {
  const raiz = raizDe(usuario, tipo);
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
async function miniatura(usuario, tipo, rel) {
  const original = resolver(usuario, tipo, rel);
  if (!original) return null;

  let st;
  try { st = fs.statSync(original); } catch { return null; }
  if (!st.isFile()) return null;

  const dir = carpetaCache(usuario, tipo);
  if (!dir) return null;
  const destino = path.join(dir, nombreCache(rel, st));

  if (fs.existsSync(destino)) return destino;

  await turno();
  try {
    // Otra peticion pudo generarla mientras esperabamos el turno.
    if (fs.existsSync(destino)) return destino;

    const temporal = destino + '.' + process.pid + '.tmp';

    /* De un video sharp no sabe nada: primero se saca un fotograma a un png
       de paso y ese es el que se recorta y comprime como una foto mas. */
    let fuente = original;
    let intermedio = null;
    if (ES_VIDEO.test(original)) {
      intermedio = destino + '.' + process.pid + '.png';
      await fotograma(original, intermedio);
      fuente = intermedio;
    }

    await sharp(fuente, { limitInputPixels: MAX_PIXELES, failOn: 'error' })
      .rotate()                     // respeta el EXIF: si no, las verticales salen tumbadas
      .resize(LADO, LADO, { fit: 'cover', position: 'attention' })
      .webp({ quality: CALIDAD })
      .toFile(temporal);

    /* Se escribe aparte y se mueve al final: si dos peticiones coinciden o el
       proceso se muere a medias, nadie llega a ver una miniatura incompleta. */
    fs.renameSync(temporal, destino);
    if (intermedio) { try { fs.unlinkSync(intermedio); } catch {} }
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
async function medidas(usuario, tipo, rel) {
  const original = resolver(usuario, tipo, rel);
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
async function grande(usuario, tipo, rel) {
  const original = resolver(usuario, tipo, rel);
  if (!original) return null;
  let st;
  try { st = fs.statSync(original); } catch { return null; }

  const dir = carpetaCache(usuario, tipo);
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
function limpiar(usuario, tipo, dias = 30) {
  const dir = carpetaCache(usuario, tipo);
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
