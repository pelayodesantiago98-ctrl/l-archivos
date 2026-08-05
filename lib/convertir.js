'use strict';
/*
 * Pasar a PDF cualquiera de los formatos de ofimatica.
 *
 * Lo hace LibreOffice en modo sin pantalla, que es la unica forma honrada de
 * conseguir un PDF que se parezca al documento: mantiene tipografias, tablas,
 * saltos de pagina y estilos. Escribir el PDF a mano habria sido mas ligero
 * pero el resultado no seria una conversion, seria otro documento.
 *
 * A cambio pesa: unos 300 MB de memoria mientras convierte, en una maquina de
 * 1,8 GB que ya sostiene seis sitios y Jellyfin. Por eso va de UNA EN UNA, con
 * el resto esperando en cola, y con un tope de tiempo: un documento roto puede
 * dejar a soffice pensando indefinidamente, y eso si tumbaria la maquina.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ficheros = require('./ficheros');

const SOFFICE = '/usr/bin/soffice';
const TOPE_MS = 120000;          // dos minutos por documento
const TOPE_TAMANO = 60 * 1024 * 1024;

const CONVERTIBLES = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|html?)$/i;

let ocupado = false;
const cola = [];

function turno() {
  return new Promise((suelta) => {
    const intentar = () => { if (!ocupado) { ocupado = true; suelta(); } else cola.push(intentar); };
    intentar();
  });
}
function libera() {
  ocupado = false;
  const siguiente = cola.shift();
  if (siguiente) siguiente();
}

const sePuede = (nombre) => CONVERTIBLES.test(nombre);

/*
 * Devuelve la ruta de un PDF temporal. Quien lo pide se encarga de mandarlo y
 * de borrarlo: dejarlo aqui obligaria a inventar una politica de caducidad para
 * algo que se usa una vez y se descarga.
 */
async function aPdf(tipo, rel) {
  const origen = ficheros.resolver(tipo, rel);
  if (!origen) {
    const err = new Error('Ese fichero no existe.');
    err.status = 404;
    throw err;
  }
  if (!sePuede(origen)) {
    const err = new Error('Un .' + ficheros.extDe(origen) + ' no se puede pasar a PDF.');
    err.status = 400;
    throw err;
  }
  const st = fs.statSync(origen);
  if (st.size > TOPE_TAMANO) {
    const err = new Error('El documento es demasiado grande para convertirlo aqui.');
    err.status = 413;
    throw err;
  }

  await turno();
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'apdf-'));
  try {
    /* -env:UserInstallation apunta el perfil a un directorio de usar y tirar.
       Sin esto, dos conversiones a la vez se pelean por el perfil compartido y
       la segunda se queda esperando un bloqueo que no llega -- y aunque aqui
       van de una en una, el perfil por defecto vive en el HOME del servicio,
       que con ProtectHome puede no existir siquiera. */
    const argumentos = [
      '-env:UserInstallation=file://' + path.join(carpeta, 'perfil'),
      '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
      '--convert-to', 'pdf:writer_pdf_Export',
      '--outdir', carpeta,
      origen,
    ];

    await new Promise((ok, mal) => {
      execFile(SOFFICE, argumentos, { timeout: TOPE_MS, maxBuffer: 8 << 20 }, (err, salida, error) => {
        if (err) {
          return mal(new Error(err.killed
            ? 'La conversion ha tardado demasiado y se ha cortado.'
            : 'LibreOffice no ha podido con el documento: '
              + String(error || err.message).slice(0, 160)));
        }
        ok();
      });
    });

    const pdf = fs.readdirSync(carpeta).find((f) => f.toLowerCase().endsWith('.pdf'));
    if (!pdf) throw new Error('La conversion no ha dejado ningun PDF.');

    /* Se saca de la carpeta temporal a un fichero suelto para poder borrar la
       carpeta entera (con el perfil dentro) sin llevarse el resultado. */
    const destino = path.join(os.tmpdir(),
      'pdf-' + crypto.randomBytes(8).toString('hex') + '.pdf');
    fs.renameSync(path.join(carpeta, pdf), destino);
    return { ruta: destino, nombre: path.basename(rel).replace(/\.[^.]+$/, '') + '.pdf' };
  } finally {
    try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch {}
    libera();
  }
}

module.exports = { aPdf, sePuede, enCola: () => cola.length, ocupado: () => ocupado };
