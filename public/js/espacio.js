'use strict';
/*
 * Compartir tus archivos con otra cuenta, y saber de quien son los que estas
 * viendo.
 *
 * Se carga en las tres pantallas —galeria, documentos y archivos— porque el
 * espacio es el mismo para las tres: si entras en los de otra persona, entras
 * en todo lo suyo, no solo en sus fotos.
 *
 * La barra de arriba solo aparece cuando estas en lo de otro. Estar en lo tuyo
 * es lo normal y no merece un aviso permanente.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  async function api(ruta, cuerpo) {
    var opciones = { credentials: 'same-origin' };
    if (cuerpo !== undefined) {
      opciones.method = 'POST';
      opciones.headers = { 'Content-Type': 'application/json' };
      opciones.body = JSON.stringify(cuerpo);
    }
    var res = await fetch(ruta, opciones);
    var d = null;
    try { d = await res.json(); } catch (e) { /* sin cuerpo */ }
    if (!res.ok) throw new Error((d && d.error) || ('Error ' + res.status));
    return d;
  }

  function crear(tag, clase, texto) {
    var n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto != null) n.textContent = texto;
    return n;
  }

  // ── La barra de "estas en lo de otro" ──────────────────────────────────

  function barra(estado) {
    if (estado.activo.propio) return;

    var b = crear('div', 'barra-espacio');
    b.append(crear('span', null,
      'Estás viendo los archivos de ' + estado.activo.dueno +
      (estado.activo.permiso === 'editor' ? ', y puedes cambiarlos.' : ', de sólo lectura.')));

    var volver = crear('button', 'espacio-boton', 'Volver a los míos');
    volver.type = 'button';
    volver.addEventListener('click', async function () {
      await api('/api/espacio/cambiar', { dueno: '' });
      location.reload();
    });
    b.append(volver);
    document.body.insertBefore(b, document.body.firstChild);
  }

  // ── El panel de espacios ───────────────────────────────────────────────

  /* Solo lleva a donde se puede ir. Antes tambien repartia enlaces de entrada
     a todo tu espacio; eso se quito porque lo que se comparte se comparte por
     fichero, desde la seleccion. */
  function panel(estado) {
    var caja = crear('div', 'espacio-panel');
    caja.hidden = true;

    var ir = crear('div', 'espacio-acciones');
    ir.append(crear('span', 'espacio-nota', 'Ir a:'));
    estado.espacios.forEach(function (e) {
      var b = crear('button', 'espacio-boton' +
        (e.dueno === estado.activo.dueno ? ' on' : ''),
        e.propio ? 'Los míos' : e.dueno);
      b.type = 'button';
      b.addEventListener('click', async function () {
        await api('/api/espacio/cambiar', { dueno: e.propio ? '' : e.dueno });
        location.reload();
      });
      ir.append(b);
    });
    caja.append(ir);

    return caja;
  }

  // ── Arranque ───────────────────────────────────────────────────────────

  (async function () {
    var estado;
    try { estado = await api('/api/espacio/estado'); } catch (e) { return; }

    barra(estado);

    /* Con un solo espacio —el tuyo— no hay a donde ir, asi que no se pone
       nada: un boton que abre una lista de un elemento es ruido. */
    if (!estado.espacios || estado.espacios.length < 2) return;

    var sitio = document.querySelector('.filtros') || document.querySelector('h1');
    if (!sitio) return;

    var abrir = crear('button', 'espacio-boton', 'Espacios');
    abrir.type = 'button';
    abrir.id = 'espacio-abrir';

    var caja = panel(estado);
    sitio.parentNode.insertBefore(abrir, sitio.nextSibling);
    abrir.parentNode.insertBefore(caja, abrir.nextSibling);

    abrir.addEventListener('click', function () {
      caja.hidden = !caja.hidden;
      abrir.textContent = caja.hidden ? 'Espacios' : 'Ocultar';
    });
  })();
})();
