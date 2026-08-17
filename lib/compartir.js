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

/*
 * Cada cosa con su seccion.
 *
 * Se acepta un nombre suelto, una lista de nombres o una lista de {tipo, rel}.
 * Lo primero y lo segundo son de una sola seccion —la que diga quien llama— y
 * lo tercero permite mezclar: en la galeria conviven fotos y videos, que son
 * dos carpetas distintas en disco.
 */
function normalizar(porDefecto, rel) {
  const bruto = Array.isArray(rel) ? rel : [rel];
  const items = [];
  for (const x of bruto) {
    if (!x) continue;
    if (typeof x === 'object') {
      const r = String(x.rel || '');
      if (r) items.push({ tipo: String(x.tipo || x.seccion || porDefecto || ''), rel: r });
    } else {
      const r = String(x);
      if (r) items.push({ tipo: String(porDefecto || ''), rel: r });
    }
  }
  return items;
}

/* Lo que identifica a un lote, para no sembrar un enlace nuevo cada vez que se
   comparte lo mismo. El tipo entra en la huella: dos ficheros con el mismo
   nombre en secciones distintas no son el mismo fichero. */
const huellaDe = (items) => items
  .map((i) => i.tipo + '\u0000' + i.rel).sort().join('\u001f');

/* Lo que hay guardado, sea del formato que sea. Las entradas viejas traen
   `rels` (o `rel` a secas) y una sola seccion para todas. */
const itemsDe = (e) => e.items
  || (e.rels || (e.rel ? [e.rel] : [])).map((r) => ({ tipo: e.tipo, rel: r }));

function crear(usuario, tipo, rel, dias) {
  const items = normalizar(tipo, rel);
  if (!items.length) {
    const err = new Error('No has dicho que compartir.');
    err.status = 400;
    throw err;
  }

  // Tienen que existir AHORA, no cuando alguien abra el enlace.
  for (const uno of items) {
    const abs = ficheros.resolver(usuario, uno.tipo, uno.rel);
    if (!abs || !fs.statSync(abs).isFile()) {
      const err = new Error('«' + path.basename(uno.rel) + '» no existe o no es un fichero.');
      err.status = 404;
      throw err;
    }
  }

  /* dias === 0 o 'siempre' pide un enlace sin fecha. Se distingue de "no me
     han dicho nada", que sigue cayendo en los 7 dias de siempre: quedarse sin
     caducidad por un parametro que falta seria justo el fallo que no se quiere
     tener aqui. */
  const indefinido = dias === 0 || dias === '0' || dias === 'siempre';
  const cuantos = Math.min(DIAS_MAXIMO, Math.max(1, Number(dias) || DIAS_POR_DEFECTO));
  const datos = leer();
  limpiar(datos);

  const nombre = items.length === 1
    ? path.basename(items[0].rel)
    : items.length + ' archivos';

  /* Si ya hay un enlace vivo para exactamente lo mismo, se devuelve ese en vez
     de sembrar uno nuevo cada vez que se pulsa el boton: acabarian veinte
     enlaces validos de lo mismo y revocar uno no serviria de nada. */
  const huella = huellaDe(items);
  for (const [token, e] of Object.entries(datos)) {
    if (e.usuario !== usuario) continue;
    if (huellaDe(itemsDe(e)) === huella) {
      return { token, caduca: e.caduca, nombre: e.nombre || nombre,
               cuantos: items.length, reutilizado: true };
    }
  }

  const token = crypto.randomBytes(16).toString('base64url');
  datos[token] = {
    usuario,
    /* `tipo` se sigue guardando —es el de la primera— porque hay pantallas que
       preguntan por el; el que manda al abrir es el de cada item. */
    tipo: items[0].tipo,
    items,
    nombre,
    creado: Date.now(),
    caduca: indefinido ? null : Date.now() + cuantos * 86400000,
    vistas: 0,
  };
  escribir(datos);
  return { token, caduca: datos[token].caduca, nombre, cuantos: items.length };
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

  /* Las entradas de antes traen `rels`, o `rel` a secas, y una sola seccion
     para todas. Se leen como lo que son sin tocar el almacen: reescribirlo
     entero por esto seria arriesgar los enlaces que ya estan repartidos. */
  const lista = itemsDe(e);

  const cosas = [];
  for (const uno of lista) {
    const abs = ficheros.resolver(e.usuario, uno.tipo, uno.rel);
    /* Lo que se haya borrado despues simplemente ya no esta; el enlace sigue
       valiendo para el resto. Que un fichero de cinco desaparezca no tiene por
       que tumbar los otros cuatro. */
    if (abs) cosas.push({ tipo: uno.tipo, rel: uno.rel, nombre: path.basename(uno.rel), abs });
  }
  if (!cosas.length) return null;

  if (contar) {
    e.vistas = (e.vistas || 0) + 1;
    e.ultima = Date.now();
    try { escribir(datos); } catch { /* llevar la cuenta no puede romper la visita */ }
  }

  return {
    /* Para quien solo entiende de uno, el del primero: con secciones mezcladas
       no hay un tipo del lote. */
    tipo: cosas[0].tipo,
    cosas,
    /* Para quien solo entiende de uno: el primero. */
    rel: cosas[0].rel,
    abs: cosas[0].abs,
    nombre: e.nombre || cosas[0].nombre,
    caduca: e.caduca,
    vistas: e.vistas,
  };
}

function revocar(token, usuario) {
  const datos = leer();
  /* Retirar el enlace de otro con solo saber el token seria una puerta
     de atras; se comprueba que es suyo. */
  if (!datos[token] || datos[token].usuario !== usuario) {
    /* Mismo error si no existe que si es de otro: distinguirlos diría a quien
       va probando tokens cuáles ha acertado. */
    const err = new Error('Ese enlace ya no existe.');
    err.status = 404;
    throw err;
  }
  delete datos[token];
  escribir(datos);
  return { ok: true };
}

function listar(usuario) {
  const datos = leer();
  if (limpiar(datos)) { try { escribir(datos); } catch {} }
  return Object.entries(datos)
    .filter(([, e]) => e.usuario === usuario)
    .map(([token, e]) => ({
      token, tipo: e.tipo, rel: e.rel || (itemsDe(e)[0] || {}).rel, nombre: e.nombre,
      creado: e.creado, caduca: e.caduca, vistas: e.vistas || 0,
      indefinido: e.caduca === null,
      dias: e.caduca === null ? null : Math.max(0, Math.ceil((e.caduca - Date.now()) / 86400000)),
    }))
    .sort((a, b) => b.creado - a.creado);
}

module.exports = { crear, resolver, revocar, listar, DIAS_POR_DEFECTO, DIAS_MAXIMO };
