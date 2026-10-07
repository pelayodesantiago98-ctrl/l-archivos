'use strict';
/*
 * Descargas de video de la web.
 *
 * Se pega la direccion de una pagina que tenga un video -- YouTube, Vimeo,
 * Twitch, un periodico, casi cualquier cosa: yt-dlp trae extractor para unos
 * dos mil sitios y uno generico para los que no -- y el video acaba donde
 * acaban los torrents.
 *
 * Mismo destino y por el mismo camino: se baja al disco del VPS, se deja en el
 * buzon de /var/media/entrada y de ahi lo recoge procesar-entrada.js, que lo
 * sube a la Storage Box y avisa a Jellyfin. Lo unico distinto es la puerta de
 * entrada -- yt-dlp en vez de transmission -- y la biblioteca en la que acaba:
 * /var/media/videos y no peliculas, porque esto no son peliculas y Jellyfin no
 * tiene que buscarles ficha en TMDb ni ponerles la portada de otra cosa.
 *
 *
 * POR QUE SE BAJA A UNA CARPETA APARTE Y NO DIRECTAMENTE AL BUZON
 *
 * Porque el buzon se dispara solo en cuanto aparece algo dentro. Bajar ahi
 * seria enseñarle un fichero a medias, y aunque procesar-entrada.js mira dos
 * veces el tamaño antes de tocarlo, no hay razon para jugarsela: se baja en
 * /var/archivos/.videos y solo cuando esta entero y con su nombre definitivo
 * se mueve al buzon de un tiron, con un rename que es instantaneo porque los
 * dos sitios estan en el mismo disco.
 *
 *
 * POR QUE LA COLA SI SE GUARDA Y LO BAJADO NO
 *
 * Los torrents los guarda transmission, que es otro proceso y sobrevive a que
 * l-archivos se reinicie. Aqui el que baja es un hijo de este proceso: si el
 * servicio se reinicia, el yt-dlp se muere con el y los bytes a medias no
 * valen nada. Eso no cambia -- la carpeta de trabajo se sigue vaciando al
 * arrancar.
 *
 * Lo que si sobrevive es la LISTA. Cuando esto se escribio se pedia un video
 * suelto y volver a pedirlo costaba cinco segundos, asi que guardar la lista
 * era guardar una ficha que ademas mentiria sobre lo bajado. Desde que se
 * pegan cien enlaces de una tacada eso ya no es verdad: la cola dura horas, y
 * un reinicio -- o un despliegue, que es lo normal aqui -- se llevaba por
 * delante noventa enlaces que nadie va a volver a pegar a mano.
 *
 * Asi que en cola.json se guarda lo que se pidio y no lo que se llevaba
 * bajado: la direccion, el titulo, el tamaño y el sitio en la cola. Al
 * arrancar, lo que estuviera bajando vuelve a la cola por el principio y
 * empieza de cero, que es lo unico honesto que se puede hacer con media
 * descarga que ya no existe.
 */
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { spawn, execFile } = require('child_process');

const torrents = require('./torrents');

const YTDLP = process.env.YTDLP || '/usr/local/bin/yt-dlp';
/* El ffmpeg de Jellyfin, que es el que hay en esta maquina: no esta instalado
   el del sistema. Es la misma pareja que usa el buzon. */
const FFMPEG_DIR = '/usr/lib/jellyfin-ffmpeg';

const TRABAJO = path.join(process.env.ARCHIVOS_RAIZ || '/var/archivos', '.videos');
const BUZON = path.join(process.env.ENTRADA_VIDEO || '/var/media/entrada', 'videos');

/* Donde acaban los videos despues de pasar por el buzon. Aqui solo se mira: de
   ponerlos ahi se encarga procesar-entrada.js. Se necesita para saber si un
   nombre ya esta cogido antes de mandar el fichero a que lo pise. */
const BIBLIOTECA = process.env.VIDEOS_BIBLIOTECA || '/var/media/videos';

/* De una en una. Son dos vCPU compartidos con otras cinco cosas, y la red de
   bajada es la misma por la que entran los torrents: dos descargas a la vez no
   llegan antes, llegan las dos a la mitad de velocidad. */
const A_LA_VEZ = 1;

/* Cuanto se queda en la lista una descarga ya colocada. Lo justo para verla
   terminar y saber que fue bien; despues estorba, porque donde hay que mirarla
   es en Jellyfin. */
const VIDA_TERMINADA = 30 * 60000;

/*
 * De donde se puede bajar: de cualquier sitio de internet, pero SOLO de
 * internet.
 *
 * Al principio esto era una lista blanca con los dominios de YouTube. La lista
 * no estaba ahi por manias con las demas paginas, sino por una razon concreta:
 * la direccion la escribe una persona en un formulario y la pide un programa
 * que corre DENTRO del servidor. Un http://127.0.0.1:9091/transmission/rpc o un
 * http://169.254.169.254/ convierten esa caja de texto en una ventana a lo que
 * hay detras del cortafuegos, que es lo unico que el cortafuegos no puede
 * impedir.
 *
 * Con una lista blanca eso no pasaba, pero tampoco se podia bajar de ningun
 * otro sitio, y yt-dlp sabe hacerlo de casi dos mil. Asi que la lista se
 * cambia por la comprobacion que de verdad importa: se resuelve el nombre y se
 * mira que TODAS sus direcciones sean publicas. Un nombre que apunte al propio
 * servidor, a la red privada, al enlace local de la nube o a loopback se cae
 * aqui, se llame como se llame.
 *
 * Lo que esto NO cubre, y conviene tenerlo escrito: si un dominio publico
 * redirige (o vuelve a resolver) a una direccion interna despues de esta
 * comprobacion, yt-dlp la seguiria. Cerrar eso del todo pide un proxy de
 * salida, que es mucha maquinaria para una pantalla que esta detras del login
 * del portal y a la que solo entran tres personas de casa.
 */
const PUERTOS = new Set(['', '80', '443']);

/* Rangos que no son internet: loopback, privadas, enlace local, CGNAT, la
   documentacion y los reservados. En IPv6, loopback, unicas locales y enlace
   local; las ::ffff:1.2.3.4 se miran por su parte IPv4, que es lo que son. */
function esPublica(ip) {
  const t = String(ip);
  if (t.includes(':')) {
    const bajo = t.toLowerCase();
    if (bajo === '::1' || bajo === '::') return false;
    const mapeada = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bajo);
    if (mapeada) return esPublica(mapeada[1]);
    if (/^f[cd]/.test(bajo)) return false;                 // fc00::/7
    if (/^fe[89ab]/.test(bajo)) return false;              // fe80::/10
    return true;
  }
  const p = t.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;                // enlace local y metadatos de la nube
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;                  // 192.0.0/24 y 192.0.2/24
  if (a === 100 && b >= 64 && b <= 127) return false;      // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return false;   // pruebas de rendimiento
  if (a >= 224) return false;                              // multicast y reservado
  return true;
}

async function comprobarUrl(texto) {
  let u;
  try { u = new URL(String(texto).trim()); } catch { throw new Error('Eso no es una direccion web.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Solo direcciones http o https.');
  }
  if (!PUERTOS.has(u.port)) {
    throw new Error('Solo el puerto normal de la web. Un puerto raro casi nunca es una pagina.');
  }
  if (/^magnet:/i.test(texto) || /^magnet/i.test(u.hostname)) {
    throw new Error('Eso es un magnet: va en la caja de los torrents, aqui arriba.');
  }

  let direcciones = [];
  try {
    direcciones = await dns.lookup(u.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('No existe esa direccion, o no consigo resolver «' + u.hostname + '».');
  }
  if (!direcciones.length || !direcciones.every((d) => esPublica(d.address))) {
    throw new Error('Esa direccion apunta a la propia maquina o a la red interna, '
      + 'y de ahi no se baja nada.');
  }
  return u.toString();
}

/*
 * Que se baja.
 *
 * "bv*+ba" es el mejor video que haya y el mejor audio que haya, cada uno por
 * su lado, que es como YouTube sirve todo lo que pase de 720p: en flujos
 * separados. El "/b" del final es la red de seguridad para lo que solo venga
 * de una pieza, que es como viene de casi todas las demas paginas.
 *
 * El audio se pide en m4a de primeras aunque haya opus con mejor ratio, y es a
 * proposito: m4a ES aac, con lo cual el envoltorio mp4 se cierra copiando los
 * dos flujos y nadie recodifica nada. Con opus habria que meterlo en mp4, donde
 * medio mundo no lo reproduce, o recodificarlo. La diferencia de calidad entre
 * el opus y el m4a de YouTube al volumen al que se ve esto no la oye nadie; la
 * diferencia entre que Jellyfin sirva el fichero tal cual o tenga que
 * transcodificar en dos vCPU compartidos se nota entera.
 *
 * Si aun asi saliera algo raro, no se rompe nada: el buzon mira los codecs de
 * lo que le llega y remuxea lo que haga falta antes de subirlo.
 */
const FORMATO = 'bv*+ba[ext=m4a]/bv*+ba/b';

const trabajos = new Map();
let siguienteId = 1;

const ahora = () => Date.now();

function gb(bytes) {
  const g = bytes / 1073741824;
  if (g >= 10) return g.toFixed(0) + ' GB';
  if (g >= 1) return g.toFixed(1) + ' GB';
  return Math.round(bytes / 1048576) + ' MB';
}

/* La cola pedida, para que un reinicio no se la lleve. Vive dentro de la
   carpeta de trabajo porque es de lo mismo, y por eso el barrido de abajo la
   respeta igual que respeta la cache. */
const COLA = path.join(TRABAJO, 'cola.json');
const INTOCABLES = new Set(['cache', 'cola.json']);

/* La carpeta de trabajo empieza vacia en cada arranque: lo que hubiera dentro
   es de una descarga que murio con el servicio anterior y no la va a terminar
   nadie. Ocupa disco y no sirve para nada. */
function prepararCarpeta() {
  fs.mkdirSync(TRABAJO, { recursive: true });
  let restos = [];
  try { restos = fs.readdirSync(TRABAJO); } catch { return; }
  let barridos = 0;
  for (const n of restos) {
    if (INTOCABLES.has(n)) continue;
    try { fs.rmSync(path.join(TRABAJO, n), { recursive: true, force: true }); barridos++; } catch {}
  }
  if (barridos) console.log('[videos] limpiada la carpeta de trabajo');
}
prepararCarpeta();

/*
 * Guardar la cola.
 *
 * Se escribe entera y de una vez -- son cien fichas de nada, no hay que hilar
 * mas fino -- pero no en cada cambio: una descarga en marcha toca su ficha
 * varias veces por segundo con el progreso, y eso no se guarda ni hace falta.
 * Se junta lo que pase en medio segundo y se escribe una vez.
 *
 * Y se escribe al lado y se renombra encima: si el servicio se cae a mitad de
 * escribir, lo que queda en cola.json es la version anterior entera y no media
 * lista que no se puede ni leer.
 */
let relojGuardado = null;
function guardar() {
  if (relojGuardado) return;
  relojGuardado = setTimeout(() => {
    relojGuardado = null;
    const lista = [...trabajos.values()].map((t) => ({
      url: t.url, titulo: t.titulo, canal: t.canal, duracion: t.duracion,
      tamano: t.tamano, estado: t.estado, pedido: t.pedido,
      error: t.error, fichero: t.fichero, terminado: t.terminado,
    }));
    try {
      fs.writeFileSync(COLA + '.nuevo', JSON.stringify({ version: 1, lista }));
      fs.renameSync(COLA + '.nuevo', COLA);
    } catch (err) {
      console.error('[videos] no he podido guardar la cola: ' + err.message);
    }
  }, 500);
  if (relojGuardado.unref) relojGuardado.unref();
}

/*
 * Recuperarla al arrancar.
 *
 * Lo que estuviera bajando o colocandose vuelve a «esperando»: su yt-dlp murio
 * con el servicio anterior y sus bytes se acaban de barrer, asi que empieza de
 * cero. Lo que estuviera en «mirando la pagina» se vuelve a preguntar. Y lo ya
 * terminado se queda solo si aun no ha cumplido su media hora, que es lo que
 * habria durado en la lista sin reiniciar nada.
 */
function recuperarCola() {
  let guardado;
  try { guardado = JSON.parse(fs.readFileSync(COLA, 'utf8')); } catch { return; }
  if (!guardado || !Array.isArray(guardado.lista)) return;

  const repreguntar = [];
  for (const f of guardado.lista) {
    if (!f || typeof f.url !== 'string') continue;
    const parado = ['listo', 'error', 'cancelado'].includes(f.estado);
    if (parado && ahora() - (f.terminado || 0) > VIDA_TERMINADA) continue;

    const t = crearFicha(f.url, f.pedido || ahora());
    t.titulo = f.titulo || f.url;
    t.canal = f.canal || '';
    t.duracion = f.duracion || 0;
    t.tamano = f.tamano || 0;
    t.fichero = f.fichero || null;
    if (parado) {
      t.estado = f.estado;
      t.error = f.error || null;
      t.terminado = f.terminado || ahora();
    } else if (f.estado === 'consultando') {
      repreguntar.push(t);
    } else {
      t.estado = 'esperando';
    }
  }

  const vivos = [...trabajos.values()].filter((t) => t.estado === 'esperando').length;
  if (vivos || repreguntar.length) {
    console.log('[videos] recuperados ' + (vivos + repreguntar.length) + ' de la cola anterior');
  }
  if (repreguntar.length) preguntarTanda(repreguntar);
  refrescarReserva();
  siguiente().catch(() => {});
}

/*
 * Preguntar antes de bajar.
 *
 * Cuesta dos o tres segundos y a cambio se sabe el titulo y lo que va a ocupar
 * ANTES de escribir un byte, que es lo unico con lo que se puede decidir si
 * cabe. Sin esto, la unica forma de enterarse de que un video de tres horas en
 * 4K no cabia seria que el disco se llenara a mitad de camino.
 */
function preguntar(url, espera = 90000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, [
      '--no-config', '--skip-download', '--no-playlist', '--no-warnings',
      '--socket-timeout', '20', '--retries', '2',
      '-f', FORMATO,
      /* Un --print por dato y no una linea con separadores: los titulos de
         YouTube traen de todo, y cualquier separador que se elija es un
         separador que algun dia va dentro de un titulo. */
      '--print', '%(title)s',
      '--print', '%(filesize_approx,filesize)s',
      '--print', '%(duration)s',
      '--print', '%(channel,uploader)s',
      url,
    ], { timeout: espera, maxBuffer: 4 << 20 }, (err, salida, errores) => {
      if (err) {
        const linea = String(errores || err.message).split('\n')
          .filter((l) => /^ERROR/.test(l))[0] || String(err.message);
        /* «Esa pagina» y no «YouTube»: de aqui se baja de cualquier sitio desde
           que la lista blanca se cambio por la comprobacion de la IP, y decir
           YouTube cuando el enlace era de otra cosa manda a buscar el fallo
           donde no esta. */
        return reject(new Error('Esa pagina no me lo da: ' + linea.replace(/^ERROR:\s*/, '').slice(0, 200)));
      }
      /* Los campos que el video no traiga los imprime yt-dlp como "NA", que en
         Number() sale NaN y de ahi al 0 por el ||. */
      const [titulo, tam, dur, canal] = String(salida).trim().split('\n');
      resolve({
        titulo: (titulo || '').trim() || 'sin titulo',
        tamano: Number(tam) || 0,
        duracion: Number(dur) || 0,
        canal: canal && canal !== 'NA' ? canal.trim() : '',
      });
    });
  });
}

/*
 * ¿Cabe?
 *
 * Se le pregunta al mismo sitio que decide si arranca un torrent, y no a df:
 * "disponible" ya lleva descontado lo que las descargas en marcha tienen
 * pendiente de escribir, la copia que el buzon va a tener que hacer y el margen
 * de 8 GB por debajo del cual el buzon se planta. Mirar el disco a pelo diria
 * que caben 40 GB en un momento en el que meter 10 deja la cadena atascada.
 *
 * Solo se comprueba al pedirlo y no despues: un video de YouTube tarda minutos,
 * no horas, y no hay cola de espera como la de los torrents. Si no cabe ahora,
 * lo que toca es decirlo y no aceptarlo.
 */
async function sitioLibre() {
  try {
    /* Sin contar la reserva propia: el hueco que los videos tienen apartado es
       justo el que van a usar, y descontarselo a si mismos seria esperar para
       siempre un sitio que ya es suyo. */
    return await torrents.sitioPara('videos-web');
  } catch { return Infinity; }
}

/* Y lo que cabria con el disco entero vacio, para distinguir "ahora no" de "no
   va a caber nunca". Lo segundo si es un no: dejarlo en la cola seria dejarlo
   ahi para siempre. */
async function cabeAlgunaVez(bytes) {
  try {
    const d = (await torrents.estado()).disco;
    return bytes <= d.total - d.margen;
  } catch { return true; }
}

/*
 * Apartarle el sitio al que esta bajando.
 *
 * Es la misma reserva con la que las subidas desde el portatil se ponen por
 * delante de los torrents: mientras esto baje, el planificador de torrents
 * cuenta esos bytes como ya gastados y no suelta de su cola nada que no quepa
 * con ellos puestos. Sin esto, pedir un video de 8 GB y que a la vez arrancara
 * un torrent de 30 acabaria con los dos parados y el disco lleno.
 *
 * Caduca sola a los noventa segundos, asi que hay que refrescarla; si esto se
 * muere a mitad, la reserva se cae y los torrents recuperan el sitio.
 *
 *
 * SOLO SE APARTA SITIO PARA LO QUE SE ESTA ESCRIBIENDO YA, NUNCA PARA LA COLA
 *
 * Esto se aprendio a base de atascarlo. La reserva contaba tambien lo que
 * estaba esperando turno, y con dos o tres videos no se notaba; con sesenta y
 * nueve pegados de golpe, la cola se aparto 13 GB a si misma, el planificador
 * los descuento de lo disponible -- que es de donde sale sitioLibre() -- y a
 * partir de ahi ninguno arrancaba: para bajar el primero hacia falta un sitio
 * que estaba reservado por el propio primero. Un abrazo mortal que no se
 * deshacia solo, porque la reserva no baja hasta que se bajen los videos y los
 * videos no bajan hasta que baje la reserva.
 *
 * Asi que se reserva lo que le falta a la que esta bajando y nada mas. Es lo
 * unico que hay que proteger: una descarga a medias que se queda sin disco se
 * pierde, mientras que una que ni ha empezado no pierde nada por esperar --
 * exactamente el mismo trato que se dan los torrents entre ellos.
 */
function refrescarReserva() {
  let pendiente = 0, mayor = 0;
  for (const t of trabajos.values()) {
    if (t.estado !== 'bajando' && t.estado !== 'colocando') continue;
    const falta = Math.max(0, (t.tamano || 0) - (t.bajado || 0));
    pendiente += falta;
    mayor = Math.max(mayor, t.tamano || 0);
  }

  /*
   * Y el sitio del que va a arrancar ahora, que es lo que pone a los videos por
   * delante de los torrents.
   *
   * Un video de la web dura minutos y ocupa cientos de megas; una temporada
   * entera, horas y gigas. Sin apartarle el hueco al primero de la cola, cada
   * vez que un torrent deja sitio libre se lo lleva el siguiente torrent -- que
   * mira cada veinte segundos, mientras que los videos miran cada treinta -- y
   * un video de diez minutos se queda esperando detras de una cola de
   * cuatrocientos. Con el hueco apartado, el planificador de torrents lo cuenta
   * como gastado y no suelta nada que no quepa con el puesto.
   *
   * Solo el primero, no la cola entera: apartar sitio para los ciento veintiseis
   * que se pegaron el 7 de septiembre fueron 13 GB reservados que ni los
   * torrents podian usar ni los videos tampoco, porque bajan de uno en uno.
   */
  const siguienteEnCola = [...trabajos.values()]
    .filter((t) => t.estado === 'esperando')
    .sort((a, b) => a.pedido - b.pedido)[0];
  if (siguienteEnCola) {
    const suyo = necesita(siguienteEnCola);
    pendiente += suyo;
    mayor = Math.max(mayor, suyo);
  }

  torrents.reservarSubida('videos-web', pendiente, mayor);
}
const relojReserva = setInterval(refrescarReserva, 30000);
if (relojReserva.unref) relojReserva.unref();

/* Las fichas terminadas se van solas al rato. Se hace aqui y no al pedir el
   estado para que la lista no dependa de que alguien tenga la pagina abierta. */
const relojLimpieza = setInterval(() => {
  let quitadas = 0;
  for (const [id, t] of trabajos) {
    const parado = ['listo', 'error', 'cancelado'].includes(t.estado);
    if (parado && ahora() - t.terminado > VIDA_TERMINADA) { trabajos.delete(id); quitadas++; }
  }
  if (quitadas) guardar();
}, 60000);
if (relojLimpieza.unref) relojLimpieza.unref();

/*
 * El progreso.
 *
 * yt-dlp escribe su barra de progreso pisando la misma linea con retornos de
 * carro, que en una tuberia es un churro ilegible. Con --newline y una
 * plantilla propia cada actualizacion es una linea con los numeros en crudo, y
 * aqui solo hay que partir por barras verticales.
 *
 * Ojo con el "de dos en dos": video y audio son dos ficheros, asi que los
 * porcentajes van de 0 a 100 dos veces. Se lleva la cuenta de lo ya terminado
 * para que la barra de la pagina no vaya para atras a mitad de descarga.
 */
const PLANTILLA = 'PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s'
                + '|%(progress.speed)s|%(progress.eta)s';

function arrancar(t) {
  t.estado = 'bajando';
  t.empezado = ahora();
  guardar();

  const args = [
    '--no-config', '--no-playlist', '--newline', '--no-warnings',
    '--progress', '--progress-template', PLANTILLA,
    '-f', FORMATO,
    '--merge-output-format', 'mp4',
    '--embed-metadata',
    '--ffmpeg-location', FFMPEG_DIR,
    '--cache-dir', path.join(TRABAJO, 'cache'),
    '--paths', 'home:' + t.carpeta,
    /* 120 bytes y no 120 caracteres: hay titulos con emojis, y cortar por
       caracteres deja nombres que el sistema de ficheros no admite. */
    '-o', '%(title).120B.%(ext)s',
    '--retries', '5', '--fragment-retries', '10', '--socket-timeout', '30',
    t.url,
  ];

  const hijo = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  t.proceso = hijo;

  let resto = '';
  let yaBajado = 0;          // lo que sumaron los ficheros ya terminados
  let ultimoTotal = 0;

  hijo.stdout.on('data', (trozo) => {
    resto += trozo.toString();
    const lineas = resto.split('\n');
    resto = lineas.pop();
    for (const linea of lineas) {
      if (!linea.startsWith('PROG|')) {
        /* Lo demas es el relato de yt-dlp: el merge, el metadata, los avisos.
           Interesa lo que dice cuando se pone a juntar los dos ficheros, que es
           el rato en que la barra se queda quieta en el 100%. */
        if (/\[Merger\]|\[Metadata\]|Merging formats/.test(linea)) t.fase = 'juntando video y audio';
        continue;
      }
      const [, bajado, total, velocidad, eta] = linea.split('|');
      const b = Number(bajado) || 0;
      const tt = Number(total) || 0;
      /* Cada vez que empieza un fichero nuevo, el contador vuelve a cero: se
         guarda lo que llevaba el anterior y se suma. */
      if (b < ultimoTotal && ultimoTotal > 0) { yaBajado += ultimoTotal; ultimoTotal = 0; }
      ultimoTotal = b;
      t.bajado = yaBajado + b;
      t.velocidad = Number(velocidad) || 0;
      t.eta = Number(eta) || 0;
      /* El total que se enseña es el que dijo la consulta previa, que cuenta
         video y audio juntos. El de cada tramo solo vale para saber por donde
         va este. */
      if (!t.tamano && tt) t.tamano = tt;
      t.fase = 'bajando';
    }
  });

  let errores = '';
  hijo.stderr.on('data', (trozo) => { errores += trozo.toString().slice(0, 4000); });

  hijo.on('error', (err) => terminarMal(t, 'no he podido lanzar yt-dlp: ' + err.message));

  hijo.on('close', (codigo) => {
    t.proceso = null;
    if (t.estado === 'cancelado') { limpiarCarpeta(t); siguiente().catch(() => {}); return; }
    if (codigo !== 0) {
      const linea = errores.split('\n').filter((l) => /^ERROR/.test(l))[0] || '';
      terminarMal(t, linea ? linea.replace(/^ERROR:\s*/, '').slice(0, 240)
                           : 'yt-dlp ha salido con codigo ' + codigo);
      return;
    }
    colocar(t);
  });
}

/*
 * Del disco de trabajo al buzon.
 *
 * Un rename y no una copia: los dos sitios estan en el mismo disco, asi que es
 * instantaneo y no duplica los gigas ni por un momento. Y es atomico, con lo
 * cual el buzon nunca ve el fichero a medias. Si algun dia dejaran de compartir
 * disco, el rename falla con EXDEV y entonces si toca copiar.
 */
/*
 * Un nombre que no pise a nadie.
 *
 * El nombre del fichero es el titulo que da la pagina, y hay paginas que le
 * ponen el mismo a videos distintos. Paso el 8 de septiembre de 2026 con las
 * cuatro temporadas de una serie: los episodios venian titulados «Drake Josh
 * E01 ESP» sin decir de que temporada, asi que los cuatro E01 se llamaron igual
 * y cada uno piso al anterior. Se bajaron ciento veintiseis videos y en la
 * biblioteca quedaron ochenta y nueve; los treinta y siete que faltaban no
 * habian fallado, los habia borrado el siguiente con su mismo nombre.
 *
 * Asi que antes de mover nada se mira si ese nombre ya esta cogido -- en el
 * buzon o en la biblioteca, que es donde va a acabar -- y si lo esta se le
 * añade un numero. Vale mas un «Drake Josh E01 ESP (2).mp4» que un episodio
 * menos.
 */
function nombreLibre(nombre) {
  const ext = path.extname(nombre);
  const base = nombre.slice(0, nombre.length - ext.length);
  const cogido = (n) => {
    for (const carpeta of [BUZON, BIBLIOTECA]) {
      try { if (fs.existsSync(path.join(carpeta, n))) return true; } catch {}
    }
    return false;
  };
  if (!cogido(nombre)) return nombre;
  for (let i = 2; i < 100; i++) {
    const prueba = base + ' (' + i + ')' + ext;
    if (!cogido(prueba)) return prueba;
  }
  /* Cien iguales ya no es una serie, es un error: se le pone la hora y se acaba
     la discusion, que es mejor que quedarse sin sitio donde ponerlo. */
  return base + ' (' + Date.now() + ')' + ext;
}

function colocar(t) {
  t.estado = 'colocando';
  t.fase = 'moviendo al buzon';
  let salida = null;
  try {
    const dentro = fs.readdirSync(t.carpeta)
      .filter((n) => /\.(mp4|mkv|webm|m4v|mov)$/i.test(n) && !/\.part$/i.test(n));
    salida = dentro[0];
  } catch {}

  if (!salida) return terminarMal(t, 'yt-dlp ha terminado pero no encuentro el video que ha dejado');

  const origen = path.join(t.carpeta, salida);
  salida = nombreLibre(salida);
  const destino = path.join(BUZON, salida);
  try {
    fs.mkdirSync(BUZON, { recursive: true });
    try {
      fs.renameSync(origen, destino);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(origen, destino);
      fs.unlinkSync(origen);
    }
    /* Escribible por el grupo jellyfin, que es de quien es el buzon: el que
       viene detras a moverlo de ahi es procesar-entrada.js. */
    try { fs.chmodSync(destino, 0o664); } catch {}
  } catch (err) {
    return terminarMal(t, 'no he podido dejarlo en el buzon: ' + err.message);
  }

  try { t.tamanoFinal = fs.statSync(destino).size; } catch {}
  t.fichero = salida;
  t.estado = 'listo';
  t.fase = null;
  t.terminado = ahora();
  limpiarCarpeta(t);
  refrescarReserva();
  guardar();
  console.log('[videos] listo y en el buzon: ' + salida
    + ' (' + gb(t.tamanoFinal || 0) + ')');
  siguiente().catch(() => {});
}

function terminarMal(t, mensaje) {
  t.estado = 'error';
  t.error = mensaje;
  t.terminado = ahora();
  t.fase = null;
  limpiarCarpeta(t);
  refrescarReserva();
  guardar();
  console.error('[videos] ha fallado «' + t.titulo + '»: ' + mensaje);
  siguiente().catch(() => {});
}

function limpiarCarpeta(t) {
  try { fs.rmSync(t.carpeta, { recursive: true, force: true }); } catch {}
}

/*
 * Que arranque la siguiente de la cola.
 *
 * Dos motivos para esperar, y los dos se miran aqui:
 *
 *   - Que ya haya una bajando. De una en una, por lo de arriba.
 *   - Que no quepa. El disco del VPS es un sitio de paso muy pequeño y casi
 *     siempre hay una cola de torrents comiendoselo; cuando el buzon sube a la
 *     caja lo que tiene pendiente, se libera de golpe. Rechazar el video por
 *     eso seria hacer que quien lo pide vuelva a probar cada media hora a ver
 *     si hay suerte. Espera turno, como los torrents, y arranca solo.
 */
/* Para no repetir en el diario que sigue sin haber sitio. */
let avisadoSinSitio = false;

async function siguiente() {
  const bajando = [...trabajos.values()].filter((t) => t.estado === 'bajando').length;
  if (bajando >= A_LA_VEZ) return;

  const cola = [...trabajos.values()]
    .filter((t) => t.estado === 'esperando')
    .sort((a, b) => a.pedido - b.pedido);
  if (!cola.length) return;

  const libre = await sitioLibre();

  /*
   * Por orden, pero sin que uno atasque a los ciento veinticinco de detras.
   *
   * A un video que no dice lo que ocupa se le apartan 2 GB por si acaso. Es el
   * seguro correcto para un video suelto y es un tapon en una cola larga: con
   * 1.3 GB libres, esa ficha no arranca, y detras habia ciento veinticinco de
   * 200 MB que cabian de sobra. La cola entera parada por el unico que no sabe
   * lo que pesa.
   *
   * Asi que se arranca el primero QUE QUEPA, que es lo mismo que hace el
   * planificador de torrents con su cola. El orden se respeta entre los que
   * caben, y el que no quepa no pierde su sitio: lo vuelve a intentar en la
   * siguiente vuelta, cuando el buzon haya subido algo a la caja.
   */
  const elegida = cola.find((t) => necesita(t) <= libre);
  if (!elegida) {
    cola[0].fase = 'esperando sitio en el disco';
    /* Se dice una vez y no cada medio minuto: una cola parada tres horas
       llenaria el diario de la misma linea. Pero se dice, porque una lista
       larga quieta sin nada en el log es exactamente lo que cuesta media tarde
       averiguar. */
    if (!avisadoSinSitio) {
      avisadoSinSitio = true;
      console.log('[videos] ' + cola.length + ' esperando: al primero le hacen falta '
        + gb(necesita(cola[0])) + ', al mas pequeño ' + gb(Math.min(...cola.map(necesita)))
        + ', y el disco da ' + gb(libre));
    }
    return;
  }
  avisadoSinSitio = false;
  /* Los que se han quedado atras no estan «esperando turno» a secas: es que no
     caben todavia, y en la pantalla se lee la diferencia. */
  for (const t of cola) t.fase = t === elegida ? null : (necesita(t) > libre ? 'esperando sitio en el disco' : null);
  arrancar(elegida);
}

/* Lo que hay que tener libre para meterse con este video. Si no se sabe lo que
   ocupa -- pasa con los directos y algun video raro -- se piden 2 GB, que es
   mas de lo que ocupa casi todo y menos de lo que costaria equivocarse. */
const necesita = (t) => t.tamano || 2 * 1073741824;

/* La cola no se mueve sola: nadie avisa de que el buzon acaba de subir una
   pelicula a la caja y ha dejado quince gigas libres. Se vuelve a mirar cada
   medio minuto, que es el mismo ritmo al que se refresca la reserva. */
const relojCola = setInterval(() => { siguiente().catch(() => {}); }, 30000);
if (relojCola.unref) relojCola.unref();

/*
 * Pedir un video.
 *
 * Se pregunta primero (titulo y tamaño), se mira si cabe y solo entonces entra
 * en la lista. Asi el error de "no cabe" o "ese video es privado" sale en la
 * misma pulsacion del boton, y no cinco minutos despues en una ficha roja.
 */
/* El mismo enlace, ya pedido y todavia en marcha. */
function yaEsta(url) {
  for (const t of trabajos.values()) {
    if (t.url === url && ['consultando', 'esperando', 'bajando', 'colocando'].includes(t.estado)) {
      return t;
    }
  }
  return null;
}

/* La ficha en la lista. Nace sin titulo ni tamaño: eso lo trae la consulta
   previa, que es lo que tarda. */
function crearFicha(url, pedido) {
  const id = siguienteId++;
  const t = {
    id, url, titulo: url, canal: '', duracion: 0,
    tamano: 0, bajado: 0, velocidad: 0, eta: 0,
    estado: 'consultando', fase: null, error: null, fichero: null,
    /* El sitio en la cola. Normalmente es la hora de pedirlo, pero cuando se
       pegan varios de golpe se lo marca quien los reparte: las consultas
       previas salen a la vez y vuelven en el orden que quieran, y el primero
       de la lista pegada tiene que ser el primero en bajar. */
    pedido, empezado: null, terminado: null,
    carpeta: path.join(TRABAJO, 'v' + id),
    proceso: null,
  };
  fs.mkdirSync(t.carpeta, { recursive: true });
  trabajos.set(id, t);
  guardar();
  return t;
}

/* Preguntarle a la pagina y dejar la ficha lista para la cola. Lanza si el
   enlace no da video o si lo que da no cabe en el disco ni vacio. */
async function completarFicha(t, espera) {
  const info = await preguntar(t.url, espera);

  const necesario = info.tamano || 2 * 1073741824;
  if (!(await cabeAlgunaVez(necesario))) {
    throw new Error('«' + info.titulo + '» ocupa ' + gb(necesario) + ' y no cabe en el disco '
      + 'del VPS ni estando vacio. Ese no hay manera de bajarlo por aqui.');
  }

  t.titulo = info.titulo;
  t.canal = info.canal;
  t.duracion = info.duracion;
  t.tamano = info.tamano;
  t.estado = 'esperando';
  refrescarReserva();
  guardar();
  return info;
}

async function anadir(url, opciones = {}) {
  const limpia = await comprobarUrl(url);

  const otro = yaEsta(limpia);
  if (otro) return { id: otro.id, titulo: otro.titulo, duplicado: true };

  /* Con un solo enlace se pregunta ANTES de meter nada en la lista: cuesta dos
     o tres segundos y a cambio el «ese video es privado» sale en la misma
     pulsacion del boton y no en una ficha roja cinco segundos despues. */
  const t = crearFicha(limpia, opciones.pedido || ahora());
  let info;
  try {
    info = await completarFicha(t, opciones.espera);
  } catch (err) {
    limpiarCarpeta(t);
    trabajos.delete(t.id);
    throw err;
  }

  await siguiente();

  const enCola = t.estado === 'esperando';
  return {
    id: t.id, titulo: info.titulo, tamano: info.tamano, enCola,
    aviso: !enCola ? null
      : 'En cola: ahora mismo el disco del VPS esta ocupado con lo que hay bajando. '
        + 'Arranca solo en cuanto el buzon suba a la caja lo que tiene pendiente.',
  };
}

/*
 * Varios de golpe.
 *
 * Pegar diez enlaces y que se vayan bajando de uno en uno, como los torrents:
 * el que no quepa espera a que el buzon suba lo suyo a la caja y arranca solo.
 * Eso ya lo hacia la cola. Lo que faltaba era la puerta de entrada, y son dos
 * cosas distintas de la de un enlace suelto.
 *
 * NO SE ESPERA A PREGUNTAR. A cada pagina hay que preguntarle el titulo y el
 * tamaño, y eso son unos segundos por enlace: veinte enlaces no caben en la
 * respuesta a un boton -- nginx corta al minuto -- y tener la pantalla parada
 * mientras tanto tampoco tendria gracia. Asi que las fichas entran en la lista
 * al momento, en «mirando la pagina», y se van rellenando solas de cuatro en
 * cuatro, que es lo que se puede preguntar a la vez sin castigar al VPS. Un
 * enlace que no de video se queda en su ficha en rojo, con lo que dijo yt-dlp
 * y la direccion a la vista: no tira la tanda ni se pierde de vista.
 *
 * EL ORDEN LO MARCA LA LISTA, NO EL RELOJ. Cuatro preguntas a la vez vuelven
 * en el orden que quieran, y quien pega una lista espera que baje primero el
 * primero. Por eso el sitio en la cola se reparte aqui, por numero de linea,
 * antes de preguntar nada.
 */
/* Cien es lo que cabe en una pantalla de Jellyfin y bastante mas de lo que se
   pega a mano de una sentada. El tope no esta por lo que aguante el servidor
   -- las fichas no cuestan nada y bajan de una en una igual -- sino para que
   pegar sin querer un fichero entero en la caja no llene la lista de cuatro
   mil fichas que luego hay que quitar a mano. */
const DE_UNA_TACADA = 100;
const PREGUNTAS_A_LA_VEZ = 4;

/* Los nombres se resuelven de diez en diez. Es lo unico que se hace antes de
   contestar y son cien viajes al DNS: de uno en uno, con un nombre que tarde
   en resolver, la respuesta al boton se va a varios segundos. */
const NOMBRES_A_LA_VEZ = 10;

async function anadirVarias(lista) {
  const crudas = [...new Set(lista.map((u) => String(u || '').trim()).filter(Boolean))];
  if (!crudas.length) throw new Error('No hay ninguna direccion que bajar.');
  if (crudas.length > DE_UNA_TACADA) {
    throw new Error('Son ' + crudas.length + ' enlaces de una vez, y el tope esta en '
      + DE_UNA_TACADA + '. Pega los ' + DE_UNA_TACADA + ' primeros y sigue con el resto: '
      + 'la cola no se pierde entre una tanda y la siguiente.');
  }

  /* Lo unico que se mira antes de contestar: que sean direcciones de verdad y
     que no apunten a la red de dentro. Es la comprobacion que no puede esperar
     -- decide si el enlace entra o no -- y la unica que no cuesta segundos,
     porque es resolver un nombre y nada mas. */
  const limpias = new Array(crudas.length);
  let porResolver = 0;
  await Promise.all(Array.from({ length: Math.min(NOMBRES_A_LA_VEZ, crudas.length) }, async () => {
    for (;;) {
      const i = porResolver++;
      if (i >= crudas.length) return;
      try {
        limpias[i] = { url: await comprobarUrl(crudas[i]) };
      } catch (err) {
        limpias[i] = { error: err.message };
      }
    }
  }));

  /* Y las fichas se crean despues y en el orden de la lista pegada, aunque los
     nombres se hayan resuelto en desorden: el numero de linea es el sitio en
     la cola. */
  const fichas = [];
  const fallos = [];
  const duplicados = [];
  const base = ahora();
  for (let i = 0; i < crudas.length; i++) {
    const r = limpias[i];
    if (!r || r.error) { fallos.push({ url: crudas[i], error: r ? r.error : 'no he podido mirarla' }); continue; }
    const otro = yaEsta(r.url);
    if (otro) { duplicados.push({ url: crudas[i], titulo: otro.titulo }); continue; }
    fichas.push(crearFicha(r.url, base + i));
  }

  /* Las preguntas se quedan corriendo despues de contestar. */
  if (fichas.length) preguntarTanda(fichas);

  return {
    aceptados: fichas.length,
    duplicados,
    fallos,
    aviso: fichas.length
      ? 'Mirando ' + (fichas.length === 1 ? 'la pagina' : 'las ' + fichas.length + ' paginas')
        + '. Van bajando de una en una, por orden, y la que no quepa espera turno.'
      : null,
  };
}

/* Las consultas previas de una tanda, de cuatro en cuatro y por orden de
   lista. Cuando terminan todas se mira quien arranca: si se mirara segun van
   llegando, arrancaria la que menos tardo en contestar y no la primera. */
function preguntarTanda(fichas) {
  let siguienteIndice = 0;
  const turno = async () => {
    for (;;) {
      const t = fichas[siguienteIndice++];
      if (!t) return;
      /* Puede haberla quitado alguien mientras esperaba su turno. */
      if (!trabajos.has(t.id) || t.estado !== 'consultando') continue;
      try {
        await completarFicha(t, 60000);
      } catch (err) {
        if (trabajos.has(t.id)) terminarMal(t, err.message);
      }
    }
  };
  const enMarcha = Array.from({ length: Math.min(PREGUNTAS_A_LA_VEZ, fichas.length) }, turno);
  Promise.all(enMarcha).then(() => siguiente()).catch(() => {});
}

/*
 * Quitar.
 *
 * Si esta bajando se le manda un SIGTERM, que yt-dlp entiende y usa para
 * recoger sus ficheros a medias. La ficha se marca como cancelada antes de
 * matar el proceso: el manejador del cierre mira ese estado para saber que el
 * codigo de salida distinto de cero es cosa nuestra y no un fallo.
 *
 * Lo que ya este en el buzon o colocado en la biblioteca no se toca. Es otro
 * fichero y otra vida, igual que borrar un torrent no borra la pelicula.
 */
function quitar(id) {
  const t = trabajos.get(Number(id));
  if (!t) throw new Error('Esa descarga ya no esta en la lista.');
  if (t.proceso) {
    t.estado = 'cancelado';
    t.terminado = ahora();
    try { t.proceso.kill('SIGTERM'); } catch {}
    /* Por si no se entera: a los cinco segundos, a las malas. */
    setTimeout(() => { try { t.proceso && t.proceso.kill('SIGKILL'); } catch {} }, 5000);
  } else {
    limpiarCarpeta(t);
    trabajos.delete(t.id);
  }
  refrescarReserva();
  guardar();
  return { ok: true };
}

const ESTADOS = {
  consultando: 'mirando la pagina',
  esperando: 'esperando turno',
  bajando: 'bajando',
  colocando: 'colocando',
  listo: 'listo, subiendo a la caja',
  error: 'error',
  cancelado: 'cancelado',
};

function estado() {
  const lista = [...trabajos.values()]
    .sort((a, b) => b.pedido - a.pedido)
    .map((t) => {
      const porcentaje = t.tamano ? Math.min(100, Math.round((t.bajado / t.tamano) * 1000) / 10) : 0;
      return {
        id: t.id,
        titulo: t.titulo,
        canal: t.canal,
        url: t.url,
        estado: t.estado,
        /* La fase manda cuando la hay: dice algo mas concreto que el estado
           ("juntando video y audio", "esperando sitio en el disco") y es
           justo lo que explica por que la barra lleva un rato quieta. */
        estadoTexto: t.fase && t.fase !== 'bajando' ? t.fase : (ESTADOS[t.estado] || t.estado),
        porcentaje,
        tamano: t.tamano,
        tamanoTexto: t.tamano ? gb(t.tamano) : '?',
        bajado: t.bajado,
        velocidad: t.velocidad,
        eta: t.eta,
        duracion: t.duracion,
        fichero: t.fichero,
        error: t.error,
        activo: ['consultando', 'esperando', 'bajando', 'colocando'].includes(t.estado),
      };
    });
  return { descargas: lista, disponible: A_LA_VEZ };
}

/* Que la pantalla pueda decir "no esta instalado" en vez de fallar al primer
   enlace con un ENOENT que no significa nada para quien lo lea. */
const instalado = () => fs.existsSync(YTDLP);

/* Lo ultimo del modulo: para cuando esto corre, todo lo que usa esta en pie. */
recuperarCola();

module.exports = { anadir, anadirVarias, quitar, estado, instalado, gb, DE_UNA_TACADA };
