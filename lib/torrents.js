'use strict';
/*
 * Hablar con transmission, y decidir cuando puede empezar cada descarga.
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
 *
 *
 * POR QUE YA NO HAY CUOTA DE 20 GB
 *
 * Habia un tope: la suma de lo que ocupaban todas las descargas no podia pasar
 * de 20 GB, y lo que no cabia se rechazaba en la puerta con un 507. Tenia
 * sentido cuando la biblioteca vivia en el propio VPS y cada pelicula se
 * quedaba ahi para siempre.
 *
 * Ya no vive ahi. Desde que /var/media/peliculas y /var/media/series son la
 * Storage Box de 5 TB, el disco del VPS no es el sitio donde se guardan las
 * cosas: es el banco de trabajo por el que pasan. Una pelicula esta en el disco
 * el rato que tarda en bajarse y en remuxarse, y despues se va. Poner un tope
 * de 20 GB a un sitio de paso es medir la cosa equivocada -- lo que no puede
 * pasar no es que se bajen muchos gigas en total, es que haya muchos gigas A LA
 * VEZ.
 *
 * Asi que el tope se cambia por una cola: se acepta todo, y cada descarga
 * espera su turno hasta que haya sitio de verdad en el disco. Nada se rechaza,
 * nada se pierde, y el disco no se llena.
 */
const fs = require('fs');
const path = require('path');

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

/* El disco por el que pasan las descargas y el buzon del que las recoge el
   remuxador. Los dos cuelgan del mismo /dev/vda1, que es justo el motivo de
   que haya que contarlos juntos. */
const DESCARGAS = '/var/torrents';
const BUZON = process.env.ENTRADA_VIDEO || '/var/media/entrada';
const PARCIALES = path.join(process.env.ARCHIVOS_RAIZ || '/var/archivos', '.parciales');

/* Donde se deja apuntado cuanto sitio tienen pedido las subidas locales, para
   que l-torrents -- que es otro proceso -- respete la misma prioridad sin
   tener que preguntarnos por HTTP. */
const FICHA_RESERVA = path.join(PARCIALES, '.reserva.json');

/* Cuanto vale una reserva sin que la refresquen. El navegador la renueva cada
   pocos segundos mientras sube; si se cierra la pestaña, se cae el wifi o se
   va la luz, caduca sola y los torrents recuperan el sitio. Sin esto, cerrar
   el portatil a media cola dejaria las descargas paradas para siempre. */
const VIDA_RESERVA = 90000;

/* Lo que hay que dejar libre pase lo que pase. Es el mismo numero que exige
   procesar-entrada.js para ponerse a trabajar, y no es casualidad: si el disco
   baja de ahi, el que se para es el buzon. */
const MARGEN_GB = Number(process.env.TORRENTS_MARGEN_GB || 8);
const MARGEN = MARGEN_GB * 1073741824;

/* La marca con la que se distingue "esto lo he parado yo porque no hay sitio"
   de "esto lo ha parado el usuario". Vive en transmission, no aqui, para que
   sobreviva a un reinicio de l-archivos: si se guardara en memoria, al
   reiniciar el servicio la cola entera se volveria indistinguible de un monton
   de descargas pausadas a mano, y no arrancaria ninguna nunca mas. */
const ETIQUETA = 'l-archivos:esperando-disco';

// Un poco mas de sitio para ARRANCAR que para SEGUIR.
//
// Sin esta diferencia, algo que arranca justo en el limite lo aparca la vuelta
// siguiente en cuanto el buzon empieza a copiar un fichero, y se queda dando
// tumbos entre arrancar y parar sin llegar a bajar nada. Se vio en cuanto entro
// en produccion: el mismo capitulo entrando y saliendo de la cola cada veinte
// segundos. Con esta holgura, lo que arranca tiene margen para sobrevivir a la
// siguiente vuelta.
const HOLGURA = 2 * 1073741824;

const CAMPOS = [
  'id', 'name', 'status', 'percentDone', 'totalSize', 'sizeWhenDone', 'haveValid', 'rateDownload',
  'rateUpload', 'eta', 'errorString', 'error', 'addedDate', 'doneDate',
  'downloadDir', 'isFinished', 'metadataPercentComplete', 'uploadRatio', 'peersConnected',
  'labels',
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

const esperandoDisco = (t) => (t.labels || []).includes(ETIQUETA);
const enMarcha = (t) => t.status !== 0;

/* Lo que a este torrent le queda por escribir en el disco. Lo ya bajado no
   cuenta: esos bytes ya estan puestos y ya los descuenta el statfs. */
/* Lo que va a ocupar de verdad: en un torrent con archivos sin marcar —bajar
   cuatro capitulos de un pack de 160 GB— `totalSize` es el pack entero y
   `sizeWhenDone` solo lo elegido. Usar el primero dejaba la descarga en la cola
   para siempre porque "no cabe en el disco". */
const tamano = (t) => t.sizeWhenDone || t.totalSize || 0;
const pendiente = (t) => Math.max(0, tamano(t) - (t.haveValid || 0));

function discoLibre() {
  try {
    const s = fs.statfsSync(DESCARGAS);
    return s.bavail * s.bsize;
  } catch { return Infinity; }
}

function discoTotal() {
  try {
    const s = fs.statfsSync(DESCARGAS);
    return s.blocks * s.bsize;
  } catch { return Infinity; }
}

/*
 * El fichero mas gordo que ya esta esperando en el buzon.
 *
 * Cuenta para la reserva igual que los torrents: procesar-entrada.js va a tener
 * que copiarlo entero, este ahi porque acaba de bajarse o porque lleva dos dias
 * esperando su turno.
 */
function mayorEnBuzon() {
  let mayor = 0;
  try {
    for (const n of fs.readdirSync(BUZON)) {
      if (n.startsWith('.')) continue;
      try { mayor = Math.max(mayor, fs.statSync(path.join(BUZON, n)).size); } catch {}
    }
  } catch {}
  return mayor;
}

/*
 * ── La prioridad de las subidas locales ─────────────────────────────────────
 *
 * Lo que sube Pelayo desde su ordenador va POR DELANTE de los torrents, y no de
 * boquilla: se le aparta el sitio antes de repartir.
 *
 * Es lo justo aunque solo sea por como se comporta cada uno. Un torrent que se
 * queda esperando no pierde nada -- sigue ahi, arranca solo cuando toque y a
 * nadie le importa que tarde una hora mas. Una subida que se encuentra el disco
 * lleno le corta la cara a quien esta delante mirando la barra de progreso, y
 * ademas no se puede posponer: los bytes estan en su portatil, no en un
 * enjambre que los va a seguir teniendo manana.
 *
 * Se cuenta de dos maneras y se coge la mayor:
 *
 *   - Lo que el navegador dice que le queda por mandar (la cola entera, no solo
 *     el fichero de ahora). Es lo que de verdad hace falta, pero depende de que
 *     haya alguien con la pagina abierta avisando.
 *   - Lo que se ve en el disco: las subidas a medias que hay en .parciales. No
 *     sabe de la cola, pero no depende de nadie y cubre las subidas que vengan
 *     de otro sitio.
 */
const reservas = new Map();

function reservarSubida(id, bytes, mayor) {
  if (!id) return;
  const n = Number(bytes) || 0;
  if (n <= 0) { reservas.delete(id); return; }
  reservas.set(id, { bytes: n, mayor: Number(mayor) || 0, hasta: Date.now() + VIDA_RESERVA });
}

/* Lo que le falta por escribir a las subidas que hay a medias en el disco. La
   ficha dice lo que va a ocupar y el parcial lo que lleva; la resta es lo que
   todavia va a llegar. */
function pendienteEnParciales() {
  let bytes = 0, mayor = 0;
  let fichas = [];
  try { fichas = fs.readdirSync(PARCIALES); } catch { return { bytes, mayor }; }
  for (const n of fichas) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    try {
      const ficha = JSON.parse(fs.readFileSync(path.join(PARCIALES, n), 'utf8'));
      const total = Number(ficha.tamano) || 0;
      if (!total) continue;
      let hay = 0;
      try { hay = fs.statSync(path.join(PARCIALES, n.slice(0, -5))).size; } catch {}
      bytes += Math.max(0, total - hay);
      mayor = Math.max(mayor, total);
    } catch {}
  }
  return { bytes, mayor };
}

function reservadoPorSubidas(excepto) {
  const ahora = Date.now();
  let bytes = 0, mayor = 0;
  for (const [id, r] of reservas) {
    if (r.hasta < ahora) { reservas.delete(id); continue; }
    /* Quien tiene sitio apartado necesita poder preguntar "¿cabe lo mio?" sin
       tropezarse con su propia reserva: contarse a uno mismo es no arrancar
       nunca, que es como se atasco la cola de videos el 8 de septiembre. */
    if (excepto && id === excepto) continue;
    bytes += r.bytes;
    mayor = Math.max(mayor, r.mayor);
  }
  const enDisco = pendienteEnParciales();
  /* La mayor de las dos cuentas, no la suma: miden lo mismo desde dos sitios y
     sumarlas seria reservar el doble por cada subida. */
  return { bytes: Math.max(bytes, enDisco.bytes), mayor: Math.max(mayor, enDisco.mayor) };
}

/* Y se deja escrito para que l-torrents lo lea. Se escribe siempre, tambien
   cuando vale cero: un fichero viejo con una cifra grande dejaria las descargas
   de la otra app frenadas sin motivo. */
function apuntarReserva(r) {
  try {
    fs.mkdirSync(PARCIALES, { recursive: true });
    fs.writeFileSync(FICHA_RESERVA, JSON.stringify({
      bytes: r.bytes, mayor: r.mayor, hasta: Date.now() + VIDA_RESERVA,
    }));
  } catch {}
}

/*
 * ── La regla ────────────────────────────────────────────────────────────────
 *
 * ¿Puede estar bajandose todo esto a la vez sin dejar al buzon sin sitio?
 *
 * No basta con que quepa lo que falta por bajar, y aqui esta el detalle que
 * hace falta entender para que "sin limite" no acabe siendo "atascado":
 *
 * Cuando una descarga termina, el video se enlaza en /var/media/entrada y
 * procesar-entrada.js lo prepara. Prepararlo no es tocarlo en el sitio: escribe
 * una COPIA ENTERA en /var/media/.trabajo, que esta en el mismo disco, y solo
 * despues la sube a la caja y borra las dos. O sea que cada fichero pasa por un
 * momento en que ocupa el doble.
 *
 * Y ese script se niega a empezar si no ve libre el tamaño del fichero mas 8 GB.
 * Con lo cual, si se llenara el disco hasta el borde a base de descargas,
 * pasaria lo peor que puede pasar: el buzon no arrancaria, los ficheros no
 * subirian nunca a la caja, no se borrarian del VPS, y el disco se quedaria
 * lleno para siempre. La descarga sin limite se ahoga sola.
 *
 * De ahi la cuenta: de lo libre se descuenta lo que falta por bajar, y ademas
 * se aparta el tamaño del mayor de todos, que es lo que el buzon va a necesitar
 * copiar. Basta con reservar el mayor y no la suma, porque el buzon los
 * procesa de uno en uno.
 */
function cabenJuntos(lista, libre, mayorDelBuzon, reserva) {
  const subidas = reserva === undefined ? reservadoPorSubidas() : reserva;
  let porEscribir = subidas.bytes;
  let mayor = Math.max(mayorDelBuzon || 0, subidas.mayor);
  for (const t of lista) {
    porEscribir += pendiente(t);
    mayor = Math.max(mayor, tamano(t));
  }
  return libre - porEscribir - mayor - MARGEN >= 0;
}

/* Lo que no cabria ni con el disco entero vacio no esta "esperando": es que no
   cabe, y punto. Se distingue para no dejarlo bloqueando la cola de por vida. */
/* Sin contar las subidas: la pregunta es si ese torrent cabe en esta maquina,
   no si cabe hoy. Con la reserva metida, una subida en marcha haria que un
   torrent normal se marcara como imposible y no arrancara nunca mas. */
const noCabeJamas = (t) => !cabenJuntos([t], discoTotal(), 0, { bytes: 0, mayor: 0 });

async function etiquetar(t, poner) {
  const otras = (t.labels || []).filter((l) => l !== ETIQUETA);
  const nuevas = poner ? otras.concat([ETIQUETA]) : otras;
  await rpc('torrent-set', { ids: [t.id], labels: nuevas });
  t.labels = nuevas;
}

async function aparcar(t) {
  await rpc('torrent-stop', { ids: [t.id] });
  await etiquetar(t, true);
  console.warn('[torrents] a la cola, no hay disco: ' + t.name + ' (' + gb(tamano(t)) + ')');
}

async function soltar(t) {
  await etiquetar(t, false);
  await rpc('torrent-start', { ids: [t.id] });
  console.log('[torrents] ya hay sitio, arranca: ' + t.name + ' (' + gb(tamano(t)) + ')');
}

/*
 * ── El planificador ─────────────────────────────────────────────────────────
 *
 * Corre cada veinte segundos y hace dos cosas, en este orden.
 *
 * 1. Si lo que esta en marcha ya no cabe, aparca. Pasa con los magnets, que
 *    entran sin que se sepa lo que ocupan y lo dicen despues; y pasa cuando
 *    otra cosa del servidor se come el disco por su cuenta. Se aparcan los
 *    ultimos en llegar: quien lleva media pelicula bajada no tiene por que
 *    pagar por el que acaba de entrar.
 *
 * 2. Si sobra sitio, suelta de la cola por orden de llegada. En orden estricto
 *    y a proposito: dejar que las pequeñas adelanten a las grandes es como una
 *    descarga de 30 GB se queda esperando para siempre mientras van pasando
 *    capitulos por delante. Lo unico que se salta son las que no cabrian ni con
 *    el disco vacio, que si no bloquearian la cola entera.
 */
/*
 * El freno.
 *
 * El disco no es lo unico que se pelean: la subida entra por la misma tarjeta de
 * red por la que bajan los torrents, y con cinco descargas a tope una pelicula
 * de 4 GB desde casa se arrastra. Mientras haya una subida en marcha se le pone
 * a transmission su limite alternativo -- el "modo tortuga" de toda la vida --
 * y se le quita al acabar.
 *
 * Solo se habla con transmission cuando el estado CAMBIA, no en cada vuelta:
 * son veinte segundos entre pasadas y no hace falta repetirselo.
 *
 * Si esto se muere con el freno puesto, no se queda puesto para siempre: la
 * reserva caduca sola a los noventa segundos, y arrancar el servicio otra vez
 * deja `frenado` en null, con lo que la primera pasada lo vuelve a fijar a lo
 * que toque.
 */
const FRENO_KBS = Number(process.env.TORRENTS_FRENO_KBS || 2000);
let frenado = null;

async function frenar(hayQueFrenar) {
  if (frenado === hayQueFrenar) return;
  try {
    await rpc('session-set', {
      'alt-speed-down': FRENO_KBS,
      'alt-speed-enabled': hayQueFrenar,
    });
    frenado = hayQueFrenar;
    console.log('[torrents] ' + (hayQueFrenar
      ? 'freno puesto (' + FRENO_KBS + ' kB/s): hay una subida en marcha y va primero'
      : 'freno quitado: ya no hay subidas en marcha'));
  } catch (err) {
    console.error('[torrents] no he podido tocar el freno: ' + err.message);
  }
}

/*
 * ── Quien tiene por donde bajar ─────────────────────────────────────────────
 *
 * Un torrent sin tracker que conteste es un torrent que no va a bajar nada. Y
 * cuando el tracker del que cuelgan casi todos deja de responder -- el de
 * elitetorrent se bloqueo por orden judicial el 8 de septiembre de 2026, y de
 * un dia para otro 460 torrents se quedaron a cero pares -- la cola sigue
 * repartiendo el disco por orden de llegada entre torrents que no pueden
 * avanzar, mientras los que si podrian esperan detras.
 *
 * Asi que la cola mira antes si hay tracker vivo. Tres grupos:
 *
 *   FUNCIONA     algun tracker contesto la ultima vez que se le pregunto.
 *   SIN SABER    todavia no se le ha preguntado a ninguno. Es lo normal en la
 *                cola: un torrent en pausa no anuncia, asi que de la mayoria no
 *                se sabe nada hasta que arranca.
 *   NO CONTESTA  se pregunto a todos y ninguno contesto.
 *
 * Los que no contestan van al final, que es lo unico que se puede hacer con
 * ellos sin borrarlos. Y el sistema se corrige solo: al arrancar uno de los
 * "sin saber" se le pregunta a su tracker, y con la respuesta sube al primer
 * grupo o baja al tercero.
 *
 * Se consulta aparte y cada cinco minutos, no en cada vuelta del planificador:
 * son otros 460 torrents de JSON y el dato cambia con la lentitud con la que se
 * cae un tracker, no con la de un reparto de disco.
 */
const TRACKERS_CADA = 5 * 60000;
let trackersVistos = new Map();
let trackersMirados = 0;

/* Cuanto vale un "no contesta". Un torrent en pausa no vuelve a preguntar a su
   tracker, asi que sin esto el veredicto seria para siempre: el dia que el
   tracker vuelva, los que lo tienen seguirian marcados como muertos y no
   arrancarian nunca para comprobarlo. Pasadas dos horas se les vuelve a dar el
   beneficio de la duda y les toca turno otra vez. */
const CADUCA_VEREDICTO = 2 * 3600000;

async function mirarTrackers() {
  if (trackersMirados && Date.now() - trackersMirados < TRACKERS_CADA) return trackersVistos;
  try {
    const lista = (await rpc('torrent-get', { fields: ['id', 'trackerStats'] })).torrents || [];
    const nuevo = new Map();
    for (const t of lista) {
      const stats = t.trackerStats || [];
      /* «lastAnnounceSucceeded» en false no distingue entre "contesto que no" y
         "no se le ha preguntado nunca", y son cosas distintas: lo segundo es la
         cola entera. Los separa lastAnnounceTime, que solo tiene valor si de
         verdad hubo un anuncio. */
      const ahora = Date.now() / 1000;
      const recientes = stats.filter((k) => k.lastAnnounceTime > 0
        && (ahora - k.lastAnnounceTime) * 1000 < CADUCA_VEREDICTO);
      if (stats.some((k) => k.lastAnnounceSucceeded)) nuevo.set(t.id, 'funciona');
      else if (recientes.length) nuevo.set(t.id, 'no contesta');
      else nuevo.set(t.id, 'sin saber');
    }
    trackersVistos = nuevo;
    trackersMirados = Date.now();
  } catch (err) {
    /* Sin este dato la cola sigue funcionando, solo que sin la preferencia:
       vale mas repartir por orden de llegada que no repartir. */
    console.error('[torrents] no he podido mirar los trackers: ' + err.message);
  }
  return trackersVistos;
}

/* Lo bueno primero: tracker que contesta, y a igualdad el mas adelantado, que
   es el que antes va a dejar libre su sitio en el disco. La fecha de llegada
   queda de desempate, que es como se repartia antes. */
const GRUPOS = { 'funciona': 0, 'sin saber': 1, 'no contesta': 2 };

function porInteres(vivos) {
  return (a, b) => {
    const ga = GRUPOS[vivos.get(a.id)] ?? 1;
    const gb = GRUPOS[vivos.get(b.id)] ?? 1;
    if (ga !== gb) return ga - gb;
    if ((b.percentDone || 0) !== (a.percentDone || 0)) return (b.percentDone || 0) - (a.percentDone || 0);
    return (a.addedDate || 0) - (b.addedDate || 0);
  };
}

/* Cuando arranco cada uno, para no reprocharle a los diez segundos que su
   tracker no le haya contestado todavia. */
const soltadoEn = new Map();
const MARGEN_ANUNCIO = 10 * 60000;

let avisoCola = null;
let planificando = false;
async function planificar() {
  if (planificando) return;
  planificando = true;
  try {
    const todos = await listar();
    const libre = discoLibre();
    const delBuzon = mayorEnBuzon();

    /* Se mira UNA vez por pasada y se reparte el mismo numero a todo el mundo.
       Preguntarlo dentro de cada comprobacion abriria la puerta a que la cuenta
       cambiara a mitad del reparto y se soltaran dos torrents con el mismo
       hueco. */
    const subidas = reservadoPorSubidas();
    apuntarReserva(subidas);
    await frenar(subidas.bytes > 0);

    const vivos = await mirarTrackers();
    const interes = porInteres(vivos);

    let activos = todos.filter(enMarcha);

    /* Cuando hay que hacer sitio se aparca al ultimo de la fila, que con este
       orden es el que menos posibilidades tiene de avanzar: sin tracker que
       conteste y con menos bajado. Antes se aparcaba al mas reciente, y eso
       podia quitar de en medio a uno que iba por el 90% para dejar corriendo a
       otro que no tenia con quien hablar.

       Y los que estan bajando de verdad se apartan los ultimos, por delante de
       cualquier otra consideracion: el disco se mueve solo -- el buzon copia,
       una descarga termina -- y en cuanto deja de caber todo, esta cuenta se
       lleva por delante a alguien. Que sea uno que estaba parado y no el unico
       que estaba trayendo bytes. */
    /* Ordena de mas intocable a mas prescindible, porque de aqui se saca por el
       final: primero los que estan bajando, y al final del todo el que no baja
       nada y encima no tiene tracker. */
    const desalojables = (lista) => [...lista].sort((a, b) => {
      const pa = a.peersConnected ? 1 : 0, pb = b.peersConnected ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return interes(a, b);
    });

    while (activos.length && !cabenJuntos(activos, libre, delBuzon, subidas)) {
      const peor = desalojables(activos).pop();
      await aparcar(peor);
      activos = activos.filter((t) => t.id !== peor.id);
    }

    const cola = todos
      .filter((t) => !enMarcha(t) && esperandoDisco(t))
      .sort(interes);

    /*
     * El relevo: quien esta parado deja su sitio a quien puede avanzar.
     *
     * No basta con repartir bien los huecos que quedan libres. Si estan
     * corriendo cuatro al 20% que no encuentran a nadie -- porque su tracker no
     * contesta -- y en la cola espera uno al 60% que si lo tiene, el sitio lo
     * tiene que ocupar el segundo. Si no, la cola no se mueve hasta que alguien
     * pare algo a mano.
     *
     * Tres frenos, porque un relevo mal puesto es una noria que no baja nada:
     *
     *   - NO SE TOCA A QUIEN ESTA BAJANDO. Si tiene pares, esta avanzando, y da
     *     igual que vaya por el 20%: uno que baja vale mas que uno parado al
     *     60%. Solo se releva a los que no han conseguido un solo par.
     *   - NI A QUIEN ACABA DE ARRANCAR. Diez minutos de cortesia: el que aun no
     *     ha anunciado no tiene culpa de que no le contesten.
     *   - Y LA MEJORA TIENE QUE SER CLARA: o el de la cola tiene tracker que
     *     contesta y el de dentro no, o van igualados de tracker y le saca cinco
     *     puntos de descarga. Sin ese margen, dos torrents parecidos se
     *     turnarian el sitio cada veinte segundos sin bajar nada.
     */
    const yaEntraron = new Set();
    const RELEVOS_POR_VUELTA = 3;
    const MEJORA = 0.05;

    const mejorQue = (candidato, dentro) => {
      const gc = GRUPOS[vivos.get(candidato.id)] ?? 1;
      const gd = GRUPOS[vivos.get(dentro.id)] ?? 1;
      if (gc !== gd) return gc < gd;
      return (candidato.percentDone || 0) >= (dentro.percentDone || 0) + MEJORA;
    };

    const relevables = () => activos
      .filter((t) => !t.peersConnected)
      .filter((t) => {
        const desde = soltadoEn.get(t.id);
        /* Los que ya estaban en marcha al arrancar el servicio no tienen fecha:
           se les apunta ahora y se les da su margen como a los demas. */
        if (!desde) { soltadoEn.set(t.id, Date.now()); return false; }
        return Date.now() - desde > MARGEN_ANUNCIO;
      })
      .sort(interes);

    for (let i = 0; i < RELEVOS_POR_VUELTA; i++) {
      const dentro = relevables().pop();               // el peor de los que se pueden mover
      if (!dentro) break;
      const fuera = cola.find((t) => !enMarcha(t) && !yaEntraron.has(t.id)
        && !noCabeJamas(t) && mejorQue(t, dentro));
      if (!fuera) break;
      /* Que el que entra quepa en el sitio que deja el que sale. */
      const resto = activos.filter((x) => x.id !== dentro.id);
      if (!cabenJuntos(resto.concat([fuera]), libre - HOLGURA, delBuzon, subidas)) break;

      await aparcar(dentro);
      soltadoEn.delete(dentro.id);
      await soltar(fuera);
      yaEntraron.add(fuera.id);
      soltadoEn.set(fuera.id, Date.now());
      activos = resto.concat([fuera]);
      console.log('[torrents] releva: sale ' + dentro.name.slice(0, 45)
        + ' (' + Math.round((dentro.percentDone || 0) * 100) + '%, ' + vivos.get(dentro.id)
        + ') y entra ' + fuera.name.slice(0, 45)
        + ' (' + Math.round((fuera.percentDone || 0) * 100) + '%, ' + vivos.get(fuera.id) + ')');
    }

    let soltados = 0;
    for (const t of cola) {
      if (enMarcha(t) || yaEntraron.has(t.id)) continue;   // ya ha arrancado en esta misma vuelta
      if (noCabeJamas(t)) continue;
      /* Se sigue probando, no se corta.
         Aqui habia un `break`: en cuanto uno no cabia, se acababa el reparto. Con
         la cola ordenada por fecha se notaba poco; con cuatrocientos esperando y
         una temporada completa de 18 GB en cabeza, esa sola ficha dejaba el disco
         sin repartir y la cola entera parada, con 33 GB libres. Ahora entra el
         primero que quepa y el grande lo vuelve a intentar en la siguiente
         vuelta, que es cuando el buzon habra hecho sitio de verdad. */
      if (!cabenJuntos(activos.concat([t]), libre - HOLGURA, delBuzon, subidas)) continue;
      await soltar(t);
      soltadoEn.set(t.id, Date.now());
      activos.push(t);
      soltados++;
    }

    /* Si hay cola y no ha entrado nadie, se dice por que una vez. Una lista de
       cuatrocientos parada sin una linea en el diario es media tarde de
       averiguarlo. */
    if (cola.length && !soltados) {
      const primero = cola.find((t) => !noCabeJamas(t));
      const motivo = !primero ? 'ninguno cabe en este disco ni vacio'
        : 'el primero pide ' + gb(pendiente(primero)) + ' y con lo que hay en marcha no entra';
      if (avisoCola !== motivo) { avisoCola = motivo; console.log('[torrents] ' + cola.length + ' en cola: ' + motivo); }
    } else if (soltados) {
      avisoCola = null;
    }
  } catch (err) {
    console.error('[torrents] el planificador ha fallado: ' + err.message);
  } finally {
    planificando = false;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Añadir.
 *
 * Ya no rechaza nada por espacio: lo que no cabe ahora se queda en cola y
 * arranca solo. Lo unico que sigue haciendo falta es saber cuanto ocupa, y ahi
 * el magnet y el .torrent no se portan igual.
 *
 * Un .torrent trae los metadatos dentro, asi que entra en pausa y con la
 * etiqueta puesta: que decida el planificador sin haber escrito un byte.
 *
 * Un magnet son cuarenta bytes con un hash: el tamaño hay que pedirselo al
 * enjambre, y para hablar con el enjambre hay que estar en marcha. Un torrent
 * en pausa no se conecta a nadie, asi que añadirlo pausado y esperar a que diga
 * cuanto ocupa es esperar sentado -- se queda en pausa para siempre. Pasaba: la
 * primera prueba se quedo cuarenta sondeos en "en pausa, 0 MB de ?". Por eso
 * arranca, y por eso existe el paso 1 del planificador: en cuanto dice lo que
 * ocupa, si no cabe se aparca. Cuando eso pasa no ha escrito nada del video
 * todavia, porque primero pide los metadatos y solo despues los trozos.
 */
async function anadir({ magnet, base64 }) {
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
  if (!magnet) await rpc('torrent-set', { ids: [id], labels: [ETIQUETA] });

  let info = null;
  for (let i = 0; i < 20; i++) {
    const lista = (await rpc('torrent-get', { ids: [id], fields: CAMPOS })).torrents || [];
    info = lista[0];
    if (info && tamano(info) > 0) break;
    await esperar(1000);
  }

  if (!info || !tamano(info)) {
    /* Sigue buscando metadatos. Se deja correr, porque pararlo seria condenarlo
       a no encontrarlos nunca, y de que no se pase del disco ya se encarga el
       planificador en cuanto sepa lo que ocupa. */
    return {
      id, nombre: (info && info.name) || 'sin nombre', buscando: true,
      aviso: 'Todavia no se cuanto ocupa: sigue buscando la informacion del '
           + 'torrent. Aparecera en la lista en cuanto la encuentre.',
    };
  }

  // Que decida el planificador ahora mismo, sin esperar a su vuelta de reloj:
  // si hay sitio arranca al instante, y si no, se queda en cola.
  await planificar();

  const ahora = ((await rpc('torrent-get', { ids: [id], fields: CAMPOS })).torrents || [])[0];
  const enCola = !!ahora && !enMarcha(ahora) && esperandoDisco(ahora);
  const imposible = enCola && noCabeJamas(info);

  return {
    id, nombre: info.name, tamano: tamano(info), enCola,
    /* Que la pantalla sepa si esto es un problema o solo una noticia. Irse a la
       cola es lo normal y no debe salir en rojo; no caber jamas si lo es. */
    problema: imposible,
    aviso: !enCola ? null : imposible
      ? 'Ocupa ' + gb(tamano(info)) + ' y no cabe en el disco del VPS ni estando vacio '
        + '(hacen falta ' + gb(tamano(info) * 2 + MARGEN) + ' contando el remuxado). '
        + 'Se queda en la lista parada, pero no va a arrancar sola.'
      : 'En cola: ahora mismo no hay sitio en el disco. Arranca sola en cuanto el '
        + 'buzon suba a la caja lo que tiene pendiente.',
  };
}

/*
 * Arrancar y parar a mano.
 *
 * Parar quita la etiqueta: si lo paras tu, el planificador no te lo vuelve a
 * arrancar a los veinte segundos. Y arrancar tambien la quita, porque es una
 * orden tuya y manda sobre la cola.
 *
 * Lo que no puede saltarse nadie es el paso 1 del planificador: si arrancas
 * algo que no cabe, el disco gana y vuelve a aparcarse. No es llevar la
 * contraria por gusto -- es que el disco lleno se lleva por delante al buzon, y
 * con el buzon parado no sale nada del VPS.
 */
async function conEtiquetaFuera(id, metodo) {
  const n = Number(id);
  const t = ((await rpc('torrent-get', { ids: [n], fields: CAMPOS })).torrents || [])[0];
  if (t && esperandoDisco(t)) await etiquetar(t, false);
  return rpc(metodo, { ids: [n] });
}

const arrancar = (id) => conEtiquetaFuera(id, 'torrent-start');
const parar = (id) => conEtiquetaFuera(id, 'torrent-stop');

/* Borrar se lleva SIEMPRE los datos: es lo unico que libera disco, y dejar el
   torrent fuera de la lista pero los gigas puestos seria justo lo contrario de
   lo que espera quien pulsa "eliminar". Lo que ya se haya colocado en l-films
   no se toca: es otro fichero. */
async function borrar(id) {
  const r = await rpc('torrent-remove', { ids: [Number(id)], 'delete-local-data': true });
  planificar();          // ha quedado sitio: a ver si arranca alguno de la cola
  return r;
}

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
/* Lo que se puede pedir ahora mismo sin que nada se atasque. Es la misma cuenta
   de cabenJuntos(), enseñada en vez de decidida. */
function cuentaDelDisco(activos, libre, delBuzon, subidas) {
  let porEscribir = subidas.bytes;
  let mayor = Math.max(delBuzon, subidas.mayor);
  for (const t of activos) {
    porEscribir += pendiente(t);
    mayor = Math.max(mayor, tamano(t));
  }
  return { porEscribir, mayor, disponible: Math.max(0, libre - porEscribir - mayor - MARGEN - HOLGURA) };
}

/*
 * Cuanto sitio hay para quien YA tiene una reserva puesta.
 *
 * Las descargas de video de la web se apartan su hueco con reservarSubida()
 * para que los torrents no se lo coman -- son cortas y no tiene sentido que un
 * video de diez minutos espere detras de una temporada entera --, pero entonces
 * no pueden usar el «disponible» normal para decidir si arrancan: ahi dentro
 * esta su propio hueco descontado, y se quedarian esperando un sitio que ya es
 * suyo.
 */
async function sitioPara(id) {
  const activos = (await listar()).filter(enMarcha);
  return cuentaDelDisco(activos, discoLibre(), mayorEnBuzon(), reservadoPorSubidas(id)).disponible;
}

/*
 * Orden de la PANTALLA, que no es el de la cola.
 *
 * La lista llega de transmission en su propio orden, que no dice nada, y con
 * la cola llena de torrents aparcados por disco lo que de verdad estaba
 * bajando quedaba enterrado a media pagina. Los grupos son justo lo que se ve
 * en la tarjeta: primero lo que trae caudal ahora mismo, despues lo que esta
 * enganchado a alguien pero no recibe nada, despues lo que sigue en marcha sin
 * nadie al otro lado, y al final lo aparcado, lo pausado y lo que ya no se va
 * a mover.
 *
 * Dentro de cada grupo NO se ordena por velocidad, que seria lo natural: la
 * pantalla se repinta entera cada dos segundos y el caudal fluctua, asi que
 * las tarjetas se cambiarian de sitio solas mientras las miras. El porcentaje
 * sube despacio y casi nunca baja, asi que el orden se queda quieto. La fecha
 * de llegada desempata, como en porInteres().
 */
function grupoDeActividad(t) {
  if (t.error) return 6;
  if (t.isFinished || t.percentDone === 1) return 5;
  if (!enMarcha(t)) return esperandoDisco(t) ? 3 : 4;
  if ((t.rateDownload || 0) > 0) return 0;
  if ((t.peersConnected || 0) > 0) return 1;
  return 2;
}

function porActividad(a, b) {
  const grupoA = grupoDeActividad(a);
  const grupoB = grupoDeActividad(b);
  if (grupoA !== grupoB) return grupoA - grupoB;
  if ((b.percentDone || 0) !== (a.percentDone || 0)) return (b.percentDone || 0) - (a.percentDone || 0);
  return (a.addedDate || 0) - (b.addedDate || 0);
}

async function estado() {
  const torrents = await listar();
  const libre = discoLibre();
  const delBuzon = mayorEnBuzon();
  const activos = torrents.filter(enMarcha);

  const subidas = reservadoPorSubidas();
  const { porEscribir, mayor, disponible } = cuentaDelDisco(activos, libre, delBuzon, subidas);
  const enCola = torrents.filter((t) => !enMarcha(t) && esperandoDisco(t)).length;

  return {
    disco: {
      libre, libreTexto: gb(libre),
      total: discoTotal(), totalTexto: gb(discoTotal()),
      porEscribir, porEscribirTexto: gb(porEscribir),
      reserva: mayor, reservaTexto: gb(mayor),
      margen: MARGEN, margenTexto: gb(MARGEN),
      disponible, disponibleTexto: gb(disponible),
      enCola,
      /* Para poder explicar en la pantalla por que hay menos sitio del que
         parece: no es que el disco este lleno, es que hay una subida delante. */
      subidas: subidas.bytes,
      subidasTexto: gb(subidas.bytes),
      frenado: frenado === true,
    },
    biblioteca: (() => {
      const b = bibliotecaGB();
      return b ? { libreGB: Math.round(b.libre), totalGB: Math.round(b.total) } : null;
    })(),
    torrents: torrents.slice().sort(porActividad).map((t) => ({
      id: t.id,
      nombre: t.name,
      estado: nombreEstado(t),
      /* Dos banderas y no una: "parado" es lo que decide si el boton dice
         Pausar o Reanudar, y "enCola" si esta parado porque lo mando el
         usuario o porque no habia disco. Mirar el texto del estado para eso
         funcionaba mientras solo hubiera un motivo de pausa; ahora hay dos. */
      parado: !enMarcha(t),
      enCola: !enMarcha(t) && esperandoDisco(t),
      porcentaje: Math.round((t.percentDone || 0) * 1000) / 10,
      metadatos: Math.round((t.metadataPercentComplete || 1) * 100),
      tamano: tamano(t),
      tamanoTexto: tamano(t) ? gb(tamano(t)) : '?',
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

/*
 * Espacio de la biblioteca, que desde agosto de 2026 es un montaje de la
 * Storage Box. statfs sobre el montaje devuelve el tamaño real del remoto, así
 * que no hace falta preguntarle a rclone.
 *
 * Devuelve null si el montaje no responde, y la web entonces no enseña la
 * cifra en vez de enseñar un cero: un cero se lee como "está llena", que es
 * justo lo contrario de lo que pasa cuando el montaje se ha caído.
 */
function bibliotecaGB() {
  try {
    const s = fs.statfsSync('/var/media/peliculas');
    if (!s.blocks) return null;
    return {
      libre: (s.bavail * s.bsize) / 1073741824,
      total: (s.blocks * s.bsize) / 1073741824,
    };
  } catch { return null; }
}

function nombreEstado(t) {
  if (t.error) return 'error';
  if (t.status === 0 && esperandoDisco(t)) {
    return noCabeJamas(t) ? 'no cabe en el disco' : 'esperando disco';
  }
  switch (t.status) {
    case 0: return 'en pausa';
    case 1: case 2: return 'comprobando';
    /* "esperando turno" y no "en cola": la cola de verdad es la de arriba, la
       del disco. Esta es la de transmission, que solo limita cuantas bajan a la
       vez (download-queue-size). Dos cosas distintas con el mismo nombre en la
       misma pantalla no se entienden. */
    case 3: return 'esperando turno';
    case 4: return t.metadataPercentComplete < 1 ? 'buscando datos' : 'descargando';
    case 5: return 'en cola para compartir';
    case 6: return 'compartiendo';
    default: return 'desconocido';
  }
}

/*
 * Terminada la pelicula, fuera el torrent.
 *
 * Y los datos con el, que es lo que libera el disco. Suena a que se pierde la
 * descarga, pero no: al completarse, el script de transmission deja el video en
 * el buzon de l-films con un ENLACE DURO, y un fichero no se borra de verdad
 * hasta que no queda ningun enlace apuntandole. Al quitar el del torrent, los
 * bytes siguen vivos en /var/media/entrada esperando al buzon. Es la misma
 * razon por la que se enlaza en vez de copiar.
 *
 * Se espera un poco antes de borrar, en vez de hacerlo en cuanto marca 100%:
 * el script de terminado se ejecuta al completar, y borrar el torrent en ese
 * mismo instante seria una carrera contra el enlace que se esta creando. Con
 * medio minuto de margen no hay carrera que valga.
 *
 * Efecto secundario que conviene saber: al irse el torrent deja de compartirse.
 * Es lo que se pide -- que el sitio quede libre para la siguiente -- pero es un
 * intercambio, no un regalo.
 */
const ESPERA_BORRADO = 30000;

let limpiando = false;
async function limpiarTerminados() {
  if (limpiando) return;
  limpiando = true;
  let alguno = false;
  try {
    const torrents = await listar();
    const ahora = Date.now() / 1000;
    for (const t of torrents) {
      const acabado = t.isFinished || t.percentDone === 1;
      if (!acabado || t.error) continue;
      // doneDate viene en segundos; si transmission no la trae, se deja estar
      if (!t.doneDate || (ahora - t.doneDate) * 1000 < ESPERA_BORRADO) continue;

      await rpc('torrent-remove', { ids: [t.id], 'delete-local-data': true });
      alguno = true;
      console.log('[torrents] terminado y retirado: ' + t.name
        + ' (' + gb(tamano(t)) + ' de disco libres)');
    }
  } catch (err) {
    console.error('[torrents] no he podido retirar los terminados: ' + err.message);
  } finally {
    limpiando = false;
  }
  return alguno;
}

const reloj = setInterval(async function () {
  // Primero se retira lo terminado y despues se planifica, no al reves: asi el
  // sitio que acaba de quedar libre se aprovecha en esta misma vuelta y no en
  // la siguiente.
  await limpiarTerminados();
  await planificar();
}, 20000);
if (reloj.unref) reloj.unref();

module.exports = { estado, anadir, borrar, arrancar, parar, gb, MARGEN_GB, reservarSubida, sitioPara };
