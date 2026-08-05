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
const { execFile } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');
const sso = require('/usr/local/lib/lepayimio/sso');

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
  pelicula:  { carpeta: ENTRADA, video: true, ext: ['mkv', 'mp4', 'avi', 'ts', 'm2ts', 'mov', 'webm'] },
  serie:     { carpeta: ENTRADA, video: true, ext: ['mkv', 'mp4', 'avi', 'ts', 'm2ts', 'mov', 'webm'] },
  imagen:    { carpeta: path.join(ARCHIVOS, 'imagenes'),   ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif', 'tif', 'tiff', 'bmp', 'svg'] },
  documento: { carpeta: path.join(ARCHIVOS, 'documentos'), ext: ['pdf', 'epub', 'mobi', 'docx', 'doc', 'odt', 'xlsx', 'ods', 'pptx', 'txt', 'md', 'csv'] },
  otro:      { carpeta: path.join(ARCHIVOS, 'otros'),      ext: [] },
};

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
/* El .torrent viaja en base64 dentro del JSON y no cabe en los 32 kB que le
   sobran al resto de la API: uno de una pelicula ronda los 30-60 kB y en
   base64 crece un tercio. Se le pone su propio parser por delante; el general
   ve el cuerpo ya leido y no lo vuelve a tocar. */
app.use('/api/torrents', express.json({ limit: '4mb' }));
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
function sinPisar(carpeta, nombre) {
  const ext = path.extname(nombre);
  const base = path.basename(nombre, ext);
  let intento = nombre;
  for (let n = 2; fs.existsSync(path.join(carpeta, intento)); n++) intento = base + ' (' + n + ')' + ext;
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

app.post('/subida/nueva', exige, (req, res) => {
  const d = req.body || {};
  const tipo = TIPOS[d.tipo] ? String(d.tipo) : null;
  if (!tipo) return res.status(400).json({ error: 'Tipo desconocido.' });

  if (libresGB() < MARGEN_GB) {
    return res.status(507).json({ error: 'Quedan menos de ' + MARGEN_GB + ' GB libres en el servidor.' });
  }

  const ext = extensionDe(d.nombre) || 'bin';
  const nombre = nombreDe(d, ext);
  if (!nombre) return res.status(400).json({ error: 'Faltan datos para componer el nombre.' });

  const id = crypto.randomUUID();
  fs.mkdirSync(PARCIALES, { recursive: true });
  fs.writeFileSync(rutaFicha(id), JSON.stringify({
    tipo, nombre, ext,
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
app.put('/subida/:id', exige, (req, res) => {
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
  if (libresGB() < MARGEN_GB) {
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

app.post('/subida/:id/terminar', exige, (req, res) => {
  const id = req.params.id;
  const ficha = leerFicha(id);
  if (!ficha) return res.status(404).json({ error: 'Esa subida ya no existe.' });

  const tamano = recibidos(id);
  if (ficha.tamano && tamano !== ficha.tamano) {
    return res.status(409).json({ error: 'Faltan trozos.', recibido: tamano, tamano: ficha.tamano });
  }

  const carpeta = TIPOS[ficha.tipo].carpeta;
  fs.mkdirSync(carpeta, { recursive: true });
  const definitivo = sinPisar(carpeta, ficha.nombre);
  const destino = path.join(carpeta, definitivo);

  /* rename entre sistemas de ficheros distintos falla con EXDEV. Las parciales
     y el destino cuelgan del mismo disco, pero si algun dia dejan de hacerlo
     conviene que esto no se rompa en silencio. */
  try {
    fs.renameSync(rutaParcial(id), destino);
  } catch (e) {
    if (e.code !== 'EXDEV') return res.status(500).json({ error: 'No he podido guardar: ' + e.message });
    fs.copyFileSync(rutaParcial(id), destino);
    fs.unlinkSync(rutaParcial(id));
  }
  try { fs.unlinkSync(rutaFicha(id)); } catch {}
  /* Solo el grupo, no el dueno.
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
  try {
    const s = fs.statSync(carpeta);
    fs.chownSync(destino, -1, s.gid);
  } catch {}

  if (!TIPOS[ficha.tipo].video) {
    apuntar(carpeta, { fichero: definitivo, tipo: ficha.tipo, tamano, original: ficha.original });
    return res.json({
      ok: true, nombre: definitivo, tipo: ficha.tipo, tamano,
      destino: ficha.tipo === 'otro' ? 'otros' : ficha.tipo + 's',
      aviso: avisoExtension(ficha.tipo, ficha.ext),
    });
  }

  // Video: mirar que trae dentro, que es lo que decide si habra que convertir.
  if (!FFPROBE) return res.json({ ok: true, nombre: definitivo, tipo: ficha.tipo, tamano, analisis: null });
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
  try { restos = fs.readdirSync(PARCIALES); } catch { return; }
  const limite = Date.now() - CADUCIDAD_MS;
  for (const n of restos) {
    const f = path.join(PARCIALES, n);
    try {
      if (fs.statSync(f).mtimeMs < limite) { fs.unlinkSync(f); console.log('[l-archivos] barrido ' + n); }
    } catch {}
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
app.get('/cola', exige, (req, res) => {
  let ficheros = [];
  try {
    ficheros = fs.readdirSync(ENTRADA)
      .filter((n) => !n.startsWith('.'))
      .map((n) => ({ nombre: n, tamano: fs.statSync(path.join(ENTRADA, n)).size }));
  } catch {}

  const guardados = {};
  for (const [tipo, cfg] of Object.entries(TIPOS)) {
    if (cfg.video) continue;
    try {
      guardados[tipo] = fs.readdirSync(cfg.carpeta).filter((n) => !n.startsWith('.')).length;
    } catch { guardados[tipo] = 0; }
  }

  res.json({ ficheros, guardados, libresGB: Math.round(libresGB()) });
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

app.get('/torrents', exige, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'torrents.html')));

/* ── Lo que ya esta en L-films ───────────────────────────────────────────────
 *
 * Borrar un torrent no quita la pelicula: el buzon no mueve lo que llega, lo
 * pasa por ffmpeg y escribe un fichero nuevo en la biblioteca. Son dos cosas
 * que ocupan disco por separado, y hasta ahora solo se podia soltar una de las
 * dos desde aqui.
 */
const biblioteca = require('./lib/biblioteca');

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

app.get('/', exige, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

barrerParciales();
setInterval(barrerParciales, 6 * 3600 * 1000).unref();

app.listen(PUERTO, '127.0.0.1', () => console.log('[l-archivos] escuchando en 127.0.0.1:' + PUERTO));
