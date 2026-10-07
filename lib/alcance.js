'use strict';
/*
 * De "que se comparte" a la lista concreta de ficheros.
 *
 * El arbol-QR ofrece cuatro alcances, igual que en l-notes: lo marcado, la
 * carpeta en la que estas, la seccion entera o todo. Aqui abajo, sin embargo,
 * solo existe una cosa que compartir —un fichero suelto—, porque compartir.js
 * exige que cada cosa exista y sea un fichero. Asi que los tres alcances
 * grandes se RESUELVEN a la lista de ficheros que contienen, y lo que se
 * reparte es esa lista.
 *
 * Consecuencia que conviene tener presente: el enlace es una FOTO FIJA de lo
 * que habia al crearlo. Lo que se anada despues a esa carpeta no entra. Es lo
 * coherente con compartir.js, que ya comprueba que las cosas existan al crear
 * el enlace y no al abrirlo, y es lo prudente: un enlace que fuera creciendo
 * solo repartiria manana lo que hoy no se penso repartir.
 *
 * La galeria no es una carpeta sino una pantalla: ensena fotos y videos
 * mezclados por fecha, y en disco son dos secciones distintas. Por eso
 * `seccionesDe` la desdobla.
 */
const ficheros = require('./ficheros');

const ALCANCES = ['seleccion', 'carpeta', 'seccion', 'todo'];

const GALERIA = ['fotos', 'videos'];
const TODAS = ['fotos', 'videos', 'documentos', 'archivos'];

/* Cuantos ficheros como mucho caben en un enlace.
 *
 * Pasado ese numero se da error en vez de recortar. Un enlace con la mitad de
 * lo que se pidio es peor que no tener enlace: parece que ha funcionado, y lo
 * que falta no se echa en falta hasta que alguien pregunta. */
const TOPE = 300;

/* Y un tope duro al paseo por el disco, que es otra cosa: protege de un arbol
   enorme o de un ciclo de enlaces simbolicos, no del usuario. */
const TOPE_PASEO = 5000;
const HONDURA = 12;

function seccionesDe(seccion) {
  if (seccion === 'galeria') return GALERIA.slice();
  return TODAS.indexOf(seccion) >= 0 ? [seccion] : [];
}

/* Todos los ficheros de una carpeta y de las de dentro. Lo que no se puede
   leer se salta en silencio: una carpeta sin permiso no debe tumbar el resto. */
function recoger(usuario, tipo, rel, salida, hondura) {
  if (salida.length >= TOPE_PASEO || hondura > HONDURA) return;
  let l;
  try { l = ficheros.listar(usuario, tipo, rel); } catch { return; }
  for (const f of l.ficheros) {
    if (salida.length >= TOPE_PASEO) return;
    salida.push({ tipo, rel: f.rel });
  }
  for (const c of l.carpetas) recoger(usuario, tipo, c.rel, salida, hondura + 1);
}

function fallo(mensaje, status) {
  const err = new Error(mensaje);
  err.status = status || 400;
  return err;
}

/*
 * @param {string} usuario    de quien es el espacio
 * @param {string} alcance    seleccion | carpeta | seccion | todo
 * @param {string} seccion    la pantalla desde la que se pide (galeria incluida)
 * @param {string} carpeta    la ruta de la carpeta abierta, relativa a su seccion
 * @param {Array}  seleccion  [{tipo, rel}] de lo marcado, solo para 'seleccion'
 * @returns {{items: Array, cuantos: number}}
 */
function resolver(usuario, alcance, seccion, carpeta, seleccion) {
  if (ALCANCES.indexOf(alcance) < 0) {
    throw fallo('El alcance es «seleccion», «carpeta», «seccion» o «todo».');
  }

  const items = [];

  if (alcance === 'seleccion') {
    const lista = Array.isArray(seleccion) ? seleccion : [];
    for (const x of lista) {
      if (!x) continue;
      const tipo = String(x.tipo || x.seccion || seccion || '');
      const rel = String(x.rel || '');
      // La galeria no es una seccion de disco: un item suyo tiene que decir si
      // es foto o video, y si no lo dice no hay forma de resolverlo.
      if (rel && TODAS.indexOf(tipo) >= 0) items.push({ tipo, rel });
    }
    if (!items.length) throw fallo('No has marcado nada que compartir.');
  } else if (alcance === 'carpeta') {
    const rel = String(carpeta || '');
    // Sin carpeta abierta, "la carpeta" es la raiz de la seccion, que es
    // exactamente lo que se esta mirando.
    const cuales = seccionesDe(seccion);
    if (!cuales.length) throw fallo('No se de que seccion me hablas.');
    for (const t of cuales) recoger(usuario, t, rel, items, 0);
  } else if (alcance === 'seccion') {
    const cuales = seccionesDe(seccion);
    if (!cuales.length) throw fallo('No se de que seccion me hablas.');
    for (const t of cuales) recoger(usuario, t, '', items, 0);
  } else {
    for (const t of TODAS) recoger(usuario, t, '', items, 0);
  }

  if (!items.length) {
    throw fallo('Ahi no hay ningun fichero que compartir.', 404);
  }
  if (items.length > TOPE) {
    throw fallo('Son ' + items.length + ' ficheros y el tope de un enlace es '
      + TOPE + '. Comparte una carpeta mas pequena, o marca lo que quieras.');
  }

  return { items, cuantos: items.length };
}

module.exports = { resolver, seccionesDe, ALCANCES, GALERIA, TODAS, TOPE };
