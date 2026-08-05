'use strict';
/*
 * Enlaces para ensenar una foto a alguien de fuera.
 *
 * Se crea un enlace con un codigo imposible de adivinar, se le pone fecha de
 * caducidad y se dibuja su QR. Quien lo tenga ve ESA foto y nada mas: ni el
 * listado, ni la carpeta, ni las de al lado.
 *
 * Conviene tenerlo claro: un enlace compartido es PUBLICO mientras dure. No
 * pide contrasena -- si la pidiera no serviria para ensenarle una foto a
 * alguien -- asi que quien lo reciba puede reenviarlo. Por eso se puede revocar
 * a mano y por eso la pantalla lo dice con todas las letras antes de crear
 * ninguno.
 *
 * Los hay con fecha y los hay indefinidos (caduca = null). Un indefinido no se
 * cierra solo NUNCA: la unica forma de cortarlo es retirarlo. Es lo que se pide
 * cuando se pide, pero conviene que se sepa, y por eso la lista los marca.
 *
 * El codigo son 16 bytes de crypto.randomBytes en base64url: 22 caracteres y
 * 2^128 combinaciones. Probar a ciegas no es una via.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ficheros = require('./ficheros');

const ALMACEN = '/var/archivos/.compartidos.json';
const DIAS_POR_DEFECTO = 7;
const DIAS_MAXIMO = 90;

function leer() {
  try {
    const datos = JSON.parse(fs.readFileSync(ALMACEN, 'utf8'));
    return datos && typeof datos === 'object' ? datos : {};
  } catch { return {}; }
}

function escribir(datos) {
  /* Se escribe al lado y se mueve encima: si el proceso se muere a mitad, el
     fichero de verdad sigue entero en vez de quedarse en un JSON cortado que
     ya no se puede leer y se lleva por delante todos los enlaces. */
  const temporal = ALMACEN + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporal, JSON.stringify(datos, null, 2), { mode: 0o600 });
  fs.renameSync(temporal, ALMACEN);
}

/* Los caducados se van solos la proxima vez que alguien toque el almacen: no
   hace falta un temporizador para algo que nadie esta esperando. */
function limpiar(datos) {
  const ahora = Date.now();
  let fuera = 0;
  for (const [token, e] of Object.entries(datos)) {
    // caduca === null es un enlace indefinido y se queda; lo que se va es lo
    // roto (sin entrada) y lo que ya paso de fecha.
    if (!e || (e.caduca !== null && (!e.caduca || e.caduca < ahora))) {
      delete datos[token];
      fuera++;
    }
  }
  return fuera;
}

function crear(tipo, rel, dias) {
  // La foto tiene que existir AHORA, no cuando alguien abra el enlace
  const abs = ficheros.resolver(tipo, rel);
  if (!abs || !fs.statSync(abs).isFile()) {
    const err = new Error('Eso no existe.');
    err.status = 404;
    throw err;
  }

  /* dias === 0 o 'siempre' pide un enlace sin fecha. Se distingue de "no me
     han dicho nada", que sigue cayendo en los 7 dias de siempre: quedarse sin
     caducidad por un parametro que falta seria justo el fallo que no se quiere
     tener aqui. */
  const indefinido = dias === 0 || dias === '0' || dias === 'siempre';
  const cuantos = Math.min(DIAS_MAXIMO, Math.max(1, Number(dias) || DIAS_POR_DEFECTO));
  const datos = leer();
  limpiar(datos);

  /* Si ya hay un enlace vivo para esa misma foto, se devuelve ese en vez de
     sembrar uno nuevo cada vez que se pulsa el boton: acabarian veinte enlaces
     validos de la misma foto y revocar uno no serviria de nada. */
  for (const [token, e] of Object.entries(datos)) {
    if (e.tipo === tipo && e.rel === rel) {
      return { token, caduca: e.caduca, nombre: path.basename(rel), reutilizado: true };
    }
  }

  const token = crypto.randomBytes(16).toString('base64url');
  datos[token] = {
    tipo, rel,
    nombre: path.basename(rel),
    creado: Date.now(),
    caduca: indefinido ? null : Date.now() + cuantos * 86400000,
    vistas: 0,
  };
  escribir(datos);
  return { token, caduca: datos[token].caduca, nombre: datos[token].nombre };
}

/*
 * De codigo a fichero. Devuelve null por cualquier motivo -- no existe, ha
 * caducado, o la foto se borro despues -- porque de cara afuera todos esos
 * casos son el mismo: aqui no hay nada.
 */
function resolver(token, contar) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,32}$/.test(token)) return null;
  const datos = leer();
  const e = datos[token];
  if (!e) return null;
  if (e.caduca !== null && (!e.caduca || e.caduca < Date.now())) return null;

  const abs = ficheros.resolver(e.tipo, e.rel);
  if (!abs) return null;

  if (contar) {
    e.vistas = (e.vistas || 0) + 1;
    e.ultima = Date.now();
    try { escribir(datos); } catch { /* llevar la cuenta no puede romper la visita */ }
  }
  return { tipo: e.tipo, rel: e.rel, nombre: e.nombre, abs, caduca: e.caduca, vistas: e.vistas };
}

function revocar(token) {
  const datos = leer();
  if (!datos[token]) {
    const err = new Error('Ese enlace ya no existe.');
    err.status = 404;
    throw err;
  }
  delete datos[token];
  escribir(datos);
  return { ok: true };
}

function listar() {
  const datos = leer();
  if (limpiar(datos)) { try { escribir(datos); } catch {} }
  return Object.entries(datos)
    .map(([token, e]) => ({
      token, tipo: e.tipo, rel: e.rel, nombre: e.nombre,
      creado: e.creado, caduca: e.caduca, vistas: e.vistas || 0,
      indefinido: e.caduca === null,
      dias: e.caduca === null ? null : Math.max(0, Math.ceil((e.caduca - Date.now()) / 86400000)),
    }))
    .sort((a, b) => b.creado - a.creado);
}

module.exports = { crear, resolver, revocar, listar, DIAS_POR_DEFECTO, DIAS_MAXIMO };
