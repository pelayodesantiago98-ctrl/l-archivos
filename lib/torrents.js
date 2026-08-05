'use strict';
/*
 * Hablar con transmission, y el tope de 20 GB.
 *
 * transmission escucha solo en 127.0.0.1 y con clave: nadie de fuera le habla,
 * y de dentro solo quien pueda leer /etc/lepayimio/transmission.env, que es
 * root y el grupo www-data.
 *
 * Su RPC tiene una costumbre rara pero razonable: la primera peticion se
 * contesta con un 409 y una cabecera con el identificador de sesion, que hay
 * que repetir en las siguientes. Es su defensa contra que una pagina cualquiera
 * le mande ordenes desde el navegador de quien tenga la maquina abierta. Se
 * guarda y se renueva sola cuando caduca.
 */
const fs = require('fs');

const ENV = '/etc/lepayimio/transmission.env';

function leerEnv() {
  const datos = {};
  try {
    for (const linea of fs.readFileSync(ENV, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(linea.trim());
      if (m) datos[m[1]] = m[2];
    }
  } catch (err) {
    console.error('[torrents] no puedo leer ' + ENV + ': ' + err.message);
  }
  return datos;
}

const CONF = leerEnv();
const URL_RPC = CONF.TRANSMISION_URL || 'http://127.0.0.1:9091/transmission/rpc';
const AUTORIZACION = 'Basic ' + Buffer.from(
  (CONF.TRANSMISION_USUARIO || '') + ':' + (CONF.TRANSMISION_CLAVE || '')).toString('base64');

/* El tope. No es solo lo que ocupa ahora: cuenta tambien lo que van a ocupar
   las descargas a medias, porque si no se aceptarian cinco peliculas de 4 GB
   "porque ahora mismo caben" y el disco reventaria a mitad de camino. */
const TOPE = Number(process.env.TORRENTS_TOPE_GB || 20) * 1024 * 1024 * 1024;

/* Y un suelo de disco aparte del tope: el disco lo comparten Jellyfin, las
   recompresiones del buzon y los seis sitios. Que quepa en la cuota no
   significa que quepa en la maquina. */
const MARGEN_DISCO_GB = Number(process.env.TORRENTS_MARGEN_GB || 8);

const CAMPOS = [
  'id', 'name', 'status', 'percentDone', 'totalSize', 'haveValid', 'rateDownload',
  'rateUpload', 'eta', 'errorString', 'error', 'addedDate', 'doneDate',
  'downloadDir', 'isFinished', 'metadataPercentComplete', 'uploadRatio', 'peersConnected',
];

let sesion = null;

async function rpc(method, args = {}, reintento = true) {
  const res = await fetch(URL_RPC, {
    method: 'POST',
    headers: {
      'Authorization': AUTORIZACION,
      'Content-Type': 'application/json',
      ...(sesion ? { 'X-Transmission-Session-Id': sesion } : {}),
    },
    body: JSON.stringify({ method, arguments: args }),
  });

  // Sesion caducada o primera vez: se toma la nueva y se repite una vez.
  if (res.status === 409 && reintento) {
    sesion = res.headers.get('x-transmission-session-id');
    return rpc(method, args, false);
  }
  if (res.status === 401) throw new Error('transmission rechaza la clave');
  if (!res.ok) throw new Error('transmission respondio ' + res.status);

  const cuerpo = await res.json();
  if (cuerpo.result !== 'success') throw new Error(cuerpo.result || 'error de transmission');
  return cuerpo.arguments || {};
}

const listar = async () => (await rpc('torrent-get', { fields: CAMPOS })).torrents || [];

/*
 * Cuanto hay pedido y cuanto ocupa de verdad.
 *
 *  - ocupado:      lo que ya esta en el disco (trozos verificados).
 *  - comprometido: lo que ocupara cuando todo termine.
 *
 * El tope se mide contra lo comprometido, que es lo unico que evita quedarse
 * sin disco a mitad de descarga.
 */
function cuentas(torrents) {
  let ocupado = 0, comprometido = 0;
  for (const t of torrents) {
    ocupado += t.haveValid || 0;
    comprometido += t.totalSize || 0;
  }
  return {
    ocupado,
    comprometido,
    tope: TOPE,
    libre: Math.max(0, TOPE - comprometido),
    porcentaje: TOPE ? Math.min(100, Math.round((comprometido / TOPE) * 100)) : 0,
  };
}

function discoLibreGB() {
  try {
    const s = fs.statfsSync('/var/torrents');
    return (s.bavail * s.bsize) / 1073741824;
  } catch { return Infinity; }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Añadir.
 *
 * Entra SIEMPRE en pausa, se mira lo que va a ocupar y solo entonces se suelta.
 * Al reves no vale: un torrent arranca pidiendo trozos en cuanto se añade, y
 * para cuando se comprueba la cuota ya ha escrito en el disco.
 *
 * Con un .torrent el tamano se sabe al momento. Con un magnet no: hay que
 * pedirle los metadatos al enjambre, y eso tarda de uno a veinte segundos. Por
 * eso se espera, y si no llegan se queda en pausa y se avisa, en vez de soltar
 * a ciegas algo que podria ser de 80 GB.
 */
async function anadir({ magnet, base64 }) {
  /*
   * El .torrent entra en pausa; el magnet, andando. No es un capricho.
   *
   * Un .torrent trae los metadatos dentro, asi que se puede parar en la puerta,
   * mirar lo que va a ocupar y soltarlo solo si cabe.
   *
   * Un magnet son cuarenta bytes con un hash: el tamano hay que pedirselo al
   * enjambre, y para hablar con el enjambre hay que estar en marcha. Un torrent
   * en pausa no se conecta a nadie, asi que añadirlo pausado y esperar a que
   * diga cuanto ocupa es esperar sentado -- se queda en pausa para siempre.
   * Pasaba: la primera prueba se quedo cuarenta sondeos en "en pausa, 0 MB de ?".
   *
   * Soltarlo antes de comprobar la cuota no es tan grave como suena: primero
   * pide los metadatos y solo despues empieza con los trozos del video, asi que
   * cuando se comprueba no ha escrito nada. Y si no cabe, se borra con lo poco
   * que hubiera bajado.
   */
  const args = { paused: !magnet, 'download-dir': '/var/torrents/completos' };
  if (magnet) args.filename = magnet;
  else args.metainfo = base64;

  const r = await rpc('torrent-add', args);
  const nuevo = r['torrent-added'] || r['torrent-duplicate'];
  if (!nuevo) throw new Error('transmission no ha aceptado el torrent');
  if (r['torrent-duplicate']) {
    return { id: nuevo.id, nombre: nuevo.name, duplicado: true };
  }

  const id = nuevo.id;
  let info = null;
  for (let i = 0; i < 20; i++) {
    const lista = (await rpc('torrent-get', { ids: [id], fields: CAMPOS })).torrents || [];
    info = lista[0];
    if (info && info.totalSize > 0) break;
    await esperar(1000);
  }

  if (!info || !info.totalSize) {
    /* Sigue buscando metadatos. Se deja correr, porque pararlo seria condenarlo
       a no encontrarlos nunca, y de que no se pase de cuota ya se encarga el
       vigilante de mas abajo en cuanto sepa lo que ocupa. */
    return {
      id, nombre: (info && info.name) || 'sin nombre', buscando: true,
      aviso: 'Todavia no se cuanto ocupa: sigue buscando la informacion del '
           + 'torrent. Aparecera en la lista en cuanto la encuentre.',
    };
  }

  // Ahora si: ¿cabe?
  const otros = (await listar()).filter((t) => t.id !== id);
  const c = cuentas(otros);
  const faltan = info.totalSize - c.libre;

  if (faltan > 0) {
    await rpc('torrent-remove', { ids: [id], 'delete-local-data': true });
    const err = new Error(
      'No cabe: ocupa ' + gb(info.totalSize) + ' y solo quedan ' + gb(c.libre)
      + ' de los ' + gb(TOPE) + '. Libera al menos ' + gb(faltan) + ' borrando alguna descarga.');
    err.status = 507;
    throw err;
  }

  const libreGB = discoLibreGB();
  if (libreGB - info.totalSize / 1073741824 < MARGEN_DISCO_GB) {
    await rpc('torrent-remove', { ids: [id], 'delete-local-data': true });
    const err = new Error(
      'Cabe en la cuota pero no en el disco: quedarian menos de ' + MARGEN_DISCO_GB
      + ' GB libres en la maquina.');
    err.status = 507;
    throw err;
  }

  await rpc('torrent-start', { ids: [id] });
  return { id, nombre: info.name, tamano: info.totalSize };
}

const arrancar = (id) => rpc('torrent-start', { ids: [Number(id)] });
const parar = (id) => rpc('torrent-stop', { ids: [Number(id)] });

/* Borrar se lleva SIEMPRE los datos: es lo unico que libera cuota, y dejar el
   torrent fuera de la lista pero los gigas en el disco seria justo lo contrario
   de lo que espera quien pulsa "eliminar". Lo que ya se haya colocado en
   l-films no se toca: es otro fichero. */
const borrar = (id) => rpc('torrent-remove', { ids: [Number(id)], 'delete-local-data': true });

function gb(bytes) {
  const g = bytes / 1073741824;
  if (g >= 10) return g.toFixed(0) + ' GB';
  if (g >= 1) return g.toFixed(1) + ' GB';
  return Math.round(bytes / 1048576) + ' MB';
}

/*
 * Estado para la pantalla: lo justo, ya masticado, para que el navegador no
 * tenga que saber como piensa transmission.
 */
async function estado() {
  const torrents = await listar();
  const c = cuentas(torrents);
  return {
    cuota: { ...c, ocupadoTexto: gb(c.ocupado), compTexto: gb(c.comprometido),
             topeTexto: gb(c.tope), libreTexto: gb(c.libre) },
    discoLibreGB: Math.round(discoLibreGB()),
    torrents: torrents.map((t) => ({
      id: t.id,
      nombre: t.name,
      estado: nombreEstado(t),
      porcentaje: Math.round((t.percentDone || 0) * 1000) / 10,
      metadatos: Math.round((t.metadataPercentComplete || 1) * 100),
      tamano: t.totalSize,
      tamanoTexto: t.totalSize ? gb(t.totalSize) : '?',
      enDisco: t.haveValid || 0,
      enDiscoTexto: gb(t.haveValid || 0),
      bajando: t.rateDownload || 0,
      subiendo: t.rateUpload || 0,
      eta: t.eta > 0 ? t.eta : null,
      pares: t.peersConnected || 0,
      ratio: t.uploadRatio > 0 ? Math.round(t.uploadRatio * 100) / 100 : 0,
      terminado: !!t.isFinished || t.percentDone === 1,
      error: t.errorString || null,
    })),
  };
}

function nombreEstado(t) {
  if (t.error) return 'error';
  switch (t.status) {
    case 0: return 'en pausa';
    case 1: case 2: return 'comprobando';
    case 3: return 'en cola';
    case 4: return t.metadataPercentComplete < 1 ? 'buscando datos' : 'descargando';
    case 5: return 'en cola para compartir';
    case 6: return 'compartiendo';
    default: return 'desconocido';
  }
}


/*
 * Vigilante de la cuota.
 *
 * Hace falta por los magnets: entran sin que se sepa lo que ocupan, y cuando
 * por fin lo dicen puede que no quepan. Comprobarlo solo al añadir dejaria ese
 * hueco abierto. Esto lo cierra: cada veinte segundos mira el total y, si se ha
 * pasado, para los mas nuevos hasta volver por debajo.
 *
 * Para, no borra. Perder una descarga por un descuadre de cuota seria peor que
 * el descuadre, y parado no ocupa mas: lo que ya bajo sigue ahi para reanudar o
 * para borrarlo a mano desde la pagina.
 */
let vigilando = false;
async function vigilarCuota() {
  if (vigilando) return;
  vigilando = true;
  try {
    const torrents = await listar();
    const c = cuentas(torrents);
    if (c.comprometido <= TOPE) return;

    // Los ultimos en llegar son los primeros en parar: quien lleva media
    // pelicula bajada no tiene por que pagar por el que acaba de entrar.
    const candidatos = torrents
      .filter((t) => t.status !== 0)
      .sort((a, b) => (b.addedDate || 0) - (a.addedDate || 0));

    let exceso = c.comprometido - TOPE;
    for (const t of candidatos) {
      if (exceso <= 0) break;
      await rpc('torrent-stop', { ids: [t.id] });
      console.warn('[torrents] parado por cuota: ' + t.name);
      exceso -= t.totalSize || 0;
    }
  } catch (err) {
    console.error('[torrents] el vigilante ha fallado: ' + err.message);
  } finally {
    vigilando = false;
  }
}

const reloj = setInterval(vigilarCuota, 20000);
if (reloj.unref) reloj.unref();

module.exports = { estado, anadir, borrar, arrancar, parar, gb, TOPE };
