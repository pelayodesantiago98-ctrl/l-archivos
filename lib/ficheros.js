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

const BASE = process.env.ARCHIVOS_RAIZ || '/var/archivos';

/*
 * Lo de cada uno en su carpeta: /var/archivos/<id>/<seccion>.
 *
 * El identificador es el que da el portal, que no cambia aunque la persona se
 * renombre. Las peliculas y las series no estan aqui a proposito: esas van al
 * buzon de Jellyfin, que se ve entre todos.
 */
const SECCIONES = {
  fotos: 'imagenes',
  videos: 'videos',
  documentos: 'documentos',
  archivos: 'otros',
};

/* El id viaja en la ruta, asi que no puede traer nada raro. Se acepta o se
   rechaza; no se intenta arreglar, que es como acaban colandose sorpresas. */
const idValido = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id)
  && id !== '.' && id !== '..';

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

function raizDe(usuario, tipo) {
  const sub = SECCIONES[tipo];
  if (!sub || !idValido(usuario)) return null;
  const r = path.join(BASE, usuario, sub);
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
function resolver(usuario, tipo, rel = '') {
  const raiz = raizDe(usuario, tipo);
  if (!raiz) return null;
  if (typeof rel !== 'string' || rel.includes('\0')) return null;

  const limpio = rel.replace(/^[/\\]+/, '');
  const destino = path.resolve(raiz, limpio);

  let real;
  try { real = fs.realpathSync(destino); } catch { return null; }
  if (real !== raiz && !real.startsWith(raiz + path.sep)) return null;
  return real;
}

const relativo = (usuario, tipo, absoluta) => {
  const raiz = raizDe(usuario, tipo);
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

function listar(usuario, tipo, rel = '') {
  const dir = resolver(usuario, tipo, rel);
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
      rel: relativo(usuario, tipo, abs),
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

  /* Carpetas primero y por nombre; ficheros, lo mas nuevo arriba. Salvo que
     alguien haya colocado las cosas a mano, que entonces manda su orden. Las
     carpetas siguen yendo delante: mezclarlas con los ficheros solo porque se
     arrastro una hace que no se encuentre nada. */
  const orden = leerOrden(dir);
  const porNombre = (a, b) => a.nombre.localeCompare(b.nombre, 'es');
  const porFecha = (a, b) => b.fecha - a.fecha;

  if (orden.length) {
    /* segunOrden devuelve listas nuevas, asi que aqui si se puede vaciar la
       original y volver a llenarla. */
    const ordenadas = segunOrden(carpetas, orden, porNombre);
    const ordenados = segunOrden(ficheros, orden, porFecha);
    carpetas.length = 0; carpetas.push(...ordenadas);
    ficheros.length = 0; ficheros.push(...ordenados);
  } else {
    /* Y sin orden guardado se ordena en el sitio, que es lo que hacia antes.
       Nada de vaciar y volver a llenar: sort() devuelve el mismo array, no una
       copia, y vaciarlo se lleva por delante lo que se iba a empujar. */
    carpetas.sort(porNombre);
    ficheros.sort(porFecha);
  }

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

function crearCarpeta(usuario, tipo, rel, nombre) {
  if (!nombreValido(nombre)) {
    const err = new Error('Ese nombre no vale: sin barras, sin empezar por punto y hasta 120 letras.');
    err.status = 400;
    throw err;
  }
  const padre = resolver(usuario, tipo, rel);
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
  return { rel: relativo(usuario, tipo, destino), nombre: nombre.trim() };
}

function renombrar(usuario, tipo, rel, nombre) {
  if (!nombreValido(nombre)) {
    const err = new Error('Ese nombre no vale.');
    err.status = 400;
    throw err;
  }
  const origen = resolver(usuario, tipo, rel);
  const raiz = raizDe(usuario, tipo);
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
  return { rel: relativo(usuario, tipo, destino) };
}

/*
 * Borrar.
 *
 * Una carpeta con cosas dentro solo se va si se pide a proposito: el borrado
 * en cascada por accidente no tiene vuelta, y aqui no hay papelera.
 */
function borrar(usuario, tipo, rel, conTodo = false) {
  const objetivo = resolver(usuario, tipo, rel);
  const raiz = raizDe(usuario, tipo);
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
function todasLasImagenes(usuario, tipo) {
  const raiz = raizDe(usuario, tipo);
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
            rel: relativo(usuario, tipo, abs),
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


/*
 * Todo lo que va a la galeria: las fotos y los videos, mezclados y por fecha.
 *
 * Son dos secciones distintas en disco —cada una con su carpeta— pero una
 * sola pantalla, asi que cada entrada dice de que seccion sale y que clase de
 * cosa es. La rejilla no tiene que saber donde vive cada fichero.
 */
function todoElMedia(usuario) {
  const salida = [];

  for (const [seccion, patron, clase] of [['fotos', IMAGEN, 'foto'],
                                          ['videos', VIDEO, 'video']]) {
    const raiz = raizDe(usuario, seccion);
    if (!raiz) continue;

    (function hurgar(dir) {
      let entradas;
      try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entradas) {
        if (OCULTOS.test(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { hurgar(abs); continue; }
        if (!e.isFile() || !patron.test(e.name)) continue;
        try {
          const st = fs.statSync(abs);
          salida.push({
            nombre: e.name,
            rel: relativo(usuario, seccion, abs),
            seccion,
            clase,
            tamano: st.size,
            tamanoTexto: texto(st.size),
            fecha: st.mtimeMs,
          });
        } catch { /* ha desaparecido */ }
      }
    })(raiz);
  }

  return salida.sort((a, b) => b.fecha - a.fecha);
}


/*
 * Llevar algo a otra carpeta.
 *
 * `rel` es lo que se mueve y `destino` la carpeta que lo recibe; vacio es la
 * raiz de la seccion. Las dos rutas pasan por resolver(), que es la unica
 * puerta, asi que no hay forma de sacar nada fuera de lo tuyo.
 */
/*
 * Una copia al lado de la original.
 *
 * El «(copia)» va antes de la extension y no delante del nombre: asi la copia
 * ordena junto a su original y sigue viendose de que tipo es. Si ya hay una,
 * se numera.
 */
function nombreDeCopia(dir, nombre) {
  const ext = path.extname(nombre);
  const base = ext ? nombre.slice(0, -ext.length) : nombre;
  for (let i = 1; i < 100; i++) {
    const intento = base + (i === 1 ? ' (copia)' : ' (copia ' + i + ')') + ext;
    if (!fs.existsSync(path.join(dir, intento))) return intento;
  }
  const err = new Error('Ya hay demasiadas copias de eso.');
  err.status = 409;
  throw err;
}

/* A mano y no con fs.cpSync porque esa sigue marcada como experimental y avisa
   por consola en cada uso. Son quince lineas. */
function copiarTodo(origen, destino) {
  if (!fs.statSync(origen).isDirectory()) {
    fs.copyFileSync(origen, destino);
    return;
  }
  fs.mkdirSync(destino);
  for (const hijo of fs.readdirSync(origen)) {
    copiarTodo(path.join(origen, hijo), path.join(destino, hijo));
  }
}

function duplicar(usuario, tipo, rel) {
  const origen = resolver(usuario, tipo, rel);
  const raiz = raizDe(usuario, tipo);
  if (!origen || origen === raiz) {
    const err = new Error('Eso no se puede duplicar.');
    err.status = 404;
    throw err;
  }

  const dir = path.dirname(origen);
  const nombre = nombreDeCopia(dir, path.basename(origen));
  copiarTodo(origen, path.join(dir, nombre));
  return { rel: relativo(usuario, tipo, path.join(dir, nombre)), nombre };
}

function mover(usuario, tipo, rel, destino) {
  const origen = resolver(usuario, tipo, rel);
  const raiz = raizDe(usuario, tipo);
  if (!origen || origen === raiz) {
    const err = new Error('Eso no se puede mover.');
    err.status = 404;
    throw err;
  }

  const carpeta = resolver(usuario, tipo, destino || '');
  if (!carpeta || !fs.statSync(carpeta).isDirectory()) {
    const err = new Error('Esa carpeta no existe.');
    err.status = 404;
    throw err;
  }

  /* Una carpeta dentro de si misma se lleva por delante su propio contenido:
     el rename funciona y lo que habia dentro queda inalcanzable. */
  if (carpeta === origen || carpeta.startsWith(origen + path.sep)) {
    const err = new Error('Una carpeta no puede ir dentro de si misma.');
    err.status = 400;
    throw err;
  }

  if (path.dirname(origen) === carpeta) return { rel, sinCambios: true };

  const nuevo = path.join(carpeta, path.basename(origen));
  if (fs.existsSync(nuevo)) {
    const err = new Error('Ahi ya hay algo con ese nombre.');
    err.status = 409;
    throw err;
  }

  fs.renameSync(origen, nuevo);
  quitarDelOrden(path.dirname(origen), path.basename(origen));
  return { rel: relativo(usuario, tipo, nuevo) };
}

// ── El orden que pone cada uno ──────────────────────────────────────────────

const FICHERO_ORDEN = '.orden';

/* Los nombres que alguien ha colocado a mano, en su orden. Lo que no este aqui
   —lo recien subido— va detras, con el orden de siempre. */
function leerOrden(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, FICHERO_ORDEN), 'utf8'));
    return Array.isArray(d) ? d.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function escribirOrden(dir, nombres) {
  const ruta = path.join(dir, FICHERO_ORDEN);
  if (!nombres.length) {
    try { fs.unlinkSync(ruta); } catch {}
    return;
  }
  const tmp = ruta + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(nombres, null, 0));
  fs.renameSync(tmp, ruta);
}

/* Al mover o borrar algo, su nombre deja de tener sitio guardado. Sin esto el
   fichero de orden va engordando con fantasmas. */
function quitarDelOrden(dir, nombre) {
  const orden = leerOrden(dir);
  if (!orden.includes(nombre)) return;
  escribirOrden(dir, orden.filter((n) => n !== nombre));
}

function ordenar(usuario, tipo, rel, nombres) {
  const dir = resolver(usuario, tipo, rel || '');
  if (!dir || !fs.statSync(dir).isDirectory()) {
    const err = new Error('Esa carpeta no existe.');
    err.status = 404;
    throw err;
  }
  if (!Array.isArray(nombres)) {
    const err = new Error('Hace falta la lista de nombres.');
    err.status = 400;
    throw err;
  }

  /* Solo se guardan nombres que existen ahi dentro: si llega uno inventado, se
     descarta en vez de dar error, porque lo normal es que sea algo que se ha
     borrado mientras la pantalla lo tenia a la vista. */
  const hay = new Set(fs.readdirSync(dir).filter((n) => !OCULTOS.test(n)));
  escribirOrden(dir, nombres.filter((n) => typeof n === 'string' && hay.has(n)));
  return { ok: true };
}

/* Coloca segun el orden guardado. Lo que no tenga sitio se queda detras, con
   el criterio de siempre. */
function segunOrden(lista, orden, porDefecto) {
  const sitio = new Map(orden.map((n, i) => [n, i]));
  const colocados = lista.filter((x) => sitio.has(x.nombre))
    .sort((a, b) => sitio.get(a.nombre) - sitio.get(b.nombre));
  const sueltos = lista.filter((x) => !sitio.has(x.nombre)).sort(porDefecto);
  return colocados.concat(sueltos);
}

module.exports = { duplicar,
  SECCIONES, resolver, mover, ordenar, relativo, raizDe, listar, crearCarpeta, renombrar, borrar,
  todasLasImagenes, todoElMedia, claseDe, extDe, texto, nombreValido, IMAGEN,
};
