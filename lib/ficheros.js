'use strict';
/*
 * El suelo de las tres pantallas: fotos, documentos y archivos.
 *
 * Las tres miran carpetas distintas pero hacen lo mismo — listar, abrir, crear
 * carpetas, borrar — asi que las reglas viven aqui una vez. Sobre todo LA
 * regla: nada de lo que llega del navegador decide por si solo a que fichero se
 * toca.
 *
 * Como se resuelve una ruta:
 *
 *   1. El tipo tiene que ser uno de los tres. No se concatena lo que venga.
 *   2. La ruta relativa se resuelve contra la raiz y se pide su realpath, o
 *      sea, a donde apunta DE VERDAD tras seguir enlaces y quitar los "..".
 *   3. Ese resultado tiene que empezar por la raiz real. Si no, no existe.
 *
 * Comprobar el texto de la ruta en vez del realpath es el fallo clasico:
 * "fotos/../../etc" se ve raro y se rechaza, pero un enlace simbolico dentro de
 * la carpeta se ve perfectamente normal y lleva donde quiera.
 */
const fs = require('fs');
const path = require('path');

const RAICES = {
  fotos: '/var/archivos/imagenes',
  documentos: '/var/archivos/documentos',
  archivos: '/var/archivos/otros',
};

/* El manifiesto lo escribe l-archivos al subir, y las miniaturas son cosa
   nuestra: ninguno de los dos es contenido y no se ensenan. */
const OCULTOS = /^\.|^__miniaturas__$/;

const IMAGEN = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|svg)$/i;
const VIDEO = /\.(mp4|webm|mkv|mov|m4v|avi)$/i;
const AUDIO = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i;
const TEXTO = /\.(txt|md|markdown|csv|tsv|log|json|xml|yml|yaml|ini|conf|css|js|ts|py|sh|sql|html?)$/i;
const PDF = /\.pdf$/i;
const OFIMATICA = /\.(docx|xlsx|pptx|odt|ods|odp)$/i;
const OFIMATICA_VIEJA = /\.(doc|xls|ppt|rtf)$/i;

function claseDe(nombre) {
  if (IMAGEN.test(nombre)) return 'imagen';
  if (VIDEO.test(nombre)) return 'video';
  if (AUDIO.test(nombre)) return 'audio';
  if (PDF.test(nombre)) return 'pdf';
  if (OFIMATICA.test(nombre)) return 'ofimatica';
  if (OFIMATICA_VIEJA.test(nombre)) return 'ofimatica-vieja';
  if (TEXTO.test(nombre)) return 'texto';
  return 'otro';
}

const extDe = (nombre) => (path.extname(nombre).slice(1) || '').toLowerCase();

function raizDe(tipo) {
  const r = RAICES[tipo];
  if (!r) return null;
  try {
    fs.mkdirSync(r, { recursive: true });
    return fs.realpathSync(r);
  } catch { return null; }
}

/*
 * La unica puerta. Devuelve la ruta absoluta real o null, y null significa
 * siempre lo mismo de cara afuera: no existe. No se distingue entre "no esta"
 * y "esta prohibido", porque esa diferencia es justo lo que usa quien va
 * probando rutas para dibujar el mapa del disco.
 */
function resolver(tipo, rel = '') {
  const raiz = raizDe(tipo);
  if (!raiz) return null;
  if (typeof rel !== 'string' || rel.includes('\0')) return null;

  const limpio = rel.replace(/^[/\\]+/, '');
  const destino = path.resolve(raiz, limpio);

  let real;
  try { real = fs.realpathSync(destino); } catch { return null; }
  if (real !== raiz && !real.startsWith(raiz + path.sep)) return null;
  return real;
}

const relativo = (tipo, absoluta) => {
  const raiz = raizDe(tipo);
  return raiz ? path.relative(raiz, absoluta).split(path.sep).join('/') : '';
};

/*
 * Un nombre de carpeta o de fichero nuevo.
 *
 * No se "limpia" lo que llega para intentar salvarlo: se acepta o se rechaza.
 * Limpiar es lo que lleva a que "....//foo" acabe convertido en algo valido
 * pero distinto de lo que el usuario creia estar escribiendo.
 */
function nombreValido(nombre) {
  if (typeof nombre !== 'string') return false;
  const n = nombre.trim();
  if (!n || n.length > 120) return false;
  if (n === '.' || n === '..') return false;
  if (/[/\\\0]/.test(n)) return false;
  if (/[\x00-\x1f]/.test(n)) return false;
  if (n.startsWith('.')) return false;          // nada de ocultos desde la web
  return true;
}

function listar(tipo, rel = '') {
  const dir = resolver(tipo, rel);
  if (!dir || !fs.statSync(dir).isDirectory()) {
    const err = new Error('Esa carpeta no existe.');
    err.status = 404;
    throw err;
  }

  const carpetas = [];
  const ficheros = [];

  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (OCULTOS.test(e.name)) continue;
    const abs = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }   // enlace roto o carrera

    const base = {
      nombre: e.name,
      rel: relativo(tipo, abs),
      fecha: st.mtimeMs,
    };

    if (st.isDirectory()) {
      let cuantos = 0;
      try {
        cuantos = fs.readdirSync(abs).filter((x) => !OCULTOS.test(x)).length;
      } catch { /* sin permiso para mirar dentro */ }
      carpetas.push({ ...base, tipo: 'carpeta', cuantos });
    } else if (st.isFile()) {
      ficheros.push({
        ...base,
        tipo: 'fichero',
        clase: claseDe(e.name),
        ext: extDe(e.name),
        tamano: st.size,
        tamanoTexto: texto(st.size),
      });
    }
  }

  // Carpetas primero y por nombre; ficheros, lo mas nuevo arriba.
  carpetas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  ficheros.sort((a, b) => b.fecha - a.fecha);

  return {
    tipo,
    rel: rel.replace(/^[/\\]+/, ''),
    migas: migas(rel),
    carpetas,
    ficheros,
    total: carpetas.length + ficheros.length,
  };
}

/* El rastro de carpetas hasta donde estas, para poder volver a cualquier
   altura sin ir de una en una hacia atras. */
function migas(rel) {
  const partes = String(rel || '').split('/').filter(Boolean);
  const salida = [];
  let acumulado = '';
  for (const p of partes) {
    acumulado = acumulado ? acumulado + '/' + p : p;
    salida.push({ nombre: p, rel: acumulado });
  }
  return salida;
}

function crearCarpeta(tipo, rel, nombre) {
  if (!nombreValido(nombre)) {
    const err = new Error('Ese nombre no vale: sin barras, sin empezar por punto y hasta 120 letras.');
    err.status = 400;
    throw err;
  }
  const padre = resolver(tipo, rel);
  if (!padre || !fs.statSync(padre).isDirectory()) {
    const err = new Error('Esa carpeta no existe.');
    err.status = 404;
    throw err;
  }
  const destino = path.join(padre, nombre.trim());
  if (fs.existsSync(destino)) {
    const err = new Error('Ya hay algo con ese nombre.');
    err.status = 409;
    throw err;
  }
  fs.mkdirSync(destino);
  return { rel: relativo(tipo, destino), nombre: nombre.trim() };
}

function renombrar(tipo, rel, nombre) {
  if (!nombreValido(nombre)) {
    const err = new Error('Ese nombre no vale.');
    err.status = 400;
    throw err;
  }
  const origen = resolver(tipo, rel);
  const raiz = raizDe(tipo);
  if (!origen || origen === raiz) {
    const err = new Error('Eso no se puede renombrar.');
    err.status = 404;
    throw err;
  }
  const destino = path.join(path.dirname(origen), nombre.trim());
  if (fs.existsSync(destino)) {
    const err = new Error('Ya hay algo con ese nombre.');
    err.status = 409;
    throw err;
  }
  fs.renameSync(origen, destino);
  return { rel: relativo(tipo, destino) };
}

/*
 * Borrar.
 *
 * Una carpeta con cosas dentro solo se va si se pide a proposito: el borrado
 * en cascada por accidente no tiene vuelta, y aqui no hay papelera.
 */
function borrar(tipo, rel, conTodo = false) {
  const objetivo = resolver(tipo, rel);
  const raiz = raizDe(tipo);
  if (!objetivo || objetivo === raiz) {
    const err = new Error('Eso no existe.');
    err.status = 404;
    throw err;
  }

  const st = fs.statSync(objetivo);
  if (st.isDirectory()) {
    const dentro = fs.readdirSync(objetivo).filter((x) => !OCULTOS.test(x));
    if (dentro.length && !conTodo) {
      const err = new Error('La carpeta tiene ' + dentro.length + ' cosas dentro.');
      err.status = 409;
      err.cuantos = dentro.length;
      throw err;
    }
    fs.rmSync(objetivo, { recursive: true, force: true });
    return { borrado: 'carpeta', cuantos: dentro.length };
  }

  const tamano = st.size;
  fs.unlinkSync(objetivo);
  return { borrado: 'fichero', tamano, tamanoTexto: texto(tamano) };
}

function texto(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' kB';
  return bytes + ' B';
}

/* Todas las imagenes de un tipo, sin carpetas, para la galeria. Se recorre
   entero porque una galeria que solo ensena el primer nivel esconde justo lo
   que se ha ordenado en carpetas. */
function todasLasImagenes(tipo) {
  const raiz = raizDe(tipo);
  if (!raiz) return [];
  const salida = [];

  (function hurgar(dir) {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (OCULTOS.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) hurgar(abs);
      else if (e.isFile() && IMAGEN.test(e.name)) {
        try {
          const st = fs.statSync(abs);
          salida.push({
            nombre: e.name,
            rel: relativo(tipo, abs),
            tamano: st.size,
            tamanoTexto: texto(st.size),
            fecha: st.mtimeMs,
          });
        } catch { /* ha desaparecido */ }
      }
    }
  })(raiz);

  return salida.sort((a, b) => b.fecha - a.fecha);
}

module.exports = {
  RAICES, resolver, relativo, raizDe, listar, crearCarpeta, renombrar, borrar,
  todasLasImagenes, claseDe, extDe, texto, nombreValido, IMAGEN,
};
