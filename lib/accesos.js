'use strict';
/*
 * Quien puede entrar en los archivos de quien.
 *
 * Mismo trato que las bovedas de l-notes: se reparte un enlace con un permiso
 * —mirar o tambien tocar— y quien lo abre se queda el acceso. El enlace no se
 * gasta: sigue valiendo para el siguiente, y lo que se retira es el acceso ya
 * concedido, que es lo que de verdad da entrada.
 *
 * Se guarda en un JSON al lado de los archivos y no en una base: son cuatro
 * lineas por persona y meter un motor aqui seria pagar por nada.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAIZ = process.env.ARCHIVOS_RAIZ || '/var/archivos';
const FICHERO = path.join(RAIZ, '.accesos.json');

const EDITOR = 'editor';
const LECTOR = 'lector';
const PERMISOS = [EDITOR, LECTOR];

function leer() {
  try {
    const d = JSON.parse(fs.readFileSync(FICHERO, 'utf8'));
    return { invitaciones: d.invitaciones || {}, accesos: d.accesos || [] };
  } catch {
    return { invitaciones: {}, accesos: [] };
  }
}

function escribir(datos) {
  fs.mkdirSync(RAIZ, { recursive: true });
  const tmp = FICHERO + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FICHERO);
}

/* Una invitacion abierta por permiso: repartir dos enlaces iguales no aporta
   nada y luego no se sabe cual retirar. */
function invitar(dueno, permiso) {
  if (!PERMISOS.includes(permiso)) return null;
  const datos = leer();

  for (const [token, i] of Object.entries(datos.invitaciones)) {
    if (i.dueno === dueno && i.permiso === permiso) return token;
  }

  const token = crypto.randomBytes(16).toString('base64url');
  datos.invitaciones[token] = { dueno, permiso, creado: new Date().toISOString() };
  escribir(datos);
  return token;
}

/* Aceptar: el que abre el enlace se lleva su acceso. Si ya tenia uno, se le
   pone el permiso del enlace nuevo, que es lo ultimo que ha dicho el dueno. */
function aceptar(token, invitado) {
  const datos = leer();
  const inv = datos.invitaciones[token];
  if (!inv || inv.dueno === invitado) return null;

  const ya = datos.accesos.find((a) => a.dueno === inv.dueno && a.invitado === invitado);
  if (ya) {
    ya.permiso = inv.permiso;
  } else {
    datos.accesos.push({
      dueno: inv.dueno, invitado, permiso: inv.permiso,
      creado: new Date().toISOString(),
    });
  }
  escribir(datos);
  return inv.dueno;
}

/* El permiso de alguien sobre los archivos de otro, o null si no tiene. */
function permisoDe(dueno, invitado) {
  if (dueno === invitado) return EDITOR;      // en lo tuyo mandas tu
  const a = leer().accesos.find((x) => x.dueno === dueno && x.invitado === invitado);
  return a ? a.permiso : null;
}

/* Lo que uno puede mirar: lo suyo primero y luego lo que le hayan dado. */
function espaciosDe(usuario) {
  const datos = leer();
  const salida = [{ dueno: usuario, propio: true, permiso: EDITOR }];
  for (const a of datos.accesos) {
    if (a.invitado === usuario) {
      salida.push({ dueno: a.dueno, propio: false, permiso: a.permiso });
    }
  }
  return salida;
}

/* Lo que uno ha repartido: los accesos vivos y los enlaces sin usar. */
function repartidoPor(usuario) {
  const datos = leer();
  const accesos = datos.accesos
    .filter((a) => a.dueno === usuario)
    .map((a) => ({ id: 'a:' + a.invitado, invitado: a.invitado,
                   permiso: a.permiso, creado: a.creado }));
  const enlaces = Object.entries(datos.invitaciones)
    .filter(([, i]) => i.dueno === usuario)
    .map(([token, i]) => ({ id: 't:' + token, token, invitado: null,
                            permiso: i.permiso, creado: i.creado }));
  return accesos.concat(enlaces);
}

/* Retirar. Vale tanto para un acceso concedido como para un enlace sin usar;
   solo el dueno puede, y el id dice cual de las dos cosas es. */
function retirar(usuario, id) {
  const datos = leer();
  const [que, cual] = String(id || '').split(':');

  if (que === 'a') {
    const antes = datos.accesos.length;
    datos.accesos = datos.accesos.filter(
      (a) => !(a.dueno === usuario && a.invitado === cual));
    if (datos.accesos.length === antes) return false;
  } else if (que === 't') {
    const i = datos.invitaciones[cual];
    if (!i || i.dueno !== usuario) return false;
    delete datos.invitaciones[cual];
  } else {
    return false;
  }

  escribir(datos);
  return true;
}

module.exports = {
  EDITOR, LECTOR, PERMISOS,
  invitar, aceptar, permisoDe, espaciosDe, repartidoPor, retirar,
};
