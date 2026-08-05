'use strict';
/*
 * Lo que ya esta colocado en L-films, para poder verlo y borrarlo.
 *
 * Es una carpeta aparte de las descargas y son ficheros distintos: el buzon no
 * mueve lo que llega, lo pasa por ffmpeg y escribe uno nuevo. Por eso borrar un
 * torrent no quita la pelicula y borrar la pelicula no quita el torrent -- son
 * dos cosas que ocupan disco por separado y se sueltan por separado.
 *
 * Aqui se borra de verdad y sin papelera. La confirmacion la pide la pagina.
 */
const fs = require('fs');
const path = require('path');

const CARPETAS = {
  peliculas: '/var/media/peliculas',
  series: '/var/media/series',
};

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|wmv|flv)$/i;

function recorrer(raiz, base = '') {
  let salida = [];
  let entradas;
  try {
    entradas = fs.readdirSync(path.join(raiz, base), { withFileTypes: true });
  } catch { return salida; }

  for (const e of entradas) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? path.join(base, e.name) : e.name;
    if (e.isDirectory()) {
      salida = salida.concat(recorrer(raiz, rel));
    } else if (VIDEO.test(e.name)) {
      try {
        const st = fs.statSync(path.join(raiz, rel));
        salida.push({ rel, tamano: st.size, fecha: st.mtimeMs });
      } catch { /* ha desaparecido entre el listado y el stat */ }
    }
  }
  return salida;
}

function listar() {
  const salida = [];
  for (const [tipo, raiz] of Object.entries(CARPETAS)) {
    for (const f of recorrer(raiz)) {
      salida.push({
        tipo,
        rel: f.rel,
        nombre: path.basename(f.rel, path.extname(f.rel)),
        tamano: f.tamano,
        tamanoTexto: texto(f.tamano),
        fecha: f.fecha,
      });
    }
  }
  // Lo mas reciente arriba, que es lo que se acaba de bajar y lo que se suele
  // querer revisar.
  return salida.sort((a, b) => b.fecha - a.fecha);
}

/*
 * Resolver la ruta con cuidado.
 *
 * El nombre viene del navegador, asi que se comprueba a donde apunta DE VERDAD
 * despues de resolverlo, no como se ve escrito: un "..%2f.." o un enlace
 * simbolico dentro de la biblioteca podrian sacar el borrado de su carpeta, y
 * este proceso borra sin preguntar. La regla es que la ruta real tiene que
 * empezar por la raiz real, y si no, no existe y punto.
 */
function rutaSegura(tipo, rel) {
  const raiz = CARPETAS[tipo];
  if (!raiz) return null;
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;

  const raizReal = fs.realpathSync(raiz);
  const destino = path.resolve(raizReal, rel);

  let destinoReal;
  try { destinoReal = fs.realpathSync(destino); } catch { return null; }

  if (destinoReal !== raizReal && !destinoReal.startsWith(raizReal + path.sep)) return null;
  if (!VIDEO.test(destinoReal)) return null;
  if (!fs.statSync(destinoReal).isFile()) return null;
  return destinoReal;
}

function borrar(tipo, rel) {
  const ruta = rutaSegura(tipo, rel);
  if (!ruta) {
    const err = new Error('Ese fichero no esta en la biblioteca.');
    err.status = 404;
    throw err;
  }
  const tamano = fs.statSync(ruta).size;
  fs.unlinkSync(ruta);

  /* Las series dejan la carpeta de la temporada vacia detras. Se quita si no
     queda nada, pero solo si esta vacia: nunca en cascada. */
  let dir = path.dirname(ruta);
  const raizReal = fs.realpathSync(CARPETAS[tipo]);
  while (dir !== raizReal && dir.startsWith(raizReal + path.sep)) {
    try {
      if (fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    } catch { break; }
  }

  return { tamano, texto: texto(tamano) };
}

function texto(bytes) {
  const g = bytes / 1073741824;
  if (g >= 10) return g.toFixed(0) + ' GB';
  if (g >= 1) return g.toFixed(1) + ' GB';
  return Math.round(bytes / 1048576) + ' MB';
}

function resumen() {
  const items = listar();
  const total = items.reduce((s, i) => s + i.tamano, 0);
  return { items, total, totalTexto: texto(total) };
}

module.exports = { resumen, borrar };
