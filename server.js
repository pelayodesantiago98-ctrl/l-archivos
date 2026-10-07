'use strict';
/*
 * L-archivos: la puerta de entrada de ficheros de lepayimio.es.
 *
 * Es el unico sitio desde el que se meten cosas en el servidor por navegador.
 * Segun lo que sea, lo deja donde toca y se aparta:
 *
 *   pelicula / serie  ->  /var/media/entrada, que ya vigila el buzon
 *                         (procesar-entrada.js) y acaba colocandolo en Jellyfin
 *   imagen            ->  /var/archivos/imagenes
 *   documento         ->  /var/archivos/documentos
 *   otro              ->  /var/archivos/otros
 *
 * Lo que no es video todavia no tiene servicio que lo consuma. Se guarda con su
 * nombre y una linea en el manifiesto de su carpeta, para que el dia que exista
 * ese servicio se encuentre el material ordenado y fechado, en vez de un monton
 * de ficheros sueltos sin saber de donde salieron.
 *
 *
 * POR QUE LA SUBIDA VA A TROZOS
 *
 * El dominio esta detras de Cloudflare con la nube en naranja, y el plan
 * gratuito corta cualquier cuerpo que pase de 100 MB. Una pelicula son gigas,
 * asi que no puede subir de una tacada: el navegador la parte y manda trozos de
 * 16 MB, que el servidor va anadiendo al final del mismo fichero.
 *
 * Salio de una limitacion, pero es mejor que lo de antes: cada trozo se
 * confirma por separado, asi que una subida de 4 GB que se corte al 80% se
 * reanuda desde donde iba en vez de empezar de cero. El servidor no guarda el
 * progreso en memoria — es el tamano del propio fichero a medias —, asi que
 * tambien sobrevive a un reinicio del servicio.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');
const sso = require('/usr/local/lib/lepayimio/sso');
const temas = require('/usr/local/lib/lepayimio/tema');
const finanzas = require('./lib/finanzas');

/* El tema elegido, por usuario y en el servidor. El de siempre se llama
   'claro' porque aquí el tema por defecto es claro, no oscuro. */
const tema = temas.crear(
  path.join(__dirname, 'data', 'temas.json'),
  ['claro', 'crystal', 'dark-crystal'],
  'claro');

const PUERTO = Number(process.env.PORT) || 3005;

const ENTRADA = process.env.ENTRADA_VIDEO || '/var/media/entrada';
const ARCHIVOS = process.env.ARCHIVOS_RAIZ || '/var/archivos';
const PARCIALES = path.join(ARCHIVOS, '.parciales');

/* Por debajo de esto no se acepta nada mas. El disco lo comparten Jellyfin, las
   recompresiones y los demas sitios: si se llena, no falla solo la subida. */
const MARGEN_GB = Number(process.env.MARGEN_GB) || 6;

// Lo que se tarda en dar por muerta una subida a medias y borrar el resto.
const CADUCIDAD_MS = 24 * 3600 * 1000;

const FFPROBE = ['/usr/lib/jellyfin-ffmpeg/ffprobe', '/usr/bin/ffprobe'].find((p) => fs.existsSync(p));


/* Cada tipo con su carpeta y sus extensiones. Las extensiones solo sirven para
   avisar de que quiza se ha elegido mal el tipo; no bloquean nada, porque
   siempre habra un caso raro que si es lo que dice ser. */
const TIPOS = {
  /* Al buzon de Jellyfin, que es de la casa: las peliculas y las series se ven
     entre todos y por eso su carpeta es fija. */
  pelicula:  { carpeta: 'caja:pingu/jellyfin/Peliculas', video: true, ext: ['mkv', 'mp4', 'avi', 'ts', 'm2ts', 'mov', 'webm'] },
  serie:     { carpeta: 'caja:pingu/jellyfin/Series',    video: true, ext: ['mkv', 'mp4', 'avi', 'ts', 'm2ts', 'mov', 'webm'] },

  /* Lo demas es de cada uno: la carpeta sale del id de quien sube, asi que
     aqui solo se dice a que seccion pertenece. Los videos van a la galeria,
     con las fotos. */
  imagen:    { seccion: 'fotos',      ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif', 'tif', 'tiff', 'bmp', 'svg'] },
  video:     { seccion: 'videos',     ext: ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', '3gp'] },
  documento: { seccion: 'documentos', ext: ['pdf', 'epub', 'mobi', 'docx', 'doc', 'odt', 'xlsx', 'ods', 'pptx', 'txt', 'md', 'csv'] },
  otro:      { seccion: 'archivos',   ext: [] },
};

// Quien pregunta. El id del portal, que no cambia con el nombre.
const yo = (req) => String(req.sesion.id);

/*
 * De quien son los archivos que se estan mirando.
 *
 * Por defecto los tuyos. Si vienes de un enlace compartido, los de esa otra
 * persona, y solo si el acceso sigue concedido: la galleta dice cual quieres
 * ver, pero quien decide es la lista de accesos. Asi cambiarla a mano no
 * abre nada.
 */
function espacio(req) {
  const mio = yo(req);
  const pedido = String((req.cookies && req.cookies.espacio) || '').trim();
  if (!pedido || pedido === mio) return mio;
  return accesos.permisoDe(pedido, mio) ? pedido : mio;
}

/* Si ademas se puede tocar. En lo tuyo siempre; en lo de otro, depende. */
const puedoEscribir = (req) => accesos.permisoDe(espacio(req), yo(req)) === accesos.EDITOR;

/* Guardia para lo que modifica. Las de solo mirar no lo llevan. */
function exigeEscritura(req, res, next) {
  if (!puedoEscribir(req)) {
    return res.status(403).json({ error: 'Tu acceso a estos archivos es de solo lectura.' });
  }
  next();
}

// Compatibilidad: casi todo lo que habia preguntaba por las carpetas.
const quien = espacio;

/* Donde aterriza un tipo. Fija para lo de Jellyfin, y por persona para el
   resto; se crea sola la primera vez que alguien sube algo. */
function carpetaDe(usuario, tipo) {
  const t = TIPOS[tipo];
  if (!t) return null;
  return t.carpeta || ficheros.raizDe(usuario, t.seccion);
}

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
/* El .torrent viaja en base64 dentro del JSON y no cabe en los 32 kB que le
   sobran al resto de la API: uno de una pelicula ronda los 30-60 kB y en
   base64 crece un tercio. Se le pone su propio parser por delante; el general
   ve el cuerpo ya leido y no lo vuelve a tocar. */
app.use('/api/torrents', express.json({ limit: '4mb' }));
/* Y otro tanto con los videos: cien direcciones pegadas de una vez son unos 15
   kB de direcciones normales, pero una sola de esas con la mitad de la pagina
   en los parametros se come los 32 kB del resto de la API ella sola. */
app.use('/api/videos', express.json({ limit: '512kb' }));
app.use(express.json({ limit: '32kb' }));

/*
 * ── Sesion ──────────────────────────────────────────────────────────────────
 *
 * Ya no hay clave propia: quien manda es el portal. Este servicio se limita a
 * comprobar la firma de la cookie que emite lepayimio.es, asi que no guarda
 * usuarios, no valida contrasenas y no puede dejar entrar a nadie por su
 * cuenta. Una cosa menos que proteger.
 *
 * La subida va por PUT y por POST a rutas sin prefijo, asi que la regla de "es
 * API" no puede mirar /api/: aqui lo que distingue a una peticion de datos de
 * una de navegacion es el metodo.
 */
const exige = sso.exigirSesion({
  esApi: (req) => req.method !== 'GET' || req.path === '/cola' || req.path.startsWith('/subida/'),
});

app.get('/sesion', (req, res) => {
  const s = sso.sesion(req);
  res.json({ entrado: !!s, usuario: s ? s.u : null });
});

// ── Nombres ─────────────────────────────────────────────────────────────────
const limpio = (t) =>
  String(t == null ? '' : t).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();

const extensionDe = (nombre) =>
  (limpio(nombre).split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);

/* Para video el nombre lo arma el servidor y no el navegador: es lo unico que
   el buzon va a mirar para decidir si es pelicula o episodio y donde ponerlo.
   Para lo demas manda el nombre original, que es el que le dice algo a quien
   lo subio. */
function nombreDe(d, ext) {
  if (d.tipo === 'serie') {
    const serie = limpio(d.serie);
    const t = parseInt(d.temporada, 10), e = parseInt(d.episodio, 10);
    if (!serie || !(t >= 0) || !(e >= 0)) return null;
    return serie + ' S' + String(t).padStart(2, '0') + 'E' + String(e).padStart(2, '0') + '.' + ext;
  }
  if (d.tipo === 'pelicula') {
    const titulo = limpio(d.titulo);
    if (!titulo) return null;
    const anyo = /^\d{4}$/.test(String(d.anyo || '')) ? ' (' + d.anyo + ')' : '';
    return titulo + anyo + '.' + ext;
  }
  const base = limpio(d.nombre).replace(/^\.+/, '');
  return base || ('sin-nombre-' + Date.now() + '.' + ext);
}

/* Dos fotos distintas pueden llamarse IMG_0042.jpg. Antes de escribir se busca
   un hueco libre en vez de pisar lo que ya hay. */
async function sinPisar(carpeta, nombre) {
  const ext = path.extname(nombre);
  const base = path.basename(nombre, ext);
  const existe = (c) => esRemoto(carpeta) ? existeEnRemoto(carpeta, c) : fs.existsSync(path.join(carpeta, c));
  let intento = nombre;
  for (let n = 2; await existe(intento); n++) intento = base + ' (' + n + ')' + ext;
  return intento;
}

/* Todo cuelga del mismo disco, asi que da igual la carpeta que se mire. Si la
   consulta falla se devuelve Infinity a proposito: preferimos aceptar la
   subida y que falle al escribir, a bloquearla por no saber cuanto queda. */
const libresGB = () => {
  try {
    const s = fs.statfsSync('/');
    return (s.bavail * s.bsize) / 1073741824;
  } catch { return Infinity; }
};

/* Helpers para destinos en la Storage Box (rclone remotos).
 *
 * Las peliculas y series suben directo a `caja:pingu/jellyfin/...` en vez de
 * pasar por el buzon local y luego `procesar-entrada.js`. Asi el VPS no hace
 * de intermediario ni duplica cada fichero en `.trabajo`. */
const esRemoto = (ruta) => typeof ruta === 'string' && /^[a-zA-Z0-9_-]+:/.test(ruta);
const rcloneExec = (args, opts = {}) => new Promise((resolve, reject) => {
  execFile('rclone', ['--config', '/etc/rclone-caja.conf', ...args], { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message || '').toString().trim() || 'rclone fallo'));
    else resolve(String(stdout || ''));
  });
});
async function existeEnRemoto(remoto, nombre) {
  try {
    const out = await rcloneExec(['lsjson', '--files-only', remoto]);
    return JSON.parse(out).some((f) => f.Name === nombre || f.Path === nombre);
  } catch { return false; }
}
async function espacioRemotoGB(remoto) {
  try {
    const out = await rcloneExec(['about', '--json', remoto]);
    return JSON.parse(out).free / 1073741824;
  } catch { return Infinity; }
}
/* Libre total: minimo entre disco local y caja. Asi no subimos una peli de
   4 GB si la caja solo tiene 100 MB libres. */
async function libresTotalGB() {
  const [local, remoto] = await Promise.all([
    Promise.resolve(libresGB()),
    espacioRemotoGB('caja:'),
  ]);
  return Math.min(local, remoto);
}

/* Cola de subidas a la caja que se procesan en background.
 *
 * El problema era: /terminar esperaba a que rclone copyto subiera el fichero
 * entero a la caja antes de responder al cliente. Con pelis grandes eso son
 * minutos, y Cloudflare (entre el navegador y este nginx) corta a los ~100 s
 * con un 524. La cola devuelve OK al cliente en cuanto la parcial esta en
 * disco y verificada, y un worker va subiendo a la caja sin bloquear nada. */
const colaSubidas = [];
const SUBIDAS_MAX_PARALELO = 2;
let subidasEnCurso = 0;
function encolarSubida(job) { colaSubidas.push(job); }
async function workerSubidas() {
  while (true) {
    while (subidasEnCurso >= SUBIDAS_MAX_PARALELO || colaSubidas.length === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const job = colaSubidas.shift();
    if (!job) continue;
    subidasEnCurso++;
    job().catch((e) => console.error('[subidas] error:', e.message))
      .finally(() => { subidasEnCurso--; });
  }
}
workerSubidas().catch((e) => console.error('[subidas] worker murio:', e));

// ── Subida a trozos ─────────────────────────────────────────────────────────
/* El id viene del cliente en la URL, asi que se comprueba que es un UUID y
   nada mas: sin esto, un id con barras o puntos escribiria donde quisiera. */
const ID_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const rutaParcial = (id) => path.join(PARCIALES, id);
const rutaFicha = (id) => path.join(PARCIALES, id + '.json');

const leerFicha = (id) => {
  if (!ID_VALIDO.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(rutaFicha(id), 'utf8')); } catch { return null; }
};

const recibidos = (id) => {
  try { return fs.statSync(rutaParcial(id)).size; } catch { return 0; }
};

app.post('/subida/nueva', exige, exigeEscritura, async (req, res) => {
  const d = req.body || {};
  const tipo = TIPOS[d.tipo] ? String(d.tipo) : null;
  if (!tipo) return res.status(400).json({ error: 'Tipo desconocido.' });

  if (await libresTotalGB() < MARGEN_GB) {
    return res.status(507).json({ error: 'Quedan menos de ' + MARGEN_GB + ' GB libres en el servidor.' });
  }

  const ext = extensionDe(d.nombre) || 'bin';
  const nombre = nombreDe(d, ext);
  if (!nombre) return res.status(400).json({ error: 'Faltan datos para componer el nombre.' });

  const id = crypto.randomUUID();
  fs.mkdirSync(PARCIALES, { recursive: true });
  fs.writeFileSync(rutaFicha(id), JSON.stringify({
    tipo, nombre, ext,
    /* De quien es: al terminar la subida hay que saber en que carpeta
       aterriza, y para entonces la peticion es otra. */
    usuario: quien(req),
    original: limpio(d.nombre),
    tamano: Number(d.tamano) || 0,
    creado: new Date().toISOString(),
  }));
  fs.writeFileSync(rutaParcial(id), '');

  res.json({ id, recibido: 0 });
});

// Cuanto lleva el servidor, para reanudar donde se quedo.
app.get('/subida/:id', exige, (req, res) => {
  const ficha = leerFicha(req.params.id);
  if (!ficha) return res.status(404).json({ error: 'Esa subida ya no existe.' });
  res.json({ id: req.params.id, recibido: recibidos(req.params.id), tamano: ficha.tamano });
});

/* Un trozo. Va con el offset en la URL y solo se acepta si encaja justo con lo
   que hay escrito: si no encaja se responde 409 con el tamano real, y el
   cliente reanuda desde ahi en vez de duplicar o dejar un hueco. */
app.put('/subida/:id', exige, async (req, res) => {
  const id = req.params.id;
  const ficha = leerFicha(id);
  if (!ficha) return res.status(404).json({ error: 'Esa subida ya no existe.' });

  const desde = Number(req.query.desde);
  const yaHay = recibidos(id);
  if (!Number.isFinite(desde) || desde < 0) return res.status(400).json({ error: 'Offset invalido.' });
  if (desde !== yaHay) return res.status(409).json({ error: 'Desfase', recibido: yaHay });

  /* El disco se mira aqui tambien, no solo al abrir la subida.
   *
   * Entre que empieza una pelicula de 4 GB y llega su ultimo trozo pasan
   * minutos u horas, y en ese rato el hueco puede haberse acabado: el disco lo
   * comparten Jellyfin, las recompresiones del buzon y los demas sitios. Sin
   * esto la subida seguia escribiendo hasta llenarlo, y con el disco lleno no
   * falla solo la subida, falla todo lo demas. */
  if (await libresTotalGB() < MARGEN_GB) {
    return res.status(507).json({ error: 'Quedan menos de ' + MARGEN_GB + ' GB libres en el servidor.' });
  }

  /* Y no se acepta mas de lo que la ficha dijo que iba a ocupar.
   *
   * El tamano lo declara el navegador al empezar, pero luego nadie comprobaba
   * que los trozos se ajustaran a el: quien tuviera sesion podia declarar un
   * megabyte y seguir mandando trozos hasta llenar el disco. El limite de
   * nginx (64 MB) acota cada peticion por separado, no cuantas se mandan. */
  const tope = Number(ficha.tamano) || 0;

  const salida = fs.createWriteStream(rutaParcial(id), { flags: 'a' });
  let cortado = false;
  let escritos = yaHay;
  req.on('aborted', () => { cortado = true; salida.destroy(); });
  salida.on('error', () => { cortado = true; });

  if (tope) {
    req.on('data', (trozo) => {
      escritos += trozo.length;
      if (escritos <= tope) return;
      cortado = true;
      salida.destroy();
      req.destroy();
      if (!res.headersSent) {
        res.status(413).json({ error: 'La subida se pasa del tamano declarado.' });
      }
    });
  }

  req.pipe(salida);
  salida.on('close', () => {
    if (cortado) return;
    res.json({ recibido: recibidos(id) });
  });
});

app.post('/subida/:id/terminar', exige, async (req, res) => {
  const id = req.params.id;
  const ficha = leerFicha(id);
  if (!ficha) return res.status(404).json({ error: 'Esa subida ya no existe.' });

  const tamano = recibidos(id);
  if (ficha.tamano && tamano !== ficha.tamano) {
    return res.status(409).json({ error: 'Faltan trozos.', recibido: tamano, tamano: ficha.tamano });
  }

  const carpeta = carpetaDe(ficha.usuario || quien(req), ficha.tipo);
  if (!carpeta) return res.status(400).json({ error: 'Tipo desconocido.' });
  const remoto = esRemoto(carpeta);
  if (!remoto) fs.mkdirSync(carpeta, { recursive: true });

  /* Pelis y series en la caja van con subdirectorios, igual que el resto de la
     biblioteca: Peliculas/<Titulo (anyo)>/<Titulo (anyo).mkv> y
     Series/<Serie>/Season XX/<Serie SXXEYY.mkv>. El nombre del subdir sale
     del propio nombre del fichero, asi que no hay que pedirlo al usuario. */
  let subdir = '';
  if (remoto && ficha.tipo === 'pelicula') {
    subdir = path.parse(ficha.nombre).name;  // titulo (anyo)
  } else if (remoto && ficha.tipo === 'serie') {
    /* El patron acepta cualquier numero de digitos en temporada y
       episodio: antes era S(\d{2})E(\d{2}), que solo cogia hasta E99
       y devolvia 400 en cualquier episodio >= 100. Con \d+ ya entran
       E100, E129, etc. La temporada se rellena a 2 digitos con
       padStart para mantener el formato de carpeta (Season 01). */
    const m = ficha.nombre.match(/^(.+?) S(\d+)E(\d+)\./);
    if (!m) return res.status(400).json({ error: 'Nombre de serie no encaja con el patron Temporada/Episodio.' });
    subdir = m[1] + '/Season ' + String(m[2]).padStart(2, '0');
  }
  const remotoBase = subdir ? `${carpeta}/${subdir}` : carpeta;
  const definitivo = await sinPisar(remotoBase, ficha.nombre);
  const parcial = rutaParcial(id);
  const destino = remoto ? `${remotoBase}/${definitivo}` : path.join(carpeta, definitivo);

  /* Si el destino es la Storage Box, rclone copyto sube la parcial sin pasar
     dos veces por la red. Si es local, el rename de toda la vida con fallback
     a copyFileSync por si las parciales y el destino acaban en filesystems
     distintos. */
  let falloGuardar = null;
  if (!remoto) {
    // Flujo local: rename de toda la vida, con fallback a copyFileSync si
    // las parciales y el destino acaban en filesystems distintos.
    try {
      fs.renameSync(parcial, destino);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(parcial, destino);
      fs.unlinkSync(parcial);
    }
  }
  // Si el destino es la caja, NO esperamos al copyto aqui: lo encolamos y el
  // worker lo sube en background. Asi /terminar responde al cliente en ms y
  // Cloudflare no corta a los 100 s con un 524.
  try { fs.unlinkSync(rutaFicha(id)); } catch {}
  if (falloGuardar) {
    return res.status(500).json({ error: 'No he podido guardar: ' + falloGuardar.message });
  }
  if (remoto) {
    const _id = id, _parcial = parcial, _destino = destino, _remotoBase = remotoBase, _subdir = subdir;
    encolarSubida(async () => {
      const t0 = Date.now();
      try {
        if (_subdir) await rcloneExec(['mkdir', _remotoBase]);
        await rcloneExec(['copyto', _parcial, _destino]);
        try { fs.unlinkSync(_parcial); } catch {}
        console.log('[subidas] ' + _id + ' -> caja OK (' + ((Date.now()-t0)/1000).toFixed(1) + ' s)');
      } catch (e) {
        console.error('[subidas] ' + _id + ' fallo: ' + e.message);
        /* Si la subida falla, la parcial no sirve: el cliente ya recibio OK
           y no va a reintentar. Si la dejamos se queda ocupando sitio hasta
           que el barrido la recoja 24h despues (o mas si la app estaba mal).
           Mejor borrarla ya y que el usuario, si la quiere, la vuelva a subir. */
        try { fs.unlinkSync(_parcial); } catch (e2) {
          console.error('[subidas] ' + _id + ' no he podido borrar la parcial: ' + e2.message);
        }
      }
    });
  }
  /* Solo el grupo, no el dueno (solo en local; la caja gestiona sus permisos).
   *
   * Esto ponia dueno y grupo de la carpeta de destino, y funcionaba porque el
   * servicio corria como root. Ya no: corre como www-data, y cambiar el dueno
   * de un fichero a otro usuario es cosa exclusiva de root -- daba EPERM y se
   * lo tragaba el catch, dejando la subida con el grupo equivocado.
   *
   * El grupo si se puede, porque el servicio lleva jellyfin de suplementario y
   * un proceso puede regalar sus ficheros a un grupo al que pertenece. Con eso
   * basta: la carpeta de entrada tiene escritura de grupo, que es lo que el
   * buzon necesita para recoger la pelicula. -1 en el uid es "este no lo
   * toques".
   */
  if (!remoto) {
    try {
      const s = fs.statSync(path.dirname(destino));
      fs.chownSync(destino, -1, s.gid);
    } catch {}
  }

  if (!TIPOS[ficha.tipo].video) {
    apuntar(carpeta, { fichero: definitivo, tipo: ficha.tipo, tamano, original: ficha.original });
    return res.json({
      ok: true, nombre: definitivo, tipo: ficha.tipo, tamano,
      destino: ficha.tipo === 'otro' ? 'otros' : ficha.tipo + 's',
      aviso: avisoExtension(ficha.tipo, ficha.ext),
    });
  }

  // Video: analizar codecs. Si ya subimos a la caja, no bajamos solo
  // para mirar: el buzon que hacia esto ya no existe, el VPS no necesita saber.
  if (!FFPROBE || remoto) return res.json({ ok: true, nombre: definitivo, tipo: ficha.tipo, tamano, analisis: null });
  execFile(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'csv=p=0', destino], (err, salidaFf) => {
    if (err) {
      return res.json({ ok: true, nombre: definitivo, tipo: ficha.tipo, tamano,
        analisis: { error: 'No se ha podido analizar.' } });
    }
    const flujos = String(salidaFf).trim().split('\n').map((l) => l.split(','));
    const video = (flujos.find((f) => f[0] === 'video') || [])[1] || null;
    const audio = (flujos.find((f) => f[0] === 'audio') || [])[1] || null;
    const videoOk = video === 'h264';
    const audioOk = ['aac', 'mp3'].includes(audio);
    res.json({
      ok: true, nombre: definitivo, tipo: ficha.tipo, tamano,
      analisis: { video, audio, videoOk, audioOk,
        plan: videoOk && audioOk ? 'envoltorio' : videoOk ? 'audio' : 'video' },
    });
  });
});

app.delete('/subida/:id', exige, (req, res) => {
  if (!ID_VALIDO.test(String(req.params.id))) return res.status(400).json({ error: 'Id invalido.' });
  try { fs.unlinkSync(rutaParcial(req.params.id)); } catch {}
  try { fs.unlinkSync(rutaFicha(req.params.id)); } catch {}
  res.json({ ok: true });
});

/* Una subida abandonada se queda ocupando disco para siempre. Se barren las que
   llevan mas de un dia sin tocarse: lo bastante como para no cortarle la
   reanudacion a nadie, y lo bastante poco como para no acumular gigas. */
function barrerParciales() {
  let restos = [];
  try { restos = fs.readdirSync(PARCIALES); } catch (e) {
    console.error('[l-archivos] barrido: no puedo listar ' + PARCIALES + ': ' + e.message);
    return;
  }
  const limite = Date.now() - CADUCIDAD_MS;
  for (const n of restos) {
    const f = path.join(PARCIALES, n);
    try {
      if (fs.statSync(f).mtimeMs < limite) { fs.unlinkSync(f); console.log('[l-archivos] barrido ' + n); }
    } catch (e) {
      console.error('[l-archivos] barrido: no he podido tocar ' + n + ': ' + e.message);
    }
  }
}

// ── Manifiesto ──────────────────────────────────────────────────────────────
/* Es la memoria de la carpeta: una linea por fichero, en JSONL para poder ir
   anadiendo sin releer ni reescribir nada. Cuando exista el servicio que
   consuma estas carpetas, esto es lo que le dira que hay. */
function apuntar(carpeta, datos) {
  try {
    fs.appendFileSync(
      path.join(carpeta, '.manifiesto.jsonl'),
      JSON.stringify({ ...datos, fecha: new Date().toISOString() }) + '\n'
    );
  } catch (e) {
    console.error('No he podido apuntar en el manifiesto: ' + e.message);
  }
}

const avisoExtension = (tipo, ext) => {
  const esperadas = TIPOS[tipo].ext;
  if (!esperadas.length || esperadas.includes(ext)) return null;
  return 'Un .' + ext + ' no es lo habitual en ' + tipo + '. Se ha guardado igual.';
};

// ── Estado ──────────────────────────────────────────────────────────────────
/*
 * El navegador aprovecha esta consulta -- que ya hacia -- para decir cuanto le
 * queda por subir en total, contando la cola entera y no solo el fichero de
 * ahora. Con eso el planificador de torrents le aparta el sitio por delante.
 *
 * Va aqui y no en una ruta nueva porque la pagina ya pregunta por aqui cada
 * pocos segundos mientras sube: una ruta aparte seria otra peticion diciendo lo
 * mismo, y ademas habria que acordarse de llamarla. El identificador es de la
 * tanda, no de la persona, y solo sirve para que dos pestañas subiendo a la vez
 * no se pisen la reserva.
 */
app.get('/cola', exige, async (req, res) => {
  const quien = String(req.query.quien || '').slice(0, 64).replace(/[^a-zA-Z0-9-]/g, '');
  if (quien) {
    torrents.reservarSubida(quien, Number(req.query.reserva) || 0, Number(req.query.mayor) || 0);
  }

  /* Antes listaba ENTRADA (el buzon local). Como pelis y series suben
     directo a la caja, ese buzon ya no se usa; mostramos los 20 ultimos
     que han entrado en la caja para que la UI siga mostrando algo. */
  let ficheros = [];
  try {
    const json = await rcloneExec(['lsjson', '--files-only', '--sort-by', 'modtime',
      'caja:pingu/jellyfin/Peliculas', 'caja:pingu/jellyfin/Series']);
    const lista = JSON.parse(json);
    lista.sort((a, b) => new Date(b.ModTime) - new Date(a.ModTime));
    ficheros = lista.slice(0, 20).map((f) => ({ nombre: f.Path.split('/').pop(), tamano: f.Size }));
  } catch {}

  const guardados = {};
  for (const [tipo, cfg] of Object.entries(TIPOS)) {
    if (cfg.video) continue;
    try {
      guardados[tipo] = fs.readdirSync(cfg.carpeta).filter((n) => !n.startsWith('.')).length;
    } catch { guardados[tipo] = 0; }
  }

  const _libresCajaGB = await espacioRemotoGB('caja:');
  res.json({ ficheros, guardados, libresGB: Math.round(await libresTotalGB()), libresCajaGB: Math.round(_libresCajaGB) });
});

/* La portada exige sesion y manda al login del portal si no la hay. Los
   estaticos (hoja de estilos) se sirven despues y sin candado: no son secretos
   y hacen falta en cualquier caso. */
/* ── Torrents ────────────────────────────────────────────────────────────────
 *
 * Se mete un .torrent o un enlace magnet, transmission lo baja y al terminar
 * deja el video enlazado en /var/media/entrada, que es el mismo buzon por el
 * que entran las subidas de aqui: de ahi en adelante el camino a Jellyfin ya
 * estaba hecho y no hay nada nuevo que mantener.
 *
 * El tope de 20 GB vive en lib/torrents.js, no aqui: es una regla del sistema
 * de descargas, no de estas rutas.
 */
const torrents = require('./lib/torrents');

app.get('/torrents', exige, pantalla('torrents'));

/* ── Editar, crear y convertir documentos ────────────────────────────────────
 *
 * Los editores viven en el navegador; aqui esta lo que no puede vivir alli:
 * escribir el .docx o el .xlsx de verdad, y llamar a LibreOffice para el PDF.
 *
 * Guardar SIEMPRE escribe el fichero entero. Estos formatos no admiten
 * modificar un trozo: son un ZIP de XML y hay que rehacerlo. Por eso la
 * pantalla avisa cuando el documento traia cosas que el editor no sabe
 * mantener -- imagenes, tablas, formatos raros -- antes de dejar guardar encima.
 */
app.get('/editar', exige, pantalla('editor'));

/* Abrir para editar. Es el mismo lector que usa la pantalla de documentos, pero
   sirve para las dos secciones: en archivos tambien hay .txt y hojas sueltas. */
app.get('/api/documento/abrir', exige, (req, res) => {
  const tipo = ['documentos', 'archivos'].includes(String(req.query.tipo))
    ? String(req.query.tipo) : 'documentos';
  const rel = String(req.query.f || '');
  const abs = ficheros.resolver(quien(req), tipo, rel);
  if (!abs) return res.status(404).json({ error: 'Ese fichero no existe.' });

  const ext = ficheros.extDe(abs);
  const clase = ficheros.claseDe(abs);
  try {
    if (clase === 'texto') {
      const st = fs.statSync(abs);
      if (st.size > 2 * 1024 * 1024) {
        return res.json({ clase: 'grande', ext,
          aviso: 'Son ' + ficheros.texto(st.size) + ' de texto: mejor descargarlo.' });
      }
      return res.json({ clase: 'texto', ext, texto: fs.readFileSync(abs, 'utf8') });
    }
    if (ext === 'docx' || ext === 'odt') {
      const d = ofimatica.leer(abs, ext);
      /* Lo que el editor no sabe mantener se avisa ANTES de dejar guardar
         encima: al guardar se rehace el fichero entero, asi que lo que no
         entiende se perderia sin que nadie lo hubiera dicho. */
      return res.json({ ...d, ext, editable: ext === 'docx',
        aviso: ext === 'odt'
          ? 'Este es un .odt: se puede leer, pero al guardar se escribiria un .docx. Mejor conviertelo antes.'
          : 'El editor guarda texto, titulos, negrita, cursiva, listas y alineacion. '
            + 'Si el documento traia imagenes, tablas o formatos raros, se perderan al guardar.' });
    }
    if (ext === 'xlsx' || ext === 'ods') {
      const d = ofimatica.leer(abs, ext);
      return res.json({ ...d, ext, editable: ext === 'xlsx',
        aviso: ext === 'ods'
          ? 'Este es un .ods: se puede leer, pero al guardar se escribiria un .xlsx.'
          : 'Se guardan los valores y las formulas. Los formatos de celda, colores y '
            + 'graficos no se mantienen.' });
    }
    if (clase === 'pdf') return res.json({ clase: 'pdf', ext });
    return res.json({ clase: 'sin-visor', ext, aviso: 'Un .' + ext + ' no se puede editar aqui.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const escribir = require('./lib/escribir');
const pptx = require('./lib/pptx');
const convertir = require('./lib/convertir');

const PLANTILLAS = {
  documento: { ext: 'docx', vacio: () => escribir.docx([{ texto: '', trozos: [] }]) },
  hoja: { ext: 'xlsx', vacio: () => escribir.xlsx([[]], 'Hoja1') },
  presentacion: { ext: 'pptx', vacio: () => pptx.pptx() },
  texto: { ext: 'txt', vacio: () => Buffer.from('', 'utf8') },
};

/* Crear uno de cero. El nombre lo pone quien lo crea; la extension la pone el
   tipo, para que no acabe un .docx llamado "cosas.jpg". */
app.post('/api/documento/nuevo', exige, exigeEscritura, (req, res) => {
  const d = req.body || {};
  const plantilla = PLANTILLAS[String(d.clase || '')];
  if (!plantilla) return res.status(400).json({ error: 'No se que tipo de documento es ese.' });

  const tipo = ['documentos', 'archivos'].includes(String(d.tipo)) ? String(d.tipo) : 'documentos';
  const base = String(d.nombre || '').trim().replace(/\.[^.]*$/, '');
  if (!ficheros.nombreValido(base)) {
    return res.status(400).json({ error: 'Ese nombre no vale: sin barras y sin empezar por punto.' });
  }

  const carpeta = ficheros.resolver(quien(req), tipo, String(d.en || ''));
  if (!carpeta) return res.status(404).json({ error: 'Esa carpeta no existe.' });

  const nombre = base + '.' + plantilla.ext;
  const destino = path.join(carpeta, nombre);
  if (fs.existsSync(destino)) return res.status(409).json({ error: 'Ya hay algo con ese nombre.' });

  try {
    fs.writeFileSync(destino, plantilla.vacio());
    res.json({ ok: true, tipo, rel: ficheros.relativo(quien(req), tipo, destino), nombre });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documento/guardar', exige, exigeEscritura, (req, res) => {
  const d = req.body || {};
  const tipo = String(d.tipo || '');
  const abs = ficheros.resolver(quien(req), tipo, String(d.f || ''));
  if (!abs) return res.status(404).json({ error: 'Ese fichero no existe.' });

  const ext = ficheros.extDe(abs);
  try {
    let datos;
    if (ext === 'txt' || ficheros.claseDe(abs) === 'texto') {
      datos = Buffer.from(String(d.texto == null ? '' : d.texto), 'utf8');
    } else if (ext === 'docx') {
      if (!Array.isArray(d.parrafos)) return res.status(400).json({ error: 'Falta el contenido.' });
      datos = escribir.docx(d.parrafos);
    } else if (ext === 'xlsx') {
      if (!Array.isArray(d.filas)) return res.status(400).json({ error: 'Falta el contenido.' });
      datos = escribir.xlsx(d.filas, d.hoja);
    } else {
      return res.status(400).json({ error: 'Un .' + ext + ' no se puede guardar desde aqui.' });
    }

    /* Se escribe al lado y se mueve encima: si algo falla a mitad, el documento
       de antes sigue entero en vez de quedarse a medias. */
    const temporal = abs + '.guardando';
    fs.writeFileSync(temporal, datos);
    fs.renameSync(temporal, abs);
    res.json({ ok: true, tamano: datos.length, tamanoTexto: ficheros.texto(datos.length) });
  } catch (err) {
    res.status(500).json({ error: 'No he podido guardar: ' + err.message });
  }
});

/* ── Finanzas: el boton del Centro de Control ─────────────────────────────── */

/* Un token propio en vez de la cookie del SSO. El atajo del iPhone manda una
   peticion suelta, sin navegador que guarde nada, asi que no hay sesion que
   exigir. El token solo abre estas dos rutas, y lo unico que saben hacer es
   anadir una fila a un libro fijo: si se filtra, lo peor que pasa es que te
   descuadren las cuentas. */
const FINANZAS_TOKEN = process.env.TOKEN_FINANZAS || '';
const FINANZAS_HOJA = path.join(
  ARCHIVOS,
  process.env.FINANZAS_USUARIO || 'Lepayo',
  'documentos',
  process.env.FINANZAS_FICHERO || 'finanzas.xlsx');

function tokenFinanzas(req) {
  if (!FINANZAS_TOKEN) return false;

  /* El teclado del movil mete espacios y saltos de linea donde no toca al
     pegar, y una cabecera puede llegar como "Bearer  xxx " sin que se note
     mirandola. Se limpia antes de comparar; lo que no se hace es aflojar la
     comparacion en si. */
  /*
   * La cabecera es lo correcto, pero la pantalla de Atajos del iPhone la deja
   * vacia con una facilidad pasmosa: si escribes la clave y no confirmas el
   * valor, manda "Authorization:" a secas y aqui llegan cero caracteres. Como
   * el cuerpo de la peticion si se rellena bien, se admite tambien ahi. No es
   * menos seguro: un POST no deja el cuerpo escrito en el log, al contrario que
   * la URL.
   */
  const deLaCabecera = String(req.get('authorization') || '');
  const delCuerpo = req.body && req.body.token ? String(req.body.token) : '';
  const crudo = (deLaCabecera || delCuerpo)
    .replace(/^Bearer\s+/i, '')
    .replace(/\s+/g, '');
  const dado = Buffer.from(crudo);
  const bueno = Buffer.from(String(FINANZAS_TOKEN).trim());

  // timingSafeEqual exige el mismo largo, y dos largos distintos ya no son iguales
  if (dado.length !== bueno.length) {
    console.log('[finanzas] token de ' + dado.length + ' caracteres, se esperaban ' + bueno.length
      + ' (agente: ' + String(req.get('user-agent') || '?').slice(0, 40)
      + ', venia ' + (deLaCabecera ? 'en la cabecera' : (delCuerpo ? 'en el cuerpo' : 'sin poner')) + ')');
    return false;
  }
  if (!crypto.timingSafeEqual(dado, bueno)) {
    console.log('[finanzas] token del largo correcto pero distinto');
    return false;
  }
  return true;
}

/* La maquina va en UTC y las cuentas son de aqui: un gasto de las once y media
   de la noche no puede aparecer al dia siguiente, ni caer en el mes que no es. */
function ahoraEnEspana() {
  return new Date().toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

app.post('/api/finanzas/apuntar', (req, res) => {
  if (!tokenFinanzas(req)) return res.status(401).json({ error: 'Token no valido.' });

  const d = req.body || {};
  // El teclado del movil puede mandar la coma decimal de aqui
  const importe = Number(String(d.importe == null ? '' : d.importe).replace(',', '.'));
  if (!isFinite(importe) || importe === 0) {
    return res.status(400).json({ error: 'El importe no es un numero.' });
  }

  /* Manda el tipo, no el signo: asi da igual que el atajo lo mande ya en
     negativo o que se te olvide el menos. */
  const tipo = String(d.tipo || '').toLowerCase().startsWith('ingres') ? 'Ingreso' : 'Gasto';
  const firmado = (tipo === 'Gasto' ? -1 : 1) * Math.round(Math.abs(importe) * 100) / 100;

  const motivo = String(d.motivo == null ? '' : d.motivo).replace(/\s+/g, ' ').trim().slice(0, 120);
  const fecha = String(d.fecha == null ? '' : d.fecha).trim().slice(0, 40) || ahoraEnEspana();

  try {
    const r = finanzas.apuntar(FINANZAS_HOJA, { fecha, tipo, importe: firmado, motivo });
    /* 'texto' es lo que el atajo enseña en la notificacion. Se da la diferencia
       del MES y no la del libro entero: es el numero que dice si este mes vas
       bien, que es para lo que se apunta. */
    res.json({
      ok: true,
      texto: tipo + ' ' + Math.abs(firmado).toFixed(2) + ' € · ' + r.mes.nombre
        + ': ' + r.mes.diferencia.toFixed(2) + ' €',
      fecha,
      tipo,
      importe: firmado,
      motivo,
      mes: r.mes,
      total: r.total,
    });
  } catch (err) {
    res.status(500).json({ error: 'No he podido apuntarlo: ' + err.message });
  }
});

/* Para mirar como va la cosa sin apuntar nada. */
app.get('/api/finanzas/resumen', (req, res) => {
  if (!tokenFinanzas(req)) return res.status(401).json({ error: 'Token no valido.' });
  try {
    const r = finanzas.resumen(FINANZAS_HOJA);
    res.json({
      ok: true,
      texto: 'Total ' + r.total.diferencia.toFixed(2) + ' €',
      total: r.total,
      meses: r.meses,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── A PDF ───────────────────────────────────────────────────────────────── */

app.get('/api/documento/pdf', exige, async (req, res) => {
  const tipo = String(req.query.tipo || '');
  const rel = String(req.query.f || '');
  if (!['documentos', 'archivos', 'fotos'].includes(tipo)) {
    return res.status(400).json({ error: 'Seccion desconocida.' });
  }
  try {
    const { ruta, nombre } = await convertir.aPdf(tipo, rel);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.descarga === '1') {
      res.setHeader('Content-Disposition',
        'attachment; filename="' + encodeURIComponent(nombre) + '"');
    }
    res.sendFile(ruta, (err) => {
      // El PDF es de usar y tirar: se borra en cuanto sale por el cable
      fs.unlink(ruta, () => {});
      if (err && !res.headersSent) res.status(500).end();
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* Guardar la conversion como un fichero mas, al lado del original. */
app.post('/api/documento/pdf', exige, async (req, res) => {
  const d = req.body || {};
  const tipo = String(d.tipo || '');
  const rel = String(d.f || '');
  if (!['documentos', 'archivos'].includes(tipo)) {
    return res.status(400).json({ error: 'Seccion desconocida.' });
  }
  try {
    const { ruta, nombre } = await convertir.aPdf(tipo, rel);
    const origen = ficheros.resolver(quien(req), tipo, rel);
    let destino = path.join(path.dirname(origen), nombre);
    let n = 2;
    while (fs.existsSync(destino)) {
      destino = path.join(path.dirname(origen), nombre.replace(/\.pdf$/, '') + ' (' + n++ + ').pdf');
    }
    fs.copyFileSync(ruta, destino);
    fs.unlinkSync(ruta);
    res.json({ ok: true, nombre: path.basename(destino), rel: ficheros.relativo(quien(req), tipo, destino) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ── Compartir una foto con alguien de fuera ─────────────────────────────────
 *
 * Se crea un enlace con un codigo imposible de adivinar y se dibuja su QR, para
 * ensenarselo a alguien que tenga el movil delante. Quien lo abra ve ESA foto y
 * nada mas.
 *
 * Las dos rutas publicas de aqui son las UNICAS de todo el servicio que no
 * piden sesion, asi que no tocan nada que venga del navegador salvo el codigo,
 * y ese se comprueba contra la lista antes de mirar un solo fichero.
 */
/* El nombre del fichero acaba dentro del HTML de la pagina publica, y lo puso
   quien subio el fichero: si lleva comillas o un "<", ahi se cuela lo que
   quiera. Se escapa antes de pintarlo. */
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const compartir = require('./lib/compartir');
/* Envio de correo: vive fuera del proyecto porque lo comparten varios
   servicios. Ver /usr/local/lib/lepayimio/correo.js */
const correo = require('/usr/local/lib/lepayimio/correo');
const accesos = require('./lib/accesos');
const qr = require('qrcode');

app.get('/api/compartidos', exige, (req, res) => {
  try {
    res.json({ enlaces: compartir.listar(quien(req)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/compartir', exige, async (req, res) => {
  const d = req.body || {};
  try {
    /* Cada cosa puede venir con su seccion —{tipo, rel}— o como un nombre
       suelto, que entonces es de la seccion que diga `d.tipo`. */
    const loQueSea = Array.isArray(d.f)
      ? d.f.map((x) => (x && typeof x === 'object'
          ? { tipo: String(x.tipo || x.seccion || ''), rel: String(x.rel || '') }
          : String(x || '')))
      : String(d.f || '');
    const r = compartir.crear(quien(req), String(d.tipo || ''), loQueSea, d.dias);
    const url = 'https://' + (req.headers.host || 'l-archivos.lepayimio.es') + '/c/' + r.token;
    /* El QR se dibuja en SVG: se ve nitido a cualquier tamano, pesa menos que
       un PNG y no obliga a decidir una resolucion. */
    const svg = await qr.toString(url, {
      type: 'svg', margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#101322', light: '#ffffff' },
    });
    res.json({ ...r, url, svg });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/*
 * Manda por correo un enlace ya creado.
 *
 * El enlace se arma AQUI a partir del token, no se acepta una URL del
 * navegador. Si se aceptara, este endpoint seria una forma de mandar correo
 * con cualquier contenido desde tu dominio: bastaria con llamarlo con otra
 * direccion. Ademas se comprueba que el enlace sea de quien lo pide, para que
 * nadie reparta enlaces ajenos.
 *
 * El remitente no lo elige el navegador: sale de la lista blanca de
 * /etc/lepayimio/resend.env. Lo unico que decide quien envia es a quien.
 */
app.post('/api/enviar-enlace', exige, async (req, res) => {
  const d = req.body || {};
  try {
    const token = String(d.token || '');
    const para = String(d.para || '').trim();
    const nota = String(d.nota || '').slice(0, 500);

    const mio = compartir.listar(quien(req)).find((e) => e.token === token);
    if (!mio) return res.status(404).json({ error: 'Ese enlace no es tuyo o ya no existe.' });
    if (!correo.valida(para)) return res.status(400).json({ error: 'Esa dirección no es válida.' });

    const url = 'https://' + (req.headers.host || 'l-archivos.lepayimio.es') + '/c/' + token;
    const que = mio.nombre || mio.rel || 'un archivo';
    const caduca = mio.indefinido
      ? 'Este enlace no caduca: seguirá funcionando hasta que se retire.'
      : 'El enlace caduca en ' + mio.dias + ' día(s).';

    const cuerpo = [
      'Te comparto ' + que + ':',
      '',
      url,
      '',
      nota ? nota + '\n' : '',
      caduca,
      'Quien tenga el enlace puede verlo sin necesidad de cuenta.',
    ].filter((l) => l !== null).join('\n');

    const id = await correo.enviar({
      para,
      asunto: 'Te comparto ' + que,
      texto: cuerpo,
    });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/compartir/:token', exige, (req, res) => {
  try {
    res.json(compartir.revocar(String(req.params.token), quien(req)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ── MARCA-ARBOLQR · El arbol-QR: un enlace con alcance y permiso ────────────
 *
 * El mismo trato que en l-notes: se elige QUE se comparte y CON QUE PERMISO, y
 * de ahi sale un enlace u otro.
 *
 *   lectura    enlace publico sin cuenta. La pagina no ofrece bajar y la ruta
 *              de descarga responde que no.
 *   descarga   enlace publico con su boton de bajar, que es lo de siempre.
 *   escritura  invitacion de EDITOR sobre todo tu espacio, via accesos.js.
 *
 * Sobre «lectura», y la pantalla lo dice con estas palabras: es un BADEN, no un
 * candado. Para ensenar una foto hay que mandarle los bytes al navegador, asi
 * que quien tenga el enlace puede guardarla desde el menu, sacarla de las
 * herramientas de desarrollo o hacerle una captura. Sirve para que no se baje
 * sin querer y para dejar dicha la intencion. Nada mas.
 *
 * Y «escritura» obliga a vetar combinaciones: accesos.js NO tiene ambito —un
 * acceso concedido vale para las cuatro secciones enteras— asi que solo se
 * puede ofrecer con alcance «todo». Ofrecerla con «esta carpeta» seria decir
 * una cosa y hacer otra. En l-notes pasa lo mismo al reves (una nota suelta no
 * se puede compartir con escritura) y se resuelve igual: la combinacion no
 * existe, y la pantalla explica por que.
 */
const alcances = require('./lib/alcance');

app.post('/api/qr/crear', exige, (req, res) => {
  const d = req.body || {};
  const alcance = String(d.alcance || '');
  const permiso = String(d.permiso || '');

  const alto = (mensaje, status) => {
    const err = new Error(mensaje);
    err.status = status || 400;
    return err;
  };

  try {
    if (permiso === 'escritura') {
      if (alcance !== 'todo') {
        throw alto('La escritura no se puede acotar: un acceso de editor vale '
          + 'para todos tus archivos. Elige «Todo», o baja el permiso.');
      }
      /* Repartir es cosa del dueno. En el espacio de otra persona no se
         invita a sus archivos, ni teniendo permiso de editor sobre ellos. */
      if (espacio(req) !== yo(req)) {
        throw alto('Solo puedes repartir accesos a tus propios archivos.', 403);
      }
      const token = accesos.invitar(yo(req), accesos.EDITOR);
      if (!token) throw alto('No se pudo crear la invitacion.', 500);
      return res.json({
        ok: true, alcance, permiso, necesita_cuenta: true, cuantos: null,
        url: 'https://' + (req.headers.host || 'l-archivos.lepayimio.es')
             + '/a/' + token,
      });
    }

    if (permiso !== 'lectura' && permiso !== 'descarga') {
      throw alto('El permiso es «lectura», «descarga» o «escritura».');
    }

    const r0 = alcances.resolver(quien(req), alcance, String(d.seccion || ''),
                                 String(d.carpeta || ''), d.seleccion);
    const r = compartir.crear(quien(req), r0.items[0].tipo, r0.items,
                              d.dias, permiso);
    const url = 'https://' + (req.headers.host || 'l-archivos.lepayimio.es')
                + '/c/' + r.token;
    res.json(Object.assign({}, r, {
      ok: true, alcance, permiso, necesita_cuenta: false,
      cuantos: r0.cuantos, url,
    }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ── Las dos rutas publicas ──────────────────────────────────────────────── */

app.get('/c/:token', (req, res) => {
  const e = compartir.resolver(String(req.params.token), true);
  if (!e) {
    return res.status(404).type('html').send(paginaCaducada());
  }
  /* Con varios no hay una vista que sirva para todos: se listan. */
  const pintar = e.cosas.length > 1 ? paginaDeVarios : paginaCompartida;
  res.type('html').send(pintar(e, String(req.params.token)));
});

/* Uno cualquiera de los del enlace, por su numero de orden. La de /img se
   queda porque hay enlaces repartidos que la usan. */
app.get('/c/:token/f/:i', (req, res) => {
  const e = compartir.resolver(String(req.params.token), false);
  if (!e) return res.status(404).end();
  const cual = e.cosas[Number(req.params.i)];
  if (!cual) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.query.bajar === '1') {
    /* Enlace de solo lectura: no se sirve como descarga. Lo que esto NO hace
       —y la pagina lo dice— es impedir que se guarde la imagen desde el
       navegador: para verla hay que mandarsela. Es un baden. */
    if (e.permiso === 'lectura') {
      return res.status(403).type('text/plain; charset=utf-8')
        .send('Este enlace es de solo lectura: no permite descargar.');
    }
    res.setHeader('Content-Disposition',
      'attachment; filename*=UTF-8\'\'' + encodeURIComponent(cual.nombre));
  }
  res.sendFile(cual.abs);
});

app.get('/c/:token/img', (req, res) => {
  const e = compartir.resolver(String(req.params.token), false);
  if (!e) return res.status(404).end();
  /* Un enlace compartido no se guarda en caches de por medio: caduca y se puede
     revocar, y una copia en Cloudflare sobreviviria a las dos cosas. */
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(e.abs);
});

/*
 * La pagina de un enlace con varios ficheros.
 *
 * Una lista con su nombre y un boton para bajar cada uno, en vez de intentar
 * ensenarlos todos a la vez: con cinco cosas de tipos distintos —una foto, un
 * pdf y un zip— no hay una vista que valga para las tres, y lo que se quiere
 * al abrir un enlace asi es llevarselas.
 */
function paginaDeVarios(e, token) {
  const dias = e.caduca === null
    ? null : Math.max(0, Math.ceil((e.caduca - Date.now()) / 86400000));
  const filas = e.cosas.map((c, i) => `      <li>
        <span class="nombre">${esc(c.nombre)}</span>
        ${e.permiso === 'lectura' ? '' : `<a class="bajar" href="/c/${esc(token)}/f/${i}?bajar=1" download>Descargar</a>`}
        <a class="ver" href="/c/${esc(token)}/f/${i}" target="_blank" rel="noopener">Ver</a>
      </li>`).join('\n');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${e.cosas.length} archivos compartidos</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#101322">
<style>
  html, body { height: 100%; margin: 0; }
  body {
    color: #fff; background: #0d0f1c;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: .75rem;
    padding: .9rem 1.1rem; border-bottom: 1px solid rgba(255,255,255,.12);
  }
  h1 { margin: 0; font-size: .98rem; font-weight: 600; }
  .dato { color: rgba(255,255,255,.55); font-size: .78rem; }
  main { padding: 1.1rem; }
  ul { list-style: none; margin: 0 auto; padding: 0; max-width: 42rem; }
  li {
    display: flex; align-items: center; gap: .8rem;
    padding: .8rem .9rem; margin-bottom: .5rem;
    background: rgba(255,255,255,.06); border-radius: .7rem;
  }
  .nombre { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .92rem; }
  a { color: #8fc2ff; text-decoration: none; font-size: .85rem; white-space: nowrap; }
  a.bajar { padding: .35rem .8rem; border-radius: 999px; background: rgba(143,194,255,.16); }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <header>
    <h1>${e.cosas.length} archivos compartidos</h1>
    <span class="dato">${dias === null ? 'sin fecha de caducidad'
      : (dias === 0 ? 'caduca hoy' : 'caduca en ' + dias + (dias === 1 ? ' día' : ' días'))}</span>
  </header>
  <main>
    <ul>
${filas}
    </ul>
  </main>
</body>
</html>
`;
}

function paginaCompartida(e, token) {
  const nombre = esc(e.nombre);
  const dias = e.caduca === null
    ? null : Math.max(0, Math.ceil((e.caduca - Date.now()) / 86400000));
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${nombre}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#101322">
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    flex-direction: column;
    color: #fff;
    background: #0d0f1c;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: .75rem;
    padding: .9rem 1.1rem; border-bottom: 1px solid rgba(255,255,255,.12);
  }
  h1 { margin: 0; font-size: .98rem; font-weight: 600; overflow-wrap: anywhere; }
  .dato { color: rgba(255,255,255,.55); font-size: .78rem; }
  main { flex: 1; display: grid; place-items: center; padding: 1rem; min-height: 0; }
  img, video { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: .5rem; }
  iframe { width: 100%; height: 100%; border: 0; border-radius: .5rem; background: #fff; }
  pre {
    width: 100%; max-width: 54rem; max-height: 100%; margin: 0; padding: 1.1rem;
    overflow: auto; background: rgba(255,255,255,.06); border-radius: .6rem;
    font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .82rem;
    white-space: pre-wrap; overflow-wrap: anywhere; text-align: left;
  }
  .sin-vista { text-align: center; color: rgba(255,255,255,.6); }
  .sin-vista .tipo {
    display: inline-block; margin-bottom: .9rem; padding: 1.1rem 1.4rem;
    background: rgba(255,255,255,.08); border-radius: .8rem;
    font-size: 1.4rem; font-weight: 700; letter-spacing: .04em;
  }
  footer { padding: .9rem 1.1rem; text-align: center; }
  a.bajar {
    display: inline-block; padding: .5rem 1rem;
    color: #101322; background: #fff; border-radius: 999px;
    font-size: .86rem; font-weight: 600; text-decoration: none;
  }
  .pie { margin-top: .6rem; color: rgba(255,255,255,.4); font-size: .72rem; }
</style>
</head>
<body>
  <header>
    <h1>${nombre}</h1>
    <span class="dato">compartida desde lepayimio.es</span>
  </header>
  <main>${cuerpoDe(e, token, nombre)}</main>
  <footer>
    ${e.permiso === 'lectura' ? '<p class="solo-ver">Este enlace es solo para ver.</p>' : `<a class="bajar" href="/c/${esc(token)}/img" download="${nombre}">Descargar</a>`}
    <div class="pie">${dias === null
      ? 'Compartida sin fecha de caducidad.'
      : 'Este enlace caduca ' + (dias === 0 ? 'hoy' : 'en ' + dias + (dias === 1 ? ' día' : ' días')) + '.'}</div>
  </footer>
</body>
</html>`;
}

/*
 * Que se ensena segun lo que sea.
 *
 * Empezo sirviendo solo fotos, con un <img> fijo. Al compartir tambien
 * documentos y archivos eso deja de valer: un PDF pide su visor, un video sus
 * controles, un texto su caja, y de un .zip no hay nada que ensenar salvo el
 * boton de bajarlo.
 *
 * Nada de esto lee el fichero: se decide por la extension y se deja que el
 * navegador haga lo suyo con la misma URL de siempre.
 */
function cuerpoDe(e, token, nombre) {
  const url = '/c/' + esc(token) + '/img';
  const clase = ficheros.claseDe(e.rel);

  if (clase === 'imagen') return `<img src="${url}" alt="${nombre}">`;
  if (clase === 'video') return `<video src="${url}" controls preload="metadata"></video>`;
  if (clase === 'audio') return `<video src="${url}" controls preload="metadata" style="width:min(100%,34rem)"></video>`;
  if (clase === 'pdf') return `<iframe src="${url}" title="${nombre}"></iframe>`;
  if (clase === 'texto') {
    /* El texto se pinta en el servidor y no se trae con fetch: la pagina
       publica no lleva javascript, y asi sigue sin llevarlo. */
    try {
      const st = fs.statSync(e.abs);
      if (st.size <= 400 * 1024) {
        return `<pre>${esc(fs.readFileSync(e.abs, 'utf8'))}</pre>`;
      }
    } catch { /* si no se puede leer, se cae al caso de abajo */ }
  }

  const ext = ficheros.extDe(e.rel) || 'fichero';
  return `<div class="sin-vista">
      <div class="tipo">${esc(ext.toUpperCase())}</div>
      <p>Esto no se puede ver en el navegador.<br>Descárgalo para abrirlo.</p>
    </div>`;
}

function paginaCaducada() {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enlace no disponible</title>
<meta name="robots" content="noindex, nofollow">
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; padding: 2rem; text-align: center;
    color: #fff; background: #0d0f1c;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  p { max-width: 22rem; color: rgba(255,255,255,.65); line-height: 1.5; }
</style>
</head>
<body>
  <div>
    <h1>Este enlace ya no vale</h1>
    <p>Puede que haya caducado, que se haya retirado o que nunca existiera.
       Pídeselo otra vez a quien te lo mandó.</p>
  </div>
</body>
</html>`;
}

/* ── Lo que ya esta en L-films ───────────────────────────────────────────────
 *
 * Borrar un torrent no quita la pelicula: el buzon no mueve lo que llega, lo
 * pasa por ffmpeg y escribe un fichero nuevo en la biblioteca. Son dos cosas
 * que ocupan disco por separado, y hasta ahora solo se podia soltar una de las
 * dos desde aqui.
 */
const biblioteca = require('./lib/biblioteca');
const favoritos = require('./lib/favoritos');

/* ── Favoritos ───────────────────────────────────────────────────────────────
 *
 * Marcar una pelicula la saca de la lista desde la que se borra y hace que el
 * servidor se niegue a borrarla. Es para los despistes, que con 3 GB y sin
 * papelera salen caros.
 */
app.get('/api/favoritos', exige, (req, res) => {
  try {
    const todo = biblioteca.resumen();
    res.json({
      favoritos: todo.items.filter((i) => i.favorito),
      resto: todo.items.filter((i) => !i.favorito),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/favoritos', exige, (req, res) => {
  const d = req.body || {};
  // Admite una sola o un puñado, para poder marcar varias de una vez
  const lista = Array.isArray(d.items) ? d.items
    : (d.tipo && d.f ? [{ tipo: String(d.tipo), rel: String(d.f) }] : []);
  if (!lista.length) return res.status(400).json({ error: 'No has dicho cuales.' });
  try {
    res.json(favoritos.anadir(lista.map((x) => ({ tipo: String(x.tipo || ''), rel: String(x.rel || x.f || '') }))));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/favoritos', exige, (req, res) => {
  try {
    res.json(favoritos.quitar(String(req.query.tipo || ''), String(req.query.f || '')));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});


app.get('/api/biblioteca', exige, (req, res) => {
  try {
    res.json(biblioteca.resumen());
  } catch (err) {
    res.status(500).json({ error: 'No puedo leer la biblioteca: ' + err.message });
  }
});

/* El fichero va en la consulta y no en la ruta.
 *
 * Un episodio vive en "Serie/Temporada 1/cap.mkv", con barras dentro, y meter
 * eso en un parametro de ruta obliga a un comodin. Express 5 estrena
 * path-to-regexp 8, donde el ":rel(*)" de toda la vida ya no se admite -- el
 * servicio no arrancaba y decia "Unexpected ( at index 26". En la consulta el
 * valor viaja entero y codificado, sin sintaxis que se pueda quedar vieja.
 */
app.delete('/api/biblioteca', exige, (req, res) => {
  try {
    const r = biblioteca.borrar(String(req.query.tipo || ''), String(req.query.rel || ''));
    res.json({ ok: true, liberado: r.texto });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/torrents', exige, async (req, res) => {
  try {
    res.json(await torrents.estado());
  } catch (err) {
    res.status(502).json({ error: 'No puedo hablar con el gestor de descargas: ' + err.message });
  }
});

/* El .torrent llega en base64 dentro del JSON y no como formulario: son unos
   kilobytes, y asi esta ruta no necesita saber nada de multipart. */
app.post('/api/torrents', exige, async (req, res) => {
  const d = req.body || {};
  const magnet = typeof d.magnet === 'string' ? d.magnet.trim() : '';
  const base64 = typeof d.torrent === 'string' ? d.torrent.trim() : '';

  if (!magnet && !base64) return res.status(400).json({ error: 'Hace falta un magnet o un .torrent.' });
  if (magnet && !/^magnet:\?xt=urn:btih:/i.test(magnet)) {
    return res.status(400).json({ error: 'Eso no parece un enlace magnet.' });
  }
  if (base64 && base64.length > 4 * 1024 * 1024) {
    return res.status(413).json({ error: 'Ese .torrent es absurdamente grande.' });
  }

  try {
    res.json(await torrents.anadir(magnet ? { magnet } : { base64 }));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/api/torrents/:id/:accion', exige, async (req, res) => {
  const { id, accion } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Id invalido.' });
  try {
    if (accion === 'parar') await torrents.parar(id);
    else if (accion === 'arrancar') await torrents.arrancar(id);
    else return res.status(400).json({ error: 'Accion desconocida.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* Borrar se lleva los datos del disco: es lo unico que libera cuota. Lo que ya
   se haya colocado en l-films es otro fichero y no se toca. */
app.delete('/api/torrents/:id', exige, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Id invalido.' });
  try {
    await torrents.borrar(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ── Videos de la web ────────────────────────────────────────────────────────
 *
 * La otra caja de la pantalla de descargas. Se pega la direccion de una pagina
 * con video -- YouTube, Vimeo, Twitch, un periodico, lo que sea -- yt-dlp lo
 * baja en la mejor calidad que ofrezca y el video acaba en la Storage Box y en
 * Jellyfin por el mismo buzon que las peliculas, solo que en su propia
 * biblioteca y no en la de peliculas.
 *
 * Todo el trabajo vive en lib/videos.js, incluida la comprobacion de a donde
 * apunta la direccion: es texto de fuera que acaba en manos de un programa que
 * hace peticiones DESDE el servidor, asi que lo que resuelva a la red interna
 * se queda en la puerta.
 */
const videos = require('./lib/videos');

app.get('/api/videos', exige, (req, res) => {
  try {
    res.json({ ...videos.estado(), instalado: videos.instalado() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
 * Uno o una lista, por la misma puerta.
 *
 * La pantalla manda «urls» con todo lo que haya pegado en la caja, que es casi
 * siempre mas de una linea desde que se pueden pegar varias. Se sigue
 * aceptando «url» a secas porque es lo que entiende cualquier cosa que ya
 * llame a esta ruta, y porque un solo enlace merece la respuesta de siempre:
 * el titulo, el tamaño y el fallo concreto si lo hay.
 */
app.post('/api/videos', exige, async (req, res) => {
  const cuerpo = req.body || {};
  const url = typeof cuerpo.url === 'string' ? cuerpo.url.trim() : '';
  const lista = Array.isArray(cuerpo.urls)
    ? cuerpo.urls.filter((u) => typeof u === 'string').map((u) => u.trim()).filter(Boolean)
    : [];
  if (!url && !lista.length) {
    return res.status(400).json({ error: 'Pega la direccion de la pagina del video.' });
  }
  if (!videos.instalado()) {
    return res.status(503).json({ error: 'yt-dlp no esta instalado en el servidor.' });
  }
  try {
    res.json(lista.length ? await videos.anadirVarias(lista) : await videos.anadir(url));
  } catch (err) {
    /* 400 y no 502: lo que falla aqui casi siempre es el enlace -- privado,
       borrado, con region bloqueada, de una pagina que pide sesion o
       directamente mal pegado -- y no el servidor. Un 502 mandaria a mirar los
       logs del VPS por nada. */
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/videos/:id', exige, (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Id invalido.' });
  try {
    res.json(videos.quitar(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/* ── Fotos, documentos y archivos ────────────────────────────────────────────
 *
 * Las tres pantallas que ensenan lo que se ha subido. Comparten todo el suelo
 * -- rutas seguras, listado, borrado -- en lib/ficheros.js, y cada una anade lo
 * suyo: miniaturas la galeria, lectura de ofimatica los documentos, carpetas el
 * gestor.
 *
 * Ninguna ruta de aqui construye un camino pegando lo que llega del navegador:
 * todas pasan por resolver(), que comprueba a donde apunta de verdad.
 */
const ficheros = require('./lib/ficheros');
const miniaturas = require('./lib/miniaturas');
const ofimatica = require('./lib/ofimatica');

const TIPOS_VALIDOS = ['fotos', 'videos', 'documentos', 'archivos'];
const compruebaTipo = (t) => (TIPOS_VALIDOS.includes(t) ? t : null);

/*
 * Las pantallas se sirven sin cachear.
 *
 * Son HTML con el javascript dentro, asi que cachearlas es cachear el programa:
 * al anadir un boton, quien tuviera la pagina guardada seguia sin verlo y no
 * habia forma de saber si el fallo era suyo o del navegador. Pesan unos 20 kB y
 * se piden una vez por visita: no hay nada que ahorrar ahi.
 */
const marcas = new Map();

/* La marca de tiempo del fichero, mirada como mucho una vez cada pocos
   segundos: son cuatro ficheros y se piden en cada visita. */
function marcaDe(rel) {
  const guardada = marcas.get(rel);
  const ahora = Date.now();
  if (guardada && ahora - guardada.mirado < 5000) return guardada.marca;

  let marca = '0';
  try {
    marca = String(Math.floor(fs.statSync(path.join(__dirname, 'public', rel)).mtimeMs));
  } catch (err) {
    /* Si no esta, que lo diga el 404 al pedirlo, no un fallo aqui. */
  }
  marcas.set(rel, { marca, mirado: ahora });
  return marca;
}

/* Los guiones y las hojas, con la marca de su fichero pegada. */
function conMarca(html) {
  return html.replace(/(src|href)="(\/(?:js|css)\/[^"?]+\.(?:js|css))"/g,
    (todo, atributo, rel) => atributo + '="' + rel + '?v=' + marcaDe(rel) + '"');
}

function pantalla(nombre) {
  return (req, res, siguiente) => {
    fs.readFile(path.join(__dirname, 'public', nombre + '.html'), 'utf8', (err, html) => {
      if (err) return siguiente(err);
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.type('html').send(conMarca(html));
    });
  };
}

for (const p of ['fotos', 'documentos', 'archivos']) {
  app.get('/' + p, exige, pantalla(p));
}

// ── Listado ──────────────────────────────────────────────────────────────────


/* Huella del arrastre: deja constancia de mover y ordenar. Son gestos puntuales
   y, cuando uno no funciona, lo primero que hace falta saber es si la peticion
   llego siquiera. El resto del trafico no se registra. */
app.use('/api/f', (req, res, siguiente) => {
  if (!/\/(mover|orden)$/.test(req.path)) return siguiente();
  const empezo = Date.now();
  const cuerpo = JSON.stringify(req.body || {}).slice(0, 200);
  res.on('finish', () => {
    console.log('[arrastre] ' + req.method + ' ' + req.originalUrl
      + ' -> ' + res.statusCode + ' (' + (Date.now() - empezo) + 'ms) ' + cuerpo);
  });
  siguiente();
});

app.get('/api/f/:tipo', exige, (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).json({ error: 'No existe esa seccion.' });
  try {
    res.json(ficheros.listar(quien(req), tipo, String(req.query.en || '')));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* La galeria pide todo de una vez, con carpetas incluidas: una galeria que
   solo ensena el primer nivel esconde justo lo que se ha ordenado. */
app.get('/api/fotos/todas', exige, (req, res) => {
  try {
    /* Fotos y videos, que en la galeria son lo mismo. Se sigue mandando
       como `fotos` para no romper a quien ya pedia esto. */
    const lista = ficheros.todoElMedia(quien(req));
    res.json({
      total: lista.length,
      fotos: lista,
      videos: lista.filter((e) => e.clase === 'video').length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Compartir tus archivos ───────────────────────────────────────────────────

/* En que espacio estas, a cuales puedes ir y que has repartido. Todo de una
   vez: son tres listas cortas de la misma pregunta. */
app.get('/api/espacio/estado', exige, (req, res) => {
  const mio = yo(req);
  const activo = espacio(req);
  res.json({
    activo: { dueno: activo, propio: activo === mio, permiso: accesos.permisoDe(activo, mio) },
    espacios: accesos.espaciosDe(mio),
    repartidos: accesos.repartidoPor(mio).map((r) => Object.assign({}, r, {
      url: r.token ? (req.protocol + '://' + req.get('host') + '/a/' + r.token) : null,
      token: undefined,
    })),
  });
});

app.post('/api/espacio/invitar', exige, (req, res) => {
  const permiso = String((req.body || {}).permiso || '');
  const token = accesos.invitar(yo(req), permiso);
  if (!token) return res.status(400).json({ error: 'El permiso es lector o editor.' });
  res.json({ ok: true, permiso, url: req.protocol + '://' + req.get('host') + '/a/' + token });
});

app.post('/api/espacio/retirar', exige, (req, res) => {
  if (!accesos.retirar(yo(req), (req.body || {}).id)) {
    return res.status(404).json({ error: 'No existe ese acceso.' });
  }
  res.json({ ok: true });
});

/* Cambiar de espacio. La galleta solo dice cual se quiere ver; el permiso se
   comprueba en cada peticion, asi que tocarla no abre nada. */
app.post('/api/espacio/cambiar', exige, (req, res) => {
  const cual = String((req.body || {}).dueno || '').trim();
  const mio = yo(req);

  if (!cual || cual === mio) {
    res.clearCookie('espacio', { path: '/' });
    return res.json({ ok: true, activo: mio });
  }
  if (!accesos.permisoDe(cual, mio)) {
    return res.status(403).json({ error: 'No tienes acceso a esos archivos.' });
  }
  res.cookie('espacio', cual, {
    httpOnly: true, sameSite: 'lax', secure: true, path: '/',
    maxAge: 365 * 24 * 3600 * 1000,
  });
  res.json({ ok: true, activo: cual });
});

/* El enlace que se reparte. Al abrirlo te quedas el acceso y entras. */
app.get('/a/:token', exige, (req, res) => {
  const dueno = accesos.aceptar(req.params.token, yo(req));
  if (!dueno) return res.redirect('/');
  res.cookie('espacio', dueno, {
    httpOnly: true, sameSite: 'lax', secure: true, path: '/',
    maxAge: 365 * 24 * 3600 * 1000,
  });
  res.redirect('/fotos');
});

// ── Servir el contenido ──────────────────────────────────────────────────────

/* Cachear un ano con immutable seria mentir: el fichero puede cambiar sin que
   cambie la URL. Con no-cache el navegador pregunta y se queda con su copia si
   nada ha cambiado, que para una galeria es casi igual de rapido y nunca
   ensena algo que ya no esta. */
function mandaFichero(req, res, absoluta, descarga) {
  if (!absoluta) return res.status(404).json({ error: 'No existe.' });
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const opciones = descarga ? { headers: { 'Content-Disposition':
    'attachment; filename="' + encodeURIComponent(path.basename(absoluta)) + '"' } } : {};
  res.sendFile(absoluta, opciones, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
}

app.get('/api/f/:tipo/ver', exige, (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).json({ error: 'No existe esa seccion.' });
  mandaFichero(req, res, ficheros.resolver(quien(req), tipo, String(req.query.f || '')),
               req.query.descarga === '1');
});

// ── Miniaturas y version grande, solo para imagenes ──────────────────────────

app.get('/api/f/:tipo/mini', exige, async (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).end();
  try {
    const m = await miniaturas.miniatura(quien(req), tipo, String(req.query.f || ''));
    if (!m) return res.status(404).end();
    // Esta si es inmutable de verdad: su nombre lleva la fecha del original,
    // asi que una miniatura concreta nunca cambia de contenido.
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.sendFile(m);
  } catch { res.status(500).end(); }
});

app.get('/api/f/:tipo/grande', exige, async (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).end();
  try {
    const g = await miniaturas.grande(quien(req), tipo, String(req.query.f || ''));
    if (!g) return mandaFichero(req, res, ficheros.resolver(quien(req), tipo, String(req.query.f || '')), false);
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.sendFile(g);
  } catch { res.status(500).end(); }
});

// ── Abrir un documento ───────────────────────────────────────────────────────

app.get('/api/documentos/abrir', exige, (req, res) => {
  const rel = String(req.query.f || '');
  const abs = ficheros.resolver(quien(req), 'documentos', rel);
  if (!abs) return res.status(404).json({ error: 'No existe.' });

  const ext = ficheros.extDe(abs);
  const clase = ficheros.claseDe(abs);

  try {
    if (clase === 'texto') {
      const st = fs.statSync(abs);
      if (st.size > 2 * 1024 * 1024) {
        return res.json({ clase: 'grande', ext,
          aviso: 'Son ' + ficheros.texto(st.size) + ' de texto: mejor descargarlo.' });
      }
      return res.json({ clase: 'texto', ext, texto: fs.readFileSync(abs, 'utf8') });
    }
    if (clase === 'ofimatica') return res.json({ ...ofimatica.leer(abs, ext), ext });
    if (clase === 'pdf') return res.json({ clase: 'pdf', ext });
    if (clase === 'imagen') return res.json({ clase: 'imagen', ext });
    if (clase === 'ofimatica-vieja') {
      return res.json({ clase: 'sin-visor', ext,
        aviso: 'Los .' + ext + ' son del formato binario antiguo y no se pueden '
             + 'leer sin LibreOffice. Puedes descargarlo.' });
    }
    return res.json({ clase: 'sin-visor', ext, aviso: 'No hay visor para un .' + ext + '.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Carpetas y borrado ───────────────────────────────────────────────────────

app.post('/api/f/:tipo/carpeta', exige, exigeEscritura, (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).json({ error: 'No existe esa seccion.' });
  try {
    res.json(ficheros.crearCarpeta(quien(req), tipo, String((req.body || {}).en || ''),
                                   String((req.body || {}).nombre || '')));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});


/* Llevar algo a otra carpeta, que es lo que pasa al arrastrarlo encima. */
app.post('/api/f/:tipo/mover', exige, exigeEscritura, (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).json({ error: 'No existe esa seccion.' });
  const d = req.body || {};
  try {
    res.json(ficheros.mover(quien(req), tipo, String(d.f || ''), String(d.a || '')));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* El orden que alguien ha puesto a mano en una carpeta. */
app.post('/api/f/:tipo/orden', exige, exigeEscritura, (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).json({ error: 'No existe esa seccion.' });
  const d = req.body || {};
  try {
    res.json(ficheros.ordenar(quien(req), tipo, String(d.en || ''), d.nombres));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* Una copia al lado de la original. Vale igual para una carpeta: se copia
   entera, con lo que lleve dentro. */
app.post('/api/f/:tipo/duplicar', exige, exigeEscritura, (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).json({ error: 'No existe esa seccion.' });
  try {
    res.json(ficheros.duplicar(quien(req), tipo, String((req.body || {}).f || '')));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/f/:tipo/renombrar', exige, exigeEscritura, (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).json({ error: 'No existe esa seccion.' });
  try {
    res.json(ficheros.renombrar(quien(req), tipo, String((req.body || {}).f || ''),
                                String((req.body || {}).nombre || '')));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/f/:tipo', exige, exigeEscritura, (req, res) => {
  const tipo = compruebaTipo(req.params.tipo);
  if (!tipo) return res.status(404).json({ error: 'No existe esa seccion.' });
  try {
    res.json(ficheros.borrar(quien(req), tipo, String(req.query.f || ''), req.query.contodo === '1'));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, cuantos: err.cuantos });
  }
});

/* Con sesión obligatoria. Aquí `exige` no es global, se pone ruta por ruta,
   así que sin esto estas dos llegaban sin req.sesion y `yo` reventaba con un
   500 en cada intento de guardar el tema. */
app.use('/api/tema', exige);
tema.rutas(app, yo);

/* La portada se lee y se marca con el tema antes de mandarla, en vez de
   servirla con sendFile: aplicarlo desde el navegador obligaría a pintar el
   tema por defecto y corregirlo después, y ese parpadeo se ve en cada carga. */
app.get('/', exige, (req, res, siguiente) => {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, html) => {
    if (err) return siguiente(err);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(conMarca(tema.inyectar(html, tema.de(yo(req)))));
  });
});
/* Lo que se pide con ?v= identifica un contenido concreto: si el fichero
   cambia, cambia la direccion. Asi que se puede guardar sin fecha de caducidad
   en vez de preguntar por el en cada visita. */
app.use((req, res, siguiente) => {
  if (req.query.v && /\.(js|css)$/.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  siguiente();
});


/* Cerrar sesion. Borra la cookie del dominio padre —la misma que vale para los
   cinco sitios— y manda al login del portal. Por POST: cerrar sesion cambia
   algo, y con un GET lo dispararia cualquier precarga del navegador. */
app.post('/salir', (req, res) => {
  res.clearCookie(sso.COOKIE, {
    httpOnly: true, secure: true, sameSite: 'lax', domain: '.lepayimio.es', path: '/',
  });
  res.redirect(sso.LOGIN);
});


app.use(express.static(path.join(__dirname, 'public'), { index: false }));

barrerParciales();
setInterval(barrerParciales, 1 * 3600 * 1000).unref();

app.listen(PUERTO, '127.0.0.1', () => console.log('[l-archivos] escuchando en 127.0.0.1:' + PUERTO));
