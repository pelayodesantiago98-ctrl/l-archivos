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

  // ── El panel de compartir ──────────────────────────────────────────────

  function panel(estado) {
    var caja = crear('div', 'espacio-panel');
    caja.hidden = true;

    caja.append(crear('p', 'espacio-nota',
      'Reparte un enlace y quien lo abra entrará en tus archivos: fotos, ' +
      'vídeos, documentos y lo demás. El enlace no se gasta, y el acceso se ' +
      'puede retirar cuando quieras.'));

    var botones = crear('div', 'espacio-acciones');
    [['lector', 'Enlace de lectura'], ['editor', 'Enlace de edición']].forEach(function (par) {
      var b = crear('button', 'espacio-boton', par[1]);
      b.type = 'button';
      b.addEventListener('click', async function () {
        var r = await api('/api/espacio/invitar', { permiso: par[0] });
        try { await navigator.clipboard.writeText(r.url); } catch (e) { /* sin portapapeles */ }
        var antes = b.textContent;
        b.textContent = 'Enlace copiado';
        setTimeout(function () { b.textContent = antes; }, 1600);
        refrescar();
      });
      botones.append(b);
    });
    caja.append(botones);

    var lista = crear('div', 'espacio-lista');
    lista.id = 'espacio-lista';
    caja.append(lista);

    // A quien puedo ir, si me han dado acceso a algo.
    if (estado.espacios.length > 1) {
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
    }

    return caja;
  }

  function pintarRepartidos(repartidos) {
    var lista = $('espacio-lista');
    if (!lista) return;
    lista.replaceChildren();

    if (!repartidos.length) {
      lista.append(crear('p', 'espacio-nota', 'Todavía no has dado acceso a nadie.'));
      return;
    }

    repartidos.forEach(function (r) {
      var fila = crear('div', 'espacio-fila');
      fila.append(crear('span', 'espacio-quien', r.invitado || 'Enlace sin usar'));
      fila.append(crear('span', 'espacio-permiso',
        r.permiso === 'editor' ? 'Puede cambiar' : 'Sólo lectura'));

      if (r.url) {
        var copiar = crear('button', 'espacio-boton pequeno', 'Copiar');
        copiar.type = 'button';
        copiar.addEventListener('click', async function () {
          try { await navigator.clipboard.writeText(r.url); } catch (e) { /* nada */ }
          copiar.textContent = 'Copiado';
          setTimeout(function () { copiar.textContent = 'Copiar'; }, 1400);
        });
        fila.append(copiar);
      }

      var quitar = crear('button', 'espacio-boton pequeno malo', 'Retirar');
      quitar.type = 'button';
      quitar.addEventListener('click', async function () {
        await api('/api/espacio/retirar', { id: r.id });
        refrescar();
      });
      fila.append(quitar);

      lista.append(fila);
    });
  }

  async function refrescar() {
    var estado = await api('/api/espacio/estado');
    pintarRepartidos(estado.repartidos);
    return estado;
  }

  // ── Arranque ───────────────────────────────────────────────────────────

  (async function () {
    var estado;
    try { estado = await api('/api/espacio/estado'); } catch (e) { return; }

    barra(estado);

    var sitio = document.querySelector('.filtros') || document.querySelector('h1');
    if (!sitio) return;

    var abrir = crear('button', 'espacio-boton', 'Compartir mis archivos');
    abrir.type = 'button';
    abrir.id = 'espacio-abrir';

    var caja = panel(estado);
    sitio.parentNode.insertBefore(abrir, sitio.nextSibling);
    abrir.parentNode.insertBefore(caja, abrir.nextSibling);

    abrir.addEventListener('click', async function () {
      caja.hidden = !caja.hidden;
      abrir.textContent = caja.hidden ? 'Compartir mis archivos' : 'Ocultar';
      if (!caja.hidden) await refrescar();
    });
  })();
})();
