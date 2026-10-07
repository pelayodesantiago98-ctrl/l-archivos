'use strict';
/*
 * Apuntar gastos e ingresos desde el boton del Centro de Control del iPhone.
 *
 * El atajo de iOS no sabe arrastrar la cookie del SSO: manda una peticion
 * suelta, sin navegador que guarde nada. Por eso la ruta que lo atiende lleva
 * un token propio en la cabecera, y a cambio no puede hacer nada mas que lo que
 * hay aqui: anadir una fila a una hoja concreta.
 *
 * El libro tiene una pestana por mes y una de Resumen delante. El mes de cada
 * movimiento sale de su propia fecha y no de la pestana donde estaba: asi, si
 * una fila acaba donde no toca -- porque se edito a mano, o porque un apunte
 * entro a las doce y pico de la noche del dia 1 --, se recoloca sola en el
 * siguiente apunte en vez de quedarse mal para siempre.
 *
 * El libro se reescribe entero cada vez. Con unos miles de movimientos son
 * decenas de kilobytes y no compensa nada mas fino; lo que si importa es que la
 * escritura sea atomica, porque si se corta a la mitad te quedas sin cuentas.
 *
 * Los totales se guardan como numeros ya calculados y no como formulas. El
 * visor de Documentos lee el XML pero no evalua nada, y escribir.libro guarda
 * una formula como <f> a secas, sin valor: en pantalla saldria una celda vacia.
 * Asi que se recalculan aqui en cada apunte. El precio es que si editas el
 * libro a mano desde Excel los totales se quedan como estaban hasta el apunte
 * siguiente.
 */
const fs = require('fs');
const ofimatica = require('./ofimatica');
const escribir = require('./escribir');

const CABECERA = ['Fecha', 'Tipo', 'Importe', 'Motivo'];
const RESUMEN = 'Resumen';

/* Donde caen los movimientos con una fecha que no hay por donde coger. Van a su
   propia pestana en vez de perderse o de ensuciar un mes que no es. */
const SIN_FECHA = 'sin-fecha';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/* A partir de aqui el libro pesa lo suficiente como para que reescribirlo
   entero en cada apunte empiece a notarse. Son anos de gastos diarios. */
const TOPE_FILAS = 20000;

const dosDecimales = (n) => Math.round(n * 100) / 100;

/* "A" -> 0, "B" -> 1, "AA" -> 26. Las filas vienen con las celdas dispersas
   (una fila sin motivo no trae la D) y hay que devolver cada una a su sitio
   antes de poder leerlas por posicion. */
function indiceDe(letra) {
  let n = 0;
  for (const c of String(letra == null ? '' : letra).toUpperCase()) {
    if (c < 'A' || c > 'Z') break;
    n = n * 26 + (c.charCodeAt(0) - 64);
  }
  return n - 1;
}

function aDenso(filasDispersas) {
  return (filasDispersas || []).map((celdas) => {
    const fila = [];
    for (const celda of celdas || []) {
      const i = indiceDe(celda.col);
      if (i >= 0) fila[i] = celda.valor;
    }
    for (let i = 0; i < fila.length; i++) {
      if (fila[i] === undefined) fila[i] = '';
    }
    return fila;
  });
}

/* "2026-08" a partir de lo que venga escrito en la casilla de la fecha. El
   atajo manda 26/08/2026, pero una fila tocada a mano puede traer otra cosa. */
function claveDe(fecha) {
  const t = String(fecha == null ? '' : fecha).trim();

  const espanola = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(t);
  if (espanola) return espanola[3] + '-' + espanola[2].padStart(2, '0');

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (iso) return iso[1] + '-' + iso[2].padStart(2, '0');

  return SIN_FECHA;
}

function nombreDelMes(clave) {
  if (clave === SIN_FECHA) return 'Sin fecha';
  const [ano, mes] = clave.split('-');
  return MESES[Number(mes) - 1] + ' ' + ano;
}

/* Se queda solo con los movimientos de una pestana: la cabecera "Fecha" marca
   donde empiezan. La de Resumen no la tiene, asi que se salta sola. */
function movimientosDe(filas) {
  const cabecera = filas.findIndex(
    (f) => String(f[0] == null ? '' : f[0]).trim().toLowerCase() === 'fecha');
  if (cabecera < 0) return [];
  return filas.slice(cabecera + 1)
    .filter((f) => String(f[0] == null ? '' : f[0]).trim() !== '')
    .map((f) => [
      String(f[0] == null ? '' : f[0]),
      String(f[1] == null ? '' : f[1]),
      Number(f[2]) || 0,
      String(f[3] == null ? '' : f[3]),
    ]);
}

/* El importe va firmado: el gasto en negativo y el ingreso en positivo. Asi la
   diferencia es una resta que ya viene hecha y no hay que mirar la columna del
   tipo para nada. */
function totales(movs) {
  let ingresos = 0;
  let gastos = 0;
  for (const m of movs) {
    if (m[2] >= 0) ingresos += m[2];
    else gastos += m[2];
  }
  return {
    ingresos: dosDecimales(ingresos),
    gastos: dosDecimales(gastos),
    diferencia: dosDecimales(ingresos + gastos),
    movimientos: movs.length,
  };
}

/* Todos los movimientos del libro, vengan de la pestana que vengan. */
function leer(abs) {
  if (!fs.existsSync(abs)) return [];
  const libro = ofimatica.leer(abs, 'xlsx');
  const hojas = (libro && libro.hojas) || [];
  const todos = [];
  for (const h of hojas) todos.push(...movimientosDe(aDenso(h.filas)));
  return todos;
}

function porMeses(movs) {
  const cajones = new Map();
  for (const m of movs) {
    const clave = claveDe(m[0]);
    if (!cajones.has(clave)) cajones.set(clave, []);
    cajones.get(clave).push(m);
  }
  /* Del mes de ahora hacia atras: al abrir el libro en el movil, lo primero
     que se ve despues del resumen es lo de este mes. "Sin fecha" al final,
     que es donde estorba menos. */
  const claves = [...cajones.keys()].sort((a, b) => {
    if (a === SIN_FECHA) return 1;
    if (b === SIN_FECHA) return -1;
    return b.localeCompare(a);
  });
  return claves.map((clave) => ({ clave, movs: cajones.get(clave) }));
}

function hojaDeMes(clave, movs) {
  const t = totales(movs);
  /* Dentro de cada mes, del dia mas viejo al mas nuevo. */
  const ordenados = movs.slice().sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return {
    nombre: nombreDelMes(clave),
    filas: [
      ['Mes', nombreDelMes(clave), 'Ingresos', t.ingresos, 'Gastos', t.gastos, 'Diferencia', t.diferencia],
      [],
      CABECERA.slice(),
    ].concat(ordenados),
  };
}

function hojaResumen(meses) {
  const filas = [['Mes', 'Ingresos', 'Gastos', 'Diferencia']];
  let ingresos = 0;
  let gastos = 0;
  for (const m of meses) {
    const t = totales(m.movs);
    filas.push([nombreDelMes(m.clave), t.ingresos, t.gastos, t.diferencia]);
    ingresos += t.ingresos;
    gastos += t.gastos;
  }
  filas.push([]);
  filas.push(['TOTAL', dosDecimales(ingresos), dosDecimales(gastos), dosDecimales(ingresos + gastos)]);
  return { nombre: RESUMEN, filas };
}

function componer(movs) {
  const meses = porMeses(movs);
  return [hojaResumen(meses)].concat(meses.map((m) => hojaDeMes(m.clave, m.movs)));
}

/* Se escribe al lado y se mueve encima, igual que hace el editor: si algo falla
   a mitad, el libro de antes sigue entero. La copia .bak es de la ultima
   version buena, por si un apunte sale torcido y hay que volver. */
function guardar(abs, hojas) {
  const datos = escribir.libro(hojas);
  const temporal = abs + '.apuntando';
  fs.writeFileSync(temporal, datos);
  if (fs.existsSync(abs)) fs.copyFileSync(abs, abs + '.bak');
  fs.renameSync(temporal, abs);
  return datos.length;
}

function apuntar(abs, mov) {
  const movs = leer(abs);
  if (movs.length >= TOPE_FILAS) {
    throw new Error('El libro ya tiene ' + movs.length + ' movimientos: archivalo y empieza otro.');
  }
  movs.push([mov.fecha, mov.tipo, mov.importe, mov.motivo]);
  guardar(abs, componer(movs));

  const clave = claveDe(mov.fecha);
  const delMes = movs.filter((m) => claveDe(m[0]) === clave);
  return {
    total: totales(movs),
    mes: Object.assign({ clave, nombre: nombreDelMes(clave) }, totales(delMes)),
  };
}

function resumen(abs) {
  const movs = leer(abs);
  return {
    total: totales(movs),
    meses: porMeses(movs).map((m) => Object.assign(
      { clave: m.clave, nombre: nombreDelMes(m.clave) }, totales(m.movs))),
  };
}

function crear(abs) {
  if (fs.existsSync(abs)) return false;
  guardar(abs, componer([]));
  return true;
}

module.exports = { apuntar, crear, leer, resumen, totales, componer, CABECERA };
