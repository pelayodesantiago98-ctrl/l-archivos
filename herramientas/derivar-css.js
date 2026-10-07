'use strict';
/* Deriva el arbolqr.css de l-archivos a partir del de l-notes.
 *
 * Se genera en vez de transcribirse a mano por dos motivos: son 340 lineas y
 * copiarlas a ojo es pedir una errata, y asi queda escrito de donde sale.
 * Lo unico que cambia son los nombres de las variables de tema, que en cada
 * app se llaman de una forma.
 *
 * uso: node derivar-css.js <origen> <destino>
 */
const fs = require('fs');

const [, , ORIGEN, DESTINO] = process.argv;
if (!ORIGEN || !DESTINO) { console.error('uso: derivar-css.js <origen> <destino>'); process.exit(1); }

let css = fs.readFileSync(ORIGEN, 'utf8');

/* El mapa. `--vault-panel` trae su propio color de respaldo y hay que
   conservarlo: sin el, un tema que no defina la variable deja el panel
   transparente y el dialogo se lee sobre la pagina. */
const MAPA = [
  ['--vault-accent', '--accent'],
  ['--vault-line', '--border'],
  ['--vault-panel', '--card'],
];

const cuenta = {};
for (const [de, a] of MAPA) {
  const trozos = css.split(de);
  cuenta[de] = trozos.length - 1;
  css = trozos.join(a);
}

/* La regla del tema dorado es de l-notes: alli el acento es claro y el icono
   tiene que ir oscuro encima. Aqui ese tema no existe, asi que el selector no
   casa nunca. Se quita en vez de dejarla muerta. */
const antes = css.length;
css = css.replace(/^:root\[data-theme="gold"\][^\n]*\n/gm, '');
const doradas = antes !== css.length;

const CABECERA = `/* ─────────────────────────────────────────────────────────────────────────
   El arbol-QR en l-archivos: el boton de la esquina, el dialogo y el crecer.

   GENERADO a partir de l-notes (apps/notes/static/notes/arbolqr.css) por
   herramientas/derivar-css.js. Si hay que cambiar algo de fondo, cambiarlo
   alli y volver a derivar: son la misma pieza en dos sitios, y tocar solo una
   es como acaban divergiendo.

   Lo unico que se traduce son las variables de tema, que cada app nombra a su
   manera: --vault-accent → --accent, --vault-line → --border,
   --vault-panel → --card.
   ───────────────────────────────────────────────────────────────────────── */
`;

fs.writeFileSync(DESTINO, CABECERA + css);
console.log('derivado ' + DESTINO);
for (const [de, a] of MAPA) console.log('  ' + de + ' → ' + a + '  (' + cuenta[de] + ')');
console.log('  regla del tema dorado: ' + (doradas ? 'quitada' : 'no habia'));
