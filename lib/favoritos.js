'use strict';
/*
 * Favoritos de L-films.
 *
 * Marcar una pelicula como favorita hace dos cosas: la saca de la lista desde
 * la que se borra -- para no cargarsela por un clic distraido -- y el servidor
 * se niega a borrarla aunque se lo pidan.
 *
 * Las dos, no solo la primera. Esconder el boton es comodidad; lo que de verdad
 * protege es la comprobacion del servidor, porque la peticion se puede lanzar
 * igual desde fuera de la pagina. Lo que se quiere evitar aqui son los
 * despistes, y un despiste con 3 GB de pelicula no tiene deshacer.
 *
 * El almacen es un JSON al lado de la biblioteca, con la ruta de cada una. Se
 * guarda la ruta y no un identificador porque no hay base de datos: el nombre
 * del fichero ES la pelicula.
 */
const fs = require('fs');

/*
 * El almacen vive con la aplicacion, no dentro de la biblioteca.
 *
 * Estaba en /var/media/.favoritos.json y no funcionaba: ese directorio es de
 * jellyfin, asi que www-data no puede crear ahi el fichero temporal con el que
 * se escribe. La primera version se creo bien solo porque la hizo root a mano,
 * y desde el servicio saltaba EACCES al guardar. Aqui manda el permiso del
 * DIRECTORIO, no el del fichero.
 *
 * Ademas es lo correcto: la lista de favoritos es un dato de esta aplicacion,
 * no de la biblioteca de peliculas.
 */
const ALMACEN = '/var/www/l-archivos/data/favoritos.json';
const CARPETA = '/var/www/l-archivos/data';

const clave = (tipo, rel) => tipo + '/' + rel;

function leer() {
  try {
    const d = JSON.parse(fs.readFileSync(ALMACEN, 'utf8'));
    return Array.isArray(d) ? new Set(d) : new Set();
  } catch { return new Set(); }
}

function escribir(conjunto) {
  fs.mkdirSync(CARPETA, { recursive: true });
  const temporal = ALMACEN + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporal, JSON.stringify([...conjunto].sort(), null, 2));
  fs.renameSync(temporal, ALMACEN);
}

const es = (tipo, rel) => leer().has(clave(tipo, rel));

function anadir(lista) {
  const c = leer();
  let nuevos = 0;
  for (const { tipo, rel } of lista) {
    if (!tipo || !rel) continue;
    if (!c.has(clave(tipo, rel))) { c.add(clave(tipo, rel)); nuevos++; }
  }
  if (nuevos) escribir(c);
  return { nuevos, total: c.size };
}

function quitar(tipo, rel) {
  const c = leer();
  if (!c.delete(clave(tipo, rel))) {
    const err = new Error('Esa no estaba en favoritos.');
    err.status = 404;
    throw err;
  }
  escribir(c);
  return { ok: true, total: c.size };
}

/* Las que estan marcadas pero cuyo fichero ya no existe se quedan en el
   almacen: no molestan, ocupan nada, y si el fichero vuelve -- por ejemplo
   porque se recupera de una copia -- sigue marcada como estaba. Se filtran al
   listar y punto. */
const todas = () => leer();

module.exports = { es, anadir, quitar, todas };
